'use strict';
// Renders the digest file (data/digests/<date>.md) as Markdown, in one of two forms:
//   renderArchive(): the model digest, merged by customer: each customer's severity, headline, Leadership flag and
//                    supporting points (every severity, low included; the file is the archive), then the unit lines,
//                    incidents, what was skipped or not summarized, and the footer.
//   renderDigest():  the code-only digest (--no-model): per conversation, counts, the busiest threads, the latest
//                    messages and compressed bot posts.
// Every link is built in code (src/slack.js permalink) from evidence references; model text arrives sanitized.
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

// units: [{ bu, subs: [{ sub, blocks, quiet, errors }] }] in display order. Code-only digest (--no-model).
function renderDigest({ units, window, footer, ctx, customerKey }) {
  const out = [];
  out.push(`# Slack digest, ${new Date(window.end * 1000).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}`);
  out.push(`Window: ${new Date(window.start * 1000).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })} to ${new Date(window.end * 1000).toLocaleString('en-CA', { timeStyle: 'short' })} (${window.hours.toFixed(1)} h, ${window.reason}).`);
  out.push('Written by: code only (no model).');
  out.push('', '_Code-only digest: no model was used. It shows activity, thread starters, the latest messages and compressed bot posts, each with a link._');
  for (const u of units) {
    out.push('', `## ${u.bu}`);
    for (const s of u.subs) {
      const isCustomers = customerKey && u.bu === customerKey.bu && s.sub === customerKey.sub;
      out.push('', `### ${s.sub ?? '(no sub-group)'}: ${s.blocks.length} active${s.quiet.length ? `, ${s.quiet.length} quiet` : ''}`);
      const opts = isCustomers ? {} : { threads: 2, latest: 2, botGroups: 3 };
      for (const b of s.blocks) out.push('', renderConversation(b, ctx, opts));
      if (s.errors.length) out.push('', `Could not read: ${s.errors.map((e) => `${convLabel(e.conv, ctx.me)} (${e.error})`).join(', ')}`);
      if (s.quiet.length) out.push('', isCustomers ? `Quiet: ${s.quiet.map((c) => convLabel(c, ctx.me)).join(', ')}` : `Quiet: ${s.quiet.length} more ${s.quiet.length === 1 ? 'conversation' : 'conversations'} with no messages.`);
    }
  }
  out.push('', '---', ...footer);
  return `${out.join('\n')}\n`;
}

// Numbered links for one item's evidence, built from the reference map (never from model text).
function evidenceLinks(evidence, ctx) {
  return evidence.map((e, i) => `[${i + 1}](${permalink(ctx.workspaceUrl, e.conv, e.ts, e.threadTs)})`).join(' ');
}
const pointLine = (p, ctx) => `- [${p.severity}${p.category ? ` · ${p.category}` : ''}${p.botReport ? ' · bot report' : ''}] ${p.summary} ${evidenceLinks(p.evidence, ctx)}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// model: the result of runPipeline() (src/digest/pipeline.js).
function renderArchive({ model, window, footer, ctx }) {
  const out = [];
  out.push(`# Slack digest, ${new Date(window.end * 1000).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}`);
  out.push(`Window: ${new Date(window.start * 1000).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })} to ${new Date(window.end * 1000).toLocaleString('en-CA', { timeStyle: 'short' })} (${window.hours.toFixed(1)} h, ${window.reason}).`);
  out.push(`Written by: ${ctx.writtenBy}.`);
  out.push('', '_Merged by customer across its success, coordination and external channels, plus mentions in Leadership and Internal channels. Every point links to the messages it rests on; points without a valid source were dropped. All severities are kept here; the Slack DM shows medium and high only._');

  const notable = model.records.filter((r) => r.notable);
  const quiet = model.records.filter((r) => !r.notable);
  out.push('', `## Customers: ${notable.length} with notable items, ${quiet.length} active with nothing notable`);
  for (const r of notable) {
    const flags = [r.severity.toUpperCase(), r.leadership ? 'also discussed in Leadership' : null, r.merged ? null : `not merged (${r.synthError ?? 'no synthesis'}); stage-1 findings shown`, r.unmatched ? 'unmatched channel' : null].filter(Boolean);
    out.push('', `### ${r.name} (${flags.join(' · ')})`);
    out.push(`**${r.headline}**`);
    for (const p of r.points) out.push(pointLine(p, ctx));
    out.push(`Channels: ${r.convs.map((c) => `${c.label} (${c.messages}${c.status === 'ok' ? '' : `, ${c.status === 'cap' ? 'not summarized: cap' : `failed: ${c.error}`}`}${c.trimmed ? `, oldest ${c.trimmed} not read` : ''})`).join(', ') || 'none active'}${r.mentions ? `; mentions: ${r.mentions} (${r.leadershipMentions} in Leadership)` : ''}`);
  }
  if (quiet.length) out.push('', `Nothing notable: ${quiet.map((r) => `${r.name} (${r.convs.reduce((t, c) => t + c.messages, 0)}${r.mentions ? ` + ${r.mentions} mentions` : ''})`).join(', ')}`);
  const notDone = model.records.flatMap((r) => r.convs.filter((c) => c.status !== 'ok').map((c) => `${c.label} (${c.messages} messages; ${c.status === 'cap' ? 'cap' : c.error})`));
  if (notDone.length) out.push('', `Not summarized: ${notDone.join(', ')}`);

  if (model.incidents.length) {
    out.push('', '## Incidents');
    for (const i of model.incidents) out.push(`- ${i.source}: ${i.summary} ${evidenceLinks(i.evidence, ctx)}`);
  }
  out.push('', '## Units');
  for (const u of model.units) {
    const title = u.kind === 'unit' ? `${u.bu} > ${u.sub ?? '-'} (full)` : u.kind === 'brief' ? `${u.bu} (brief)` : `${u.bu} (off: incidents only)`;
    out.push('', `### ${title}: ${plural(u.conversations.length, 'active conversation', 'active conversations')}`);
    if (u.status !== 'ok') out.push(`- Not summarized (${u.status === 'cap' ? 'cap' : u.error}).`);
    else if (u.kind !== 'incident') {
      if (u.points.length) for (const p of u.points) out.push(`- ${p.summary} ${evidenceLinks(p.evidence, ctx)}`);
      else out.push('- Nothing notable.');
    }
  }
  const s = model.skipped;
  out.push('', '## Skipped');
  out.push(`- Bot hygiene items dropped: ${s.botHygiene}; bot posts in the window: ${s.botPosts}; quiet conversations: ${s.quietConversations}.`);
  out.push(`- Your own conversations (you posted most messages) left out of unit summaries: ${s.ownConversations}. noCloud conversations: ${s.noCloudConversations}.`);
  out.push(`- Dropped: personnel ${s.personnel}, not evidence of a notable change ${s.notEvidence}, missing or invalid references ${s.badRef}, over the item limit ${s.overLimit}.`);
  out.push('', '---', ...footer);
  return `${out.join('\n')}\n`;
}

module.exports = { renderDigest, renderArchive, renderConversation, snippet, convLabel, evidenceLinks };
