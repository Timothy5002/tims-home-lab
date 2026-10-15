'use strict';
// The Slack digest's model stages: turns fetched messages into model calls and validated items.
//   prepare():   numbers messages (m001... or s001...), masks them (secrets in every conversation, full masking in
//                external ones; see src/mask.js) and keeps a reference map in memory. Text never leaves memory except
//                in the request to the pinned provider.
//   validate():  checks a model reply against the expected shape, keeps only items whose references exist in the
//                reference map, enforces the noise rules (only evidence categories survive; bot hygiene, personnel
//                and other items are dropped and counted), strips anything link- or mention-like from the model's
//                text, and decides in code what is notable, how severe a customer record is, whether it was
//                discussed in Leadership and which items are bot reports. Links are built later from the reference map.
//   planJobs():  fits the calls into the run's input cap before any is sent: customer calls first, then the rest,
//                busiest first within each; a call over the per-call cap keeps its newest messages; whatever does
//                not fit is marked "not summarized (cap)" instead of aborting the run.
//   analyzeAll(): runs the calls through src/openrouter.js (primary, one primary retry, one fallback) at most 3 at
//                a time, under the run's input, output and cost caps.
//   synthesisJob(): builds the stage-2 call for one customer from its stage-1 findings and its mentions.
// Call kinds: customer (stage 1, one conversation), synth (stage 2, one customer), unit (full-mode sub-group),
// brief (brief-mode unit), incident (off-mode unit). Nothing here logs or stores message text or model text.
const { chat, estimateTokens } = require('../openrouter');
const { maskText, maskSecrets } = require('../mask');
const P = require('./prompts');

const MAX_MESSAGE_CHARS = 2000;  // a single very long message is cut before sending
const SUMMARY_CHARS = 200;
const HEADLINE_WORDS = 20;
const BRIEF_WORDS = 12;
const LEVELS = ['high', 'medium', 'low'];
const LEVEL_RANK = { high: 0, medium: 1, low: 2 };
// The noise rules: only these categories are evidence that something is notable.
const EVIDENCE = new Set(['sentiment', 'incident', 'deadline', 'commercial', 'escalation', 'ownership']);

const KINDS = {
  customer: { system: P.CUSTOMER_SYSTEM, maxTokens: 1500, maxItems: 6 },
  synth: { system: P.SYNTH_SYSTEM, maxTokens: 1500, maxItems: 6 },
  unit: { system: P.UNIT_SYSTEM, maxTokens: 800, maxItems: 5 },
  brief: { system: P.BRIEF_SYSTEM, maxTokens: 400, maxItems: 3 },
  incident: { system: P.INCIDENT_SYSTEM, maxTokens: 300, maxItems: 1 },
};

const when = (ts) => new Date(Number(ts) * 1000).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

// messages: [{ conv: { id, external }, ts, threadTs, who, where?, text, bot?, mention? }] sorted by time.
// mention: 'leadership' or 'internal' when the message came from a mention channel.
function prepare(messages, maskCounts, prefix = 'm') {
  const refMap = new Map();
  const lines = messages.map((m, i) => {
    const ref = `${prefix}${String(i + 1).padStart(3, '0')}`;
    refMap.set(ref, { conv: m.conv.id, ts: m.ts, threadTs: m.threadTs ?? null, bot: Boolean(m.bot), mention: m.mention ?? null });
    const cut = m.text.length > MAX_MESSAGE_CHARS ? `${m.text.slice(0, MAX_MESSAGE_CHARS)}…` : m.text;
    const text = m.conv.external ? maskText(cut, maskCounts) : maskSecrets(cut, maskCounts);
    return { ref, when: when(m.ts), who: m.who, where: m.where, text };
  });
  return { lines, refMap };
}

