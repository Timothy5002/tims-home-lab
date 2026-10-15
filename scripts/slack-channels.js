'use strict';
// Lists the Slack channels and group DMs the token's user is a member of, maps each to a business unit,
// and saves the list to data/slack-channels.json (no message text). Step 1 of measuring how much text a
// daily Slack digest would have to read; slack-measure.js uses the saved list. See docs/slack-measurement.md.
// Usage: node scripts/slack-channels.js [--all] [--no-activity] | --from-cache
//   --all          include every public channel the token can see, not only ones the user is in (slow)
//   --no-activity  skip the one-call-per-channel "last activity" lookup (much faster)
//   --from-cache   no Slack calls: re-apply config/slack-bus.json to the saved list and print the report
const path = require('node:path');
const { parseArgs } = require('node:util');
const fs = require('node:fs');
const { ROOT, CHANNELS_FILE, createClient, SlackError, loadConfig, placeChannel, writePrivateJson, localDay, printTable } = require('../src/slack');

const TYPE = { public: 'public', private: 'private', group_dm: 'group_dm' };

function channelType(c) {
  if (c.is_mpim) return TYPE.group_dm;
  return c.is_private ? TYPE.private : TYPE.public;
}

// Section headings match the questions the report answers; see docs/slack-measurement.md.
function report(cfg, channels) {
  const last = (ch) => (ch.lastActivity ? localDay(new Date(ch.lastActivity)) : (ch.error ? `(${ch.error})` : 'no messages'));
  const byActivity = (a, b) => String(b.lastActivity ?? '').localeCompare(String(a.lastActivity ?? ''));
  const isId = (n) => /^U[A-Z0-9]{6,}$/.test(n);
  // Group DM internal names are "mpdm-<handle>--<handle>-1"; handles help identify members whose IDs did not resolve.
  const handles = (c) => (c.name.startsWith('mpdm-') ? c.name.replace(/^mpdm-/, '').replace(/-\d+$/, '').split('--') : []);
  const members = (c) => {
    const names = c.memberNames ?? [];
    const hint = names.some(isId) && handles(c).length ? `  [handles: ${handles(c).join(', ')}]` : '';
    return (names.join(', ') || `(${c.error ?? 'unknown'})`) + hint;
  };

  const counts = { public: 0, private: 0, group_dm: 0 };
  for (const ch of channels) counts[ch.type]++;
  console.log(`\n${channels.length} conversations: ${counts.public} public, ${counts.private} private, ${counts.group_dm} group DMs.`);

  // 1. Matched per business unit and sub-group
  const tally = new Map();
  const bump = (key, type) => {
    const row = tally.get(key) ?? { public: 0, private: 0, group_dm: 0 };
    row[type]++;
    tally.set(key, row);
  };
  for (const ch of channels.filter((c) => c.bu)) {
    bump(ch.bu, ch.type);
    if (ch.sub) bump(`${ch.bu}\u0000${ch.sub}`, ch.type);
  }
  console.log('\n1. Matched per business unit and sub-group:');
  if (tally.size === 0) console.log('  (none placed yet; add rules to config/slack-bus.json)');
  else printTable(['business unit / sub-group', 'public', 'private', 'group DMs', 'total'],
    [...tally].sort(([a], [b]) => a.localeCompare(b)).map(([key, r]) => {
      const [bu, sub] = key.split('\u0000');
      return [sub ? `    ${sub}` : bu, r.public, r.private, r.group_dm, r.public + r.private + r.group_dm];
    }));
  const excluded = channels.filter((c) => c.by === 'excluded');
  if (excluded.length) console.log(`  ${excluded.length} channel(s) left out on purpose (override set to null).`);

  // 2. Overlaps
  const multi = channels.filter((c) => c.matches?.length > 1);
  console.log(`\n2. Channels matched by more than one rule (${multi.length}):`);
  for (const c of multi) {
    const differ = new Set(c.matches.map((m) => m.group)).size > 1;
    console.log(`  ${c.name}  -> placed in ${c.group ?? '(left out)'} by ${c.by === 'rule' ? c.matches[0].label : c.by}${differ ? '  [DIFFERENT targets]' : '  [same target]'}`);
    for (const m of c.matches) console.log(`      ${m.label} -> ${m.group}`);
  }

  // 3. Unplaced channels
  const unplaced = channels.filter((c) => c.type !== 'group_dm' && c.by === null).sort(byActivity);
  console.log(`\n3. Channels still unplaced, busiest first (${unplaced.length}):`);
  if (unplaced.length) console.log(`  ${unplaced.map((c) => c.name).join(', ')}`);

  // 4. Recently active group DMs that are not assigned
  const cutoff = Date.now() - 30 * 86_400_000;
  const dms = channels.filter((c) => c.type === 'group_dm' && c.by === null && c.lastActivity && Date.parse(c.lastActivity) >= cutoff).sort(byActivity);
  console.log(`\n4. Group DMs active in the last 30 days that are not assigned (${dms.length}):`);
  if (dms.length) printTable(['id', 'last activity', 'members'], dms.map((c) => [c.id, last(c), members(c)]));

  // 5. Group DMs from the config that could not be matched
  const byId = new Map(channels.map((c) => [c.id, c]));
  const missing = Object.entries(cfg.groupDms).filter(([id]) => !byId.has(id));
  const drift = channels.filter((c) => c.memberDrift);
  const pending = cfg.pendingGroupDms;
  console.log(`\n5. Group DMs from your list that are not matched (${missing.length + drift.length + pending.length}):`);
  for (const [id, t] of missing) console.log(`  ${t.label ?? id} (${id}): not in the saved channel list`);
  for (const c of drift) {
    console.log(`  ${cfg.groupDms[c.id].label ?? c.id} (${c.id}): members changed; still assigned, please re-check`);
    console.log(`      config: ${cfg.groupDms[c.id].members.join(', ')}\n      now:    ${(c.memberNames ?? []).join(', ')}`);
  }
  for (const p of pending) {
    console.log(`  "${p.label}" -> ${p.sub ? `${p.bu} > ${p.sub}` : p.bu}: waiting for a choice${p.note ? ` (${p.note})` : ''}`);
    for (const id of p.candidates) {
      const c = byId.get(id);
      console.log(`      ${id}  ${c ? `last ${last(c)}  ${members(c)}` : '(not in the saved list)'}`);
    }
  }

  // 6. External conversations: their text is masked before any model call (see docs/slack-digest-design.md)
  const placedAll = channels.filter((c) => c.bu);
  const ext = placedAll.filter((c) => c.external);
  const hasSharedField = channels.some((c) => typeof c.isExtShared === 'boolean');
  console.log(`\n6. External conversations (masked before any model call): ${ext.length} of ${placedAll.length} placed`);
  if (!hasSharedField) console.log("  This listing has no Slack 'externally shared' field, so only the unit rule applied. The next full listing records it (no extra calls).");
  const byGroup = new Map();
  for (const c of ext) byGroup.set(c.group, [...(byGroup.get(c.group) ?? []), c]);
  for (const [g, cs] of [...byGroup].sort(([a], [b]) => a.localeCompare(b))) {
    const counts = { public: 0, private: 0, group_dm: 0 };
    for (const c of cs) counts[c.type]++;
    console.log(`  ${g}: ${cs.length} (${counts.public} public, ${counts.private} private, ${counts.group_dm} group DMs)`);
    const named = cs.filter((c) => c.type !== 'group_dm').map((c) => c.name + (c.externalWhy.includes('Slack shared') ? ' [shared]' : '')).sort();
    if (named.length) console.log(`      ${named.join(', ')}`);
    for (const c of cs.filter((x) => x.type === 'group_dm')) console.log(`      ${c.id}  ${c.name.startsWith('mpdm-') ? '' : `[${c.name}] `}${(c.memberNames ?? []).join(', ')}`);
  }
  const internalCount = placedAll.length - ext.length;
  console.log(`  Internal (not masked): ${internalCount}`);
}

