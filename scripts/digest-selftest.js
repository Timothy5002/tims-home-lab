'use strict';
// Self-tests for the Slack digest's guard code, using invented text only: masking (src/mask.js), the OpenRouter
// client's guards, primary retry and primary/secondary fallback (src/openrouter.js, with a fake API so nothing
// leaves the Mac), the run and per-call caps (src/digest/analyze.js), the send-only Slack client and the DM
// (src/slack-send.js, src/digest/dm.js, fake Slack), the healthcheck helper, the secret-file check, and bot
// compression (src/digest/compress.js). Run after changing any of them: node scripts/digest-selftest.js
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
  ['mixed-case random key still masked', 'key Zq8Rt2Lm9Xv4Bn7Ks1Wd6Hj3Pf5Gc0Ty8Ue2Ma7Qp in config', 'key [secret] in config', { secret: 1 }],
  ['several at once', 'Jane (jane@ex.com, 555.987.6543) acct 99887766',
    'Jane ([email], [phone]) acct [number]', { email: 1, phone: 1, number: 1 }],
];
// Secrets-only masking (every conversation): false positives found on real data. Shapes only were inspected;
// these examples are invented. URL paths, file paths and slugs must survive.
for (const [name, input] of [
  ['URL path with UUID', 'Recording: https://calls.example.test/r/3f2b9c1e-8a7d-4e6f-9b0a-1c2d3e4f5a6b/audio'],
  ['URL path of words', 'See https://docs.example.test/Guides/Setup-Your-Account-In-5-Steps/v2'],
  ['file path', 'Saved to Reports/Q3-Customer-Summary-Final-2026/Export-Version-12.csv'],
  ['slug of words and digits', 'branch fix-retry-logic-for-webhook-handler-v2-2026'],
  ['long token with no upper case', 'id 9f8e7d6c5b4a39281706f5e4d3c2b1a0_9f8e7d6c5b4a3928 ok'],
]) {
  const counts = newCounts();
  const got = maskSecrets(input, counts);
  check(`mask secrets-only: ${name} kept`, got === input && counts.secret === 0, `got "${got}"`);
}
check('mask: URL whose path is hyphenated words is not a token',
  maskText('See https://docs.example.test/Guides/Setup-Your-Account-In-5-Steps/v2') === 'See https://docs.example.test/Guides/Setup-Your-Account-In-5-Steps/v2');
check('mask: URL with a UUID path is still masked in external text',
  maskText('Recording: https://calls.example.test/r/3f2b9c1e-8a7d-4e6f-9b0a-1c2d3e4f5a6b/audio') === 'Recording: [url]');
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

