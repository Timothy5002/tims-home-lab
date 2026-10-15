'use strict';
// Self-tests for the Slack digest's guard code, using invented text only: masking (src/mask.js), the OpenRouter
// client's guards and primary/secondary fallback (src/openrouter.js, with a fake API so nothing leaves the Mac),
// the secret-file check, and bot compression (src/digest/compress.js). Run after changing any of them: node scripts/digest-selftest.js
// Prints one line per case; exits non-zero if any case fails.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { maskText, maskSecrets, newCounts } = require('../src/mask');
const { chat, buildBody, loadRoutes, createBudget, costFromPrices } = require('../src/openrouter');
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

{
  // Internal conversations get secrets-only masking: names, emails, phones and numbers stay.
  const counts = newCounts();
  const hits = [];
  const got = maskSecrets('Pat Lee (pat@example.com, 555-123-4567) shared sk-abcdefghijklmnop1234 and order 12345678', counts, (t, p) => hits.push(`${t}:${p}`));
  check('mask: secrets-only keeps names, emails, phones and numbers',
    got === 'Pat Lee (pat@example.com, 555-123-4567) shared [secret] and order 12345678' && counts.secret === 1 && counts.email === 0, `got "${got}"`);
  check('mask: onHit names the pattern that fired', hits.join(',') === 'secret:sk-key', hits.join(','));
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

// ---------- OpenRouter client (fake API, invented text, fake key) ----------
const FAKE_KEY = 'invented-key-for-tests';
const ROUTES = loadRoutes({
  primary: { model: 'deepseek/deepseek-v3.2', providers: ['deepinfra'], temperature: true, reasoningMandatory: false,
    reasoningOff: { enabled: false }, reasoningOn: { enabled: true }, reasoningAllowance: 4096 },
  secondary: { model: 'google/gemini-3.8-flash', providers: ['google-vertex/global'], temperature: false, reasoningMandatory: true,
    reasoningOff: { effort: 'low' }, reasoningOn: { effort: 'high' }, reasoningAllowance: 4096 },
});
// Per million tokens, as the endpoint list reports them (per token).
const ENDPOINTS = {
  'deepseek/deepseek-v3.2': [{ tag: 'deepinfra/fp4', provider_name: 'DeepInfra', max_completion_tokens: 16384,
    pricing: { prompt: '0.00000026', completion: '0.00000038', input_cache_read: '0.00000013' } }],
  'google/gemini-3.8-flash': [{ tag: 'google-vertex/global', provider_name: 'Google', max_completion_tokens: 65536,
    pricing: { prompt: '0.00000075', completion: '0.00000375', input_cache_read: '0.000000075', internal_reasoning: '0.00000375' } }],
};
const json = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: new Map(Object.entries(headers)), json: async () => body });
// chatReplies: one entry per chat request, in order: a response, a function (init) => response, or { content, provider, usage, cost }.
function fakeOpenRouter(chatReplies) {
  const calls = { chat: [], generation: [], endpoints: 0 };
  const served = new Map();
  const f = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/endpoints')) {
      calls.endpoints++;
      const model = u.pathname.replace('/api/v1/models/', '').replace('/endpoints', '');
      return json(200, { data: { endpoints: ENDPOINTS[model] ?? [] } });
    }
    if (u.pathname.endsWith('/generation')) {
      calls.generation.push({ init });
      const g = served.get(u.searchParams.get('id'));
      return g ? json(200, { data: g }) : json(404, {});
    }
    const body = JSON.parse(init.body);
    calls.chat.push({ body, init });
    const r = chatReplies[calls.chat.length - 1];
    if (typeof r === 'function') return r(init);
    if (r && 'status' in r) return r;
    const id = `gen-test-${calls.chat.length}`;
    served.set(id, { provider_name: r.provider, total_cost: r.cost ?? null });
    return json(200, { id, model: body.model, choices: [{ message: { content: r.content }, finish_reason: 'stop' }],
      usage: r.usage ?? { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } } });
  };
  f.calls = calls;
  return f;
}
const base = { routes: ROUTES, system: 'Reply in json.', user: 'Invented text: the widget shipped.', keyReader: () => FAKE_KEY, sleepImpl: async () => {} };
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };
const hang = (init) => new Promise((_, reject) => {
  // Stands in for a hung request's open socket (Node's AbortSignal.timeout timer alone would not keep the process alive).
  const keepAlive = setTimeout(() => {}, 5000);
  init.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init.signal.reason); });
});

