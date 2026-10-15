'use strict';
// Measures how much text a daily Slack digest would have to read: for every channel mapped to a
// business unit (and every listed group DM), counts messages, characters, estimated tokens and threads
// per day over the last N full days. Only counts are kept; message text is measured in memory and
// dropped. Run scripts/slack-channels.js first. See docs/slack-measurement.md.
// Usage: node scripts/slack-measure.js [--days 7] [--thread-lookback 30] [--out-tokens 1500]
//                                      [--in-price USD --out-price USD]   (USD per million tokens)
//                                      [--unassigned-dms]  also measure unassigned group DMs active in the last
//                                                          30 days, as a separate "Unassigned DMs" bucket
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { ROOT, DATA_DIR, CHANNELS_FILE, SKIP_SUBTYPES, createClient, SlackError, loadConfig, placeChannel, writePrivateJson, localDay, fmtInt, printTable } = require('../src/slack');

const CHARS_PER_TOKEN = 4;
const LOCAL_IN_TPS = 65;      // qwen2.5:7b on this Mac, reading
const LOCAL_OUT_TPS = 12;     // qwen2.5:7b on this Mac, writing
const LOCAL_CHUNK_CHARS = 8000; // src/llm.js input cap
const UNASSIGNED = 'Unassigned DMs';
const UNASSIGNED_ACTIVE_DAYS = 30; // same test as section 4 of the slack-channels.js report


function usage(msg) {
  console.error(`slack-measure: ${msg}`);
  console.error('usage: node scripts/slack-measure.js [--days 7] [--thread-lookback 30] [--out-tokens 1500] [--in-price USD --out-price USD] [--unassigned-dms]');
  process.exit(2);
}

function numberOpt(opts, name, { int = false, min = 0, max = Infinity } = {}) {
  if (opts[name] === undefined) return undefined;
  const n = Number(opts[name]);
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) usage(`--${name} must be ${int ? 'a whole number' : 'a number'} from ${min} to ${max}`);
  return n;
}

// Characters a digest would read: the message text plus legacy attachment text (bots often post there).
function textLength(m) {
  let n = (m.text ?? '').length;
  for (const a of m.attachments ?? []) n += (a.pretext ?? '').length + (a.title ?? '').length + (a.text ?? '').length;
  return n;
}

function label(ch) {
  if (ch.type !== 'group_dm') return `#${ch.name}`;
  if (!ch.name.startsWith('mpdm-')) return `DM: ${ch.name}`; // a group DM someone gave a name
  const names = (ch.memberNames ?? []).join(', ');
  return `DM: ${names.length > 40 ? names.slice(0, 39) + '…' : names || ch.id}`;
}

