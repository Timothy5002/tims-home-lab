'use strict';
// Maps, ignores or un-maps Slack conversations for the digest, so the "unmapped" list in the DM footer can be
// cleared without hand-editing JSON. It edits only the git-ignored configs: config/slack-bus.json (overrides,
// group DMs, the ignore list) and config/digest-customers.json (customer channels). It reads conversation names
// from the cached listing (data/slack-channels.json) and makes no Slack calls. Names and IDs only: it never reads
// or prints message text, and never touches a token.
//
// Usage: node scripts/digest-map.js <command> ...
//   list-unmapped                       conversations you are in that no rule maps and that are not ignored, each
//                                       marked active (last 30 days, as far as the cached listing knows) or not
//   map <name> <Unit>[/<Sub-group>]     map a channel (override) or a group DM (by ID, members recorded) to a unit;
//                                       an unknown unit or sub-group needs --new
//   map-customer <name> <customer>      attach a customer-unit channel to a customer (key or name)
//   ignore <name>                       stop listing an unmapped conversation
//   ignore-all-unmapped [--active-only] [--yes]
//                                       without --yes: print how many would be ignored and the first 20, write nothing;
//                                       with --yes: add them all to the ignore list in one atomic write
//                                       (--active-only: only those active in the last 30 days; default: all)
//   remove <name>                       undo: drop its override, group DM entry, ignore entry and customer assignment
// <name>: a channel name (with or without #), a conversation ID, or a group DM's full member list, comma-separated
// ("Ann Lee, Bo Diaz"; your own name may be left out). A name that fits more than one conversation, or none, lists
// the candidates and changes nothing. Config files are written atomically (temp file, then rename), mode 600.
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, CHANNELS_FILE, CONFIG_FILE, loadConfig, placeChannel, recentlyActive, splitUnmapped } = require('../src/slack');
const { loadCustomerConfig, buildRegistry, CONFIG: CUSTOMERS_FILE } = require('../src/digest/customers');
const { convLabel } = require('../src/digest/render');

const DEFAULT_PATHS = { bus: CONFIG_FILE, customers: CUSTOMERS_FILE, channels: CHANNELS_FILE, digest: path.join(ROOT, 'config', 'slack-digest.json') };
const ID = /^[CGD][A-Z0-9]{6,}$/;

function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const sameSet = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

