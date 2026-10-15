'use strict';
// Builds the morning Slack DM from the pipeline's records (src/digest/pipeline.js): a short top-level message and
// one threaded reply. Slack mrkdwn; model text arrives sanitized and is escaped here; every link is built in code.
//
// Top-level (hard cap TOP_MAX characters), in this order:
//   1. title line with the date
//   2. "Needs attention": at most 5 customers, ranked; bold name, 🔴 high or 🟠 medium, the headline, one link
//   3. "Watch": the other customers with medium or high items, each name plus at most 6 words
//   4. "Incident": one line if an outage or incident happened
//   5. "Other units": one line per brief-mode unit
//   6. "Skipped": counts of bot noise and quiet channels
// Thread reply (cap THREAD_MAX): per-customer bullets with links (medium and high only), the brief units' items
// with links, other incidents, and the footer (model, provider, retries, fallbacks, cost).
// Low-severity items never appear here; they stay in the archive file. If the top-level would run long, it is
// shortened in steps (Watch descriptions, unit items, then fewer "Needs attention" lines moving to Watch).
const { permalink } = require('../slack');
const { escapeMrkdwn: esc } = require('../slack-send');

const TOP_MAX = 1500;
const THREAD_MAX = 3900;
const ICON = { high: '🔴', medium: '🟠' };

const cutWords = (s, n) => { const w = String(s).split(' ').filter(Boolean); return w.length > n ? `${w.slice(0, n).join(' ')}…` : w.join(' '); };
const link = (e, ctx, label = '›') => (e ? `<${permalink(ctx.workspaceUrl, e.conv, e.ts, e.threadTs)}|${label}>` : '');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// model: runPipeline() result; window; ctx: { workspaceUrl, writtenBy }; footer: [string] (stats only).
function buildDm({ model, window, ctx, footer }) {
  const day = new Date(window.end * 1000).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const shown = model.records.filter((r) => r.notable && (r.severity === 'high' || r.severity === 'medium'));
  const briefUnits = model.units.filter((u) => u.kind === 'brief' && u.status === 'ok');
  const s = model.skipped;

  function top({ attention, watchWords, unitItems, headlineWords }) {
    const lines = [`*Slack digest · ${esc(day)}*`];
    const need = shown.slice(0, attention);
    const watch = shown.slice(attention);
    lines.push('', '*Needs attention*');
    if (need.length) for (const r of need) lines.push(`• *${esc(r.name)}* ${ICON[r.severity]} ${esc(cutWords(r.headline, headlineWords))} ${link(r.best, ctx)}`);
    else lines.push('Nothing urgent.');
    if (watch.length) lines.push('', `*Watch*: ${watch.map((r) => (watchWords ? `${esc(r.name)} (${esc(cutWords(r.headline, watchWords))})` : esc(r.name))).join(', ')}`);
    const inc = model.incidents[0];
    if (inc) lines.push('', `*Incident*: ${esc(inc.source)}: ${esc(cutWords(inc.summary, 20))} ${link(inc.evidence[0], ctx)}${model.incidents.length > 1 ? ` (+${model.incidents.length - 1} in thread)` : ''}`);
    if (briefUnits.length) {
      lines.push('', '*Other units*');
      for (const u of briefUnits) lines.push(`• ${esc(u.bu)}: ${u.points.length ? u.points.slice(0, unitItems).map((p) => esc(p.summary)).join('; ') : 'nothing notable'}`);
    }
    lines.push('', `*Skipped*: ${plural(s.botHygiene, 'bot-hygiene item', 'bot-hygiene items')}, ${plural(s.botPosts, 'bot post', 'bot posts')}, ${plural(s.quietConversations, 'quiet channel', 'quiet channels')}`);
    return lines.join('\n');
  }

  // Shorten step by step until it fits the hard cap.
  const steps = [];
  for (const attention of [5, 4, 3, 2, 1]) {
    for (const [watchWords, unitItems, headlineWords] of [[6, 3, 20], [6, 2, 20], [3, 2, 16], [0, 1, 14], [0, 1, 10]]) steps.push({ attention, watchWords, unitItems, headlineWords });
  }
  let text = '';
  let used = steps[0];
  for (const st of steps) {
    used = st;
    text = top(st);
    if (text.length <= TOP_MAX) break;
  }
  if (text.length > TOP_MAX) text = `${text.slice(0, TOP_MAX - 2)}…`;

  // Thread: details for medium and high only, then brief units with links, other incidents, then the footer.
  const foot = ['', '_' + footer.map(esc).join(' · ') + '_'].join('\n');
  const parts = [];
  for (const r of shown) {
    const pts = r.points.filter((p) => p.severity !== 'low');
    parts.push([`*${esc(r.name)}* ${ICON[r.severity]} ${esc(r.headline)}${r.leadership ? ' _(also discussed in Leadership)_' : ''}`,
      ...pts.map((p) => `• ${p.severity}${p.botReport ? ' · bot report' : ''}: ${esc(p.summary)} ${p.evidence.map((e, i) => link(e, ctx, String(i + 1))).join(' ')}`)].join('\n'));
  }
  if (briefUnits.some((u) => u.points.length)) {
    parts.push(['*Other units*', ...briefUnits.flatMap((u) => u.points.map((p) => `• ${esc(u.bu)}: ${esc(p.summary)} ${link(p.evidence[0], ctx)}`))].join('\n'));
  }
  if (model.incidents.length > 1) parts.push(['*Incidents*', ...model.incidents.map((i) => `• ${esc(i.source)}: ${esc(i.summary)} ${link(i.evidence[0], ctx)}`)].join('\n'));
  let thread = '';
  let included = 0;
  for (const p of parts) {
    const next = `${thread}${thread ? '\n\n' : ''}${p}`;
    if (next.length + foot.length + 60 > THREAD_MAX) break;
    thread = next;
    included++;
  }
  if (included < parts.length) thread += `\n\n…${parts.length - included} more ${parts.length - included === 1 ? 'section' : 'sections'} in the archive file on the mini.`;
  if (!thread) thread = 'No medium or high items.';
  thread += `\n${foot}`;

  return {
    top: text, thread,
    stats: { topChars: text.length, threadChars: thread.length, needsAttention: Math.min(used.attention, shown.length), watch: Math.max(0, shown.length - used.attention), threadSections: included, threadSectionsTotal: parts.length },
  };
}

module.exports = { buildDm, TOP_MAX, THREAD_MAX };
