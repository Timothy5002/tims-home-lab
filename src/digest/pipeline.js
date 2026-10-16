'use strict';
// The Slack digest's model pipeline: from fetched, compressed conversations to customer records and unit lines.
//   1. Sort each active conversation by its unit's mode (config/slack-digest.json "unitModes"):
//      - customer conversations (the registry, src/digest/customers.js) in a full-mode unit: stage-1 extraction,
//        one call per conversation
//      - other full-mode sub-groups: one unit summary each (archive file only)
//      - brief-mode units: one call per unit, at most 3 one-line items
//      - off-mode units: one incident check per unit (only an outage or incident that affects customers)
//      - the registry's "other" bucket (customer-unit conversations that are not customers): one brief call under
//        the bucket's name, at most 3 one-line items, never a customer record
//      Conversations where the user is the main poster are left out of unit and brief summaries (counted).
//      noCloud conversations are never sent anywhere, including as mentions.
//   2. Find customer mentions in the mention channels (Leadership, Internal) by alias, in code.
//   3. Plan stage 1 under the caps (customers first, busiest first; a share of the run cap is kept for stage 2),
//      then run it.
//   4. Stage 2: one synthesis call per customer with findings or mentions, merging all its channels into one record.
//      If it fails, the record falls back to the stage-1 findings, unmerged.
//   5. Verification: for each customer that will be shown under "Needs attention" (the top 5 with medium or high
//      severity), one cheap call checks the headline against ONLY the messages it cites. Overstated headlines are
//      replaced by the corrected text (marked "softened" in the archive only); unsupported ones are dropped, and that
//      customer is not shown under "Needs attention".
// Extraction runs 2 calls at a time, synthesis and verification 3; with `verify` (the batch provider check), each
// stage's served providers are checked in one batch after the stage. Phase times are returned in `timing`.
// Returns records, unit lines, incidents, skipped counts and stats. No text is logged or stored here; the caller
// renders the archive file and the DM from the returned items (validated, sanitized model text and code-built
// evidence references).
const { analyzeAll, planJobs, synthesisJob, verifyJob, isCapped, newDrops, LEVEL_RANK, SHORT_WORDS } = require('./analyze');
const { mentionedCustomers } = require('./customers');

const SYNTH_RESERVE = 0.15; // share of the run cap kept for stage 2
const NEEDS_ATTENTION = 5;  // customers shown under "Needs attention" in the DM, each with a checked headline
const CONCURRENCY = { extraction: 2, synthesis: 3, verification: 3 };
const words = (s) => String(s).split(' ').filter(Boolean).length;

const modeOf = (modes, conv) => modes[`${conv.bu} > ${conv.sub ?? '-'}`] ?? modes[conv.bu] ?? 'brief';
const count = (b) => b.compressed.stats.messagesIn;

// Messages a model may see for one conversation: people's messages and the kept bot lines (examples and alerts).
function toMessages(b, nameOf, where) {
  return [
    ...b.compressed.humans.map((m) => ({ ts: m.ts, threadTs: m.threadTs, who: nameOf(m.user), user: m.user, text: m.text, bot: false })),
    ...b.compressed.botGroups.flatMap((g) => [...g.examples, ...g.alerts].map((m) => ({
      ts: m.ts, threadTs: m.threadTs, who: `${g.botName ?? 'bot'} (bot${g.count > 1 ? `, ${g.count} similar posts` : ''})`, text: m.text, bot: true,
    }))),
  ].map((m) => ({ ...m, conv: { id: b.conv.id, external: b.conv.external }, where })).sort((x, y) => Number(x.ts) - Number(y.ts));
}

// The user is the main poster when they wrote more than half of the people's messages.
function mainlyMine(b, me) {
  const humans = b.compressed.humans;
  return Boolean(me) && humans.length > 0 && humans.filter((m) => m.user === me).length * 2 > humans.length;
}

const addDrops = (into, d) => { for (const k of Object.keys(into)) into[k] += d?.[k] ?? 0; };
const resolve = (refs, refMap) => refs.map((r) => refMap.get(r));

