'use strict';
// Self-tests for the Slack digest's guard code, using invented text only: masking (src/mask.js), the DeepSeek
// client's guards (src/deepseek.js, with a fake API so nothing leaves the Mac), the secret-file check, and bot
// compression (src/digest/compress.js). Run after changing any of them: node scripts/digest-selftest.js
// Prints one line per case; exits non-zero if any case fails.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { maskText, newCounts } = require('../src/mask');
const { chat, rateAt, estimateCost } = require('../src/deepseek');
const { readSecret } = require('../src/secrets');

let failed = 0;
let passed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  -> ${detail}`}`);
}

// ---------- Masking (all examples invented) ----------
const MASK_CASES = [
  ['plain email', 'Email me at jane.doe@example.com today', 'Email me at [email] today', { email: 1 }],
  ['email in angle brackets', 'From: Jane <jane@example.org>', 'From: Jane <[email]>', { email: 1 }],
  ['Slack mailto markup', 'Write to <mailto:bob@acme.test|bob@acme.test> please', 'Write to [email] please', { email: 1 }],
  ['Slack mailto with other label', 'ping <mailto:bob@acme.test|Bob>', 'ping [email]', { email: 1 }],
  ['phone with dashes', 'Call 555-123-4567', 'Call [phone]', { phone: 1 }],
  ['phone with dots', 'Call 555.123.4567 now', 'Call [phone] now', { phone: 1 }],
  ['phone with spaces', 'Call 555 123 4567', 'Call [phone]', { phone: 1 }],
  ['phone with +1 and brackets', 'Cell: +1 (555) 123-4567.', 'Cell: [phone].', { phone: 1 }],
  ['international phone', 'UK office +44 20 7946 0958', 'UK office [phone]', { phone: 1 }],
  ['long digit run', 'Account 12345678 is on hold', 'Account [number] is on hold', { number: 1 }],
  ['five digits kept', 'Order #12345 shipped', 'Order #12345 shipped', {}],
  ['ISO date kept', 'Due 2026-10-14 at 10:30', 'Due 2026-10-14 at 10:30', {}],
  ['US date kept', 'Signed 10/14/2026', 'Signed 10/14/2026', {}],
  ['amount with commas kept', 'Quote was $1,250,000', 'Quote was $1,250,000', {}],
  ['version kept', 'Upgraded to v2.10.3', 'Upgraded to v2.10.3', {}],
  ['user mention kept', 'Thanks <@U05ABCDE12>!', 'Thanks <@U05ABCDE12>!', {}],
  ['plain URL kept', 'Docs: https://example.com/docs/setup', 'Docs: https://example.com/docs/setup', {}],
  ['URL with query', 'Reset at https://example.com/reset?token=abc123&u=9', 'Reset at [url]', { url: 1 }],
  ['URL with token path', 'Join https://example.com/invite/Ab3dEf9hIj2kLm5nOp8q', 'Join [url]', { url: 1 }],
  ['Slack link markup with query', 'See <https://app.example.com/a?x=1|the dashboard>', 'See the dashboard ([url])', { url: 1 }],
  ['Slack link markup plain', 'See <https://example.com/faq|FAQ>', 'See FAQ (https://example.com/faq)', {}],
  ['sk- key', 'key is sk-abcdefghijklmnop1234 ok', 'key is [secret] ok', { secret: 1 }],
  ['Slack token', 'token xoxb-1234-5678-abcdefghij here', 'token [secret] here', { secret: 1 }],
  ['GitHub token', 'ghp_ABCdef1234567890ABCdef1234 leaked', '[secret] leaked', { secret: 1 }],
  ['AWS key id', 'AKIAABCDEFGHIJKLMNOP in config', '[secret] in config', { secret: 1 }],
  ['long hex', 'hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', 'hash [secret]', { secret: 1 }],
  ['base64 secret', 'cred dGhpc2lzYXZlcnlsb25nc2VjcmV0dmFsdWUxMjM0NTY3ODkw', 'cred [secret]', { secret: 1 }],
  ['long word kept', 'pneumonoultramicroscopicsilicovolcanoconiosis is long', 'pneumonoultramicroscopicsilicovolcanoconiosis is long', {}],
  ['several at once', 'Jane (jane@ex.com, 555.987.6543) acct 99887766',
    'Jane ([email], [phone]) acct [number]', { email: 1, phone: 1, number: 1 }],
];
for (const [name, input, want, wantCounts] of MASK_CASES) {
  const counts = newCounts();
  const got = maskText(input, counts);
  const countsOk = Object.entries(counts).every(([k, v]) => v === (wantCounts[k] ?? 0));
  check(`mask: ${name}`, got === want && countsOk, `got "${got}" counts ${JSON.stringify(counts)}`);
}
{
  const counts = newCounts();
  const got = maskText('ts 1728912345.123456 and id 4444444444', counts);
  check('mask: no 6-digit run survives', !/\d{6,}/.test(got), `got "${got}"`);
}