(async () => {
  let opts;
  try {
    ({ values: opts } = parseArgs({ options: {
      days: { type: 'string', default: '7' },
      'thread-lookback': { type: 'string', default: '30' },
      'out-tokens': { type: 'string', default: '1500' },
      'in-price': { type: 'string' },
      'out-price': { type: 'string' },
      'unassigned-dms': { type: 'boolean', default: false },
    } }));
  } catch (e) { usage(e.message); }
  const days = numberOpt(opts, 'days', { int: true, min: 1, max: 90 });
  const lookback = numberOpt(opts, 'thread-lookback', { int: true, min: days, max: 365 });
  const outTokensPerBu = numberOpt(opts, 'out-tokens', { int: true, min: 0, max: 100_000 });
  const inPrice = numberOpt(opts, 'in-price', { max: 1000 });
  const outPrice = numberOpt(opts, 'out-price', { max: 1000 });
  if ((inPrice === undefined) !== (outPrice === undefined)) usage('give both --in-price and --out-price, or neither');

  if (!fs.existsSync(CHANNELS_FILE)) usage('data/slack-channels.json not found; run node scripts/slack-channels.js first');
  const saved = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
  const cfg = loadConfig();
  // Re-apply the current rules, so editing config/slack-bus.json does not need a new channel listing.
  const placed = saved.channels.map((c) => ({ ...c, ...placeChannel(cfg, c) }));
  const targets = placed.filter((c) => c.bu);
  if (targets.length === 0) usage('no channels are mapped to a business unit; add rules to config/slack-bus.json');
  // Optional bucket: group DMs nobody assigned (not excluded either) that were recently active. They are measured
  // like everything else but kept out of the main totals and estimates, so they cannot blur the decision.
  const cutoff = Date.now() - UNASSIGNED_ACTIVE_DAYS * 86_400_000;
  const unassigned = !opts['unassigned-dms'] ? [] : placed
    .filter((c) => c.type === 'group_dm' && c.by === null && c.lastActivity && Date.parse(c.lastActivity) >= cutoff)
    .map((c) => ({ ...c, bu: UNASSIGNED, sub: null, group: UNASSIGNED, unassigned: true }));
  targets.push(...unassigned);

  // Window: the N full local days before today, so every day in the report is complete.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const daysAgo = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return d; };
  const windowStart = daysAgo(days).getTime() / 1000;
  const windowEnd = today.getTime() / 1000;
  const lookbackStart = daysAgo(lookback).getTime() / 1000;
  const dayList = Array.from({ length: days }, (_, i) => localDay(daysAgo(days - i)));

  console.log(`Window: ${dayList[0]} to ${dayList.at(-1)} (${days} full days, local time). Channel list from ${saved.generatedAt}.`);
  console.log(`Measuring ${targets.length} conversations${unassigned.length ? ` (${unassigned.length} of them in "${UNASSIGNED}")` : ''}; threads started up to ${lookback} days back are checked for replies in the window.\n`);

  const started = Date.now();
  const slack = createClient();
  const results = [];

  for (const [i, ch] of targets.entries()) {
    process.stderr.write(`  [${i + 1}/${targets.length}] ${label(ch)}\n`);
    const perDay = {};
    const threadsByDay = {};
    const add = (m, viaThread) => {
      const ts = Number(m.ts);
      if (ts < windowStart || ts >= windowEnd || SKIP_SUBTYPES.has(m.subtype)) return;
      const day = localDay(m.ts);
      const d = (perDay[day] ??= { messages: 0, chars: 0, threads: 0, botMessages: 0, botChars: 0 });
      const n = textLength(m);
      d.messages++;
      d.chars += n;
      if (m.bot_id || m.subtype === 'bot_message') { d.botMessages++; d.botChars += n; }
      if (viaThread) (threadsByDay[day] ??= new Set()).add(m.thread_ts);
    };
    const threads = [];
    const result = { id: ch.id, name: ch.name, type: ch.type, bu: ch.bu, sub: ch.sub, group: ch.group, unassigned: Boolean(ch.unassigned), label: label(ch), days: perDay };
    try {
      await slack.paginate('conversations.history',
        { channel: ch.id, oldest: String(lookbackStart), latest: String(windowEnd), limit: '200' }, 'messages', (msgs) => {
          for (const m of msgs) {
            // Replies "also sent to channel" show up here and in the thread; count them once, in the thread.
            if (m.subtype !== 'thread_broadcast') add(m, false);
            if (m.reply_count > 0 && Number(m.latest_reply) >= windowStart) threads.push(m.ts);
          }
        });
      for (const ts of threads) {
        await slack.paginate('conversations.replies',
          { channel: ch.id, ts, oldest: String(windowStart), latest: String(windowEnd), limit: '200' }, 'messages', (msgs) => {
            for (const m of msgs) if (m.ts !== ts) add(m, true); // the thread's first message is counted from history
          });
      }
    } catch (e) {
      if (!(e instanceof SlackError)) throw e;
      result.error = e.code;
    }
    for (const [day, set] of Object.entries(threadsByDay)) perDay[day].threads = set.size;
    results.push(result);
  }
  const runtimeS = Math.round((Date.now() - started) / 1000);

  // Totals
  const tokens = (chars) => chars / CHARS_PER_TOKEN;
  const sumDays = (rs, field) => Object.fromEntries(dayList.map((day) => [day, rs.reduce((s, r) => s + (r.days[day]?.[field] ?? 0), 0)]));
  // Main totals and estimates cover assigned conversations only; the unassigned bucket is reported beside them.
  const assigned = results.filter((r) => !r.unassigned);
  const total = Object.fromEntries(['messages', 'chars', 'threads', 'botChars'].map((f) => [f, sumDays(assigned, f)]));
  const avg = (byDay) => Object.values(byDay).reduce((a, b) => a + b, 0) / days;
  const peak = (byDay) => Object.entries(byDay).reduce((best, e) => (e[1] > best[1] ? e : best), [dayList[0], -1]);

  const bus = [...new Set(assigned.map((r) => r.bu))].sort();
  const statsFor = (rs) => {
    const chars = sumDays(rs, 'chars');
    const chunks = Object.fromEntries(dayList.map((d) => [d, Math.ceil(chars[d] / LOCAL_CHUNK_CHARS)]));
    return { channels: rs.length, chars, chunks, messages: sumDays(rs, 'messages') };
  };
  const buStats = bus.map((bu) => ({ bu, ...statsFor(results.filter((r) => r.bu === bu)) }));
  const bucket = unassigned.length ? { bu: UNASSIGNED, ...statsFor(results.filter((r) => r.unassigned)) } : null;
  // Sub-group rows sit under their business unit in the table; channels without a sub-group only count in the BU row.
  const subStats = (bu) => [...new Set(results.filter((r) => r.bu === bu && r.sub).map((r) => r.sub))].sort()
    .map((sub) => ({ bu: `    ${sub}`, ...statsFor(results.filter((r) => r.bu === bu && r.sub === sub)) }));

  console.log(`\nTokens per day (all business units${bucket ? `; "${UNASSIGNED}" not included` : ''}):`);
  printTable(['day', 'messages', 'characters', 'est. tokens', 'threads'],
    dayList.map((d) => [d, fmtInt(total.messages[d]), fmtInt(total.chars[d]), fmtInt(tokens(total.chars[d])), fmtInt(total.threads[d])]));
  const [peakDay, peakChars] = peak(total.chars);
  const avgChars = avg(total.chars);
  const botShare = avgChars ? avg(total.botChars) / avgChars : 0;
  console.log(`\n  Average: ${fmtInt(tokens(avgChars))} tokens/day.  Peak: ${fmtInt(tokens(peakChars))} on ${peakDay}` +
    (avgChars ? ` (${(peakChars / avgChars).toFixed(1)}x average).` : '.') + `  Bot messages: ${Math.round(botShare * 100)}% of characters.`);
  if (bucket) {
    const withChars = Object.fromEntries(dayList.map((d) => [d, total.chars[d] + bucket.chars[d]]));
    const [wd, wc] = peak(withChars);
    console.log(`  With "${UNASSIGNED}" (${bucket.channels} group DMs): average ${fmtInt(tokens(avg(withChars)))} tokens/day, peak ${fmtInt(tokens(wc))} on ${wd}.`);
  }

  console.log('\nPer business unit and sub-group (est. tokens):');
  printTable(['business unit / sub-group', 'channels', 'msgs/day', 'avg tokens/day', 'peak tokens/day', 'peak day', '8k-char chunks/day (avg)'],
    [...buStats.flatMap((b) => [b, ...subStats(b.bu)]), ...(bucket ? [bucket] : [])].map((b) => { const [pd, pc] = peak(b.chars); return [b.bu, b.channels, fmtInt(avg(b.messages)), fmtInt(tokens(avg(b.chars))), fmtInt(tokens(pc)), pc > 0 ? pd : "-", avg(b.chunks).toFixed(1)]; }));

  const totalChars = (r) => Object.values(r.days).reduce((s, d) => s + d.chars, 0);
  const active = results.filter((r) => !r.error && totalChars(r) > 0).sort((a, b) => totalChars(b) - totalChars(a));
  console.log('\nTop 10 channels:');
  printTable(['channel', 'business unit', 'avg tokens/day', 'messages', 'threads'],
    active.slice(0, 10).map((r) => [r.label, r.group, fmtInt(tokens(totalChars(r)) / days),
      fmtInt(Object.values(r.days).reduce((s, d) => s + d.messages, 0)), fmtInt(Object.values(r.days).reduce((s, d) => s + d.threads, 0))]));

  const quiet = results.filter((r) => !r.error && totalChars(r) === 0 && Object.keys(r.days).length === 0);
  console.log(`\nNo activity in the window (${quiet.length}):`);
  for (const r of quiet) console.log(`  ${r.label} (${r.group})`);
  const failed = results.filter((r) => r.error);
  if (failed.length) {
    console.log(`\nCould not read (${failed.length}); these are not in the totals:`);
    for (const r of failed) console.log(`  ${r.label} (${r.group}): ${r.error}`);
  }

  // Model estimates. Output size is an assumption (--out-tokens per business unit per day), not a measurement.
  const activeBus = buStats.filter((b) => avg(b.chars) > 0).length;
  const outTokens = outTokensPerBu * activeBus;
  const avgIn = tokens(avgChars);
  const peakIn = tokens(peakChars);
  const localSecs = (inTok) => inTok / LOCAL_IN_TPS + outTokens / LOCAL_OUT_TPS;
  const fmtDur = (s) => (s < 120 ? `${Math.round(s)}s` : `${(s / 60).toFixed(1)} min`);
  const chunksByDay = Object.fromEntries(dayList.map((d) => [d, buStats.reduce((s, b) => s + b.chunks[d], 0)]));
  console.log(`\nAssumed digest output: ${fmtInt(outTokensPerBu)} tokens per active business unit x ${activeBus} = ${fmtInt(outTokens)} tokens/day (--out-tokens).`);
  console.log('Local model (qwen2.5:7b, ~65 tokens/s reading, ~12 tokens/s writing):');
  console.log(`  Average day: ~${fmtDur(localSecs(avgIn))}; peak day: ~${fmtDur(localSecs(peakIn))}.`);
  console.log(`  Calls needed with the current 8,000-character helper limit: ~${avg(chunksByDay).toFixed(0)} on an average day, ${peak(chunksByDay)[1]} on the busiest day,`);
  console.log('  each limited to 50s, and a dispatcher job gets 60s in total. Prompt overhead per call is not included.');
  if (inPrice !== undefined) {
    const cost = (inTok) => (inTok * inPrice + outTokens * outPrice) / 1e6;
    console.log(`Cloud model at $${inPrice}/M input, $${outPrice}/M output:`);
    console.log(`  Average day: $${cost(avgIn).toFixed(4)}; peak day: $${cost(peakIn).toFixed(4)}; month (30 x average): $${(cost(avgIn) * 30).toFixed(2)}.`);
  }
  console.log('Token counts are characters / 4. Raw Slack markup (<@U123> mentions, links) makes this a slight overestimate.');

  const outFile = path.join(DATA_DIR, `slack-measure-${localDay(new Date())}.json`);
  writePrivateJson(outFile, {
    generatedAt: new Date().toISOString(), days: dayList, threadLookbackDays: lookback, charsPerToken: CHARS_PER_TOKEN,
    channels: results.map(({ id, name, type, bu, sub, unassigned: u, days: d, error }) => ({ id, name, type, bu, sub, ...(u ? { unassigned: true } : {}), days: d, ...(error ? { error } : {}) })),
  });
  const s = slack.stats;
  console.log(`\n${s.calls} API calls, ${s.rateLimited} rate-limit waits (${Math.round(s.waitedMs / 1000)}s), runtime ${fmtDur(runtimeS)}. Counts saved to ${path.relative(ROOT, outFile)}.`);
})().catch((e) => {
  console.error(`slack-measure: ${e.message}`);
  process.exit(1);
});
