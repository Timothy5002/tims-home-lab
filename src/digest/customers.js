'use strict';
// Customer registry for the Slack digest, derived in code from channel names, so that one customer's success,
// coordination and external channels merge into one record, and mentions of the customer elsewhere can be found.
//
// Settings come from config/digest-customers.json (git-ignored; template config/digest-customers.example.json),
// because the prefixes, suffixes and aliases name real companies:
//   customerSources  ["Unit > Sub-group", ...]  conversations that belong to customers
//   anchorSources    ["Unit > Sub-group", ...]  where each conversation defines a customer (the success channels)
//   mentionSources   [{ unit: "Unit" | "Unit > Sub-group", leadership?: true }]  scanned for customer mentions
//   stripPrefixes, stripSuffixes  removed from a channel name (longest first, repeatedly) before the key is made
//   dropWords        words removed from the name (company and filler words such as "coordination")
//   minContainLength a key joins another when one contains the other and the shorter is at least this long
//   minAliasLength   automatic aliases shorter than this are not used for mentions (set them by hand instead)
//   customers        { key: { name?, aliases?: [...], channels?: [name or ID], keys?: [other derived keys] } }
//   notCustomers     [name or ID]  customer-source conversations that are general, not one customer's
//   noMention        [alias]  automatic aliases never used for mention matching
//
// Key: lower case, prefixes and suffixes stripped, split on "-", "_", "." and spaces, drop words removed, joined.
// Matching is code only; mention matching is whole-word and case-insensitive, with "-", "_" or a space (or
// nothing) allowed between an alias's words. It reads message text in memory and keeps nothing.
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../slack');

const CONFIG = path.join(ROOT, 'config', 'digest-customers.json');

function loadCustomerConfig(file = CONFIG) {
  if (!fs.existsSync(file)) throw new Error('config/digest-customers.json not found; copy config/digest-customers.example.json and edit it');
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = (k) => (Array.isArray(c[k]) ? c[k].map(String) : []);
  return {
    customerSources: list('customerSources'),
    anchorSources: list('anchorSources'),
    mentionSources: (Array.isArray(c.mentionSources) ? c.mentionSources : []).map((m) => ({ unit: String(m.unit), leadership: m.leadership === true })),
    stripPrefixes: list('stripPrefixes').map((s) => s.toLowerCase()).sort((a, b) => b.length - a.length),
    stripSuffixes: list('stripSuffixes').map((s) => s.toLowerCase()).sort((a, b) => b.length - a.length),
    dropWords: new Set(list('dropWords').map((s) => s.toLowerCase())),
    minContainLength: Number.isInteger(c.minContainLength) ? c.minContainLength : 5,
    minAliasLength: Number.isInteger(c.minAliasLength) ? c.minAliasLength : 4,
    customers: c.customers && typeof c.customers === 'object' ? c.customers : {},
    notCustomers: new Set(list('notCustomers')),
    noMention: new Set(list('noMention').map((s) => s.toLowerCase())),
  };
}

// "Unit > Sub-group" matches that sub-group; "Unit" matches the whole unit.
const inUnit = (conv, spec) => (spec.includes(' > ') ? `${conv.bu} > ${conv.sub ?? '-'}` === spec : conv.bu === spec);

function strip(name, cfg) {
  let n = String(name).toLowerCase();
  for (let changed = true; changed;) {
    changed = false;
    for (const p of cfg.stripPrefixes) if (n.startsWith(p) && n.length > p.length) { n = n.slice(p.length); changed = true; break; }
    for (const s of cfg.stripSuffixes) if (n.endsWith(s) && n.length > s.length) { n = n.slice(0, -s.length); changed = true; break; }
  }
  return n;
}
const words = (name, cfg) => strip(name, cfg).split(/[-_.\s]+/).filter((w) => w && !cfg.dropWords.has(w));
const deriveKey = (name, cfg) => words(name, cfg).join('');
const titleCase = (ws) => ws.map((w) => (w.length <= 3 && /\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1))).join(' ');