// ---------- Secret file check ----------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selftest-'));
  fs.writeFileSync(path.join(dir, 'loose'), 'invented-value\n', { mode: 0o644 });
  fs.chmodSync(path.join(dir, 'loose'), 0o644);
  fs.writeFileSync(path.join(dir, 'tight'), 'invented-value\n', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'empty'), '\n', { mode: 0o600 });
  let msg = '';
  try { readSecret('loose', dir); } catch (e) { msg = e.message; }
  check('secret: mode 644 refused', /mode 600/.test(msg) && !msg.includes('invented-value'), msg);
  check('secret: mode 600 read', readSecret('tight', dir) === 'invented-value');
  msg = '';
  try { readSecret('empty', dir); } catch (e) { msg = e.message; }
  check('secret: empty refused', /empty/.test(msg), msg);
  fs.rmSync(dir, { recursive: true });
}

// ---------- DeepSeek client guards (fake API, invented text, fake key) ----------
const FAKE_KEY = 'invented-key-for-tests';
const okBody = (content, usage = { prompt_tokens: 100, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 60, completion_tokens: 20 }) =>
  ({ status: 200, ok: true, headers: new Map(), json: async () => ({ model: 'deepseek-flash', choices: [{ message: { content }, finish_reason: 'stop' }], usage }) });
const status = (code, headers = {}) => ({ status: code, ok: false, headers: new Map(Object.entries(headers)), json: async () => ({}) });
function fakeFetch(responses) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return typeof r === 'function' ? r(init) : r;
  };
  f.calls = calls;
  return f;
}
const base = { system: 'Reply in json.', user: 'Invented text: the widget shipped.', keyReader: () => FAKE_KEY, retries: 2 };
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };

