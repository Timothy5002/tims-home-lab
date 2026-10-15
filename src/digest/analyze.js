'use strict';
// Phase 2 of the Slack digest: turns fetched messages into model calls and validated items.
//   prepare():   numbers messages m001..., masks them (secrets in every conversation, full masking in external
//                ones; see src/mask.js) and keeps a reference map in memory. Text never leaves memory except in
//                the request to the pinned provider.
//   validate():  checks a model reply against the expected shape, keeps only items whose references exist in
//                the reference map, strips anything link- or mention-like from the model's text, and counts
//                what it dropped. The model never supplies a URL; links are built later from the reference map.
//   planJobs():  fits the calls into the run's input cap before any is sent: customers first, then sub-groups,
//                busiest first within each; a call over the per-call cap keeps its newest messages; whatever does
//                not fit is marked "not summarized (cap)" instead of aborting the run.
//   analyzeAll(): runs the calls through src/openrouter.js (primary, one primary retry, one fallback) at most 3 at
//                a time, under the run's input, output and cost caps.
// Nothing here logs or stores message text or model text.
const { chat, estimateTokens } = require('../openrouter');
const { maskText, maskSecrets } = require('../mask');
const { CUSTOMER_SYSTEM, UNIT_SYSTEM, renderMessages } = require('./prompts');

const MAX_MESSAGE_CHARS = 2000;  // a single very long message is cut before sending
const MAX_ITEMS = 5;
const SUMMARY_CHARS = 200;
const LEVELS = new Set(['low', 'medium', 'high']);

const when = (ts) => new Date(Number(ts) * 1000).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

// messages: [{ conv: { id, external, label }, ts, threadTs, who, text }] sorted by time.
function prepare(messages, maskCounts) {
  const refMap = new Map();
  const lines = messages.map((m, i) => {
    const ref = `m${String(i + 1).padStart(3, '0')}`;
    refMap.set(ref, { conv: m.conv.id, ts: m.ts, threadTs: m.threadTs ?? null });
    const cut = m.text.length > MAX_MESSAGE_CHARS ? `${m.text.slice(0, MAX_MESSAGE_CHARS)}…` : m.text;
    const text = m.conv.external ? maskText(cut, maskCounts) : maskSecrets(cut, maskCounts);
    return { ref, when: when(m.ts), who: m.who, where: m.where, text };
  });
  return { lines, refMap };
}

