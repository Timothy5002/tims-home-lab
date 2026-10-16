'use strict';
// Builds the morning Slack DM from the pipeline's records (src/digest/pipeline.js): a short top-level message and
// up to MAX_REPLIES threaded replies. Slack mrkdwn; model text arrives sanitized and is escaped here; every link is
// built in code. Nothing here ever cuts a sentence: lines are kept whole or left out.
//
// Top-level (hard cap TOP_MAX characters), in this order:
//   1. title line with the date
//   2. "Needs attention": at most 5 customers, ranked; bold name, 🔴 high or 🟠 medium, the short headline written by
//      the synthesis and checked by the verification pass (verbatim), one link, and "(incident)" when one of that
//      customer's points is an incident. A customer whose headline was found unsupported is not shown here.
//   3. "Watch": the names of the other customers with medium or high items
//   4. "Incident": one line for an incident that is not already on a "Needs attention" line
//   5. "Other units": one line per brief-mode unit
//   6. "Skipped": counts of bot noise and quiet channels
// If it would run over the cap, whole pieces are dropped in this order: Watch names, Other-units items and lines,
// the Incident line, then "Needs attention" lines from the bottom (those customers are still in the thread).
//
// Thread: every customer with medium or high items, ranked, each with its full headline, at most 3 bullets (one
// fact each, with links) and the Leadership flag; then the brief units' items and the incidents. Split across up to
// MAX_REPLIES replies of at most REPLY_MAX characters, breaking only between sections. Whatever still does not fit
// is named on one closing "Also notable" line, so nothing is dropped silently. The footer (model, provider,
// fallbacks, cost, unmapped conversations) closes the last reply. Low-severity items never appear in the DM.
const { permalink } = require('../slack');
const { escapeMrkdwn: esc } = require('../slack-send');

const TOP_MAX = 1500;
const REPLY_MAX = 3500;
const MAX_REPLIES = 5;
const MAX_BULLETS = 3;
const ICON = { high: '🔴', medium: '🟠' };

const link = (e, ctx, label = '›') => (e ? `<${permalink(ctx.workspaceUrl, e.conv, e.ts, e.threadTs)}|${label}>` : '');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const join = (...parts) => parts.filter(Boolean).join(' ');

// Packs sections into at most MAX_REPLIES replies of at most REPLY_MAX characters, in order, never splitting a
// section. Returns the replies, or null if they do not fit.
function pack(sections) {
  const replies = [];
  for (const s of sections) {
    const last = replies.length - 1;
    if (last >= 0 && replies[last].length + 2 + s.length <= REPLY_MAX) replies[last] += `\n\n${s}`;
    else if (s.length <= REPLY_MAX && replies.length < MAX_REPLIES) replies.push(s);
    else return null;
  }
  return replies;
}

