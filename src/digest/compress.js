'use strict';
// Bot-post compression for the Slack digest, in code (no model). Bots write about half of all characters, mostly
// repeats of the same template (call logs, alerts, reports). Messages from one bot that share a template (the text
// with numbers, IDs, URLs, emails and dates replaced by placeholders) become one group: the first and latest
// example, a count, and any instances with alert words, so a real failure is never folded away.
// Works on messages in memory; never logs or stores text.

const EXAMPLE_CHARS = 300;
const MAX_ALERTS_PER_GROUP = 5;
const ALERT_WORDS = /\b(errors?|fail(?:ed|ure|ures|ing|s)?|down|outage|escalat\w*|urgent|cancel\w*|refund\w*|churn\w*|complain\w*|angry|broken|not working|time[ds]? ?out|critical|sev ?[12]|p[01])\b/i;

function template(text) {
  return String(text)
    .toLowerCase()
    .replace(/<[^>]+>/g, '<x>')                        // Slack markup: mentions, links, channels
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>')
    .replace(/\b[0-9a-f]{8,}\b/g, '<id>')
    .replace(/\d+/g, '<n>')
    .replace(/(?:<n>[\s.:/+-]*){2,}/g, '<n> ')         // dates, times, phone numbers, amounts
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// msgs: [{ ts, bot, botKey, botName?, text, ... }] in any order. Returns
// { humans: [...unchanged], botGroups: [{ botKey, botName, count, examples, alerts }], stats }.
function compressBots(msgs) {
  const sorted = [...msgs].sort((a, b) => Number(a.ts) - Number(b.ts));
  const humans = [];
  const groups = new Map();
  let charsIn = 0;
  let botMessagesIn = 0;
  for (const m of sorted) {
    charsIn += m.text.length;
    if (!m.bot) { humans.push(m); continue; }
    botMessagesIn++;
    const key = `${m.botKey}\u0000${template(m.text)}`;
    const g = groups.get(key) ?? { botKey: m.botKey, botName: m.botName ?? null, count: 0, all: [] };
    g.count++;
    g.all.push(m);
    groups.set(key, g);
  }
  const botGroups = [...groups.values()].map((g) => {
    const first = g.all[0];
    const latest = g.all.at(-1);
    const examples = (first === latest ? [first] : [first, latest]).map((m) => ({ ...m, text: cut(m.text, EXAMPLE_CHARS) }));
    const alerts = g.all
      .filter((m) => m !== first && m !== latest && ALERT_WORDS.test(m.text))
      .slice(-MAX_ALERTS_PER_GROUP)
      .map((m) => ({ ...m, text: cut(m.text, EXAMPLE_CHARS) }));
    const alertCount = g.all.filter((m) => ALERT_WORDS.test(m.text)).length;
    return { botKey: g.botKey, botName: g.botName, count: g.count, examples, alerts, alertCount };
  });
  const charsOut = humans.reduce((s, m) => s + m.text.length, 0)
    + botGroups.reduce((s, g) => s + [...g.examples, ...g.alerts].reduce((t, m) => t + m.text.length, 0) + 20, 0);
  return { humans, botGroups, stats: { messagesIn: sorted.length, botMessagesIn, charsIn, charsOut } };
}

module.exports = { compressBots, template, ALERT_WORDS };