(async () => {
  {
    const b = buildBody(ROUTES.primary, { system: 's json', user: 'u' });
    check('openrouter: primary body pins its provider, no fallbacks, data_collection deny',
      JSON.stringify(b.provider) === JSON.stringify({ order: ['deepinfra'], only: ['deepinfra'], allow_fallbacks: false, require_parameters: true, data_collection: 'deny' }), JSON.stringify(b.provider));
    check('openrouter: primary body has model, json mode, temperature 0.1, reasoning off, no tools',
      b.model === 'deepseek/deepseek-v3.2' && b.response_format?.type === 'json_object' && b.temperature === 0.1
      && JSON.stringify(b.reasoning) === '{"enabled":false}' && b.max_tokens === 1500 && !('tools' in b), JSON.stringify(b));
    const on = buildBody(ROUTES.primary, { system: 's json', user: 'u', reasoning: true });
    check('openrouter: reasoning flag turns it on, drops temperature, adds the reasoning allowance',
      JSON.stringify(on.reasoning) === '{"enabled":true}' && !('temperature' in on) && on.max_tokens === 1500 + 4096);
    const g = buildBody(ROUTES.secondary, { system: 's json', user: 'u' });
    check('openrouter: secondary body: lowest reasoning level, no temperature, allowance for mandatory reasoning, pinned to its provider',
      JSON.stringify(g.reasoning) === '{"effort":"low"}' && !('temperature' in g) && g.max_tokens === 1500 + 4096
      && g.provider.only[0] === 'google-vertex/global' && g.provider.data_collection === 'deny' && g.provider.allow_fallbacks === false);
  }
  {
    const f = fakeOpenRouter([{ content: '{"ok":true}', provider: 'DeepInfra', cost: 0.00004 }]);
    const r = await chat({ ...base, fetchImpl: f });
    const { init } = f.calls.chat[0];
    check('openrouter: key only in Authorization headers (chat and generation stats)',
      init.headers.Authorization === `Bearer ${FAKE_KEY}` && !init.body.includes(FAKE_KEY)
      && f.calls.generation.every((c) => c.init.headers.Authorization === `Bearer ${FAKE_KEY}`));
    check('openrouter: primary served by its pinned provider; cost from OpenRouter',
      r.route === 'primary' && r.provider === 'DeepInfra' && r.fellBack === false && r.costUsd === 0.00004 && r.json.ok === true, JSON.stringify(r));
  }
  for (const [label, first, code] of [
    ['timeout', hang, 'timeout'],
    ['5xx', json(503, {}), 'server-error'],
    ['429', json(429, {}), 'rate-limited'],
    ['provider mismatch', { content: '{"ok":true}', provider: 'SomeOtherProvider' }, 'provider-mismatch'],
  ]) {
    const f = fakeOpenRouter([first, { content: '{"ok":2}', provider: 'Google', cost: 0.0001 }]);
    const r = await chat({ ...base, fetchImpl: f, timeoutMs: 50 });
    check(`openrouter: ${label} on primary -> one attempt on secondary`,
      r.route === 'secondary' && r.fellBack && r.primaryError === code && r.provider === 'Google' && f.calls.chat.length === 2
      && f.calls.chat[1].body.model === 'google/gemini-3.8-flash' && f.calls.chat[0].body.model === 'deepseek/deepseek-v3.2', JSON.stringify({ r, n: f.calls.chat.length }));
  }
  {
    const f = fakeOpenRouter([json(503, {}), json(503, {}), { content: '{}', provider: 'Google' }]);
    const e = await errOf(chat({ ...base, fetchImpl: f }));
    check('openrouter: never a third attempt', e?.code === 'server-error' && f.calls.chat.length === 2, `${e?.code} after ${f.calls.chat.length} requests`);
  }
  {
    const f = fakeOpenRouter([{ content: '{"ok":true}', provider: 'Venice' }, { content: '{"ok":true}', provider: 'Google AI Studio' }]);
    const e = await errOf(chat({ ...base, fetchImpl: f }));
    check('openrouter: secondary served by an unpinned provider fails the call', e?.code === 'provider-mismatch' && f.calls.chat.length === 2, e?.message);
  }
  for (const [label, first, code] of [
    ['401', json(401, {}), 'auth'],
    ['404 (no endpoint fits the pins or data policy)', json(404, {}), 'no-endpoint'],
    ['invalid JSON', { content: 'not json', provider: 'DeepInfra' }, 'invalid-json'],
    ['empty reply', { content: '  ', provider: 'DeepInfra' }, 'empty'],
  ]) {
    const f = fakeOpenRouter([first, { content: '{}', provider: 'Google' }]);
    const e = await errOf(chat({ ...base, fetchImpl: f }));
    check(`openrouter: ${label} does not fall back`, e?.code === code && f.calls.chat.length === 1 && !String(e?.message).includes(FAKE_KEY), `${e?.code}, ${f.calls.chat.length} requests`);
  }
  {
    const f = fakeOpenRouter([{ content: '{}', provider: 'DeepInfra' }]);
    const e = await errOf(chat({ ...base, fetchImpl: f, user: 'x'.repeat(4000), budget: createBudget({ maxInputTokens: 500 }) }));
    check('openrouter: over the per-run input cap: no request', e?.code === 'input-cap' && f.calls.chat.length === 0, e?.message);
    const f2 = fakeOpenRouter([{ content: '{}', provider: 'DeepInfra' }]);
    const e2 = await errOf(chat({ ...base, fetchImpl: f2, budget: createBudget({ maxCostUsd: 0.0000001 }) }));
    check('openrouter: over the per-run cost cap: no request', e2?.code === 'cost-cap' && f2.calls.chat.length === 0, e2?.message);
    const e3 = await errOf(chat({ ...base, fetchImpl: fakeOpenRouter([{ content: '{}', provider: 'DeepInfra' }]), maxTokens: 20000 }));
    check("openrouter: max_tokens over the pinned endpoint's limit is refused", e3?.code === 'bad-request', e3?.message);
  }
  {
    // Gemini reasons even at the lowest level: reasoning tokens count toward cost and the output cap.
    const usage = { prompt_tokens: 1000, completion_tokens: 700, prompt_tokens_details: { cached_tokens: 200 }, completion_tokens_details: { reasoning_tokens: 500 } };
    const f = fakeOpenRouter([json(503, {}), { content: '{"ok":1}', provider: 'Google', usage }]); // no cost reported
    const budget = createBudget({ maxOutputTokens: 10000 });
    const r = await chat({ ...base, fetchImpl: f, budget });
    const want = 800 * 0.00000075 + 200 * 0.000000075 + 200 * 0.00000375 + 500 * 0.00000375;
    check('openrouter: reasoning tokens priced and counted when OpenRouter reports no cost',
      Math.abs(r.costUsd - want) < 1e-12 && r.usage.reasoning === 500 && budget.used.reasoningTokens === 500 && budget.used.outputTokens === 700,
      JSON.stringify({ got: r.costUsd, want, used: budget.used }));
    check('openrouter: costFromPrices arithmetic (per-million prices 0.26 / 0.13 cached / 0.38)',
      Math.abs(costFromPrices({ in: 0.26e-6, cacheRead: 0.13e-6, out: 0.38e-6, reasoning: 0.38e-6 }, { prompt: 1e6, cached: 0, completion: 1e6, reasoning: 0 }) - 0.64) < 1e-9);
  }
  {
    const e = await errOf(Promise.resolve().then(() => loadRoutes({ primary: { model: 'deepseek/deepseek-v3.2', providers: [], reasoningOff: {}, reasoningOn: {} } })));
    check('openrouter: a route with no pinned provider is refused', e?.code === 'bad-config', e?.message);
    const f = fakeOpenRouter([{ content: '{}', provider: 'DeepInfra' }]);
    const routes = loadRoutes({ primary: { ...ROUTES.primary, providers: ['nonexistent'] } });
    const e2 = await errOf(chat({ ...base, routes, fetchImpl: f }));
    check('openrouter: a pinned provider missing from the endpoint list is refused before any request', e2?.code === 'provider-not-listed' && f.calls.chat.length === 0, e2?.message);
    const e3 = await errOf(chat({ ...base, system: 'Reply briefly.', user: 'Invented.', fetchImpl: fakeOpenRouter([]) }));
    check('openrouter: JSON mode requires the word json in the prompt', e3?.code === 'bad-request');
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
