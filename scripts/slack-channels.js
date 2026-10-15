'use strict';
// Lists the Slack channels and group DMs the token's user is a member of, maps each to a business unit,
// and saves the list to data/slack-channels.json (no message text). Step 1 of measuring how much text a
// daily Slack digest would have to read; slack-measure.js uses the saved list. See docs/slack-measurement.md.
// Usage: node scripts/slack-channels.js [--all] [--no-activity]
//   --all          include every public channel the token can see, not only ones the user is in (slow)
//   --no-activity  skip the one-call-per-channel "last activity" lookup (much faster)
const path = require('node:path');
const { parseArgs } = require('node:util');
const { ROOT, CHANNELS_FILE, createClient, SlackError, loadConfig, placeChannel, writePrivateJson, localDay, printTable } = require('./slack-lib');

const TYPE = { public: 'public', private: 'private', group_dm: 'group_dm' };

function channelType(c) {
  if (c.is_mpim) return TYPE.group_dm;
  return c.is_private ? TYPE.private : TYPE.public;
}

(async () => {
  const { values: opts } = parseArgs({ options: {
    all: { type: 'boolean', default: false },
    'no-activity': { type: 'boolean', default: false },
  } });
  const started = Date.now();
  const cfg = loadConfig();
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
    const ch = { id: c.id, name: c.name, type: channelType(c), members: c.num_members ?? null, isMember: memberIds.has(c.id) };
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

  // Report
  const last = (ch) => (ch.lastActivity ? localDay(new Date(ch.lastActivity)) : (ch.error ? `(${ch.error})` : '-'));
  const byActivity = (a, b) => String(b.lastActivity ?? '').localeCompare(String(a.lastActivity ?? ''));
  const counts = { public: 0, private: 0, group_dm: 0 };
  for (const ch of channels) counts[ch.type]++;
  console.log(`\nLooked up ${channels.length} conversations: ${counts.public} public, ${counts.private} private, ${counts.group_dm} group DMs.`);

  const perBu = new Map();
  for (const ch of channels.filter((c) => c.bu)) {
    const row = perBu.get(ch.bu) ?? { public: 0, private: 0, group_dm: 0 };
    row[ch.type]++;
    perBu.set(ch.bu, row);
  }
  console.log('\nChannels per business unit:');
  if (perBu.size === 0) console.log('  (none placed yet; add rules to config/slack-bus.json)');
  else printTable(['business unit', 'public', 'private', 'group DMs', 'total'],
    [...perBu].sort().map(([bu, r]) => [bu, r.public, r.private, r.group_dm, r.public + r.private + r.group_dm]));

  const excluded = channels.filter((c) => c.by === 'excluded');
  if (excluded.length) console.log(`\n${excluded.length} channel(s) left out on purpose (override set to null).`);

  const unplaced = channels.filter((c) => c.type !== TYPE.group_dm && c.by === null).sort(byActivity);
  console.log(`\nCould not place ${unplaced.length} channel(s):`);
  if (unplaced.length) printTable(['id', 'name', 'type', 'members', 'member?', 'last activity'],
    unplaced.map((c) => [c.id, c.name, c.type, c.members ?? '-', c.isMember ? 'yes' : 'no', last(c)]));

  const dms = channels.filter((c) => c.type === TYPE.group_dm && c.by === null).sort(byActivity);
  console.log(`\n${dms.length} group DM(s) not included (add an ID to "groupDms" to measure it):`);
  if (dms.length) printTable(['id', 'last activity', 'members'],
    dms.map((c) => [c.id, last(c), (c.memberNames ?? []).join(', ') || `(${c.error ?? 'unknown'})`]));

  const s = slack.stats;
  console.log(`\nWrote ${path.relative(ROOT, CHANNELS_FILE)}. ${s.calls} API calls, ${s.rateLimited} rate-limit waits, ${Math.round((Date.now() - started) / 1000)}s.`);
})().catch((e) => {
  console.error(`slack-channels: ${e.message}`);
  process.exit(1);
});