{
  // External = in an external unit and the name lacks an internal prefix; Slack's shared flag does not count.
  const { placeChannel } = require('../src/slack');
  const cfg = { rules: [], overrides: {}, groupDms: { G1: { bu: 'Unit B', sub: null } }, pendingGroupDms: [],
    external: { units: ['Unit B'], internalPrefixes: ['success-', 'bas'] } };
  cfg.rules = [{ bu: 'Unit B', sub: null, label: 'r', test: () => true }];
  const ext = (name, extra = {}) => placeChannel(cfg, { id: 'C1', name, type: 'public', ...extra }).external;
  check('external: customer channel in the external unit is external', ext('acme-coordination') === true);
  check('external: success- prefix is internal', ext('success-acme') === false);
  check('external: bas prefix is internal', ext('bas-team-notes') === false && ext('Basement-ops') === false);
  check('external: Slack shared flag alone does not make it external', ext('success-acme', { isExtShared: true }) === false);
  check("external: the unit's group DMs are external", placeChannel(cfg, { id: 'G1', name: 'mpdm-a--b-1', type: 'group_dm' }).external === true);
  const other = { ...cfg, rules: [{ bu: 'Unit A', sub: null, label: 'r', test: () => true }] };
  check('external: other units are internal even when shared', placeChannel(other, { id: 'C2', name: 'acme-x', type: 'public', isExtShared: true }).external === false);
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
    if (r.provider) served.set(id, { provider_name: r.provider, total_cost: r.cost ?? null });
    return json(200, { id, model: body.model, ...(r.replyProvider ? { provider: r.replyProvider } : {}), choices: [{ message: { content: r.content }, finish_reason: 'stop' }],
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
    // Transient errors get one primary retry first; a provider mismatch goes straight to the secondary.
    const retries = code !== 'provider-mismatch';
    const f = fakeOpenRouter(retries ? [first, first, { content: '{"ok":2}', provider: 'Google', cost: 0.0001 }] : [first, { content: '{"ok":2}', provider: 'Google', cost: 0.0001 }]);
    const r = await chat({ ...base, fetchImpl: f, timeoutMs: 50 });
    const n = retries ? 3 : 2;
    check(`openrouter: ${label} on primary${retries ? ' twice (one retry)' : ', no retry'} -> one attempt on secondary`,
      r.route === 'secondary' && r.fellBack && r.primaryError === code && r.provider === 'Google' && f.calls.chat.length === n
      && JSON.stringify(r.primaryErrors) === JSON.stringify(retries ? [code, code] : [code])
      && f.calls.chat[n - 1].body.model === 'google/gemini-3.8-flash' && f.calls.chat.slice(0, n - 1).every((c) => c.body.model === 'deepseek/deepseek-v3.2'), JSON.stringify({ r, n: f.calls.chat.length }));
  }
  for (const [label, first, code] of [['timeout', hang, 'timeout'], ['5xx', json(502, {}), 'server-error'], ['429', json(429, {}), 'rate-limited']]) {
    const slept = [];
    const f = fakeOpenRouter([first, { content: '{"ok":1}', provider: 'DeepInfra', cost: 0.00001 }]);
    const r = await chat({ ...base, fetchImpl: f, timeoutMs: 50, sleepImpl: async (ms) => { slept.push(ms); } });
    check(`openrouter: ${label} then success -> recovered on the primary retry after a backoff, no fallback`,
      r.route === 'primary' && !r.fellBack && r.retried && r.primaryErrors[0] === code && f.calls.chat.length === 2 && slept[0] === 3000,
      JSON.stringify({ route: r.route, slept, n: f.calls.chat.length }));
  }
  {
    const slept = [];
    const f = fakeOpenRouter([json(429, {}, { 'retry-after': '60' }), { content: '{}', provider: 'DeepInfra' }]);
    await chat({ ...base, fetchImpl: f, sleepImpl: async (ms) => { slept.push(ms); } });
    check('openrouter: Retry-After is honored but capped at 10 s', slept[0] === 10_000, JSON.stringify(slept));
  }
  {
    const f = fakeOpenRouter([json(503, {}), json(503, {}), json(503, {}), { content: '{}', provider: 'Google' }]);
    const e = await errOf(chat({ ...base, fetchImpl: f }));
    check('openrouter: never a fourth attempt (primary, retry, secondary)', e?.code === 'server-error' && f.calls.chat.length === 3
      && e.fellBack && JSON.stringify(e.primaryErrors) === '["server-error","server-error"]', `${e?.code} after ${f.calls.chat.length} requests`);
    const f2 = fakeOpenRouter([json(503, {}), json(401, {}), { content: '{}', provider: 'Google' }]);
    const e2 = await errOf(chat({ ...base, fetchImpl: f2 }));
    check('openrouter: a retry that fails with a non-fallback error does not fall back', e2?.code === 'auth' && f2.calls.chat.length === 2, `${e2?.code} after ${f2.calls.chat.length}`);
  }
  {
    // A timed-out request may still be billed: its worst case counts against the cost cap.
    const f = fakeOpenRouter([hang, hang, hang]);
    const budget = createBudget();
    await errOf(chat({ ...base, fetchImpl: f, timeoutMs: 30, budget }));
    check('openrouter: timed-out attempts count their worst-case cost toward the cap', budget.used.costUsd > 0 && budget.used.calls === 3, JSON.stringify(budget.used));
  }
  {
    // Per-call cap: input (+30% margin) and output must fit the pinned endpoint's context.
    const saved = ENDPOINTS['deepseek/deepseek-v3.2'][0].context_length;
    ENDPOINTS['deepseek/deepseek-v3.2'][0].context_length = 4000;
    const f = fakeOpenRouter([{ content: '{}', provider: 'DeepInfra' }]);
    const e = await errOf(chat({ ...base, fetchImpl: f, user: 'x'.repeat(12_000) }));
    check('openrouter: a call over the context length is refused before sending, no fallback', e?.code === 'context-cap' && f.calls.chat.length === 0, e?.message);
    ENDPOINTS['deepseek/deepseek-v3.2'][0].context_length = saved;
  }
  {
    const f = fakeOpenRouter([{ content: '{"ok":true}', provider: 'Venice' }, { content: '{"ok":true}', provider: 'Google AI Studio' }]);
    const e = await errOf(chat({ ...base, fetchImpl: f }));
    check('openrouter: secondary served by an unpinned provider fails the call', e?.code === 'provider-mismatch' && f.calls.chat.length === 2, e?.message);
  }
  {
    // Provider confirmation: the reply's own provider field counts; stats that never appear make it unconfirmed.
    const f = fakeOpenRouter([{ content: '{"ok":1}', replyProvider: 'DeepInfra' }]);
    const seen = [];
    const r = await chat({ ...base, fetchImpl: f, debug: (d) => seen.push(d) });
    check('openrouter: provider confirmed from the reply field when stats never appear (waits through ~30 s of backoff)',
      r.provider === 'DeepInfra' && f.calls.generation.length === 8 && seen[0]?.statsTries.length === 8, JSON.stringify(seen[0]));
    check('openrouter: debug output has field names, ids and statuses only',
      Array.isArray(seen[0]?.replyFields) && !JSON.stringify(seen[0]).includes('"ok"') && !JSON.stringify(seen[0]).includes(FAKE_KEY));
    const f2 = fakeOpenRouter([{ content: '{}' }, { content: '{}' }]);
    const e2 = await errOf(chat({ ...base, fetchImpl: f2 }));
    check('openrouter: no provider from either source is a mismatch (strict), on both routes', e2?.code === 'provider-mismatch' && f2.calls.chat.length === 2, e2?.message);
    const f3 = fakeOpenRouter([{ content: '{}', provider: 'DeepInfra', replyProvider: 'Venice' }, { content: '{}', provider: 'Google' }]);
    const r3 = await chat({ ...base, fetchImpl: f3 });
    check('openrouter: sources disagreeing (one unpinned) is a mismatch', r3.fellBack && r3.primaryError === 'provider-mismatch');
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
    const f = fakeOpenRouter([json(503, {}), json(503, {}), { content: '{"ok":1}', provider: 'Google', usage }]); // no cost reported
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

  // ---------- Phase 2: preparation, validation, sanitizing, caps, links (invented data, stubbed model) ----------
  {
    const { prepare, validate, sanitize, analyzeAll } = require('../src/digest/analyze');
    const { renderDigest } = require('../src/digest/render');
    const ext = { id: 'C-EXT', external: true };
    const int = { id: 'C-INT', external: false };
    const counts = newCounts();
    const { lines, refMap } = prepare([
      { conv: ext, ts: '100.000001', who: 'Pat', text: 'mail pat@example.test, call 555-123-4567' },
      { conv: int, ts: '200.000002', who: 'Sam', text: 'mail sam@example.test, key sk-abcdefghijklmnop1234', threadTs: '150.000000' },
    ], counts);
    check('phase2: references m001.. map to conversation and timestamp', lines[0].ref === 'm001' && refMap.get('m002').conv === 'C-INT' && refMap.get('m002').threadTs === '150.000000');
    check('phase2: external text fully masked, internal only secrets, names kept',
      lines[0].text === 'mail [email], call [phone]' && lines[1].text === 'mail sam@example.test, key [secret]' && lines[0].who === 'Pat' && counts.email === 1 && counts.secret === 1, JSON.stringify(lines));
    const v = validate('customer', {
      went_wrong: [
        { summary: 'Calls dropped', severity: 'HIGH', refs: ['m001', 'm999'] },
        { summary: 'Invented with no source', severity: 'high', refs: [] },
        { summary: 'Made-up reference', severity: 'low', refs: ['m777'] },
      ],
      risks: [{ summary: '  ', likelihood: 'high', refs: ['m002'] }],
      notable: true,
    }, refMap);
    check('phase2: only cited items survive; unknown refs removed; drops counted',
      v.wentWrong.length === 1 && v.wentWrong[0].refs.join() === 'm001' && v.wentWrong[0].severity === 'high' && v.risks.length === 0 && v.dropped === 3, JSON.stringify(v));
    const v2 = validate('customer', { went_wrong: [{ summary: 'x', refs: ['m404'] }], risks: [], notable: true }, refMap);
    check('phase2: "notable" is decided by code, not the model', v2.notable === false && v2.dropped === 1);
    const six = Array.from({ length: 6 }, (_, i) => ({ summary: `p${i}`, refs: ['m001'] }));
    check('phase2: at most 5 items per list', validate('unit', { points: six }, refMap).points.length === 5);
    let shapeErr = null;
    try { validate('customer', { went_wrong: 'oops' }, refMap); } catch (e) { shapeErr = e.code; }
    check('phase2: a wrong shape is rejected', shapeErr === 'bad-shape');
    const dirty = 'See <https://evil.test/x|here>, [click](https://evil.test) or https://evil.test/a and www.evil.test, ping <@U123> <!channel> @everyone, mail a@b.test';
    const clean = sanitize(dirty);
    check('phase2: model text loses links, mentions, emails and markup', !/https?:|www\.|evil\.test|<|@|\]\(/.test(clean), clean);
    // Links come only from the reference map.
    const res = new Map([['C-EXT', { ok: true, notable: true, refMap, dropped: 0,
      wentWrong: [{ summary: sanitize('Outage https://evil.test'), severity: 'high', refs: ['m002'] }], risks: [] }]]);
    const md = renderDigest({
      units: [{ bu: 'Unit B', subs: [{ sub: 'Customers', blocks: [{ conv: { id: 'C-EXT', name: 'success-acme', type: 'public', external: false }, compressed: { stats: { messagesIn: 3 } } }], quiet: [], errors: [], analysis: res }] }],
      window: { start: 0, end: 86400, hours: 24, reason: 'test' }, footer: [],
      ctx: { workspaceUrl: 'https://ws.example.test', analyzed: true, writtenBy: 'model X via Provider Y', nameOf: () => '' }, customerKey: { bu: 'Unit B', sub: 'Customers' },
    });
    const urls = md.match(/https?:\/\/[^\s)]+/g) ?? [];
    check('phase2: every link in the digest is a code-built Slack link',
      urls.length === 1 && urls[0] === 'https://ws.example.test/archives/C-INT/p200000002?thread_ts=150.000000&cid=C-INT' && md.includes('Written by: model X via Provider Y'), urls.join(' '));
    // A run-level cap stops the remaining calls; a bad reply shape fails only its own job.
    const jobs = [0, 1, 2].map((i) => ({ kind: 'unit', key: `k${i}`, header: 'h', messages: [{ conv: int, ts: `${i}.0`, who: 'x', text: 'y' }] }));
    let n = 0;
    const stub = async () => {
      n++;
      if (n === 1) return { route: 'primary', model: 'm', provider: 'P', json: { points: 'nope' }, usage: {}, costUsd: 0 };
      const e = new Error('cap'); e.code = 'cost-cap'; throw e;
    };
    const out = await analyzeAll(jobs, { routes: {}, budget: null, maskCounts: newCounts(), concurrency: 1, chatImpl: stub });
    check('phase2: bad shape fails one job; a cost cap stops the rest without calling',
      out[0].error === 'bad-shape' && out[1].error === 'cost-cap' && out[2].error === 'not sent: cost-cap' && n === 2, JSON.stringify(out.map((o) => o.error)));
  }

  // ---------- Caps: an oversized invented window (phase 3) ----------
  {
    const { planJobs, analyzeAll: runAll } = require('../src/digest/analyze');
    const { renderDigest: render } = require('../src/digest/render');
    const conv = (id) => ({ id, external: false });
    const msgs = (id, n, chars) => Array.from({ length: n }, (_, k) => ({ conv: conv(id), ts: `${1000 + k}.0`, who: 'Invented Person', text: 'z'.repeat(chars) }));
    // 40 customers of growing size (about 2k to 40k tokens each, about 840k in all), 6 unit sub-groups, and one
    // customer far over the per-call cap.
    const jobs = [];
    for (let i = 1; i <= 40; i++) jobs.push({ kind: 'customer', key: `C${i}`, header: `Customer channel: #c${i}.`, messages: msgs(`C${i}`, 4 * i, 400) });
    for (let i = 1; i <= 6; i++) jobs.push({ kind: 'unit', key: `U${i}`, header: `Unit ${i}.`, messages: msgs(`G${i}`, 20 * i, 400) });
    jobs.push({ kind: 'customer', key: 'CBIG', header: 'Customer channel: #big.', messages: msgs('CBIG', 1200, 1000) });
    const plan = planJobs(jobs, { runCap: 400_000, callCap: 100_000 });
    const kept = jobs.filter((j) => !j.capSkipped);
    const big = jobs.find((j) => j.key === 'CBIG');
    check('caps: the planned input stays under the 400k run cap', plan.estimatedInputTokens <= 400_000 && kept.reduce((t, j) => t + j.est, 0) === plan.estimatedInputTokens, String(plan.estimatedInputTokens));
    check('caps: a call over the per-call cap keeps its newest messages and fits', big.est <= 100_000 && big.trimmed > 0 && big.messages.at(-1).ts === '2199.0', `${big.est} tokens, trimmed ${big.trimmed}`);
    const keptCustomers = kept.filter((j) => j.kind === 'customer').map((j) => j.messages.length + j.trimmed);
    const skippedCustomers = jobs.filter((j) => j.capSkipped && j.kind === 'customer').map((j) => j.messages.length + j.trimmed);
    check('caps: busiest customers are summarized first; the rest are skipped, not aborted',
      plan.skippedCalls > 0 && Math.min(...keptCustomers) >= Math.max(...skippedCustomers, 0) && plan.skippedMessages === jobs.filter((j) => j.capSkipped).reduce((t, j) => t + j.messages.length + j.trimmed, 0),
      JSON.stringify({ skipped: plan.skippedCalls, kept: keptCustomers.length }));
    check('caps: customers come before unit sub-groups', jobs.filter((j) => j.kind === 'unit').every((j) => j.capSkipped) || jobs.filter((j) => j.kind === 'customer').every((j) => !j.capSkipped));
    let sent = 0;
    const stub = async () => { sent++; return { route: 'primary', model: 'm', provider: 'P', json: { went_wrong: [], risks: [], points: [] }, usage: {}, costUsd: 0 }; };
    const out = await runAll(jobs, { routes: {}, budget: null, maskCounts: newCounts(), concurrency: 3, chatImpl: stub });
    check('caps: skipped calls are never sent', sent === kept.length && out.filter((r) => r.capSkipped).length === plan.skippedCalls, `${sent} sent, ${kept.length} planned`);
    // The digest names what was not summarized, with counts.
    const blocks = jobs.filter((j) => j.kind === 'customer').map((j) => ({ conv: { id: j.key, name: j.key.toLowerCase(), type: 'public' }, compressed: { stats: { messagesIn: j.messages.length + j.trimmed } } }));
    const analysis = new Map(jobs.filter((j) => j.kind === 'customer').map((j) => [j.key, out[jobs.indexOf(j)]]));
    const md = render({ units: [{ bu: 'Unit B', subs: [{ sub: 'Customers', blocks, quiet: [], errors: [], analysis }] }], window: { start: 0, end: 86400, hours: 24, reason: 'test' }, footer: [],
      ctx: { workspaceUrl: 'https://ws.example.test', analyzed: true, writtenBy: 'm via P', nameOf: () => '' }, customerKey: { bu: 'Unit B', sub: 'Customers' } });
    check('caps: the digest lists "Not summarized (cap)" with counts', new RegExp(`Not summarized \\(cap\\): ${skippedCustomers.length} customers, ${skippedCustomers.reduce((a, b) => a + b, 0)} messages`).test(md));
  }

  // ---------- Slack DM delivery (phase 3): send-only client and message (invented IDs and text) ----------
  {
    const { createSender, METHODS } = require('../src/slack-send');
    const { buildDm, MAX_CHARS } = require('../src/digest/dm');
    const ME = 'U0INVENTED1';
    const BOT_TOKEN = 'invented-bot-token';
    function fakeSlack({ openReply } = {}) {
      const calls = [];
      const f = async (url, init = {}) => {
        const u = new URL(url);
        calls.push({ host: u.hostname, method: u.pathname.replace('/api/', ''), init });
        const ok = (b) => json(200, { ok: true, ...b });
        if (u.hostname === 'files.example-upload.slack.com') return json(200, {});
        switch (u.pathname) {
          case '/api/conversations.open': return ok(openReply ?? { channel: { id: 'D0INVENTED', is_im: true, user: ME } });
          case '/api/chat.postMessage': return ok({ channel: 'D0INVENTED', ts: '1.0' });
          case '/api/files.getUploadURLExternal': return ok({ upload_url: 'https://files.example-upload.slack.com/upload/v1/abc', file_id: 'F0INVENTED' });
          case '/api/files.completeUploadExternal': return ok({ files: [{ id: 'F0INVENTED' }] });
          default: return json(200, { ok: false, error: 'unknown_method' });
        }
      };
      f.calls = calls;
      return f;
    }
    {
      const f = fakeSlack();
      const s = createSender({ recipient: ME, fetchImpl: f, tokenReader: () => BOT_TOKEN });
      let early;
      try { await s.postText('x'); } catch (e) { early = e.code; }
      await s.openDm();
      await s.postText('Invented one-line test.');
      await s.uploadFile('2026-01-01.md', Buffer.from('invented digest'), 'Slack digest');
      const api = f.calls.filter((c) => c.host === 'slack.com');
      const upload = f.calls.find((c) => c.host !== 'slack.com');
      check('deliver: nothing is posted before the DM is verified', early === 'dm-not-verified');
      check('deliver: open DM, post, get upload URL, upload, complete; into the verified DM only',
        api.map((c) => c.method).join(',') === 'conversations.open,chat.postMessage,files.getUploadURLExternal,files.completeUploadExternal'
        && JSON.parse(api[1].init.body).channel === 'D0INVENTED' && JSON.parse(api[3].init.body).channel_id === 'D0INVENTED', api.map((c) => c.method).join(','));
      check('deliver: bot token only in the Authorization header, never sent to the upload host',
        api.every((c) => c.init.headers.Authorization === `Bearer ${BOT_TOKEN}` && !String(c.init.body).includes(BOT_TOKEN)) && !JSON.stringify(upload.init.headers).includes(BOT_TOKEN));
      check('deliver: links are not unfurled', JSON.parse(api[1].init.body).unfurl_links === false);
      check('deliver: only four write-side methods are known', [...METHODS].sort().join(',') === 'chat.postMessage,conversations.open,files.completeUploadExternal,files.getUploadURLExternal');
    }
    for (const [label, openReply] of [
      ['a DM with someone else', { channel: { id: 'D0OTHER', is_im: true, user: 'U0SOMEONE' } }],
      ['a channel, not a DM', { channel: { id: 'C0CHANNEL', is_im: false, user: ME } }],
      ['no user field', { channel: { id: 'D0INVENTED' } }],
    ]) {
      const f = fakeSlack({ openReply });
      const s = createSender({ recipient: ME, fetchImpl: f, tokenReader: () => BOT_TOKEN });
      let code;
      try { await s.openDm(); await s.postText('x'); } catch (e) { code = e.code; }
      check(`deliver: refused when conversations.open returns ${label}; nothing posted`, code === 'dm-mismatch' && !f.calls.some((c) => c.method === 'chat.postMessage'), code);
    }
    {
      let code;
      try { createSender({ recipient: 'C0CHANNEL', fetchImpl: fakeSlack(), tokenReader: () => BOT_TOKEN }); } catch (e) { code = e.code; }
      check('deliver: a recipient that is not a user ID is refused', code === 'bad-recipient');
      const f = async (url) => (new URL(url).pathname === '/api/files.getUploadURLExternal'
        ? json(200, { ok: true, upload_url: 'https://evil.example.test/up', file_id: 'F1' }) : fakeSlack()(url));
      const s = createSender({ recipient: ME, fetchImpl: f, tokenReader: () => BOT_TOKEN });
      await s.openDm();
      let up;
      try { await s.uploadFile('a.md', Buffer.from('x'), 't'); } catch (e) { up = e.code; }
      check('deliver: an upload URL off slack.com is refused', up === 'bad-upload-url');
      let tok;
      try { createSender({ recipient: ME, tokenReader: () => { throw new Error('mode'); } }); } catch (e) { tok = e.code; }
      check('deliver: an unreadable or loose bot-token file stops delivery', tok === 'bot-token');
    }
    {
      // The DM: date and model header, customer items first (escaped, code-built links), a line per other unit,
      // not-summarized counts, and under the length limit even with many items.
      const refMap = new Map([['m001', { conv: 'C1', ts: '100.000001', threadTs: null }]]);
      const item = (n, lvl) => ({ summary: `Invented problem ${n} <script> & more ${'x'.repeat(120)}`, severity: lvl, refs: ['m001'] });
      const analysis = new Map();
      const blocks = [];
      for (let i = 0; i < 12; i++) {
        blocks.push({ conv: { id: `C${i}`, name: `success-${i}`, type: 'public' }, compressed: { stats: { messagesIn: 5 } } });
        analysis.set(`C${i}`, { ok: true, notable: true, refMap, wentWrong: [item(i, i % 3 ? 'low' : 'high'), item(i + 100, 'medium')], risks: [{ ...item(i + 200, 'x'), likelihood: 'medium' }] });
      }
      blocks.push({ conv: { id: 'CQ', name: 'success-capped', type: 'public' }, compressed: { stats: { messagesIn: 9 } } });
      analysis.set('CQ', { ok: false, capSkipped: true, error: 'not summarized (cap)' });
      const units = [
        { bu: 'Unit B', subs: [{ sub: 'Customers', blocks, quiet: [], errors: [], analysis }] },
        { bu: 'Unit A', subs: [{ sub: 'Ops', blocks: [{ conv: { id: 'C9', name: 'ops' }, compressed: { stats: { messagesIn: 3 } } }], quiet: [], errors: [],
          analysis: { ok: true, refMap, points: [{ summary: 'Invented ops point', refs: ['m001'] }] } }] },
      ];
      const { text, stats } = buildDm({ units, ctx: { workspaceUrl: 'https://ws.example.test', writtenBy: 'm via P', me: null }, customerKey: { bu: 'Unit B', sub: 'Customers' },
        window: { start: 0, end: 86400, hours: 24 }, counts: { noCloud: { conversations: 2, messages: 7 }, unreadable: 1 } });
      const links = text.match(/<[^>]+>/g) ?? [];
      check('dm: under the length limit, with the rest pointed to the file', text.length <= MAX_CHARS && stats.customerItemsShown < stats.customerItems && /…and \d+ more in the file/.test(text), `${text.length} chars`);
      check('dm: header, customer risks first, other units, then not-summarized counts', /^\*Slack digest, .*\n+Model: m via P/.test(text)
        && text.indexOf('*Unit B risks*') < text.indexOf('*Other units*') && text.indexOf('*Other units*') < text.indexOf('*Not summarized*')
        && /Unit A: 1 active conversation: Invented ops point/.test(text) && /2 conversations on the noCloud list \(7 messages\); 1 call over the cap \(9 messages\); 1 conversation unreadable/.test(text));
      check('dm: most severe items first', text.split('\n').find((l) => l.startsWith('• ')).includes('[high problem]'));
      check('dm: model text is escaped; the only links are code-built Slack links', !text.includes('<script>') && text.includes('&lt;script&gt; &amp;')
        && links.length > 0 && links.every((l) => l.startsWith('<https://ws.example.test/archives/C1/p100000001|')));
    }
  }

  // ---------- Healthcheck ping helper (phase 3) ----------
  {
    const { checkPingFile, ping } = require('../src/healthcheck');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-'));
    fs.writeFileSync(path.join(dir, 'healthcheck-url-t'), 'https://hc.example.test/ping/invented\n', { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'healthcheck-url-loose'), 'https://hc.example.test/x\n', { mode: 0o644 });
    fs.chmodSync(path.join(dir, 'healthcheck-url-loose'), 0o644);
    let e1;
    try { checkPingFile('loose', dir); } catch (e) { e1 = e.message; }
    let e2;
    try { checkPingFile('missing', dir); } catch (e) { e2 = e.message; }
    check('healthcheck: loose or missing URL file refused', /mode 600/.test(e1 ?? '') && /not found/.test(e2 ?? ''));
    const sent = [];
    const f = async (url, init) => { sent.push({ url, body: init.body }); return { ok: true, status: 200 }; };
    await ping('t', false, 'ok', { fetchImpl: f, dir });
    await ping('t', true, 'x'.repeat(20_000), { fetchImpl: f, dir });
    check('healthcheck: success to the URL, failure to /fail, body cut to 10 kB',
      sent[0].url === 'https://hc.example.test/ping/invented' && sent[1].url === 'https://hc.example.test/ping/invented/fail' && sent[1].body.length === 10_000);
    fs.rmSync(dir, { recursive: true });
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
