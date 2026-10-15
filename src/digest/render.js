'use strict';
// Renders the code-only digest (phase 1: no model) as Markdown. For each unit and sub-group it lists active
// conversations with counts, the busiest threads, the latest human messages and compressed bot posts. The
// customer sub-group comes first, and quiet customers collapse to one line. Every snippet links to its message;
// links are built in code (src/slack.js permalink).
const { permalink } = require('../slack');
const { isCapped } = require('./analyze');

const SNIPPET = 160;

// One-line, readable snippet: Slack markup turned into plain text, whitespace collapsed, cut to length.
function snippet(text, nameOf) {
  const s = String(text)
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id) => `@${nameOf(id)}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<!(here|channel|everyone)[^>]*>/g, '@$1')
    .replace(/<(?:https?:\/\/|mailto:)[^>|]+\|([^>]+)>/g, '$1')
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > SNIPPET ? `${s.slice(0, SNIPPET - 1)}…` : s;
}

const hhmm = (ts) => new Date(Number(ts) * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const dayHhmm = (ts) => new Date(Number(ts) * 1000).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

function convLabel(conv, me) {
  if (conv.type !== 'group_dm') return `#${conv.name}`;
  if (!conv.name.startsWith('mpdm-')) return `DM: ${conv.name}`;
  return `DM: ${(conv.memberNames ?? []).filter((n) => n !== me).join(', ')}`;
}

// block: { conv, compressed: { humans, botGroups, stats }, parents, error }
function renderConversation(block, ctx, { threads = 3, latest = 3, botGroups = 5 } = {}) {
  const { conv, compressed, parents } = block;
  const link = (m) => permalink(ctx.workspaceUrl, conv.id, m.ts, m.threadTs);
  const lines = [];
  const humans = compressed.humans;
  const botCount = compressed.stats.botMessagesIn;
  const threadSet = new Map();
  for (const m of [...humans, ...compressed.botGroups.flatMap((g) => g.examples)]) {
    if (m.threadTs) threadSet.set(m.threadTs, (threadSet.get(m.threadTs) ?? 0) + 1);
  }
  lines.push(`#### ${convLabel(conv, ctx.me)}${conv.external ? ' (external)' : ''}`);
  lines.push(`${compressed.stats.messagesIn} messages (${humans.length} from people, ${botCount} from bots), ${parents.size} active ${parents.size === 1 ? 'thread' : 'threads'}`);
  // noCloud conversations are never sent to a model; the digest gives counts only.
  if (conv.noCloud) {
    lines.push('- Not summarized (on the noCloud list): counts only.');
    return lines.join('\n');
  }

  // Busiest threads in the window, named by their first message.
  const replyCounts = new Map();
  for (const m of humans) if (m.isReply) replyCounts.set(m.threadTs, (replyCounts.get(m.threadTs) ?? 0) + 1);
  const topThreads = [...parents.entries()]
    .map(([ts, p]) => ({ p, n: replyCounts.get(ts) ?? 0 }))
    .filter((t) => t.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, threads);
  if (topThreads.length) {
    lines.push('- Threads:');
    for (const { p, n } of topThreads) {
      const since = p.context ? ` (started ${dayHhmm(p.ts)})` : '';
      lines.push(`  - "${snippet(p.text, ctx.nameOf) || '(no text)'}"${since}: ${n} new ${n === 1 ? 'reply' : 'replies'} · [open](${link({ ...p, threadTs: null })})`);
    }
  }
  const recent = humans.slice(-latest).reverse();
  if (recent.length) {
    lines.push('- Latest from people:');
    for (const m of recent) lines.push(`  - ${hhmm(m.ts)} ${ctx.nameOf(m.user)}: "${snippet(m.text, ctx.nameOf)}" · [open](${link(m)})`);
  }
  const groups = [...compressed.botGroups].sort((a, b) => b.alertCount - a.alertCount || b.count - a.count).slice(0, botGroups);
  if (groups.length) {
    lines.push(`- Bot posts (${botCount} compressed to ${compressed.botGroups.length} ${compressed.botGroups.length === 1 ? 'kind' : 'kinds'}):`);
    for (const g of groups) {
      const latestEx = g.examples.at(-1);
      lines.push(`  - ${g.botName ?? 'bot'} × ${g.count}${g.alertCount ? `, ${g.alertCount} with alert words` : ''}: "${snippet(latestEx.text, ctx.nameOf)}" · [latest](${link(latestEx)})`);
      for (const a of g.alerts) lines.push(`    - ⚠ ${hhmm(a.ts)} "${snippet(a.text, ctx.nameOf)}" · [open](${link(a)})`);
    }
    if (compressed.botGroups.length > groups.length) lines.push(`  - …and ${compressed.botGroups.length - groups.length} more kinds`);
  }
  return lines.join('\n');
}

