'use strict';
// Renders the code-only digest (phase 1: no model) as Markdown. For each unit and sub-group it lists active
// conversations with counts, the busiest threads, the latest human messages and compressed bot posts. The
// customer sub-group comes first, and quiet customers collapse to one line. Every snippet links to its message;
// links are built in code (src/slack.js permalink).
const { permalink } = require('../slack');

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

// units: [{ bu, subs: [{ sub, blocks: [...], quiet: [conv], errors: [{ conv, error }] }] }] in display order
function renderDigest({ units, window, footer, ctx, customerKey }) {
  const out = [];
  out.push(`# Slack digest, ${new Date(window.end * 1000).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}`);
  out.push(`Window: ${new Date(window.start * 1000).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })} to now (${window.hours.toFixed(1)} h, ${window.reason}).`);
  out.push('');
  out.push('_Code-only preview (phase 1). No model was used: this shows activity, thread starters, the latest messages and compressed bot posts, each with a link. Risk extraction comes in phase 2._');
  for (const u of units) {
    out.push('', `## ${u.bu}`);
    for (const s of u.subs) {
      const isCustomers = customerKey && u.bu === customerKey.bu && s.sub === customerKey.sub;
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

module.exports = { renderDigest, renderConversation, snippet, convLabel };