(async () => {
  {
    const f = fakeFetch([okBody('{"ok":true}')]);
    const r = await chat({ ...base, fetchImpl: f });
    const { body, init } = f.calls[0];
    check('deepseek: request shape (model, thinking off, temperature 0.1, json mode)',
      body.model === 'deepseek-flash' && body.thinking?.type === 'disabled' && body.temperature === 0.1
      && body.response_format?.type === 'json_object' && !('tools' in body), JSON.stringify(body));
    check('deepseek: key only in Authorization header', init.headers.Authorization === `Bearer ${FAKE_KEY}` && !init.body.includes(FAKE_KEY));
    check('deepseek: JSON parsed, usage and cost returned', r.json?.ok === true && r.usage?.completion_tokens === 20 && typeof r.costUsd === 'number');
  }
  {
    const f = fakeFetch([okBody('{"ok":true}')]);
    await chat({ ...base, fetchImpl: f, thinking: true });
    check('deepseek: thinking flag turns thinking on and drops temperature', f.calls[0].body.thinking.type === 'enabled' && !('temperature' in f.calls[0].body));
  }
  {
    const f = fakeFetch([okBody('{}')]);
    const e = await errOf(chat({ ...base, fetchImpl: f, user: 'x'.repeat(4000), maxInputTokens: 500 }));
    check('deepseek: over-cap input refused before any request', e?.code === 'input-cap' && f.calls.length === 0, e?.message);
  }
  {
    const f = fakeFetch([status(429, { 'retry-after': '0.01' }), okBody('{"ok":1}')]);
    const r = await chat({ ...base, fetchImpl: f });
    check('deepseek: 429 retried after Retry-After', r.attempts === 2 && f.calls.length === 2);
  }
  {
    const f = fakeFetch([status(503), okBody('{"ok":1}')]);
    const r = await chat({ ...base, fetchImpl: f });
    check('deepseek: 5xx retried with backoff', r.attempts === 2);
  }
  {
    const f = fakeFetch([okBody('   '), okBody('{"ok":1}')]);
    const r = await chat({ ...base, fetchImpl: f });
    check('deepseek: empty reply retried', r.attempts === 2 && r.json.ok === 1);
  }
  {
    const f = fakeFetch([okBody('not json')]);
    const e = await errOf(chat({ ...base, fetchImpl: f, retries: 1 }));
    check('deepseek: invalid JSON fails after retries', e?.code === 'invalid-json' && f.calls.length === 2, e?.message);
  }
  {
    const f = fakeFetch([status(401)]);
    const e = await errOf(chat({ ...base, fetchImpl: f }));
    check('deepseek: 401 not retried, message has no key', e?.code === 'auth' && f.calls.length === 1 && !e.message.includes(FAKE_KEY), e?.message);
  }
  {
    // A request that never answers. The keep-alive timer stands in for the open socket a real hung request has
    // (Node's AbortSignal.timeout timer alone would not keep the process running).
    const hang = (init) => new Promise((_, reject) => {
      const keepAlive = setTimeout(() => {}, 5000);
      init.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init.signal.reason); });
    });
    const f = fakeFetch([hang]);
    const e = await errOf(chat({ ...base, fetchImpl: f, timeoutMs: 50, retries: 0 }));
    check('deepseek: timeout reported as timeout', e?.code === 'timeout', e?.message);
  }
  {
    const e = await errOf(chat({ ...base, system: 'Reply briefly.', user: 'Invented.', fetchImpl: fakeFetch([okBody('{}')]) }));
    check('deepseek: JSON mode requires the word json in the prompt', e?.code === 'bad-request');
  }
  check('deepseek: Monday 11:00 UTC is off-peak', rateAt(new Date('2026-10-12T11:00:00Z')) === 'offPeak');
  check('deepseek: Monday 07:00 UTC is peak', rateAt(new Date('2026-10-12T07:00:00Z')) === 'peak');
  check('deepseek: Saturday 07:00 UTC is off-peak', rateAt(new Date('2026-10-17T07:00:00Z')) === 'offPeak');
  {
    const c = estimateCost('deepseek-flash', { prompt_cache_hit_tokens: 1e6, prompt_cache_miss_tokens: 1e6, completion_tokens: 1e6 }, 'offPeak');
    check('deepseek: off-peak cost per million (0.003 + 0.15 + 0.60)', Math.abs(c - 0.753) < 1e-9, String(c));
  }

  // ---------- Bot compression (added with phase 1) ----------
  let compress;
  try { ({ compressBots: compress } = require('../src/digest/compress')); } catch { /* not built yet */ }
  if (compress) {
    const msgs = [];
    for (let i = 0; i < 12; i++) msgs.push({ ts: `${1000 + i}.0`, bot: true, botKey: 'B1', text: `Call #${5000 + i} completed in ${30 + i}s for +1 555 000 ${1000 + i}` });
    msgs.push({ ts: '2000.0', bot: true, botKey: 'B1', text: 'Call #6000 FAILED: carrier error 503' });
    msgs.push({ ts: '2001.0', bot: false, text: 'Human message stays as is' });
    const out = compress(msgs);
    const groups = out.botGroups;
    check('compress: humans untouched', out.humans.length === 1 && out.humans[0].text === 'Human message stays as is');
    check('compress: repeats grouped by template', groups.length === 2 && groups.some((g) => g.count === 12), JSON.stringify(groups.map((g) => g.count)));
    const big = groups.find((g) => g.count === 12);
    check('compress: first and latest example kept', big?.examples.length === 2 && big.examples[0].ts === '1000.0' && big.examples[1].ts === '1011.0');
    const fail = groups.find((g) => g.count === 1);
    check('compress: alert line kept', fail?.alerts.length === 1 || fail?.examples[0].text.includes('FAILED'));
    check('compress: ratio reported', out.stats.charsIn > out.stats.charsOut && out.stats.botMessagesIn === 13);
  } else {
    console.log('SKIP  compress: src/digest/compress.js not built yet');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