// units: [{ bu, subs: [{ sub, blocks: [...], quiet: [conv], errors: [{ conv, error }], analysis? }] }] in display order.
// With analysis (phase 2) a sub-group shows model items; without it (--no-model) the code-only blocks.
function renderDigest({ units, window, footer, ctx, customerKey }) {
  const out = [];
  out.push(`# Slack digest, ${new Date(window.end * 1000).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}`);
  out.push(`Window: ${new Date(window.start * 1000).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })} to ${new Date(window.end * 1000).toLocaleString('en-CA', { timeStyle: 'short' })} (${window.hours.toFixed(1)} h, ${window.reason}).`);
  out.push(`Written by: ${ctx.writtenBy ?? 'code only (no model)'}.`);
  if (!ctx.analyzed) {
    out.push('', '_Code-only digest: no model was used. It shows activity, thread starters, the latest messages and compressed bot posts, each with a link._');
  } else {
    out.push('', '_Every item links to the messages it is based on. Items without a valid source were dropped._');
  }
  for (const u of units) {
    out.push('', `## ${u.bu}`);
    for (const s of u.subs) {
      const isCustomers = customerKey && u.bu === customerKey.bu && s.sub === customerKey.sub;
      if (ctx.analyzed) {
        out.push(...(isCustomers ? renderCustomers(s, ctx) : renderUnitSummary(s, ctx)));
        continue;
      }
      const title = s.sub ?? '(no sub-group)';
      out.push('', `### ${title}: ${s.blocks.length} active${s.quiet.length ? `, ${s.quiet.length} quiet` : ''}`);
      const opts = isCustomers ? {} : { threads: 2, latest: 2, botGroups: 3 };
      for (const b of s.blocks) out.push('', renderConversation(b, ctx, opts));
      if (s.errors.length) out.push('', `Could not read: ${s.errors.map((e) => `${convLabel(e.conv, ctx.me)} (${e.error})`).join(', ')}`);
      // Quiet customers are named on one line; elsewhere a count is enough.
      if (s.quiet.length) out.push('', isCustomers ? `Quiet: ${s.quiet.map((c) => convLabel(c, ctx.me)).join(', ')}` : `Quiet: ${s.quiet.length} more ${s.quiet.length === 1 ? 'conversation' : 'conversations'} with no messages.`);
    }
  }
  out.push('', '---', ...footer);
  return `${out.join('\n')}\n`;
}

// Links for an item's references, numbered within the item. Built from the reference map, never from model text.
function refLinks(refs, refMap, ctx) {
  return refs.map((r, i) => {
    const m = refMap.get(r);
    return `[${i + 1}](${permalink(ctx.workspaceUrl, m.conv, m.ts, m.threadTs)})`;
  }).join(' ');
}

const count = (b) => b.compressed.stats.messagesIn;
const LEVEL_ORDER = { high: 0, medium: 1, low: 2 };

