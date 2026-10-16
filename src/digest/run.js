'use strict';
// Runs the daily Slack digest: fetch every conversation mapped to a business unit for the window, compress bot posts
// in code, then run the model pipeline (src/digest/pipeline.js): the customer registry merges each customer's
// channels, stage 1 extracts findings per customer conversation, stage 2 merges them per customer with mentions
// from Leadership and Internal channels, and units are handled by their mode (full, brief, off). It renders the
// customer-merged archive file data/digests/<date>.md (mode 600). --no-model gives the code-only digest.
// See docs/slack-digest.md.
//
// Window: since the last recorded successful run, capped at maxWindowHours; with no record, the last
// defaultWindowHours. Hand runs do not move the record unless --record is given. The record is written atomically,
// only after the digest file is written and, when delivering, only after the delivery succeeded, so a failed
// delivery makes the next run cover the window again.
//
// Membership refresh (scheduled runs, or --refresh): before anything else, the conversation list is re-read with
// paged conversations.list calls (src/slack.js) and data/slack-channels.json is updated. Conversations the user
// left or that were archived are dropped (counted). New ones that match a rule or override in config/slack-bus.json
// are read like any other; new ones that match nothing are never read or sent to a model, only named in the DM
// thread's footer and the archive file (stats and logs hold their count only). If the refresh fails, the run goes
// on with the saved list and the stats say so.
//
// Scheduled runs (--scheduled, from launchd/com.lab.schedule.slack-digest.plist at 06:00): deliver the digest by
// Slack DM (src/slack-send.js: a short top-level message and one threaded reply; no file), record the success,
// and ping ~/.lab/healthcheck-url-slack-digest with stats only: success, or /fail on any error, deadline or failed
// delivery. They print no per-conversation progress.
//
// Retention: message text lives in memory only. The digest file is the only thing written that contains text;
// the last KEEP_DIGESTS digest files are kept and older ones deleted. stdout, logs, the run row in
// data/dispatcher.db, the healthcheck ping and data/digest-state.json hold counts and timestamps only.
//
// Usage: node src/digest/run.js [--hours N] [--record] [--scheduled] [--deliver] [--refresh] [--no-model] [--reasoning]
//        node src/digest/run.js --from <ISO time> --to <ISO time> [--scheduled | --deliver] [--mask-report]
//   --from/--to    a fixed window (testing; never recorded as a success, even with --scheduled or --record)
//   --hours N      the last N hours (testing; never recorded either)
//   --deliver      also send the Slack DM on a hand run (scheduled runs always do)
//   --refresh      also refresh the conversation list first on a hand run (scheduled runs always do)
//   --mask-report  no digest: print which masking pattern fired on which message (pattern name, conversation ID,
//                  message timestamp), never any text
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { ROOT, DATA_DIR, CHANNELS_FILE, createClient, loadConfig, placeChannel, localDay, listConversations, applyListing, writePrivateJson } = require('../slack');
const { fetchConversation } = require('./fetch');
const { compressBots } = require('./compress');
const { renderDigest, renderArchive, convLabel, unmappedLabel } = require('./render');
const { maskText, maskSecrets, newCounts, MASK_TYPES } = require('../mask');
const { loadRoutes, createBudget, RETRY_CODES } = require('../openrouter');
const { runPipeline } = require('./pipeline');
const { loadCustomerConfig, buildRegistry } = require('./customers');
const { buildDm } = require('./dm');
const { createSender } = require('../slack-send');
const { checkPingFile, ping } = require('../healthcheck');