// Finds one conversation for a name. Returns { conv } or { candidates } (none or several: change nothing).
function resolveConv(query, channels, me) {
  const q = String(query).trim();
  const byId = channels.find((x) => x.id === q);
  if (byId) return { conv: byId };
  if (ID.test(q)) return { candidates: [] }; // looks like an ID that is not in the listing
  const name = q.replace(/^#/, '').toLowerCase();
  const byName = channels.filter((c) => c.name.toLowerCase() === name || (c.type === 'group_dm' && c.label?.toLowerCase() === q.toLowerCase()));
  if (byName.length === 1) return { conv: byName[0] };
  if (byName.length > 1) return { candidates: byName };
  // A group DM by its full member set (your own name may be left out).
  const want = q.split(',').map((s) => s.trim()).filter(Boolean);
  const dms = channels.filter((c) => c.type === 'group_dm' && Array.isArray(c.memberNames));
  const exact = dms.filter((c) => sameSet(c.memberNames, want) || (me && sameSet(c.memberNames, [...new Set([...want, me])])));
  if (exact.length === 1) return { conv: exact[0] };
  if (exact.length > 1) return { candidates: exact };
  // Nothing exact: candidates that contain the text, or group DMs that include every name given.
  const near = channels.filter((c) => (c.type !== 'group_dm' && c.name.toLowerCase().includes(name))
    || (c.type === 'group_dm' && want.length && want.every((w) => (c.memberNames ?? []).includes(w))));
  return { candidates: near.slice(0, 20) };
}

function run(argv, paths = DEFAULT_PATHS, now = Date.now()) {
  const out = [];
  const say = (l) => out.push(l);
  const args = argv.filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const [cmd, ...rest] = args;
  const busRaw = JSON.parse(fs.readFileSync(paths.bus, 'utf8'));
  const bus = loadConfig(paths.bus);
  const saved = JSON.parse(fs.readFileSync(paths.channels, 'utf8'));
  const me = fs.existsSync(paths.digest) ? JSON.parse(fs.readFileSync(paths.digest, 'utf8')).myName ?? null : null;
  const channels = saved.channels.map((c) => ({ ...c, ...placeChannel(bus, c) })).map((c) => ({ ...c, label: convLabel(c, me) }));
  const show = (c) => `${c.label} (${c.id}${c.type === 'group_dm' ? `, members: ${(c.memberNames ?? []).join(', ') || 'unknown'}` : ''})`;
  const where = (c) => (c.bu ? `${c.bu}${c.sub ? ` > ${c.sub}` : ''} (${c.by})` : c.by === 'ignored' ? 'ignored' : c.by === 'excluded' ? 'left out (override null)' : 'unmapped');
  const fail = (msg, cands) => {
    say(msg);
    if (cands) for (const c of cands) say(`  candidate: ${show(c)}  now: ${where(c)}`);
    say('Nothing was changed.');
    return { code: 1, lines: out };
  };
  const pick = (name) => {
    if (!name) return { error: fail('Give a conversation name, ID or group DM member list.') };
    const r = resolveConv(name, channels, me);
    if (r.conv) return { conv: r.conv };
    return { error: fail(r.candidates.length ? `"${name}" fits more than one conversation, or none exactly:` : `No conversation in the cached listing matches "${name}".`, r.candidates) };
  };

  // Active ones first (newest first), then inactive: the same split the digest's footer uses.
  const unmapped = () => { const u = splitUnmapped(bus, channels, { now }); return [...u.active, ...u.inactive]; };
  const active = (c) => recentlyActive(c, 30, now);

  if (cmd === 'list-unmapped') {
    const un = unmapped();
    const act = un.filter(active).length;
    say(`Unmapped conversations (never read by the digest): ${un.length} (${act} active in the last 30 days, ${un.length - act} inactive); ignored: ${channels.filter((c) => c.by === 'ignored').length}.`);
    for (const c of un) say(`  ${active(c) ? 'active  ' : 'inactive'} ${c.type.padEnd(8)} last ${c.lastActivity ? c.lastActivity.slice(0, 10) : '-'.padEnd(10)}  ${show(c)}`);
    return { code: 0, lines: out };
  }

  if (cmd === 'ignore-all-unmapped') {
    const list = unmapped().filter((c) => !flags.has('--active-only') || active(c));
    const what = flags.has('--active-only') ? 'unmapped conversations active in the last 30 days' : 'unmapped conversations';
    if (!list.length) { say(`No ${what} to ignore. Nothing was changed.`); return { code: 0, lines: out }; }
    if (!flags.has('--yes')) {
      say(`Would ignore ${list.length} ${what}${list.length > 20 ? ' (first 20 shown)' : ''}:`);
      for (const c of list.slice(0, 20)) say(`  ${active(c) ? 'active  ' : 'inactive'} ${show(c)}`);
      say('Nothing was changed. Run again with --yes to ignore them.');
      return { code: 0, lines: out };
    }
    busRaw.ignore = { ...(busRaw.ignore ?? {}) };
    for (const c of list) busRaw.ignore[c.id] = c.label;
    writeJsonAtomic(paths.bus, busRaw);
    say(`Ignored ${list.length} ${what} in ${path.relative(ROOT, paths.bus)} (one write). Undo one with: remove <name>.`);
    for (const c of list.slice(0, 20)) say(`  ${show(c)}`);
    if (list.length > 20) say(`  and ${list.length - 20} more`);
    return { code: 0, lines: out };
  }

  if (cmd === 'map') {
    const { conv, error } = pick(rest[0]);
    if (error) return error;
    const target = rest[1];
    if (!target) return fail('Give a unit, optionally with a sub-group: <Unit>[/<Sub-group>].');
    const [bu, sub] = target.split('/').map((x) => x.trim());
    const known = new Set([...bus.rules, ...Object.values(bus.overrides).filter(Boolean), ...Object.values(bus.groupDms)]
      .flatMap((t) => [t.bu, t.sub ? `${t.bu}/${t.sub}` : null]).filter(Boolean));
    if (!flags.has('--new') && (!known.has(bu) || (sub && !known.has(`${bu}/${sub}`)))) {
      return fail(`"${target}" is not a unit or sub-group the rules use yet (add --new if it is meant to be new). Known: ${[...known].sort().join(', ')}`);
    }
    const t = { bu, ...(sub ? { sub } : {}) };
    if (conv.type === 'group_dm') {
      if (!Array.isArray(conv.memberNames) || !conv.memberNames.length) return fail(`${show(conv)} has no member list in the cache; run node scripts/slack-channels.js first.`);
      busRaw.groupDms = { ...(busRaw.groupDms ?? {}), [conv.id]: { ...t, label: conv.label.replace(/^DM: /, ''), members: [...conv.memberNames].sort() } };
    } else {
      busRaw.overrides = { ...(busRaw.overrides ?? {}), [conv.id]: t };
    }
    if (busRaw.ignore?.[conv.id] !== undefined) delete busRaw.ignore[conv.id];
    writeJsonAtomic(paths.bus, busRaw);
    say(`Mapped ${show(conv)}: ${where(conv)} -> ${bu}${sub ? ` > ${sub}` : ''} (${conv.type === 'group_dm' ? 'group DM entry, members recorded' : 'override'}) in ${path.relative(ROOT, paths.bus)}.`);
    return { code: 0, lines: out };
  }

  if (cmd === 'map-customer') {
    const { conv, error } = pick(rest[0]);
    if (error) return error;
    const wanted = rest.slice(1).join(' ').trim();
    if (!wanted) return fail('Give a customer key or name.');
    const custRaw = JSON.parse(fs.readFileSync(paths.customers, 'utf8'));
    const cfg = loadCustomerConfig(paths.customers);
    const inSource = cfg.customerSources.some((s) => (s.includes(' > ') ? `${conv.bu} > ${conv.sub ?? '-'}` === s : conv.bu === s));
    if (!inSource) return fail(`${show(conv)} is in ${where(conv)}, not in a customer unit (${cfg.customerSources.join(', ')}). Map it to one first.`);
    const reg = buildRegistry(channels.filter((c) => c.bu), cfg);
    const matches = reg.customers.filter((c) => !c.unmatched && (c.key === wanted.toLowerCase() || c.name.toLowerCase() === wanted.toLowerCase()));
    if (matches.length !== 1) {
      const near = reg.customers.filter((c) => !c.unmatched && (c.key.includes(wanted.toLowerCase().replace(/\s+/g, '')) || c.name.toLowerCase().includes(wanted.toLowerCase())));
      say(matches.length ? `"${wanted}" fits more than one customer:` : `No customer is called "${wanted}".`);
      for (const c of (matches.length ? matches : near).slice(0, 20)) say(`  candidate: ${c.name} (key ${c.key})`);
      say('Nothing was changed.');
      return { code: 1, lines: out };
    }
    const key = matches[0].key;
    custRaw.customers = custRaw.customers ?? {};
    const entry = custRaw.customers[key] ?? {};
    entry.channels = [...new Set([...(entry.channels ?? []), conv.id])];
    custRaw.customers[key] = entry;
    const changes = [`${show(conv)} -> customer ${matches[0].name} (key ${key})`];
    const isIt = (x) => x === conv.id || x === conv.name;
    if (custRaw.otherBucket?.channels?.some(isIt)) { custRaw.otherBucket.channels = custRaw.otherBucket.channels.filter((x) => !isIt(x)); changes.push(`removed from ${custRaw.otherBucket.name ?? 'the other bucket'}`); }
    if (custRaw.notCustomers?.some(isIt)) { custRaw.notCustomers = custRaw.notCustomers.filter((x) => !isIt(x)); changes.push('removed from notCustomers'); }
    for (const [k, v] of Object.entries(custRaw.customers)) {
      if (k !== key && v.channels?.some(isIt)) { v.channels = v.channels.filter((x) => !isIt(x)); changes.push(`removed from customer ${k}`); }
    }
    writeJsonAtomic(paths.customers, custRaw);
    say(`Changed ${path.relative(ROOT, paths.customers)}: ${changes.join('; ')}.`);
    return { code: 0, lines: out };
  }

  if (cmd === 'ignore') {
    const { conv, error } = pick(rest[0]);
    if (error) return error;
    if (conv.by === 'ignored') { say(`${show(conv)} is already ignored. Nothing was changed.`); return { code: 0, lines: out }; }
    if (conv.by !== null) return fail(`${show(conv)} is mapped (${where(conv)}); only unmapped conversations can be ignored. Use "remove" first if you mean it.`);
    busRaw.ignore = { ...(busRaw.ignore ?? {}), [conv.id]: conv.label };
    writeJsonAtomic(paths.bus, busRaw);
    say(`Ignored ${show(conv)} in ${path.relative(ROOT, paths.bus)}; it will no longer be listed as unmapped.`);
    return { code: 0, lines: out };
  }

  if (cmd === 'remove') {
    const { conv, error } = pick(rest[0]);
    if (error) return error;
    const changes = [];
    if (busRaw.overrides && Object.hasOwn(busRaw.overrides, conv.id)) { delete busRaw.overrides[conv.id]; changes.push('override'); }
    if (busRaw.groupDms && Object.hasOwn(busRaw.groupDms, conv.id)) { delete busRaw.groupDms[conv.id]; changes.push('group DM entry'); }
    if (busRaw.ignore && Object.hasOwn(busRaw.ignore, conv.id)) { delete busRaw.ignore[conv.id]; changes.push('ignore entry'); }
    if (changes.length) writeJsonAtomic(paths.bus, busRaw);
    const custRaw = JSON.parse(fs.readFileSync(paths.customers, 'utf8'));
    const isIt = (x) => x === conv.id || x === conv.name;
    let custChanged = false;
    for (const [k, v] of Object.entries(custRaw.customers ?? {})) {
      if (v.channels?.some(isIt)) { v.channels = v.channels.filter((x) => !isIt(x)); changes.push(`customer ${k} channel`); custChanged = true; }
    }
    if (custRaw.otherBucket?.channels?.some(isIt)) { custRaw.otherBucket.channels = custRaw.otherBucket.channels.filter((x) => !isIt(x)); changes.push('other-bucket entry'); custChanged = true; }
    if (custChanged) writeJsonAtomic(paths.customers, custRaw);
    say(changes.length ? `Removed for ${show(conv)}: ${changes.join(', ')}. A rule that matches its name still applies.` : `Nothing to remove for ${show(conv)}.`);
    return { code: 0, lines: out };
  }

  say('Usage: node scripts/digest-map.js list-unmapped | map <name> <Unit>[/<Sub-group>] [--new] | map-customer <name> <customer> | ignore <name> | ignore-all-unmapped [--active-only] [--yes] | remove <name>');
  return { code: 2, lines: out };
}

if (require.main === module) {
  try {
    const r = run(process.argv.slice(2));
    for (const l of r.lines) console.log(l);
    process.exit(r.code);
  } catch (e) {
    console.error(`digest-map: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { run, resolveConv };