function renderCustomers(s, ctx) {
  const out = [];
  const results = s.analysis ?? new Map();
  const notable = [];
  const nothing = [];
  const failed = [];
  const capped = [];
  const notSent = [];
  for (const b of s.blocks) {
    if (b.conv.noCloud) { notSent.push(b); continue; }
    const r = results.get(b.conv.id);
    if (isCapped(r)) capped.push(b);
    else if (!r || !r.ok) failed.push({ b, error: r?.error ?? 'not analyzed' });
    else if (r.notable) notable.push({ b, r });
    else nothing.push(b);
  }
  const top = (r) => Math.min(...[...r.wentWrong, ...r.risks].map((i) => LEVEL_ORDER[i.severity ?? i.likelihood] ?? 1));
  notable.sort((x, y) => top(x.r) - top(y.r) || count(y.b) - count(x.b));
  out.push('', `### ${s.sub ?? 'Customers'}: ${notable.length} with something notable, ${nothing.length} active with nothing notable, ${s.quiet.length} quiet`);
  for (const { b, r } of notable) {
    out.push('', `#### ${convLabel(b.conv, ctx.me)}${b.conv.external ? ' (external)' : ''}: ${count(b)} messages${r.trimmed ? ` (oldest ${r.trimmed} not read: per-call cap)` : ''}`);
    if (r.wentWrong.length) {
      out.push('What went wrong:');
      for (const i of r.wentWrong) out.push(`- [${i.severity}] ${i.summary} ${refLinks(i.refs, r.refMap, ctx)}`);
    }
    if (r.risks.length) {
      out.push('Potential risks:');
      for (const i of r.risks) out.push(`- [${i.likelihood}] ${i.summary} ${refLinks(i.refs, r.refMap, ctx)}`);
    }
  }
  if (nothing.length) out.push('', `Nothing notable: ${nothing.map((b) => `${convLabel(b.conv, ctx.me)} (${count(b)})`).join(', ')}`);
  if (s.quiet.length) out.push('', `Quiet: ${s.quiet.map((c) => convLabel(c, ctx.me)).join(', ')}`);
  if (notSent.length) out.push('', `Not summarized (noCloud): ${notSent.map((b) => `${convLabel(b.conv, ctx.me)} (${count(b)} messages)`).join(', ')}`);
  if (capped.length) out.push('', `Not summarized (cap): ${capped.length} ${capped.length === 1 ? 'customer' : 'customers'}, ${capped.reduce((t, b) => t + count(b), 0)} messages: ${capped.map((b) => `${convLabel(b.conv, ctx.me)} (${count(b)})`).join(', ')}`);
  if (failed.length) out.push('', `Not analyzed: ${failed.map(({ b, error }) => `${convLabel(b.conv, ctx.me)} (${count(b)} messages; ${error})`).join(', ')}`);
  if (s.errors.length) out.push('', `Could not read: ${s.errors.map((e) => `${convLabel(e.conv, ctx.me)} (${e.error})`).join(', ')}`);
  return out;
}

function renderUnitSummary(s, ctx) {
  const out = [];
  const sent = s.blocks.filter((b) => !b.conv.noCloud);
  const notSent = s.blocks.filter((b) => b.conv.noCloud);
  out.push('', `### ${s.sub ?? '(no sub-group)'}: ${s.blocks.length} active${s.quiet.length ? `, ${s.quiet.length} quiet` : ''}`);
  const r = s.analysis;
  if (sent.length && isCapped(r)) {
    out.push(`- Not summarized (cap): ${sent.length} ${sent.length === 1 ? 'conversation' : 'conversations'}, ${sent.reduce((t, b) => t + count(b), 0)} messages.`);
  } else if (sent.length && r?.ok) {
    if (r.trimmed) out.push(`- (Oldest ${r.trimmed} messages not read: per-call cap.)`);
    if (r.points.length) for (const p of r.points) out.push(`- ${p.summary} ${refLinks(p.refs, r.refMap, ctx)}`);
    else out.push('- Nothing notable.');
  } else if (sent.length) {
    out.push(`- Not analyzed (${r?.error ?? 'not analyzed'}).`);
  }
  if (sent.length) out.push(`Active: ${sent.map((b) => `${convLabel(b.conv, ctx.me)} (${count(b)})`).join(', ')}`);
  if (notSent.length) out.push(`Not summarized (noCloud): ${notSent.map((b) => `${convLabel(b.conv, ctx.me)} (${count(b)} messages)`).join(', ')}`);
  if (s.errors.length) out.push(`Could not read: ${s.errors.map((e) => `${convLabel(e.conv, ctx.me)} (${e.error})`).join(', ')}`);
  return out;
}

module.exports = { renderDigest, renderConversation, snippet, convLabel, refLinks, LEVEL_ORDER };
