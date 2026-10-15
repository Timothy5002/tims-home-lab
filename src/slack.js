'use strict';
// Shared Slack code for the measurement scripts and the daily digest (src/digest/).
// It reads the Slack token, talks to Slack's read-only Web API methods with rate limiting, maps
// conversations to business units using config/slack-bus.json, and decides which conversations are
// external (masked before any model call). It never writes to Slack and never logs the token or
// message text. See docs/slack-measurement.md and docs/slack-digest-design.md.
const fs = require('node:fs');
const path = require('node:path');
const { readSecret } = require('./secrets');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CHANNELS_FILE = path.join(DATA_DIR, 'slack-channels.json');
const CONFIG_FILE = path.join(ROOT, 'config', 'slack-bus.json');
const EXAMPLE_CONFIG_FILE = path.join(ROOT, 'config', 'slack-bus.example.json');

// Housekeeping events nobody would read in a digest; skipped when measuring and when fetching.
const SKIP_SUBTYPES = new Set([
  'channel_join', 'channel_leave', 'channel_topic', 'channel_purpose', 'channel_name', 'channel_archive',
  'channel_unarchive', 'channel_convert_to_private', 'channel_convert_to_public', 'group_join', 'group_leave',
  'group_topic', 'group_purpose', 'group_name', 'group_archive', 'group_unarchive', 'pinned_item', 'unpinned_item',
  'bot_add', 'bot_remove', 'tombstone', 'joiner_notification', 'reminder_add',
]);

// Text a reader (or a model) would see: the message text plus legacy attachment text, where many bots post.
function messageText(m) {
  const parts = [m.text ?? ''];
  for (const a of m.attachments ?? []) parts.push(a.pretext, a.title, a.text);
  return parts.filter(Boolean).join('\n');
}

const isBot = (m) => Boolean(m.bot_id) || m.subtype === 'bot_message';