// Whole-word, case-insensitive regex for an alias; its words may be joined by "-", "_", a space or nothing.
function aliasRegex(alias) {
  const parts = alias.toLowerCase().split(/[-_\s]+/).filter(Boolean).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(?<![\\p{L}\\p{N}])${parts.join('[-_\\s]?')}(?![\\p{L}\\p{N}])`, 'iu');
}

// convs: conversations with { id, name, type, bu, sub }. Returns the registry (names and IDs only, no text):
// { customers: [{ key, name, aliases, convIds, anchors, unmatched? }], byConv: Map(convId -> key),
//   unmatched: [conv], general: [conv], mentionConvs: Map(convId -> 'leadership' | 'internal'), regexes }
function buildRegistry(convs, cfg) {
  const isCustomerConv = (c) => cfg.customerSources.some((s) => inUnit(c, s));
  const isAnchor = (c) => cfg.anchorSources.some((s) => inUnit(c, s));
  const listed = (c, set) => set.has(c.id) || set.has(c.name);
  const customers = new Map();
  const ensure = (key, name) => {
    if (!customers.has(key)) customers.set(key, { key, name, autoAliases: new Set(), aliases: new Set(), convIds: [], keys: new Set([key]) });
    return customers.get(key);
  };
  // Configured customers first (names, extra keys, aliases).
  for (const [key, v] of Object.entries(cfg.customers)) {
    const c = ensure(key, v.name ?? null); // no name: the anchor channel's words name it, or else the key
    for (const k of v.keys ?? []) c.keys.add(String(k).toLowerCase());
    for (const a of v.aliases ?? []) c.aliases.add(String(a));
  }
  // Anchors: each success channel defines a customer.
  const byConv = new Map();
  const assign = (conv, cust) => { byConv.set(conv.id, cust.key); cust.convIds.push(conv.id); };
  const pending = [];
  for (const conv of convs.filter(isCustomerConv)) {
    if (listed(conv, cfg.notCustomers)) continue;
    const explicit = Object.entries(cfg.customers).find(([, v]) => (v.channels ?? []).some((x) => x === conv.id || x === conv.name));
    if (explicit) { assign(conv, ensure(explicit[0], cfg.customers[explicit[0]].name ?? explicit[0])); continue; }
    if (isAnchor(conv) && conv.type !== 'group_dm') {
      const ws = words(conv.name, cfg);
      const key = ws.join('');
      const owner = [...customers.values()].find((c) => c.keys.has(key));
      const cust = owner ?? ensure(key, titleCase(ws));
      cust.name ??= titleCase(ws);
      cust.keys.add(key);
      if (key.length >= cfg.minAliasLength) cust.autoAliases.add(ws.join(' '));
      assign(conv, cust);
    } else pending.push(conv);
  }
  // Other customer conversations join by key: equal, or one contains the other (shorter at least minContainLength).
  // More than one candidate is ambiguous and left unmatched for review.
  const unmatched = [];
  for (const conv of pending) {
    const key = conv.type === 'group_dm' ? '' : deriveKey(conv.name, cfg);
    let cands = key ? [...customers.values()].filter((c) => c.keys.has(key)) : [];
    if (!cands.length && key.length >= cfg.minContainLength) {
      cands = [...customers.values()].filter((c) => [...c.keys].some((k) => Math.min(k.length, key.length) >= cfg.minContainLength && (k.includes(key) || key.includes(k))));
    }
    if (cands.length === 1) assign(conv, cands[0]);
    else unmatched.push({ conv, key, candidates: cands.map((c) => c.key) });
  }
  // Unmatched conversations still get analyzed: those sharing a derived key form one record, the rest (group DMs,
  // empty or ambiguous keys) one record each. All are flagged for review.
  for (const u of unmatched) {
    const grouped = u.key && !u.candidates.length;
    const id = grouped ? `unmatched:${u.key}` : `unmatched:${u.conv.id}`;
    const name = grouped ? titleCase(words(u.conv.name, cfg)) : (u.conv.type === 'group_dm' ? (u.conv.label ?? u.conv.name) : `#${u.conv.name}`);
    const cust = ensure(id, name);
    cust.unmatched = true;
    assign(u.conv, cust);
  }
  // Aliases for mentions: configured ones, plus the automatic ones (the success channel's words), minus noMention.
  const list = [...customers.values()].filter((c) => c.convIds.length || c.aliases.size).map((c) => {
    const aliases = [...new Set([...c.aliases, ...[...c.autoAliases].filter((a) => !cfg.noMention.has(a.toLowerCase()))])];
    return { key: c.key, name: c.name ?? c.key, aliases, convIds: c.convIds, unmatched: Boolean(c.unmatched) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const mentionConvs = new Map();
  for (const conv of convs) {
    const src = cfg.mentionSources.find((s) => inUnit(conv, s.unit));
    if (src && !byConv.has(conv.id)) mentionConvs.set(conv.id, src.leadership ? 'leadership' : 'internal');
  }
  const general = convs.filter((c) => isCustomerConv(c) && listed(c, cfg.notCustomers));
  const regexes = list.filter((c) => !c.unmatched).map((c) => ({ key: c.key, res: c.aliases.map(aliasRegex) }));
  return { customers: list, byConv, unmatched, general, mentionConvs, regexes };
}

// Keys of the customers a message text mentions (whole-word aliases). Text is only tested, never kept.
function mentionedCustomers(text, registry) {
  return registry.regexes.filter((r) => r.res.some((re) => re.test(text))).map((r) => r.key);
}

module.exports = { loadCustomerConfig, buildRegistry, mentionedCustomers, deriveKey, aliasRegex, inUnit, CONFIG };