// blocks: [{ conv: { id, label, bu, sub, external, noCloud }, compressed, error }]; registry from buildRegistry().
// startGapMs: the least time between the starts of two model calls (src/digest/analyze.js). verify: the batch
// provider check (src/openrouter.js verifyGenerations); omitted in tests, where each stub call is its own check.
async function runPipeline({ blocks, registry, modes, me, nameOf, routes, budget, maskCounts, runCap, callCap, reasoning = false, startGapMs, verify, concurrency = CONCURRENCY, chatImpl, onDone = () => {} }) {
  const stage = (jobs, kind, counts = maskCounts) => analyzeAll(jobs, { routes, budget, maskCounts: counts, reasoning, startGapMs, verify, concurrency: concurrency[kind], chatImpl, onDone });
  const skipped = { quietConversations: 0, botPosts: 0, ownConversations: 0, noCloudConversations: 0, ...newDrops() };
  const active = [];
  for (const b of blocks) {
    if (b.error) continue;
    if (!count(b)) { skipped.quietConversations++; continue; }
    skipped.botPosts += b.compressed.stats.botMessagesIn;
    if (b.conv.noCloud) { skipped.noCloudConversations++; continue; }
    active.push(b);
  }

  // 1. Sort into calls.
  const customerName = new Map(registry.customers.map((c) => [c.key, c]));
  const stage1 = [];
  const unitGroups = new Map(); // key -> { kind, bu, sub, blocks }
  for (const b of active) {
    const mode = modeOf(modes, b.conv);
    const custKey = registry.byConv.get(b.conv.id);
    if (registry.other?.convIds.has(b.conv.id)) {
      if (mainlyMine(b, me)) { skipped.ownConversations++; continue; }
      const k = `brief:${registry.other.name}`;
      if (!unitGroups.has(k)) unitGroups.set(k, { kind: 'brief', bu: registry.other.name, sub: null, blocks: [] });
      unitGroups.get(k).blocks.push(b);
      continue;
    }
    if (custKey && mode !== 'off') {
      const cust = customerName.get(custKey);
      stage1.push({ kind: 'customer', key: b.conv.id, custKey, block: b,
        header: `Customer: ${JSON.stringify(cust.name)}. Channel: ${b.conv.label}${b.conv.external ? ' (shared with the customer)' : ''}.`,
        messages: toMessages(b, nameOf, null) });
      continue;
    }
    if (mode === 'off') {
      const k = `incident:${b.conv.bu}`;
      if (!unitGroups.has(k)) unitGroups.set(k, { kind: 'incident', bu: b.conv.bu, sub: null, blocks: [] });
      unitGroups.get(k).blocks.push(b);
      continue;
    }
    if (mainlyMine(b, me)) { skipped.ownConversations++; continue; }
    const k = mode === 'full' ? `unit:${b.conv.bu} > ${b.conv.sub ?? '-'}` : `brief:${b.conv.bu}`;
    if (!unitGroups.has(k)) unitGroups.set(k, { kind: mode === 'full' ? 'unit' : 'brief', bu: b.conv.bu, sub: mode === 'full' ? b.conv.sub : null, blocks: [] });
    unitGroups.get(k).blocks.push(b);
  }
  for (const [key, g] of unitGroups) {
    const what = g.kind === 'unit' ? `Unit: ${g.bu}. Sub-group: ${g.sub ?? '(none)'}.` : `Unit: ${g.bu}.`;
    stage1.push({ kind: g.kind, key, group: g, header: `${what} Conversations: ${g.blocks.map((b) => b.conv.label).join(', ')}.`,
      messages: g.blocks.flatMap((b) => toMessages(b, nameOf, b.conv.label)).sort((x, y) => Number(x.ts) - Number(y.ts)) });
  }

  // 2. Mentions of customers in the mention channels (code only; the text is tested, not kept).
  const mentions = new Map(); // customer key -> [message]
  for (const b of active) {
    const kind = registry.mentionConvs.get(b.conv.id);
    if (!kind) continue;
    for (const m of toMessages(b, nameOf, `${b.conv.label}${kind === 'leadership' ? ' (leadership)' : ' (internal)'}`)) {
      for (const key of mentionedCustomers(m.text, registry)) {
        if (!mentions.has(key)) mentions.set(key, []);
        mentions.get(key).push({ ...m, mention: kind });
      }
    }
  }

  // 3. Stage 1 under the caps.
  const plan = planJobs(stage1, { runCap: Math.floor(runCap * (1 - SYNTH_RESERVE)), callCap });
  const r1 = await stage(stage1, 'extraction');

  // 4. Stage 2 per customer.
  const byCustomer = new Map();
  for (const [i, job] of stage1.entries()) {
    if (job.kind !== 'customer') continue;
    if (!byCustomer.has(job.custKey)) byCustomer.set(job.custKey, []);
    byCustomer.get(job.custKey).push({ job, result: r1[i] });
  }
  for (const key of mentions.keys()) if (!byCustomer.has(key)) byCustomer.set(key, []);
  const synthJobs = [];
  for (const [key, list] of byCustomer) {
    const ok = list.filter((x) => x.result.ok);
    const hasFindings = ok.some((x) => x.result.items.length);
    if (!hasFindings && !(mentions.get(key)?.length)) continue;
    synthJobs.push(synthesisJob(customerName.get(key), ok.map((x) => ({ result: x.result, messages: x.job.messages })), mentions.get(key) ?? []));
  }
  // Stage 2 re-sends text already counted, so its masking counts go to a throwaway counter.
  const throwaway = () => ({ email: 0, phone: 0, number: 0, url: 0, secret: 0 });
  const r2 = synthJobs.length ? await stage(synthJobs, 'synthesis', throwaway()) : Object.assign([], { meta: null });
  const synthBy = new Map(synthJobs.map((j, i) => [j.key, r2[i]]));
  const synthJobBy = new Map(synthJobs.map((j) => [j.key, j]));

  // Records: one per customer with activity or mentions.
  const records = [];
  for (const [key, list] of byCustomer) {
    const cust = customerName.get(key);
    const rec = {
      key, name: cust.name, unmatched: cust.unmatched,
      convs: list.map(({ job, result }) => ({ id: job.block.conv.id, label: job.block.conv.label, external: job.block.conv.external, messages: count(job.block),
        status: result.ok ? 'ok' : isCapped(result) ? 'cap' : 'failed', error: result.ok ? null : result.error, trimmed: result.trimmed ?? 0 })),
      mentions: (mentions.get(key) ?? []).length,
      leadershipMentions: (mentions.get(key) ?? []).filter((m) => m.mention === 'leadership').length,
      points: [], severity: null, headline: '', leadership: false, best: null, merged: false, synthError: null,
    };
    for (const { result } of list) if (result.ok) addDrops(skipped, result.drops);
    const s = synthBy.get(key);
    if (s?.ok) {
      addDrops(skipped, s.drops);
      const sj = synthJobBy.get(key);
      const byRef = new Map(sj.messages.map((m, i) => [`s${String(i + 1).padStart(3, '0')}`, m]));
      Object.assign(rec, {
        merged: true, severity: s.severity, headline: s.headline, short: s.short, leadership: s.leadership,
        points: s.points.map((p) => ({ ...p, evidence: resolve(p.refs, s.refMap) })),
        best: s.bestRef ? s.refMap.get(s.bestRef) : null,
        headlineMessages: s.headlineRefs.map((r) => byRef.get(r)).filter(Boolean), // for the check; never stored
      });
    } else {
      // Fallback: stage-1 findings, unmerged, strongest first.
      if (s) rec.synthError = isCapped(s) ? 'cap' : s.error;
      const items = list.filter((x) => x.result.ok).flatMap((x) => x.result.items.map((it) => ({ ...it, evidence: resolve(it.refs, x.result.refMap) })))
        .sort((a, b) => LEVEL_RANK[a.severity] - LEVEL_RANK[b.severity]);
      rec.points = items;
      rec.severity = items[0]?.severity ?? null;
      // Never cut: the strongest finding stands as the headline, and as the short one only if it is short enough.
      rec.headline = items[0]?.summary ?? '';
      rec.short = items[0] && words(items[0].summary) <= SHORT_WORDS ? items[0].summary : '';
      rec.best = items[0]?.evidence[0] ?? null;
      const msgs = list.flatMap((x) => x.job.messages);
      rec.headlineMessages = (items[0]?.evidence ?? []).map((e) => msgs.find((m) => m.conv.id === e.conv && m.ts === e.ts)).filter(Boolean);
    }
    rec.notable = rec.points.length > 0;
    records.push(rec);
  }
  records.sort(rankRecords);

  // 5. The headline check, for the customers "Needs attention" would show.
  const candidates = records.filter((r) => r.notable && (r.severity === 'high' || r.severity === 'medium') && r.headline && r.headlineMessages?.length).slice(0, NEEDS_ATTENTION);
  const verifyJobs = candidates.map((r) => verifyJob(r, r.headlineMessages));
  const r3 = verifyJobs.length ? await stage(verifyJobs, 'verification', throwaway()) : Object.assign([], { meta: null });
  const verification = { checked: r3.length, supported: 0, overstated: 0, unsupported: 0, failed: 0 };
  candidates.forEach((rec, i) => {
    const v = r3[i];
    if (!v.ok) { rec.verify = 'failed'; verification.failed++; return; }
    rec.verify = v.verdict;
    verification[v.verdict]++;
    if (v.verdict === 'overstated') Object.assign(rec, { headline: v.headline, short: v.short, softened: true });
    if (v.verdict === 'unsupported') Object.assign(rec, { headline: '', short: '', headlineDropped: true });
  });
  for (const rec of records) delete rec.headlineMessages; // message text is not kept past this point

  // Units and incidents.
  const units = [];
  const incidents = [];
  for (const [i, job] of stage1.entries()) {
    if (job.kind === 'customer') continue;
    const r = r1[i];
    const g = job.group;
    if (r.ok) addDrops(skipped, r.drops);
    const base = { kind: job.kind, bu: g.bu, sub: g.sub, conversations: g.blocks.map((b) => ({ label: b.conv.label, messages: count(b) })),
      status: r.ok ? 'ok' : isCapped(r) ? 'cap' : 'failed', error: r.ok ? null : r.error };
    if (job.kind === 'incident') {
      if (r.ok && r.incident) incidents.push({ source: g.bu, summary: r.incident.summary, evidence: resolve(r.incident.refs, r.refMap) });
      units.push({ ...base, points: [] });
    } else {
      units.push({ ...base, points: r.ok ? r.points.map((p) => ({ ...p, evidence: resolve(p.refs, r.refMap) })) : [] });
    }
  }
  // Customer incidents (medium or high) join the incident list.
  for (const rec of records) {
    for (const p of rec.points) if (p.category === 'incident' && p.severity !== 'low') incidents.push({ source: rec.name, customerKey: rec.key, severity: p.severity, summary: p.summary, evidence: p.evidence });
  }
  incidents.sort((a, b) => (LEVEL_RANK[a.severity ?? 'medium']) - (LEVEL_RANK[b.severity ?? 'medium']));

  const all = [...r1, ...r2, ...r3];
  const metas = [r1.meta, r2.meta, r3.meta].filter(Boolean);
  const capped = all.filter((r) => isCapped(r));
  return {
    records, units, incidents, skipped, results: all, plan,
    timing: {
      extractionMs: r1.meta?.modelMs ?? 0, synthesisMs: r2.meta?.modelMs ?? 0, verificationMs: r3.meta?.modelMs ?? 0,
      providerCheckMs: metas.reduce((t, m) => t + m.providerCheckMs, 0),
    },
    providerChecks: {
      checked: metas.reduce((t, m) => t + m.providerChecked, 0), mismatches: metas.reduce((t, m) => t + m.providerMismatches, 0),
      reruns: metas.reduce((t, m) => t + m.reruns, 0),
    },
    stats: {
      verification,
      calls: { stage1: r1.length, synthesis: r2.length, verification: r3.length },
      customersWithActivity: records.length,
      customersMerged: records.filter((r) => r.merged).length,
      customersNotable: records.filter((r) => r.notable).length,
      customersFallback: records.filter((r) => r.notable && !r.merged).length,
      mentionMessages: [...mentions.values()].reduce((t, l) => t + l.length, 0),
      itemsKept: records.reduce((t, r) => t + r.points.length, 0) + units.reduce((t, u) => t + u.points.length, 0) + incidents.filter((x) => !x.severity).length,
      itemsDropped: { badRef: skipped.badRef, botHygiene: skipped.botHygiene, personnel: skipped.personnel, notEvidence: skipped.notEvidence, overLimit: skipped.overLimit },
      notSummarizedCap: { calls: capped.length, messages: capped.reduce((t, r) => t + (r.messages ?? 0), 0), trimmedCalls: plan.trimmedCalls, trimmedMessages: plan.trimmedMessages },
    },
  };
}

// Most urgent first: severity, then discussed in Leadership, then how many high and medium points, then volume.
function rankRecords(a, b) {
  const sev = (r) => (r.severity ? LEVEL_RANK[r.severity] : 9);
  const strong = (r) => r.points.filter((p) => p.severity !== 'low').length;
  const msgs = (r) => r.convs.reduce((t, c) => t + c.messages, 0) + r.mentions;
  return sev(a) - sev(b) || Number(b.leadership) - Number(a.leadership) || strong(b) - strong(a) || msgs(b) - msgs(a);
}

module.exports = { runPipeline, rankRecords, modeOf, mainlyMine, toMessages, NEEDS_ATTENTION, CONCURRENCY };