const DIGEST_CONFIG = path.join(ROOT, 'config', 'slack-digest.json');
const STATE_FILE = path.join(DATA_DIR, 'digest-state.json');
const DIGEST_DIR = path.join(DATA_DIR, 'digests');
const KEEP_DIGESTS = 14;
const JOB = 'slack-digest';

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
    maxRunInputTokens: num('maxRunInputTokens', 400_000),  // whole run, estimated before any call
    maxCallInputTokens: num('maxCallInputTokens', 100_000), // one call; safely under the primary's context
    deliverTo: c.deliverTo ?? null,                          // the one Slack user ID the DM may go to (and "me")
    // Per unit or "Unit > Sub-group": full, brief or off (see src/digest/pipeline.js). Unlisted units are brief.
    unitModes: c.unitModes && typeof c.unitModes === 'object' ? c.unitModes : {},
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

// Deletes all but the newest KEEP_DIGESTS digest files (named <date>.md). Returns how many were deleted.
function pruneDigests() {
  const files = fs.readdirSync(DIGEST_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
  const old = files.slice(0, Math.max(0, files.length - KEEP_DIGESTS));
  for (const f of old) fs.unlinkSync(path.join(DIGEST_DIR, f));
  return old.length;
}

// Counts per error code, e.g. { "rate-limited": 2 }.
const tally = (codes) => codes.reduce((o, c) => ({ ...o, [c]: (o[c] ?? 0) + 1 }), {});

// Daily membership refresh: re-list conversations (conversations.list only), update the saved list, and report
// what changed. Returns { stats (counts only), newUnmapped: [label] }.
async function refreshMembership(slack, bus, saved) {
  const callsBefore = slack.stats.calls;
  const listing = await listConversations(slack);
  const r = applyListing(saved, listing);
  const place = (c) => ({ ...c, ...placeChannel(bus, c) });
  const next = { ...saved, refreshedAt: new Date().toISOString(), seen: { ...listing.seen, total: listing.raw.length },
    member: { ...listing.member, total: listing.memberIds.size }, channels: r.channels.map(place) };
  writePrivateJson(CHANNELS_FILE, next);
  // Unmapped: no rule, override or group DM entry (an override set to null is a decision, not "unmapped").
  const newUnmapped = r.added.map(place).filter((c) => c.by === null);
  return {
    saved: next,
    newUnmapped: newUnmapped.map(unmappedLabel).sort(),
    stats: { status: 'ok', listCalls: slack.stats.calls - callsBefore, conversations: r.channels.length, added: r.added.length,
      addedMapped: r.added.length - newUnmapped.length, newUnmapped: newUnmapped.length, removed: r.removed.length,
      removedMapped: r.removed.filter((c) => place(c).bu).length },
  };
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
    deliver: { type: 'boolean', default: false },
    refresh: { type: 'boolean', default: false },
  } });
  const source = opts.scheduled ? 'launchd-direct' : 'manual';
  // Scheduled runs keep the log to stats: no per-conversation progress lines.
  const progress = (line) => { if (!opts.scheduled) process.stderr.write(line); };
  const fixedWindow = Boolean(opts.from || opts.to);
  // An explicit window (--from/--to or --hours) is a test and never moves the last-success record.
  const record = (opts.record || opts.scheduled) && !fixedWindow && !opts.hours && !opts['mask-report'];
  const { logRun } = require('../db');
  // servedBy names the model and provider that wrote the digest; phase 1 is code only.
  const useModel = !opts['no-model'] && !opts['mask-report'];
  const summary = { phase: useModel ? 2 : 1, modelCalls: 0, servedBy: 'code only (no model)' };
  const finish = (status, exitCode) => {
    summary.status = status;
    summary.runtimeS = Math.round((Date.now() - started) / 1000);
    logRun({ job: JOB, source, startedAt, durationMs: Date.now() - started, exitCode, status, output: JSON.stringify(summary) });
  };
  // Scheduled runs ping healthchecks.io with stats only (never text). A failed ping is logged and fails the run.
  const pingHealth = async (failed) => {
    if (!opts.scheduled) return true;
    const pick = (k) => (summary[k] === undefined ? {} : { [k]: summary[k] });
    const body = JSON.stringify({
      status: summary.status, ...pick('error'), ...pick('windowHours'), servedBy: summary.servedBy,
      ...pick('fallbacks'), ...pick('fallbackReasons'), ...pick('retries'), ...pick('retryReasons'),
      ...pick('customersMerged'), ...pick('customersNotable'), ...pick('itemsKept'), ...pick('itemsDropped'), ...pick('itemsDroppedBy'), ...pick('notSummarizedCap'),
      ...pick('costUsd'), ...pick('membership'), runtimeS: summary.runtimeS, delivery: summary.delivery ?? { status: 'not attempted' },
    });
    try {
      await ping(JOB, failed, body);
      console.log(`healthcheck ping sent (${failed ? 'fail' : 'success'})`);
      return true;
    } catch (e) {
      console.error(`slack-digest: healthcheck ping failed: ${e.message}`);
      return false;
    }
  };
  const fail = async (status, message) => {
    summary.error = message;
    finish(status, 1);
    console.error(`slack-digest: ${message}`);
    await pingHealth(true);
    process.exit(1);
  };

  let cfg;
  try {
    cfg = loadDigestConfig();
    if (opts.scheduled) checkPingFile(JOB); // before any work, so a missing check fails loudly (there is nothing to ping)
  } catch (e) {
    summary.error = e.message;
    finish('error', 1);
    console.error(`slack-digest: ${e.message}`);
    process.exit(1);
  }
  const deadline = setTimeout(() => {
    fail('deadline', `deadline of ${cfg.runDeadlineMinutes} min reached; no digest written`);
  }, cfg.runDeadlineMinutes * 60_000);

  try {
    const bus = loadConfig();
    if (!fs.existsSync(CHANNELS_FILE)) throw new Error('data/slack-channels.json not found; run node scripts/slack-channels.js first');
    let saved = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
    const slack = createClient();
    let newUnmapped = [];
    if (opts.scheduled || opts.refresh) {
      progress('Refreshing the conversation list...\n');
      try {
        const r = await refreshMembership(slack, bus, saved);
        saved = r.saved;
        newUnmapped = r.newUnmapped;
        summary.membership = r.stats;
      } catch (e) {
        summary.membership = { status: 'failed', code: e.code ?? 'error' }; // carry on with the saved list
      }
    }
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

    progress('Loading user names...\n');
    const users = await slack.paginate('users.list', { limit: '200' }, 'members');
    const names = new Map(users.map((u) => [u.id, u.profile?.display_name || u.real_name || u.name]));
    const ctx = { workspaceUrl: cfg.workspaceUrl, me: cfg.myName, writtenBy: summary.servedBy, nameOf: (id) => (id ? names.get(id) ?? id : 'someone') };

    // Fetch and compress, one conversation at a time (the Slack client spaces calls per method).
    const blocks = [];
    const maskCounts = newCounts();
    const totals = { messages: 0, botMessages: 0, charsIn: 0, charsOut: 0, wouldSendChars: 0, errors: 0, activeConversations: 0, externalConversations: 0, noCloudConversations: 0 };
    const secretHits = []; // for --mask-report: { pattern, conv, ts }, never text
    for (const [i, conv] of targets.entries()) {
      progress(`  [${i + 1}/${targets.length}] ${convLabel(conv, cfg.myName)}\n`);
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

    // The model pipeline (src/digest/pipeline.js): customer registry, stage-1 extraction per customer conversation,
    // unit modes, mentions, stage-2 synthesis per customer. noCloud conversations are never sent.
    let model = null;
    let modelLines = [];
    let dmFooter = [];
    if (useModel) {
      const routes = loadRoutes(cfg.models);
      for (const c of targets) c.label = convLabel(c, cfg.myName);
      const registry = buildRegistry(targets, loadCustomerConfig());
      const budget = createBudget({ maxInputTokens: cfg.maxRunInputTokens, maxOutputTokens: cfg.maxOutputTokens, maxCostUsd: cfg.maxRunCostUsd });
      let done = 0;
      model = await runPipeline({
        blocks, registry, modes: cfg.unitModes, me: cfg.deliverTo, nameOf: ctx.nameOf, routes, budget, maskCounts,
        runCap: cfg.maxRunInputTokens, callCap: cfg.maxCallInputTokens, reasoning: opts.reasoning,
        onDone: (r) => progress(`  model [${++done}] ${r.kind} ${r.ok ? 'ok' : r.error}${r.retried ? ' (retried)' : ''}${r.fellBack ? ' (secondary)' : ''}\n`),
      });
      const results = model.results;
      // Which model and provider served, per call; no text.
      const served = {};
      for (const r of results) if (r.provider) served[`${r.model} via ${r.provider}`] = (served[`${r.model} via ${r.provider}`] ?? 0) + 1;
      const ok = results.filter((r) => r.ok);
      const fellBack = results.filter((r) => r.fellBack).length;
      // Why the primary was retried or given up on (error codes only), so frequent retries and fallbacks are visible.
      const retriedCalls = results.filter((r) => RETRY_CODES.has(r.primaryErrors?.[0]));
      const retryReasons = tally(retriedCalls.map((r) => r.primaryErrors[0]));
      const fallbackReasons = tally(results.filter((r) => r.fellBack).map((r) => r.primaryErrors?.at(-1) ?? r.primaryError ?? 'unknown'));
      const recoveredByRetry = results.filter((r) => r.ok && r.retried && !r.fellBack).length;
      const st = model.stats;
      const droppedTotal = Object.values(st.itemsDropped).reduce((a, b) => a + b, 0);
      Object.assign(summary, {
        modelCalls: results.length, calls: st.calls, callsOk: ok.length, callsFailed: results.length - ok.length,
        failures: tally(results.filter((r) => !r.ok).map((r) => r.error)),
        customersWithActivity: st.customersWithActivity, customersMerged: st.customersMerged, customersNotable: st.customersNotable,
        customersNotMerged: st.customersFallback, unmatchedChannels: registry.unmatched.length, mentionMessages: st.mentionMessages,
        itemsKept: st.itemsKept, itemsDropped: droppedTotal, itemsDroppedBy: st.itemsDropped, incidents: model.incidents.length,
        skipped: { botHygiene: model.skipped.botHygiene, botPosts: model.skipped.botPosts, quietConversations: model.skipped.quietConversations, ownConversations: model.skipped.ownConversations },
        notSummarizedCap: st.notSummarizedCap, estimatedInputTokens: model.plan.estimatedInputTokens,
        retries: retriedCalls.length, retryReasons, recoveredByRetry, fallbacks: fellBack, fallbackReasons, servedBy: served,
        tokens: { input: budget.used.inputTokens, output: budget.used.outputTokens, reasoning: budget.used.reasoningTokens },
        costUsd: Number(budget.used.costUsd.toFixed(6)), costCapUsd: cfg.maxRunCostUsd,
      });
      ctx.analyzed = true;
      const names = Object.entries(served);
      ctx.writtenBy = names.length === 0 ? 'no model call succeeded'
        : names.length === 1 && !fellBack ? names[0][0]
          : names.map(([n, c]) => `${n} (${c} ${c === 1 ? 'call' : 'calls'})`).join('; ') + (fellBack ? `; ${fellBack} fell back to the secondary` : '');
      const fmt = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ');
      const nsc = st.notSummarizedCap;
      modelLines = [
        `- Model: ${ctx.writtenBy}. Calls ${results.length} (${st.calls.stage1} stage 1, ${st.calls.synthesis} synthesis; ${ok.length} ok${results.length - ok.length ? `, ${results.length - ok.length} not ok` : ''}).`,
        `- Primary retries: ${retriedCalls.length}${retriedCalls.length ? ` (${fmt(retryReasons)}; ${recoveredByRetry} recovered on the retry)` : ''}. Fallbacks to the secondary: ${fellBack}${fellBack ? ` (${fmt(fallbackReasons)})` : ''}.`,
        `- Customers: ${st.customersWithActivity} with activity or mentions, ${st.customersMerged} merged, ${st.customersNotable} notable${st.customersFallback ? ` (${st.customersFallback} not merged: stage-1 findings shown)` : ''}; ${registry.unmatched.length} channels matched no customer; ${st.mentionMessages} mention messages.`,
        `- Not summarized (cap): ${nsc.calls} ${nsc.calls === 1 ? 'call' : 'calls'}, ${nsc.messages} messages; trimmed to the per-call cap: ${nsc.trimmedCalls} ${nsc.trimmedCalls === 1 ? 'call' : 'calls'}, ${nsc.trimmedMessages} oldest messages left out. Run cap ${cfg.maxRunInputTokens.toLocaleString('en-US')} tokens (stage 1 planned ${model.plan.estimatedInputTokens.toLocaleString('en-US')}), per-call cap ${cfg.maxCallInputTokens.toLocaleString('en-US')}.`,
        `- Items kept ${st.itemsKept}; dropped ${droppedTotal} (${fmt(st.itemsDropped)}).`,
        `- Tokens: input ${budget.used.inputTokens.toLocaleString('en-US')}, output ${budget.used.outputTokens.toLocaleString('en-US')} (reasoning ${budget.used.reasoningTokens}). Cost $${budget.used.costUsd.toFixed(4)} of a $${cfg.maxRunCostUsd} cap.`,
        `- Masked before sending (secrets in every conversation, the rest in external ones): ${MASK_TYPES.map((t) => `${t} ${maskCounts[t]}`).join(', ')}.`,
      ];
      // The DM thread's footer: model, provider, retries, fallbacks and cost. Stats only.
      dmFooter = [
        `Model: ${ctx.writtenBy}`,
        `${results.length} calls, ${retriedCalls.length} retried, ${fellBack} fell back${fellBack ? ` (${fmt(fallbackReasons)})` : ''}`,
        `$${budget.used.costUsd.toFixed(4)}`,
        `window ${window.hours.toFixed(1)} h`,
        ...(registry.unmatched.length ? [`${registry.unmatched.length} unmatched channels`] : []),
        ...(newUnmapped.length ? [`${newUnmapped.length} new, unmapped: ${newUnmapped.slice(0, 15).join(', ')}${newUnmapped.length > 15 ? ` and ${newUnmapped.length - 15} more` : ''}`] : []),
        ...(summary.membership?.status === 'failed' ? ['membership refresh failed'] : []),
      ];
    }

    const wouldSendTokens = Math.ceil(totals.wouldSendChars / 4); // same characters / 4 estimate as the measurement
    const s = slack.stats;
    Object.assign(summary, totals, {
      ...(useModel ? {} : { wouldSendTokens, underCap: wouldSendTokens <= cfg.maxRunInputTokens }), masked: maskCounts,
      compressionRatio: totals.charsIn ? Number((totals.charsOut / totals.charsIn).toFixed(3)) : null,
      apiCalls: s.calls, rateLimitWaits: s.rateLimited,
    });
    const footer = [
      `- Window: ${window.hours.toFixed(1)} h (${reason}); thread lookback ${cfg.threadLookbackDays} days.`,
      `- Conversations: ${targets.length} mapped, ${totals.activeConversations} active (${totals.externalConversations} of them external), ${totals.errors} unreadable.`,
      `- Messages: ${totals.messages} (${totals.botMessages} from bots). Characters ${totals.charsIn.toLocaleString('en-US')} → ${totals.charsOut.toLocaleString('en-US')} after bot compression (${summary.compressionRatio === null ? '-' : Math.round(summary.compressionRatio * 100)}%).`,
      ...(useModel ? modelLines : [
        `- Would send to a model: about ${wouldSendTokens.toLocaleString('en-US')} tokens before prompts; run cap ${cfg.maxRunInputTokens.toLocaleString('en-US')}${summary.underCap ? '' : ' (over the cap: the quietest calls would not be summarized)'}.`,
        `- Masking dry run (secrets in every conversation, the rest in external ones): ${MASK_TYPES.map((t) => `${t} ${maskCounts[t]}`).join(', ')}. Nothing was sent.`,
      ]),
      ...(summary.membership ? [summary.membership.status === 'ok'
        ? `- Membership refresh: ${summary.membership.conversations} conversations; ${summary.membership.added} new (${summary.membership.addedMapped} mapped, ${summary.membership.newUnmapped} unmapped and not read${newUnmapped.length ? `: ${newUnmapped.join(', ')}` : ''}); ${summary.membership.removed} gone (${summary.membership.removedMapped} of them mapped).`
        : `- Membership refresh failed (${summary.membership.code}); the saved conversation list was used.`] : []),
      `- Not sent to any model by choice (noCloud): ${totals.noCloudConversations} active ${totals.noCloudConversations === 1 ? 'conversation' : 'conversations'}.`,
      `- Slack API calls: ${s.calls}, rate-limit waits: ${s.rateLimited}. Runtime: ${Math.round((Date.now() - started) / 1000)} s.`,
    ];
    const text = useModel ? renderArchive({ model, window, footer, ctx }) : renderDigest({ units, window, footer, ctx, customerKey: cg });
    const file = path.join(DIGEST_DIR, `${localDay(new Date(now * 1000))}.md`);
    writePrivateText(file, text);
    summary.digestFile = path.relative(ROOT, file);
    summary.digestsDeleted = pruneDigests();

    // Delivery: scheduled runs, or --deliver. A failure keeps the digest file, fails the run, and does not move the
    // last-success record, so the next run covers this window again.
    const delivering = opts.scheduled || opts.deliver;
    if (delivering) {
      summary.delivery = { status: 'failed' };
      try {
        if (!useModel) throw Object.assign(new Error('delivery needs the model digest'), { code: 'no-model' });
        if (!cfg.deliverTo) throw Object.assign(new Error('no deliverTo in config/slack-digest.json'), { code: 'no-recipient' });
        const dm = buildDm({ model, window, ctx, footer: dmFooter });
        const sender = createSender({ recipient: cfg.deliverTo });
        await sender.openDm();
        const posted = await sender.postText(dm.top);
        summary.delivery = { status: 'failed', code: 'thread-not-posted', topChars: dm.stats.topChars };
        await sender.postText(dm.thread, posted.ts);
        summary.delivery = { status: 'ok', ...dm.stats, slackCalls: sender.stats.calls };
      } catch (e) {
        summary.delivery = { ...summary.delivery, status: 'failed', code: e.code ?? 'error' };
      }
    }
    const delivered = !delivering || summary.delivery.status === 'ok';
    // The success is recorded only after the digest file exists and, when delivering, after delivery succeeded
    // (atomic write: temp file, then rename).
    if (record && delivered) writePrivateText(STATE_FILE, `${JSON.stringify({ lastSuccessAt: new Date(now * 1000).toISOString() })}\n`);
    summary.recorded = record && delivered;
    clearTimeout(deadline);
    finish(delivered ? 'ok' : 'delivery-failed', delivered ? 0 : 1);
    // Counts only on stdout; the digest itself is not printed.
    console.log(`Digest written to ${summary.digestFile} (mode 600).`);
    console.log(JSON.stringify({ ...summary, masked: maskCounts }, null, 2));
    const pinged = await pingHealth(!delivered);
    process.exit(delivered && pinged ? 0 : 1);
  } catch (e) {
    clearTimeout(deadline);
    await fail('error', e.message);
  }
})();

