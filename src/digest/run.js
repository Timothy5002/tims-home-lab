'use strict';
// Runs the daily Slack digest: fetch every conversation mapped to a business unit for the window, compress bot posts
// in code, then (phase 2) ask the pinned cloud model for risks per customer and a short summary per sub-group
// (src/digest/analyze.js), and render data/digests/<date>.md (mode 600). --no-model gives the phase 1 code-only
// digest. See docs/slack-digest.md.
//
// Window: since the last recorded successful run, capped at maxWindowHours; with no record, the last
// defaultWindowHours. Hand runs do not move the record unless --record is given.
//
// Retention: message text lives in memory only. The digest file is the only thing written that contains text;
// stdout, the run row in data/dispatcher.db and data/digest-state.json hold counts and timestamps only.
//
// Usage: node src/digest/run.js [--hours N] [--record] [--scheduled] [--no-model] [--reasoning]
//        node src/digest/run.js --from <ISO time> --to <ISO time> [--mask-report]
//   --from/--to    a fixed window (testing; never recorded as a success)
//   --mask-report  no digest: print which masking pattern fired on which message (pattern name, conversation ID,
//                  message timestamp), never any text
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { ROOT, DATA_DIR, CHANNELS_FILE, createClient, loadConfig, placeChannel, localDay } = require('../slack');
const { fetchConversation } = require('./fetch');
const { compressBots } = require('./compress');
const { renderDigest, convLabel } = require('./render');
const { maskText, maskSecrets, newCounts, MASK_TYPES } = require('../mask');
const { loadRoutes, createBudget, estimateTokens } = require('../openrouter');
const { analyzeAll } = require('./analyze');
const { CUSTOMER_SYSTEM, UNIT_SYSTEM } = require('./prompts');

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
    // Conversation IDs never sent to any model; the digest shows them as "not summarized" with counts only.
    noCloud: new Set(Array.isArray(c.noCloud) ? c.noCloud : []),
    models: c.models,                       // primary / secondary routes (src/openrouter.js)
    maxOutputTokens: num('maxOutputTokens', 60_000),
    maxRunCostUsd: num('maxRunCostUsd', 0.5),
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
    from: { type: 'string' },
    to: { type: 'string' },
    'mask-report': { type: 'boolean', default: false },
    'no-model': { type: 'boolean', default: false },
    reasoning: { type: 'boolean', default: false },
    record: { type: 'boolean', default: false },
    scheduled: { type: 'boolean', default: false },
  } });
  const source = opts.scheduled ? 'launchd-direct' : 'manual';
  const fixedWindow = Boolean(opts.from || opts.to);
  const record = (opts.record || opts.scheduled) && !fixedWindow && !opts['mask-report'];
  const { logRun } = require('../db');
  // servedBy names the model and provider that wrote the digest; phase 1 is code only.
  const useModel = !opts['no-model'] && !opts['mask-report'];
  const summary = { phase: useModel ? 2 : 1, modelCalls: 0, servedBy: 'code only (no model)' };
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
    let windowEnd = now;
    let reason;
    const state = readState();
    if (fixedWindow) {
      windowStart = Math.floor(Date.parse(opts.from ?? '') / 1000);
      windowEnd = Math.floor(Date.parse(opts.to ?? '') / 1000);
      if (!(windowStart < windowEnd) || windowEnd - windowStart > cfg.maxWindowHours * 3600) {
        throw new Error(`--from and --to must both be valid times, --from first, at most ${cfg.maxWindowHours} h apart`);
      }
      reason = 'fixed --from/--to';
    } else if (opts.hours) {
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
    const window = { start: windowStart, end: windowEnd, hours: (windowEnd - windowStart) / 3600, reason };
    const lookbackStart = windowStart - cfg.threadLookbackDays * 86_400;
    Object.assign(summary, { windowHours: Number(window.hours.toFixed(2)), conversations: targets.length });

    const slack = createClient();
    process.stderr.write('Loading user names...\n');
    const users = await slack.paginate('users.list', { limit: '200' }, 'members');
    const names = new Map(users.map((u) => [u.id, u.profile?.display_name || u.real_name || u.name]));
    const ctx = { workspaceUrl: cfg.workspaceUrl, me: cfg.myName, writtenBy: summary.servedBy, nameOf: (id) => (id ? names.get(id) ?? id : 'someone') };

    // Fetch and compress, one conversation at a time (the Slack client spaces calls per method).
    const blocks = [];
    const maskCounts = newCounts();
    const totals = { messages: 0, botMessages: 0, charsIn: 0, charsOut: 0, wouldSendChars: 0, errors: 0, activeConversations: 0, externalConversations: 0, noCloudConversations: 0 };
    const secretHits = []; // for --mask-report: { pattern, conv, ts }, never text
    for (const [i, conv] of targets.entries()) {
      process.stderr.write(`  [${i + 1}/${targets.length}] ${convLabel(conv, cfg.myName)}\n`);
      conv.noCloud = cfg.noCloud.has(conv.id);
      const r = await fetchConversation(slack, conv, { windowStart, windowEnd: windowEnd + 1, lookbackStart });
      if (r.error) { totals.errors++; blocks.push({ conv, error: r.error }); continue; }
      const compressed = compressBots(r.messages);
      totals.messages += compressed.stats.messagesIn;
      totals.botMessages += compressed.stats.botMessagesIn;
      totals.charsIn += compressed.stats.charsIn;
      totals.charsOut += compressed.stats.charsOut;
      if (compressed.stats.messagesIn) totals.activeConversations++;
      // What phase 2 would send: people's messages and the kept bot lines. Secrets are masked in every conversation;
      // external conversations get the full masking. Measured here and thrown away; nothing is sent (phase 1 makes
      // no model calls). noCloud conversations are never sent, so they are not measured either.
      if (conv.noCloud) {
        if (compressed.stats.messagesIn) totals.noCloudConversations++;
      } else if (!useModel) {
        const wouldSend = [...compressed.humans, ...compressed.botGroups.flatMap((g) => [...g.examples, ...g.alerts])];
        for (const m of wouldSend) {
          const onHit = (type, pattern) => { if (type === 'secret') secretHits.push({ pattern, conv: conv.id, ts: m.ts }); };
          totals.wouldSendChars += (conv.external ? maskText(m.text, maskCounts, onHit) : maskSecrets(m.text, maskCounts, onHit)).length;
        }
      }
      if (conv.external && compressed.stats.messagesIn) totals.externalConversations++;
      blocks.push({ conv, compressed, parents: r.parents, error: null });
    }

    if (opts['mask-report']) {
      // Pattern names, conversation IDs and message timestamps only; never text, and no digest is written.
      clearTimeout(deadline);
      Object.assign(summary, { maskReport: true, masked: maskCounts, secretHits: secretHits.length, apiCalls: slack.stats.calls });
      finish('mask-report', 0);
      console.log(`Mask report for ${new Date(windowStart * 1000).toISOString()} to ${new Date(windowEnd * 1000).toISOString()}: ${totals.messages} messages in ${targets.length} conversations.`);
      console.log(`Counts by type: ${MASK_TYPES.map((t) => `${t} ${maskCounts[t]}`).join(', ')}`);
      console.log(`Secret hits (${secretHits.length}):`);
      for (const h of secretHits) {
        const c = targets.find((t) => t.id === h.conv);
        console.log(`  pattern ${h.pattern.padEnd(12)} conversation ${h.conv} (${c?.external ? 'external' : 'internal'}) message ts ${h.ts}`);
      }
      return;
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

    // Phase 2: one call per active customer, one per other active sub-group. noCloud conversations are never sent.
    let modelLines = [];
    if (useModel) {
      const routes = loadRoutes(cfg.models);
      const toMessages = (b, where) => [
        ...b.compressed.humans.map((m) => ({ ts: m.ts, threadTs: m.threadTs, who: ctx.nameOf(m.user), text: m.text })),
        ...b.compressed.botGroups.flatMap((g) => [...g.examples, ...g.alerts].map((m) => ({
          ts: m.ts, threadTs: m.threadTs, who: `${g.botName ?? 'bot'} (bot${g.count > 1 ? `, ${g.count} similar posts` : ''})`, text: m.text,
        }))),
      ].map((m) => ({ ...m, conv: { id: b.conv.id, external: b.conv.external }, where }));
      const jobs = [];
      for (const u of units) {
        for (const sub of u.subs) {
          const sendable = sub.blocks.filter((b) => !b.conv.noCloud);
          if (!sendable.length) continue;
          if (cg && u.bu === cg.bu && sub.sub === cg.sub) {
            for (const b of sendable) {
              jobs.push({ kind: 'customer', key: b.conv.id, sub, header: `Customer channel: ${convLabel(b.conv, cfg.myName)}.`,
                messages: toMessages(b, null).sort((x, y) => Number(x.ts) - Number(y.ts)) });
            }
          } else {
            const msgs = sendable.flatMap((b) => toMessages(b, convLabel(b.conv, cfg.myName))).sort((x, y) => Number(x.ts) - Number(y.ts));
            jobs.push({ kind: 'unit', key: `${u.bu} > ${sub.sub ?? '-'}`, sub,
              header: `Unit: ${u.bu}. Sub-group: ${sub.sub ?? '(none)'}. Conversations: ${sendable.map((b) => convLabel(b.conv, cfg.myName)).join(', ')}.`, messages: msgs });
          }
        }
      }
      // Whole-run check before any call: estimated input for every call (prompts included) against the cap.
      const estimate = jobs.reduce((t, j) => t + estimateTokens(j.kind === 'customer' ? CUSTOMER_SYSTEM : UNIT_SYSTEM)
        + estimateTokens(j.messages.map((m) => m.text).join('\n')) + j.messages.length * 12, 0);
      summary.estimatedInputTokens = estimate;
      if (estimate > cfg.maxInputTokens) {
        throw new Error(`estimated model input ${estimate} tokens is over the per-run cap of ${cfg.maxInputTokens}; no model calls made`);
      }
      const budget = createBudget({ maxInputTokens: cfg.maxInputTokens, maxOutputTokens: cfg.maxOutputTokens, maxCostUsd: cfg.maxRunCostUsd });
      let done = 0;
      const results = await analyzeAll(jobs, {
        routes, budget, maskCounts, reasoning: opts.reasoning,
        onDone: (r) => process.stderr.write(`  model [${++done}/${jobs.length}] ${r.kind} ${r.ok ? 'ok' : r.error}${r.fellBack ? ' (secondary)' : ''}\n`),
      });
      for (const [i, j] of jobs.entries()) {
        if (j.kind === 'customer') (j.sub.analysis ??= new Map()).set(j.key, results[i]);
        else j.sub.analysis = results[i];
      }
      // Which model and provider served, per call; no text.
      const served = {};
      for (const r of results) if (r.provider) served[`${r.model} via ${r.provider}`] = (served[`${r.model} via ${r.provider}`] ?? 0) + 1;
      const ok = results.filter((r) => r.ok);
      const kept = ok.reduce((t, r) => t + (r.wentWrong?.length ?? 0) + (r.risks?.length ?? 0) + (r.points?.length ?? 0), 0);
      const dropped = ok.reduce((t, r) => t + r.dropped, 0);
      const fellBack = results.filter((r) => r.fellBack).length;
      // Why the primary was given up on (error codes only), so frequent fallbacks are visible.
      const fallbackReasons = {};
      for (const r of results) if (r.fellBack) fallbackReasons[r.primaryError] = (fallbackReasons[r.primaryError] ?? 0) + 1;
      const convsSummarized = jobs.reduce((t, j, idx) => t + (results[idx].ok ? new Set(j.messages.map((m) => m.conv.id)).size : 0), 0);
      Object.assign(summary, {
        modelCalls: results.length, callsOk: ok.length, callsFailed: results.length - ok.length,
        failures: Object.fromEntries([...new Set(results.filter((r) => !r.ok).map((r) => r.error))].map((e) => [e, results.filter((r) => r.error === e).length])),
        conversationsSummarized: convsSummarized, customersNotable: ok.filter((r) => r.kind === 'customer' && r.notable).length,
        itemsKept: kept, itemsDropped: dropped, fallbacks: fellBack, fallbackReasons, servedBy: served,
        tokens: { input: budget.used.inputTokens, output: budget.used.outputTokens, reasoning: budget.used.reasoningTokens },
        costUsd: Number(budget.used.costUsd.toFixed(6)), costCapUsd: cfg.maxRunCostUsd,
      });
      ctx.analyzed = true;
      const names = Object.entries(served);
      ctx.writtenBy = names.length === 0 ? 'no model call succeeded'
        : names.length === 1 && !fellBack ? names[0][0]
          : names.map(([n, c]) => `${n} (${c} ${c === 1 ? 'call' : 'calls'})`).join('; ') + (fellBack ? `; ${fellBack} fell back to the secondary` : '');
      modelLines = [
        `- Model: ${ctx.writtenBy}. Calls ${results.length} (${ok.length} ok${results.length - ok.length ? `, ${results.length - ok.length} failed` : ''}).${fellBack ? ` Fallback reasons: ${Object.entries(fallbackReasons).map(([k, v]) => `${k} ${v}`).join(', ')}.` : ''}`,
        `- Items kept ${kept}, dropped for missing or invalid references ${dropped}.`,
        `- Tokens: input ${budget.used.inputTokens.toLocaleString('en-US')}, output ${budget.used.outputTokens.toLocaleString('en-US')} (reasoning ${budget.used.reasoningTokens}). Cost $${budget.used.costUsd.toFixed(4)} of a $${cfg.maxRunCostUsd} cap.`,
        `- Masked before sending (secrets in every conversation, the rest in external ones): ${MASK_TYPES.map((t) => `${t} ${maskCounts[t]}`).join(', ')}.`,
      ];
    }

    const wouldSendTokens = Math.ceil(totals.wouldSendChars / 4); // same characters / 4 estimate as the measurement
    const s = slack.stats;
    Object.assign(summary, totals, {
      ...(useModel ? {} : { wouldSendTokens, underCap: wouldSendTokens <= cfg.maxInputTokens }), masked: maskCounts,
      compressionRatio: totals.charsIn ? Number((totals.charsOut / totals.charsIn).toFixed(3)) : null,
      apiCalls: s.calls, rateLimitWaits: s.rateLimited,
    });
    const footer = [
      `- Window: ${window.hours.toFixed(1)} h (${reason}); thread lookback ${cfg.threadLookbackDays} days.`,
      `- Conversations: ${targets.length} mapped, ${totals.activeConversations} active (${totals.externalConversations} of them external), ${totals.errors} unreadable.`,
      `- Messages: ${totals.messages} (${totals.botMessages} from bots). Characters ${totals.charsIn.toLocaleString('en-US')} → ${totals.charsOut.toLocaleString('en-US')} after bot compression (${summary.compressionRatio === null ? '-' : Math.round(summary.compressionRatio * 100)}%).`,
      ...(useModel ? modelLines : [
        `- Would send to a model: about ${wouldSendTokens.toLocaleString('en-US')} tokens before prompts; cap ${cfg.maxInputTokens.toLocaleString('en-US')}${summary.underCap ? '' : ' (OVER CAP: the run would abort)'}.`,
        `- Masking dry run (secrets in every conversation, the rest in external ones): ${MASK_TYPES.map((t) => `${t} ${maskCounts[t]}`).join(', ')}. Nothing was sent.`,
      ]),
      `- Not sent to any model by choice (noCloud): ${totals.noCloudConversations} active ${totals.noCloudConversations === 1 ? 'conversation' : 'conversations'}.`,
      `- Slack API calls: ${s.calls}, rate-limit waits: ${s.rateLimited}. Runtime: ${Math.round((Date.now() - started) / 1000)} s.`,
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