// Model text is shown to a person and may come from a crafted message, so nothing in it may link, mention or
// format: URLs, Slack markup, emails, @-mentions and markdown links are removed, and it is cut to length.
function sanitize(s, max = SUMMARY_CHARS) {
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
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const cutWords = (s, n) => { const w = s.split(' ').filter(Boolean); return w.length > n ? `${w.slice(0, n).join(' ')}…` : s; };
const level = (v) => (LEVELS.includes(String(v).toLowerCase()) ? String(v).toLowerCase() : 'medium');

class ShapeError extends Error {
  constructor(message) { super(message); this.code = 'bad-shape'; }
}

// Counters for what validation dropped, by reason. Counts only.
const newDrops = () => ({ badRef: 0, botHygiene: 0, personnel: 0, notEvidence: 0, overLimit: 0 });

// One list of items. An item survives only with a non-empty summary, at least one reference that exists in this
// call's reference map (unknown references are removed), and, where categories apply, an evidence category.
function keepItems(list, refMap, { maxItems, categories, words }) {
  const drops = newDrops();
  if (list === undefined || list === null) return { items: [], drops };
  if (!Array.isArray(list)) throw new ShapeError('a list field is not a list');
  const items = [];
  for (const it of list) {
    const refs = Array.isArray(it?.refs) ? [...new Set(it.refs.filter((r) => typeof r === 'string' && refMap.has(r)))] : [];
    let summary = sanitize(it?.summary);
    if (words) summary = cutWords(summary, words);
    if (!refs.length || !summary) { drops.badRef++; continue; }
    const category = String(it?.category ?? '').toLowerCase();
    if (category === 'personnel') { drops.personnel++; continue; }
    if (categories) {
      if (category === 'bot-hygiene') { drops.botHygiene++; continue; }
      if (!EVIDENCE.has(category)) { drops.notEvidence++; continue; }
    }
    if (items.length >= maxItems) { drops.overLimit++; continue; }
    const item = { summary, refs: refs.slice(0, 5) };
    if (categories) {
      item.category = category;
      item.severity = level(it.severity);
      item.kind = it.kind === 'risk' ? 'risk' : 'problem';
      // A bot report: every message the item rests on is a bot post. Decided in code, from the reference map.
      item.botReport = item.refs.every((r) => refMap.get(r).bot);
    }
    items.push(item);
  }
  return { items, drops };
}

const sumDrops = (d) => Object.values(d).reduce((a, b) => a + b, 0);

function validate(kind, reply, refMap) {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw new ShapeError('reply is not a JSON object');
  const max = KINDS[kind].maxItems;
  if (kind === 'customer') {
    const { items, drops } = keepItems(reply.items, refMap, { maxItems: max, categories: true });
    items.sort((a, b) => LEVEL_RANK[a.severity] - LEVEL_RANK[b.severity]);
    return { items, notable: items.length > 0, drops, dropped: sumDrops(drops) };
  }
  if (kind === 'synth') {
    const { items: points, drops } = keepItems(reply.points, refMap, { maxItems: max, categories: true });
    points.sort((a, b) => LEVEL_RANK[a.severity] - LEVEL_RANK[b.severity]);
    // Code decides: the record's severity is its strongest kept point; Leadership is flagged only when a kept
    // point cites a Leadership message; the best evidence is the first reference of the strongest point.
    const severity = points.length ? points[0].severity : null;
    let headline = cutWords(sanitize(reply.headline), HEADLINE_WORDS);
    if (points.length && !headline) headline = cutWords(points[0].summary, HEADLINE_WORDS);
    return {
      points, severity, headline: points.length ? headline : '', notable: points.length > 0,
      leadership: points.some((p) => p.refs.some((r) => refMap.get(r).mention === 'leadership')),
      bestRef: points.length ? points[0].refs[0] : null, drops, dropped: sumDrops(drops),
    };
  }
  if (kind === 'incident') {
    if (reply.incident === null || reply.incident === undefined) return { incident: null, drops: newDrops(), dropped: 0 };
    const { items, drops } = keepItems([reply.incident], refMap, { maxItems: 1, words: HEADLINE_WORDS });
    return { incident: items[0] ?? null, drops, dropped: sumDrops(drops) };
  }
  const { items: points, drops } = keepItems(reply.points, refMap, { maxItems: max, words: kind === 'brief' ? BRIEF_WORDS : null });
  return { points, drops, dropped: sumDrops(drops) };
}

// Estimated input tokens for one call, the same way the client estimates (characters / 4), with a per-message
// allowance for the reference, time, author and JSON quoting around each message.
const PER_MESSAGE_OVERHEAD = 15;
function estimateJob(job) {
  return estimateTokens(KINDS[job.kind].system) + estimateTokens(job.header ?? '') + 50
    + job.messages.reduce((t, m) => t + estimateTokens(String(m.text).slice(0, MAX_MESSAGE_CHARS)) + PER_MESSAGE_OVERHEAD, 0)
    + (job.findings ?? []).reduce((t, f) => t + estimateTokens(f.summary) + 20, 0);
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

// Stage 2 for one customer. stage1: [{ result (ok customer result), messages }] for its conversations; mentions:
// messages from mention channels that name the customer (mention set). The evidence is every message a stage-1
// item cites plus the mentions (newest maxMentions), renumbered s001...; findings cite those numbers.
function synthesisJob(customer, stage1, mentions, { maxMentions = 25 } = {}) {
  const evidence = [];
  const index = new Map(); // "conv:ts" -> position in evidence
  const add = (m) => {
    const k = `${m.conv.id}:${m.ts}`;
    if (!index.has(k)) { index.set(k, evidence.length); evidence.push(m); }
    return index.get(k);
  };
  const raw = [];
  for (const { result, messages } of stage1) {
    const byRef = new Map(messages.map((m, i) => [`m${String(i + 1).padStart(3, '0')}`, m]));
    for (const it of result.items) raw.push({ ...it, msgs: it.refs.map((r) => byRef.get(r)).filter(Boolean) });
  }
  const sortedMentions = [...mentions].sort((a, b) => Number(a.ts) - Number(b.ts)).slice(-maxMentions);
  // Evidence in time order, so the model reads it as a timeline.
  for (const m of [...raw.flatMap((f) => f.msgs), ...sortedMentions].sort((a, b) => Number(a.ts) - Number(b.ts))) add(m);
  const findings = raw.map((f) => ({ summary: f.summary, kind: f.kind, severity: f.severity, category: f.category,
    refs: f.msgs.map((m) => `s${String(index.get(`${m.conv.id}:${m.ts}`) + 1).padStart(3, '0')}`) }));
  return { kind: 'synth', key: customer.key, customer, header: null, messages: evidence, findings, mentions: sortedMentions.length };
}

// Builds the prompt for one job (after prepare).
function userPrompt(job, lines) {
  return job.kind === 'synth' ? P.renderSynthesis(job.customer.name, lines, job.findings) : P.renderMessages(job.header, lines);
}

// jobs: [{ kind, key, header, messages, findings?, capSkipped? }]. Returns one result per job:
// { key, kind, ok, refMap, ...validated fields, drops, dropped, route, model, provider, fellBack, retried, error }.
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
      const { lines, refMap } = prepare(job.messages, maskCounts, job.kind === 'synth' ? 's' : 'm');
      base.refMap = refMap;
      if (stopCode) { results[i] = { ...base, ok: false, error: `not sent: ${stopCode}` }; onDone(results[i]); continue; }
      try {
        const r = await chatImpl({ routes, budget, reasoning, system: KINDS[job.kind].system, user: userPrompt(job, lines), maxTokens: KINDS[job.kind].maxTokens });
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

module.exports = {
  prepare, validate, sanitize, analyzeAll, planJobs, estimateJob, synthesisJob, isCapped, cutWords, newDrops,
  ShapeError, EVIDENCE, LEVEL_RANK, KINDS,
};