(async () => {
  const { values: opts } = parseArgs({ options: {
    all: { type: 'boolean', default: false },
    'no-activity': { type: 'boolean', default: false },
    'from-cache': { type: 'boolean', default: false },
  } });
  const started = Date.now();
  const cfg = loadConfig();
  if (opts['from-cache']) {
    if (!fs.existsSync(CHANNELS_FILE)) throw new Error('data/slack-channels.json not found; run without --from-cache first');
    const saved = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
    console.log(`Using the saved list from ${saved.generatedAt} (${saved.channels.length} conversations, scope: ${saved.scope ?? 'member'}). No Slack calls.`);
    report(cfg, saved.channels.map((c) => ({ ...c, ...placeChannel(cfg, c) })));
    return;
  }
  const slack = createClient();

  process.stderr.write('Listing channels...\n');
  const raw = await slack.paginate('conversations.list',
    { types: 'public_channel,private_channel,mpim', exclude_archived: 'true', limit: '200' }, 'channels');

  // Membership comes from conversations.list itself, so filtering costs no extra calls and happens
  // before the per-channel lookups below. Slack only returns private channels and group DMs to a user
  // token when the user is in them, so those count as member if is_member is missing.
  let assumedMember = 0;
  const isMember = (c) => {
    if (typeof c.is_member === 'boolean') return c.is_member;
    if (c.is_private || c.is_mpim) { assumedMember++; return true; }
    return false;
  };
  const seen = { public: 0, private: 0, group_dm: 0 };
  const member = { public: 0, private: 0, group_dm: 0 };
  const memberIds = new Set();
  for (const c of raw) {
    seen[channelType(c)]++;
    if (isMember(c)) { member[channelType(c)]++; memberIds.add(c.id); }
  }
  const todo = opts.all ? raw : raw.filter((c) => memberIds.has(c.id));
  const sum = (o) => o.public + o.private + o.group_dm;
  console.log(`Conversations seen: ${raw.length} (archived excluded). Member of: ${memberIds.size}.` +
    (opts.all ? ' --all: looking up all of them.' : ' Looking up only those.'));
  printTable(['type', 'seen', 'member'], [
    ['public', seen.public, member.public], ['private', seen.private, member.private],
    ['group DM', seen.group_dm, member.group_dm], ['total', sum(seen), sum(member)]]);
  if (assumedMember) console.log(`  (${assumedMember} private channel(s) or group DM(s) had no is_member field and were counted as member.)`);

  process.stderr.write('Loading user names...\n');
  const users = await slack.paginate('users.list', { limit: '200' }, 'members');
  const nameOf = new Map(users.map((u) => [u.id, u.profile?.display_name || u.real_name || u.name || u.id]));

  const channels = [];
  for (const [i, c] of todo.entries()) {
    const ch = { id: c.id, name: c.name, type: channelType(c), members: c.num_members ?? null, isMember: memberIds.has(c.id),
      // Shared with another organization (Slack Connect); part of the external test in src/slack.js.
      isExtShared: Boolean(c.is_ext_shared) };
    if (ch.type === TYPE.group_dm) {
      process.stderr.write(`  [${i + 1}/${todo.length}] members of group DM ${c.id}\n`);
      try {
        const ids = await slack.paginate('conversations.members', { channel: c.id, limit: '200' }, 'members');
        ch.members = ids.length;
        ch.memberNames = ids.map((id) => nameOf.get(id) ?? id).sort();
      } catch (e) {
        if (!(e instanceof SlackError)) throw e;
        ch.error = e.code;
      }
    }
    if (!opts['no-activity']) {
      process.stderr.write(`  [${i + 1}/${todo.length}] last activity in ${ch.type === TYPE.group_dm ? c.id : '#' + c.name}\n`);
      try {
        // Only the timestamp of the newest message is kept; its text is never read or stored.
        const body = await slack.call('conversations.history', { channel: c.id, limit: '1' });
        const ts = body.messages?.[0]?.ts;
        ch.lastActivity = ts ? new Date(Number(ts) * 1000).toISOString() : null;
      } catch (e) {
        if (!(e instanceof SlackError)) throw e;
        ch.lastActivity = null;
        ch.error = e.code;
      }
    }
    Object.assign(ch, placeChannel(cfg, ch));
    channels.push(ch);
  }

  writePrivateJson(CHANNELS_FILE, {
    generatedAt: new Date().toISOString(), scope: opts.all ? 'all' : 'member', lastActivityChecked: !opts['no-activity'],
    seen: { ...seen, total: raw.length }, member: { ...member, total: memberIds.size }, channels,
  });

  report(cfg, channels);

  const s = slack.stats;
  console.log(`\nWrote ${path.relative(ROOT, CHANNELS_FILE)}. ${s.calls} API calls, ${s.rateLimited} rate-limit waits, ${Math.round((Date.now() - started) / 1000)}s.`);
})().catch((e) => {
  console.error(`slack-channels: ${e.message}`);
  process.exit(1);
});
