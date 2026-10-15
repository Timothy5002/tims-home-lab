'use strict';
// Runs the daily Slack digest. Phase 1 (this version): fetch every conversation mapped to a business unit for the
// window, compress bot posts in code, and render a code-only digest to data/digests/<date>.md (mode 600). It makes
// NO model calls; it only measures what would be sent (estimated tokens, and masking counts for external
// conversations) so phase 2 can be judged against real numbers. See docs/slack-digest.md.
//
// Window: since the last recorded successful run, capped at maxWindowHours; with no record, the last
// defaultWindowHours. Hand runs do not move the record unless --record is given.
//
// Retention: message text lives in memory only. The digest file is the only thing written that contains text;
// stdout, the run row in data/dispatcher.db and data/digest-state.json hold counts and timestamps only.
//
// Usage: node src/digest/run.js [--hours N] [--record] [--scheduled]
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { ROOT, DATA_DIR, CHANNELS_FILE, createClient, loadConfig, placeChannel, localDay } = require('../slack');
const { fetchConversation } = require('./fetch');
const { compressBots } = require('./compress');
const { renderDigest, convLabel } = require('./render');
const { maskText, newCounts, MASK_TYPES } = require('../mask');

const DIGEST_CONFIG = path.join(ROOT, 'config', 'slack-digest.json');
const STATE_FILE = path.join(DATA_DIR, 'digest-state.json');
const DIGEST_DIR = path.join(DATA_DIR, 'digests');

function loadDigestConfig() {
  if (!fs.existsSync(DIGEST_CONFIG)) throw new Error('config/slack-digest.json not found; copy config/slack-digest.example.json and edit it');
  const c = JSON.parse(fs.readFileSync(DIGEST_CONFIG, 'utf8'));
  if (!/^https:\/\/[a-z0-9-]+\.slack\.com\/?$/.test(c.workspaceUrl ?? '')) throw new Error('config/slack-digest.json: workspaceUrl must look like https://<workspace>.slack.com');
  const num = (k, d) => (Number.isFinite(c[k]) && c[k] > 0 ? c[k] : d);
  return {
    workspaceUrl: c.workspaceUrl.replace(/\/$/, ''),
    threadLookbackDays: num('threadLookbackDays', 14),
    maxWindowHours: num('maxWindowHours', 72),
    defaultWindowHours: num('defaultWindowHours', 24),
    maxInputTokens: num('maxInputTokens', 122_000),
    runDeadlineMinutes: num('runDeadlineMinutes', 25),
    unitOrder: Array.isArray(c.unitOrder) ? c.unitOrder : [],
    customerGroup: c.customerGroup ?? null, // { bu, sub }: shown first, quiet ones named
    myName: c.myName ?? null,               // left out of group DM labels
  };
}

function writePrivateText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