// model: runPipeline() result; window; ctx: { workspaceUrl, writtenBy }; footer: [string] (stats only).
function buildDm({ model, window, ctx, footer }) {
  const day = new Date(window.end * 1000).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const shown = model.records.filter((r) => r.notable && (r.severity === 'high' || r.severity === 'medium'));
  const need = shown.slice(0, 5).filter((r) => !r.headlineDropped);
  const needKeys = new Set(need.map((r) => r.key));
  const watch = shown.filter((r) => !needKeys.has(r.key));
  const briefUnits = model.units.filter((u) => u.kind === 'brief' && u.status === 'ok');
  const incidentOf = new Set(model.incidents.map((i) => i.customerKey).filter(Boolean));
  // The Incident line: the first incident that is not already marked on a "Needs attention" line.
  const extraIncidents = model.incidents.filter((i) => !needKeys.has(i.customerKey));
  const s = model.skipped;

  function top({ attention, watchNames, unitItems, units, incident }) {
    const lines = [`*Slack digest · ${esc(day)}*`, '', '*Needs attention*'];
    const n = need.slice(0, attention);
    if (n.length) {
      for (const r of n) lines.push(join(`• *${esc(r.name)}* ${ICON[r.severity]}`, esc(r.short), link(r.best, ctx), incidentOf.has(r.key) ? '(incident)' : ''));
    } else lines.push('Nothing urgent.');
    const w = [...need.slice(attention), ...watch];
    if (w.length && watchNames) lines.push('', `*Watch*: ${w.slice(0, watchNames).map((r) => esc(r.name)).join(', ')}${w.length > watchNames ? ` and ${w.length - watchNames} more` : ''}`);
    const inc = extraIncidents[0];
    if (inc && incident) lines.push('', join(`*Incident*: ${esc(inc.source)}: ${esc(inc.summary)}`, link(inc.evidence[0], ctx), extraIncidents.length > 1 ? `(+${extraIncidents.length - 1} in thread)` : ''));
    const u = briefUnits.slice(0, units);
    if (u.length && unitItems) {
      lines.push('', '*Other units*');
      for (const x of u) lines.push(`• ${esc(x.bu)}: ${x.points.length ? x.points.slice(0, unitItems).map((p) => esc(p.summary)).join('; ') : 'nothing notable'}`);
    }
    lines.push('', `*Skipped*: ${plural(s.botHygiene, 'bot-hygiene item', 'bot-hygiene items')}, ${plural(s.botPosts, 'bot post', 'bot posts')}, ${plural(s.quietConversations, 'quiet channel', 'quiet channels')}`);
    return lines.join('\n');
  }

  // Shorten by dropping whole pieces until it fits: Watch names, then Other-units items and lines, then the
  // Incident line, then "Needs attention" lines from the bottom. Never a cut sentence.
  // One straight sequence, each step dropping a little more than the one before.
  const steps = [];
  let st = { attention: need.length, incident: true, units: briefUnits.length, unitItems: 3, watchNames: need.length + watch.length };
  const push = (change) => { st = { ...st, ...change }; steps.push(st); };
  push({});
  for (const w of [8, 5, 3, 0]) if (w < st.watchNames) push({ watchNames: w });
  for (const i of [2, 1]) push({ unitItems: i });
  for (let u = briefUnits.length - 1; u >= 0; u--) push({ units: u });
  push({ incident: false });
  for (let a = need.length - 1; a >= 0; a--) push({ attention: a });
  let text = '';
  let used = null;
  for (const st of steps) {
    text = top(st);
    used = st;
    if (text.length <= TOP_MAX) break;
  }

  // Thread sections: customers first (ranked), then the brief units' items, then the incidents.
  const sections = [];
  for (const r of shown) {
    const pts = r.points.filter((p) => p.severity !== 'low').slice(0, MAX_BULLETS);
    const head = join(`*${esc(r.name)}* ${ICON[r.severity]}`, esc(r.headline), r.leadership ? '_(also discussed in Leadership)_' : '');
    sections.push({ label: `${r.name} (${r.severity})`, text: [head,
      ...pts.map((p) => `• ${p.severity}${p.botReport ? ' · bot report' : ''}: ${esc(p.summary)} ${p.evidence.map((e, i) => link(e, ctx, String(i + 1))).join(' ')}`)].join('\n') });
  }
  if (briefUnits.some((u) => u.points.length)) {
    sections.push({ label: 'Other units', text: ['*Other units*', ...briefUnits.flatMap((u) => u.points.map((p) => join(`• ${esc(u.bu)}: ${esc(p.summary)}`, link(p.evidence[0], ctx))))].join('\n') });
  }
  if (model.incidents.length) {
    sections.push({ label: 'Incidents', text: ['*Incidents*', ...model.incidents.map((i) => join(`• ${esc(i.source)}: ${esc(i.summary)}`, link(i.evidence[0], ctx)))].join('\n') });
  }
  const foot = `_${footer.map(esc).join(' · ')}_`;
  // Keep as many sections as fit; name the rest on one "Also notable" line, then the footer.
  let replies = null;
  let kept = sections.length;
  for (; kept >= 0; kept--) {
    const rest = sections.slice(kept);
    const also = rest.length ? [`*Also notable*: ${rest.map((x) => esc(x.label)).join(', ')}`] : [];
    const body = sections.slice(0, kept).map((x) => x.text);
    replies = pack([...(body.length ? body : ['No medium or high items.']), ...also, foot]);
    if (replies) break;
  }

  return {
    top: text, replies,
    stats: {
      topChars: text.length, replies: replies.length, replyChars: replies.map((r) => r.length),
      needsAttention: Math.min(used.attention, need.length), watch: shown.length - Math.min(used.attention, need.length),
      threadSections: kept, threadSectionsTotal: sections.length,
    },
  };
}

module.exports = { buildDm, TOP_MAX, REPLY_MAX, MAX_REPLIES };