// The only Slack methods these scripts may call, all read-only, with the gap kept between calls.
// Slack's published limits: Tier 2 is about 20/min, Tier 3 about 50/min, Tier 4 about 100/min.
// The gaps stay a little under those; a 429 still waits for Retry-After.
const METHODS = {
  'conversations.list': 3500,    // Tier 2
  'users.list': 3500,            // Tier 2
  'conversations.history': 1300, // Tier 3
  'conversations.replies': 1300, // Tier 3
  'conversations.members': 700,  // Tier 4
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class SlackError extends Error {
  constructor(method, code) {
    super(`${method}: ${code}`);
    this.code = code;
  }
}

function createClient() {
  const token = readSecret('slack-token');
  const lastCall = {};
  const stats = { calls: 0, rateLimited: 0, waitedMs: 0 };

  async function call(method, params = {}) {
    if (!(method in METHODS)) throw new Error(`refusing to call ${method}: not a listed read-only method`);
    const url = `https://slack.com/api/${method}?${new URLSearchParams(params)}`;
    for (let attempt = 1; ; attempt++) {
      const gap = (lastCall[method] ?? 0) + METHODS[method] - Date.now();
      if (gap > 0) await sleep(gap);
      lastCall[method] = Date.now();
      stats.calls++;
      let res;
      try {
        // The token goes only in this header; errors below never include headers.
        res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
      } catch (e) {
        if (attempt >= 4) throw new Error(`${method}: network error: ${e.message}`);
        await sleep(2000 * attempt);
        continue;
      }
      if (res.status === 429) {
        const wait = (Number(res.headers.get('retry-after')) || 30) * 1000 + 500;
        stats.rateLimited++;
        stats.waitedMs += wait;
        if (attempt >= 10) throw new Error(`${method}: still rate limited after ${attempt} tries`);
        process.stderr.write(`  rate limited on ${method}; waiting ${Math.round(wait / 1000)}s\n`);
        await sleep(wait);
        continue;
      }
      if (res.status >= 500) {
        if (attempt >= 4) throw new Error(`${method}: HTTP ${res.status}`);
        await sleep(2000 * attempt);
        continue;
      }
      const body = await res.json();
      if (!body.ok) throw new SlackError(method, body.error || `HTTP ${res.status}`);
      return body;
    }
  }

  // Calls a cursor-paginated method until the last page. Without onPage it collects and returns the
  // array named `key`; with onPage it hands each page over and keeps nothing (used for message pages,
  // so message text is never held longer than one page).
  async function paginate(method, params, key, onPage) {
    const out = [];
    let cursor;
    do {
      const body = await call(method, { ...params, ...(cursor ? { cursor } : {}) });
      const items = body[key] ?? [];
      if (onPage) onPage(items);
      else out.push(...items);
      cursor = body.response_metadata?.next_cursor;
    } while (cursor);
    return out;
  }

  return { call, paginate, stats };
}

// Business-unit rules. Shape (see config/slack-bus.example.json and docs/slack-measurement.md):
//   rules:     [{ bu, sub?, name | prefix | glob | regex }]  public and private channels only; first match wins.
//              name is an exact name or a list of them; glob uses * for "anything" and must match the whole name.
//   overrides: { "<channel id>": { bu, sub? } | null }  beats the rules; null means "leave this channel out"
//   groupDms:  { "<group DM id>": { bu, sub?, label?, members? } }  group DMs are only included if listed here;
//              members (full names, you included) is the set the ID was matched on, and is re-checked on every run.
//   pendingGroupDms: [{ label, bu, sub?, candidates: [ids], note? }]  not matched; listed in the report until decided.
//   external:  { units: [bu, ...], internalPrefixes: [prefix, ...] }  which conversations count as external
//              (fully masked before any model call): a conversation in one of these units whose name does not
//              start with an internal prefix. Nothing else is external. Slack's is_ext_shared flag is recorded
//              by the listing but deliberately not used: the user decided shared conversations outside these
//              rules are internal (most are shared between the company's own workspaces).
// Matching is case-insensitive. Keys starting with "_" are comments.
const globToRegex = (g) => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(`${path.relative(ROOT, CONFIG_FILE)} not found; copy ${path.relative(ROOT, EXAMPLE_CONFIG_FILE)} to it and edit it`);
  }
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { throw new Error(`config/slack-bus.json is not valid JSON: ${e.message}`); }
  const bad = (msg) => { throw new Error(`config/slack-bus.json: ${msg}`); };
  const target = (v, where) => {
    if (!v || typeof v !== 'object' || typeof v.bu !== 'string' || !v.bu) bad(`${where} needs a "bu" name`);
    if (v.sub !== undefined && (typeof v.sub !== 'string' || !v.sub)) bad(`${where}: "sub" must be a non-empty name`);
    return { bu: v.bu, sub: v.sub ?? null };
  };
  const rules = cfg.rules ?? [];
  if (!Array.isArray(rules)) bad('"rules" must be a list');
  const compiled = [];
  rules.forEach((r, i) => {
    const where = `rule ${i + 1}`;
    const t = target(r, where);
    const kinds = ['name', 'prefix', 'glob', 'regex'].filter((k) => r[k] !== undefined);
    if (kinds.length !== 1) bad(`${where} needs exactly one of "name", "prefix", "glob", "regex"`);
    const kind = kinds[0];
    // A list of names becomes one rule per name, so reports say which name matched.
    const values = kind === 'name' && Array.isArray(r.name) ? r.name : [r[kind]];
    for (const v of values) {
      if (typeof v !== 'string' || !v) bad(`${where}: "${kind}" must be a non-empty string`);
      let re;
      if (kind === 'name') re = new RegExp(`^${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
      else if (kind === 'prefix') re = globToRegex(`${v.replace(/\*/g, '')}*`);
      else if (kind === 'glob') re = globToRegex(v);
      else { try { re = new RegExp(v, 'i'); } catch (e) { bad(`${where} regex: ${e.message}`); } }
      compiled.push({ ...t, label: `rule ${i + 1} (${kind} ${v})`, test: (n) => re.test(n) });
    }
  });
  const overrides = {};
  for (const [id, v] of Object.entries(cfg.overrides ?? {})) {
    if (!id.startsWith('_')) overrides[id] = v === null ? null : target(v, `override ${id}`);
  }
  const groupDms = {};
  for (const [id, v] of Object.entries(cfg.groupDms ?? {})) {
    if (id.startsWith('_')) continue;
    if (v.members !== undefined && (!Array.isArray(v.members) || !v.members.every((m) => typeof m === 'string'))) bad(`group DM ${id}: "members" must be a list of names`);
    groupDms[id] = { ...target(v, `group DM ${id}`), label: v.label ?? null, members: v.members ?? null };
  }
  // Group DMs waiting for a decision: not matched, only shown in the report with their candidates.
  const pendingGroupDms = cfg.pendingGroupDms ?? [];
  if (!Array.isArray(pendingGroupDms) || !pendingGroupDms.every((p) => p && typeof p.label === 'string' && Array.isArray(p.candidates))) {
    bad('"pendingGroupDms" must be a list of { label, bu, sub?, candidates: [ids], note? }');
  }
  const ext = cfg.external ?? {};
  const strList = (v, what) => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x)) bad(`"external.${what}" must be a list of names`);
    return v;
  };
  const external = { units: strList(ext.units, 'units'), internalPrefixes: strList(ext.internalPrefixes, 'internalPrefixes') };
  return { rules: compiled, overrides, groupDms, pendingGroupDms, external };
}

// "BU > sub-group", or just "BU".
const groupName = (t) => (t.sub ? `${t.bu} > ${t.sub}` : t.bu);
const sameSet = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

// Why a conversation is external (empty list = internal). Derived from the config, never stored by hand: it is
// in an external unit and its name lacks an internal prefix (the unit's group DMs included).
function externalReasons(cfg, ch, bu) {
  const why = [];
  if (bu && cfg.external.units.includes(bu) && !cfg.external.internalPrefixes.some((p) => ch.name.toLowerCase().startsWith(p.toLowerCase()))) {
    why.push('unit rule');
  }
  return why;
}

// Returns { bu, sub, group, by, matches, memberDrift, external, externalWhy }. by is how it was placed: override, rule, group-dm,
// excluded, or null if unplaced. matches lists every rule that matched a channel (more than one is an overlap).
// memberDrift is true when a listed group DM's current members differ from the members recorded in the config.
function placeChannelBase(cfg, ch) {
  const none = { bu: null, sub: null, group: null, by: null, matches: [] };
  const matches = ch.type === 'group_dm' ? [] : cfg.rules.filter((r) => r.test(ch.name)).map((r) => ({ label: r.label, group: groupName(r) }));
  if (Object.hasOwn(cfg.overrides, ch.id)) {
    const t = cfg.overrides[ch.id];
    return t === null ? { ...none, by: 'excluded', matches } : { ...t, group: groupName(t), by: 'override', matches };
  }
  if (ch.type === 'group_dm') {
    const t = cfg.groupDms[ch.id];
    if (!t) return none;
    const memberDrift = Boolean(t.members && ch.memberNames && !sameSet(t.members, ch.memberNames));
    return { bu: t.bu, sub: t.sub, group: groupName(t), by: 'group-dm', matches, memberDrift };
  }
  if (!matches.length) return none;
  const first = cfg.rules.find((r) => r.test(ch.name));
  return { bu: first.bu, sub: first.sub, group: groupName(first), by: 'rule', matches };
}

function placeChannel(cfg, ch) {
  const p = placeChannelBase(cfg, ch);
  const externalWhy = externalReasons(cfg, ch, p.bu);
  return { ...p, external: externalWhy.length > 0, externalWhy };
}

// Link to a message, built in code (never by a model). Thread replies need the parent and channel too.
function permalink(workspaceUrl, channel, ts, threadTs) {
  const base = `${workspaceUrl.replace(/\/+$/, '')}/archives/${channel}/p${String(ts).replace('.', '')}`;
  return threadTs && threadTs !== ts ? `${base}?thread_ts=${threadTs}&cid=${channel}` : base;
}

// Writes JSON readable only by this user (the files hold channel names and member names).
function writePrivateJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Local calendar date (YYYY-MM-DD) for a Slack timestamp or Date.
function localDay(t) {
  const d = t instanceof Date ? t : new Date(Number(t) * 1000);
  return d.toLocaleDateString('en-CA');
}

function fmtInt(n) { return Math.round(n).toLocaleString('en-US'); }

// Prints rows as a plain aligned table; numbers are right-aligned.
function printTable(header, rows) {
  const all = [header, ...rows].map((r) => r.map(String));
  const widths = header.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  const numeric = header.map((_, i) => rows.length > 0 && rows.every((r) => typeof r[i] === 'number' || /^[\d,.$%-]+$/.test(String(r[i]))));
  for (const r of all) {
    console.log('  ' + r.map((c, i) => (numeric[i] ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ').trimEnd());
  }
}

module.exports = {
  ROOT, DATA_DIR, CHANNELS_FILE, CONFIG_FILE, SKIP_SUBTYPES, messageText, isBot, permalink, readSecret,
  createClient, SlackError, loadConfig, placeChannel, groupName, writePrivateJson, localDay, fmtInt, printTable, sleep,
};