(async () => {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const { values: opts } = parseArgs({ options: {
    hours: { type: 'string' },
    record: { type: 'boolean', default: false },
    scheduled: { type: 'boolean', default: false },
  } });
  const source = opts.scheduled ? 'launchd-direct' : 'manual';
  const record = opts.record || opts.scheduled;
  const { logRun } = require('../db');
  const summary = { phase: 1, modelCalls: 0 };
  const finish = (status, exitCode) => {
    summary.runtimeS = Math.round((Date.now() - started) / 1000);
    logRun({ job: 'slack-digest', source, startedAt, durationMs: Date.now() - started, exitCode, status, output: JSON.stringify(summary) });
  };

  const cfg = loadDigestConfig();
  const deadline = setTimeout(() => {
    summary.error = `deadline of ${cfg.runDeadlineMinutes} min reached`;
    finish('deadline', 1);
    console.error(`slack-digest: ${summary.error}; no digest written`);
    process.exit(1);
  }, cfg.runDeadlineMinutes * 60_000);

  try {
    const bus = loadConfig();
    if (!fs.existsSync(CHANNELS_FILE)) throw new Error('data/slack-channels.json not found; run node scripts/slack-channels.js first');
    const saved = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
    const targets = saved.channels.map((c) => ({ ...c, ...placeChannel(bus, c) })).filter((c) => c.bu);

    // Window
    const now = Math.floor(Date.now() / 1000);
    let windowStart;
    let reason;
    const state = readState();
    if (opts.hours) {
      const h = Number(opts.hours);
      if (!(h > 0 && h <= cfg.maxWindowHours)) throw new Error(`--hours must be between 0 and ${cfg.maxWindowHours}`);
      windowStart = now - h * 3600;
      reason = `--hours ${h}`;
    } else if (state?.lastSuccessAt) {
      const last = Math.floor(Date.parse(state.lastSuccessAt) / 1000);
      windowStart = Math.max(last, now - cfg.maxWindowHours * 3600);
      reason = windowStart === last ? 'since the last successful run' : `last run was over ${cfg.maxWindowHours} h ago; capped`;
    } else {
      windowStart = now - cfg.defaultWindowHours * 3600;
      reason = `no recorded run; last ${cfg.defaultWindowHours} h`;
    }
    const window = { start: windowStart, end: now, hours: (now - windowStart) / 3600, reason };
    const lookbackStart = windowStart - cfg.threadLookbackDays * 86_400;
    Object.assign(summary, { windowHours: Number(window.hours.toFixed(2)), conversations: targets.length });

    const slack = createClient();
    process.stderr.write('Loading user names...\n');
    const users = await slack.paginate('users.list', { limit: '200' }, 'members');
    const names = new Map(users.map((u) => [u.id, u.profile?.display_name || u.real_name || u.name]));
    const ctx = { workspaceUrl: cfg.workspaceUrl, me: cfg.myName, nameOf: (id) => (id ? names.get(id) ?? id : 'someone') };

    // Fetch and compress, one conversation at a time (the Slack client spaces calls per method).
    const blocks = [];
    const maskCounts = newCounts();
    const totals = { messages: 0, botMessages: 0, charsIn: 0, charsOut: 0, wouldSendChars: 0, errors: 0, activeConversations: 0, externalConversations: 0 };
    for (const [i, conv] of targets.entries()) {
      process.stderr.write(`  [${i + 1}/${targets.length}] ${convLabel(conv, cfg.myName)}\n`);
      const r = await fetchConversation(slack, conv, { windowStart, windowEnd: now + 1, lookbackStart });
      if (r.error) { totals.errors++; blocks.push({ conv, error: r.error }); continue; }
      const compressed = compressBots(r.messages);
      totals.messages += compressed.stats.messagesIn;
      totals.botMessages += compressed.stats.botMessagesIn;
      totals.charsIn += compressed.stats.charsIn;
      totals.charsOut += compressed.stats.charsOut;
      if (compressed.stats.messagesIn) totals.activeConversations++;
      // What phase 2 would send: people's messages and the kept bot lines, masked if the conversation is external.
      // Measured here and thrown away; nothing is sent (phase 1 makes no model calls).
      const wouldSend = [...compressed.humans, ...compressed.botGroups.flatMap((g) => [...g.examples, ...g.alerts])];
      for (const m of wouldSend) totals.wouldSendChars += (conv.external ? maskText(m.text, maskCounts) : m.text).length;
      if (conv.external && compressed.stats.messagesIn) totals.externalConversations++;
      blocks.push({ conv, compressed, parents: r.parents, error: null });
    }

    // Arrange by unit and sub-group: configured unit order, customers first inside their unit.
    const cg = cfg.customerGroup;
    const unitNames = [...new Set(targets.map((c) => c.bu))]
      .sort((a, b) => ((cfg.unitOrder.indexOf(a) + 1 || 999) - (cfg.unitOrder.indexOf(b) + 1 || 999)) || a.localeCompare(b));
    const units = unitNames.map((bu) => {
      const subNames = [...new Set(targets.filter((c) => c.bu === bu).map((c) => c.sub))]
        .sort((a, b) => (cg && bu === cg.bu ? (b === cg.sub) - (a === cg.sub) : 0) || (a === null) - (b === null) || String(a).localeCompare(String(b)));
      return {
        bu,
        subs: subNames.map((sub) => {
          const mine = blocks.filter((b) => b.conv.bu === bu && b.conv.sub === sub);
          const active = mine.filter((b) => !b.error && b.compressed.stats.messagesIn > 0)
            .sort((a, b) => b.compressed.stats.messagesIn - a.compressed.stats.messagesIn);
          return {
            sub,
            blocks: active,
            quiet: mine.filter((b) => !b.error && b.compressed.stats.messagesIn === 0).map((b) => b.conv),
            errors: mine.filter((b) => b.error).map((b) => ({ conv: b.conv, error: b.error })),
          };
        }),
      };
    });

    const wouldSendTokens = Math.ceil(totals.wouldSendChars / 4); // same characters / 4 estimate as the measurement
    const s = slack.stats;
    Object.assign(summary, totals, {
      wouldSendTokens, underCap: wouldSendTokens <= cfg.maxInputTokens, masked: maskCounts,
      compressionRatio: totals.charsIn ? Number((totals.charsOut / totals.charsIn).toFixed(3)) : null,
      apiCalls: s.calls, rateLimitWaits: s.rateLimited,
    });
    const footer = [
      `- Window: ${window.hours.toFixed(1)} h (${reason}); thread lookback ${cfg.threadLookbackDays} days.`,
      `- Conversations: ${targets.length} mapped, ${totals.activeConversations} active (${totals.externalConversations} of them external), ${totals.errors} unreadable.`,
      `- Messages: ${totals.messages} (${totals.botMessages} from bots). Characters ${totals.charsIn.toLocaleString('en-US')} → ${totals.charsOut.toLocaleString('en-US')} after bot compression (${summary.compressionRatio === null ? '-' : Math.round(summary.compressionRatio * 100)}%).`,
      `- Would send to a model (phase 2): about ${wouldSendTokens.toLocaleString('en-US')} tokens before prompts; cap ${cfg.maxInputTokens.toLocaleString('en-US')}${summary.underCap ? '' : ' (OVER CAP: the run would abort)'}.`,
      `- Masking dry run on external conversations: ${MASK_TYPES.map((t) => `${t} ${maskCounts[t]}`).join(', ')}. Nothing was sent.`,
      `- Slack API calls: ${s.calls}, rate-limit waits: ${s.rateLimited}. Model calls: 0. Runtime: ${Math.round((Date.now() - started) / 1000)} s.`,
    ];
    const text = renderDigest({ units, window, footer, ctx, customerKey: cg });
    const file = path.join(DIGEST_DIR, `${localDay(new Date(now * 1000))}.md`);
    writePrivateText(file, text);
    summary.digestFile = path.relative(ROOT, file);

    if (record) writePrivateText(STATE_FILE, `${JSON.stringify({ lastSuccessAt: new Date(now * 1000).toISOString() })}\n`);
    clearTimeout(deadline);
    finish('ok', 0);
    // Counts only on stdout; the digest itself is not printed.
    console.log(`Digest written to ${summary.digestFile} (mode 600).`);
    console.log(JSON.stringify({ ...summary, masked: maskCounts }, null, 2));
  } catch (e) {
    clearTimeout(deadline);
    summary.error = e.message;
    finish('error', 1);
    console.error(`slack-digest: ${e.message}`);
    process.exit(1);
  }
})();

