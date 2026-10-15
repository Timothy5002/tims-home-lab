'use strict';
// Shared code for the Slack measurement scripts (slack-channels.js, slack-measure.js).
// It reads the Slack token, talks to Slack's read-only Web API methods with rate limiting, and maps
// channels to business units using config/slack-bus.json. It never writes to Slack and never logs
// the token or message text. See docs/slack-measurement.md.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CHANNELS_FILE = path.join(DATA_DIR, 'slack-channels.json');
const CONFIG_FILE = path.join(ROOT, 'config', 'slack-bus.json');
const EXAMPLE_CONFIG_FILE = path.join(ROOT, 'config', 'slack-bus.example.json');

// Same check as src/schedule-run.js: the file must be a regular file nobody else can read.
function readSecret(name) {
  const file = path.join(os.homedir(), '.lab', name);
  const st = fs.statSync(file);
  if (!st.isFile() || (st.mode & 0o077) !== 0) throw new Error(`${file} must be a regular file with mode 600`);
  const v = fs.readFileSync(file, 'utf8').trim();
  if (!v) throw new Error(`${file} is empty`);
  return v;
}

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

// Business-unit rules. Shape (see config/slack-bus.example.json):
//   rules:     [{ bu, prefix } | { bu, regex }]  first match wins; public and private channels only
//   overrides: { "<channel id>": "<bu>" | null } beats the rules; null means "leave this channel out"
//   groupDms:  { "<group DM id>": "<bu>" }        group DMs are only included if listed here
// Keys starting with "_" are comments.
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(`${path.relative(ROOT, CONFIG_FILE)} not found; copy ${path.relative(ROOT, EXAMPLE_CONFIG_FILE)} to it and edit it`);
  }
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { throw new Error(`config/slack-bus.json is not valid JSON: ${e.message}`); }
  const bad = (msg) => { throw new Error(`config/slack-bus.json: ${msg}`); };
  const rules = cfg.rules ?? [];
  const overrides = cfg.overrides ?? {};
  const groupDms = cfg.groupDms ?? {};
  if (!Array.isArray(rules)) bad('"rules" must be a list');
  const compiled = rules.map((r, i) => {
    if (!r || typeof r.bu !== 'string' || !r.bu) bad(`rule ${i + 1} needs a "bu" name`);
    if (typeof r.prefix === 'string' && r.prefix) return { bu: r.bu, test: (n) => n.toLowerCase().startsWith(r.prefix.toLowerCase()) };
    if (typeof r.regex === 'string' && r.regex) {
      let re;
      try { re = new RegExp(r.regex, 'i'); } catch (e) { bad(`rule ${i + 1} regex: ${e.message}`); }
      return { bu: r.bu, test: (n) => re.test(n) };
    }
    return bad(`rule ${i + 1} needs a "prefix" or a "regex"`);
  });
  for (const [k, v] of Object.entries(overrides)) {
    if (!k.startsWith('_') && v !== null && (typeof v !== 'string' || !v)) bad(`override ${k} must be a bu name or null`);
  }
  for (const [k, v] of Object.entries(groupDms)) {
    if (!k.startsWith('_') && (typeof v !== 'string' || !v)) bad(`group DM ${k} must map to a bu name`);
  }
  return { rules: compiled, overrides, groupDms };
}

// Returns { bu, by } where by is how it was placed: override, rule, group-dm, excluded, or null if unplaced.
function placeChannel(cfg, ch) {
  if (Object.hasOwn(cfg.overrides, ch.id)) {
    const bu = cfg.overrides[ch.id];
    return bu === null ? { bu: null, by: 'excluded' } : { bu, by: 'override' };
  }
  if (ch.type === 'group_dm') {
    return Object.hasOwn(cfg.groupDms, ch.id) ? { bu: cfg.groupDms[ch.id], by: 'group-dm' } : { bu: null, by: null };
  }
  const rule = cfg.rules.find((r) => r.test(ch.name));
  return rule ? { bu: rule.bu, by: 'rule' } : { bu: null, by: null };
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
  ROOT, DATA_DIR, CHANNELS_FILE, CONFIG_FILE,
  createClient, SlackError, loadConfig, placeChannel, writePrivateJson, localDay, fmtInt, printTable, sleep,
};