// Model text is shown to a person and may come from a crafted message, so nothing in it may link, mention or
// format: URLs, Slack markup, emails, @-mentions and markdown links are removed, and it is cut to length.
function sanitize(s) {
  const t = String(s ?? '')
    .replace(/<[^>]*>/g, ' ')                      // Slack markup: <@U..>, <!channel>, <url|label>
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')       // markdown links
    .replace(/\b(?:https?|ftp):\/\/\S+/gi, '')
    .replace(/\bwww\.\S+/gi, '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '')
    .replace(/(^|\s)@\w[\w.-]*/g, '$1')
    .replace(/[`*_~|#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > SUMMARY_CHARS ? `${t.slice(0, SUMMARY_CHARS - 1)}…` : t;
}

class ShapeError extends Error {
  constructor(message) { super(message); this.code = 'bad-shape'; }
}

// Returns { items, dropped } for one list. An item survives only with a non-empty summary and at least one
// reference that exists in this call's reference map; unknown references are removed from kept items.
function keepCited(list, refMap, levelKey) {
  if (list === undefined) return { items: [], dropped: 0 };
  if (!Array.isArray(list)) throw new ShapeError('a list field is not a list');
  let dropped = 0;
  const items = [];
  for (const it of list) {
    const refs = Array.isArray(it?.refs) ? [...new Set(it.refs.filter((r) => typeof r === 'string' && refMap.has(r)))] : [];
    const summary = sanitize(it?.summary);
    if (!refs.length || !summary || items.length >= MAX_ITEMS) { dropped++; continue; }
    const item = { summary, refs: refs.slice(0, 5) };
    if (levelKey) item[levelKey] = LEVELS.has(String(it[levelKey]).toLowerCase()) ? String(it[levelKey]).toLowerCase() : 'medium';
    items.push(item);
  }
  return { items, dropped };
}

function validate(kind, reply, refMap) {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw new ShapeError('reply is not a JSON object');
  if (kind === 'customer') {
    const w = keepCited(reply.went_wrong, refMap, 'severity');
    const r = keepCited(reply.risks, refMap, 'likelihood');
    // "notable" is decided by code: a customer is notable only if a cited item survived.
    return { wentWrong: w.items, risks: r.items, notable: w.items.length + r.items.length > 0, dropped: w.dropped + r.dropped };
  }
  const p = keepCited(reply.points, refMap, null);
  return { points: p.items, dropped: p.dropped };
}

// Estimated input tokens for one call, the same way the client estimates (characters / 4), with a per-message
// allowance for the reference, time, author and JSON quoting around each message.
const PER_MESSAGE_OVERHEAD = 15;
function estimateJob(job) {
  const system = job.kind === 'customer' ? CUSTOMER_SYSTEM : UNIT_SYSTEM;
  return estimateTokens(system) + estimateTokens(job.header) + 50
    + job.messages.reduce((t, m) => t + estimateTokens(String(m.text).slice(0, MAX_MESSAGE_CHARS)) + PER_MESSAGE_OVERHEAD, 0);
}

// jobs: [{ kind, key, header, messages (oldest first) }]. Mutates each job: est (tokens), trimmed (oldest messages
// left out to fit the per-call cap), capSkipped (true if it did not fit the run cap). Returns totals, counts only.
function planJobs(jobs, { runCap, callCap }) {
  for (const j of jobs) {
    j.trimmed = 0;
    j.est = estimateJob(j);
    while (j.est > callCap && j.messages.length > 1) {
      // Drop the oldest messages in chunks until it fits; the newest are the most useful.
      const n = Math.max(1, Math.ceil(j.messages.length * 0.1));
      j.messages = j.messages.slice(n);
      j.trimmed += n;
      j.est = estimateJob(j);
    }
  }
  const order = [...jobs].sort((a, b) => (a.kind === 'customer' ? 0 : 1) - (b.kind === 'customer' ? 0 : 1)
    || (b.messages.length + b.trimmed) - (a.messages.length + a.trimmed) || b.est - a.est);
  // Strictly in priority order: once a call does not fit, it and every quieter call are skipped, so a quieter
  // conversation is never summarized while a busier one is not.
  let total = 0;
  let full = false;
  for (const j of order) {
    if (!full && j.est <= callCap && total + j.est <= runCap) { total += j.est; j.capSkipped = false; } else { full = true; j.capSkipped = true; }
  }
  const skipped = jobs.filter((j) => j.capSkipped);
  return {
    estimatedInputTokens: total,
    skippedCalls: skipped.length,
    skippedMessages: skipped.reduce((t, j) => t + j.messages.length + j.trimmed, 0),
    trimmedCalls: jobs.filter((j) => j.trimmed && !j.capSkipped).length,
    trimmedMessages: jobs.filter((j) => !j.capSkipped).reduce((t, j) => t + j.trimmed, 0),
  };
}

const CAP_CODES = new Set(['input-cap', 'output-cap', 'cost-cap']);
// True when a result was not summarized because of a cap (planned skip, or a run cap reached mid-run).
const isCapped = (r) => Boolean(r?.capSkipped) || CAP_CODES.has(r?.error) || /^not sent: /.test(r?.error ?? '');

// jobs: [{ kind: 'customer' | 'unit', key, header, messages, capSkipped? }]. Returns one result per job:
// { key, kind, ok, refMap, items..., dropped, route, model, provider, fellBack, primaryError, error }.
async function analyzeAll(jobs, { routes, budget, maskCounts, reasoning = false, concurrency = 3, chatImpl = chat, onDone = () => {} }) {
  const results = new Array(jobs.length);
  let next = 0;
  let stopCode = null; // a run-level cap stops the remaining calls
  async function worker() {
    while (next < jobs.length) {
      const i = next++;
      const job = jobs[i];
      const base = { key: job.key, kind: job.kind, messages: job.messages.length, trimmed: job.trimmed ?? 0 };
      // Skipped calls are neither masked nor sent.
      if (job.capSkipped) { results[i] = { ...base, ok: false, capSkipped: true, error: 'not summarized (cap)' }; onDone(results[i]); continue; }
      const { lines, refMap } = prepare(job.messages, maskCounts);
      base.refMap = refMap;
      if (stopCode) { results[i] = { ...base, ok: false, error: `not sent: ${stopCode}` }; onDone(results[i]); continue; }
      try {
        const r = await chatImpl({
          routes, budget, reasoning,
          system: job.kind === 'customer' ? CUSTOMER_SYSTEM : UNIT_SYSTEM,
          user: renderMessages(job.header, lines),
          maxTokens: job.kind === 'customer' ? 1500 : 800,
        });
        const served = { route: r.route, model: r.model, provider: r.provider, fellBack: Boolean(r.fellBack), retried: Boolean(r.retried),
          primaryError: r.primaryError ?? null, primaryErrors: r.primaryErrors ?? [], costUsd: r.costUsd, usage: r.usage };
        try {
          results[i] = { ...base, ...served, ok: true, ...validate(job.kind, r.json, refMap) };
        } catch (e) {
          results[i] = { ...base, ...served, ok: false, error: e.code ?? 'bad-shape' };
        }
      } catch (e) {
        if (CAP_CODES.has(e.code)) stopCode = e.code;
        results[i] = { ...base, ok: false, error: e.code ?? 'error', route: e.result?.route ?? null, provider: e.result?.provider ?? null,
          fellBack: Boolean(e.fellBack), primaryErrors: e.primaryErrors ?? [] };
      }
      onDone(results[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return results;
}

module.exports = { prepare, validate, sanitize, analyzeAll, planJobs, estimateJob, isCapped, ShapeError };
