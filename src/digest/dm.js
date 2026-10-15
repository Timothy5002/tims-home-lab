'use strict';
// Builds the short Slack DM that announces each morning's digest (the full digest file is uploaded after it).
// Order: the date and the model header; the customer group's risks (each customer with problems or risks, one
// line per item with its link); one short line per other unit; then counts of what was not summarized. It stays
// under MAX_CHARS by dropping the lowest items and saying how many more are in the file.
//
// Only validated, sanitized model items are used (src/digest/analyze.js), escaped for Slack, and every link is
// built in code from the reference map. The text is returned to the caller for sending; it is never logged.
const { permalink } = require('../slack');
const { escapeMrkdwn } = require('../slack-send');
const { convLabel, LEVEL_ORDER } = require('./render');
const { isCapped } = require('./analyze');

const MAX_CHARS = 2900;
const UNIT_LINE_CHARS = 160;

const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function link(ref, refMap, ctx) {
  const m = refMap.get(ref);
  return m ? ` <${permalink(ctx.workspaceUrl, m.conv, m.ts, m.threadTs)}|link>` : '';
}

// units, ctx, customerKey and window as passed to renderDigest; counts: { noCloud: { conversations, messages },
// unreadable } from the run.
function buildDm({ units, ctx, customerKey, window, counts }) {
  const day = new Date(window.end * 1000).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const head = [`*Slack digest, ${escapeMrkdwn(day)}* (${window.hours.toFixed(1)} h)`, `Model: ${escapeMrkdwn(ctx.writtenBy ?? 'code only (no model)')}`];

  // Customer items, most severe first, one line each.
  const items = [];
  let customersWithItems = 0;
  const capped = { calls: 0, messages: 0 };
  let failed = 0;
  const unitLines = [];
  for (const u of units) {
    let active = 0;
    let points = [];
    let unitCapped = 0;
    for (const s of u.subs) {
      const isCustomers = customerKey && u.bu === customerKey.bu && s.sub === customerKey.sub;
      if (isCustomers) {
        for (const b of s.blocks) {
          if (b.conv.noCloud) continue;
          const r = s.analysis?.get(b.conv.id);
          if (isCapped(r)) { capped.calls++; capped.messages += b.compressed.stats.messagesIn; continue; }
          if (!r?.ok) { failed++; continue; }
          if (!r.notable) continue;
          customersWithItems++;
          for (const i of [...r.wentWrong.map((x) => ({ ...x, level: x.severity, kind: 'problem' })), ...r.risks.map((x) => ({ ...x, level: x.likelihood, kind: 'risk' }))]) {
            items.push({ order: LEVEL_ORDER[i.level] ?? 1, line: `• ${escapeMrkdwn(convLabel(b.conv, ctx.me))}: [${i.level} ${i.kind}] ${escapeMrkdwn(i.summary)}${link(i.refs[0], r.refMap, ctx)}` });
          }
        }
        continue;
      }
      const sent = s.blocks.filter((b) => !b.conv.noCloud);
      active += s.blocks.length;
      if (!sent.length) continue;
      const r = s.analysis;
      if (isCapped(r)) { capped.calls++; capped.messages += sent.reduce((t, b) => t + b.compressed.stats.messagesIn, 0); unitCapped++; continue; }
      if (!r?.ok) { failed++; continue; }
      points = points.concat(r.points.map((p) => ({ p, refMap: r.refMap })));
    }
    if (!active) continue;
    const top = points[0];
    const tail = top ? `: ${escapeMrkdwn(cut(top.p.summary, UNIT_LINE_CHARS))}${link(top.p.refs[0], top.refMap, ctx)}${points.length > 1 ? ` (+${points.length - 1} more)` : ''}`
      : unitCapped ? ': not summarized (cap)' : ': nothing notable';
    unitLines.push(`• ${escapeMrkdwn(u.bu)}: ${plural(active, 'active conversation', 'active conversations')}${tail}`);
  }
  items.sort((a, b) => a.order - b.order);

  const notSummarized = [
    counts.noCloud.conversations ? `${plural(counts.noCloud.conversations, 'conversation', 'conversations')} on the noCloud list (${counts.noCloud.messages} messages)` : null,
    capped.calls ? `${plural(capped.calls, 'call', 'calls')} over the cap (${capped.messages} messages)` : null,
    failed ? `${plural(failed, 'call', 'calls')} failed` : null,
    counts.unreadable ? `${plural(counts.unreadable, 'conversation', 'conversations')} unreadable` : null,
  ].filter(Boolean);
  const riskTitle = `*${escapeMrkdwn(customerKey?.bu ?? 'Customer')} risks*: ${customersWithItems ? plural(customersWithItems, 'customer', 'customers') + ' with problems or risks' : 'none found'}`;
  const tailLines = [
    ...(unitLines.length ? ['', '*Other units*', ...unitLines] : []),
    '', `*Not summarized*: ${notSummarized.length ? notSummarized.join('; ') : 'nothing'}`,
    'Full digest attached.',
  ];

  // Fit under MAX_CHARS: unit lines and the tail always stay; customer items are cut from the least severe.
  const assemble = (n) => [...head, '', riskTitle, ...items.slice(0, n).map((i) => i.line),
    ...(n < items.length ? [`…and ${items.length - n} more in the file`] : []), ...tailLines].join('\n');
  let n = items.length;
  let text = assemble(n);
  while (text.length > MAX_CHARS && n > 0) text = assemble(--n);
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS - 30)}\n…(cut; see the file)`;
  return { text, stats: { chars: text.length, customerItems: items.length, customerItemsShown: n, customersWithItems } };
}

module.exports = { buildDm, MAX_CHARS };
