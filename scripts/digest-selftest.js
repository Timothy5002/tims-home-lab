'use strict';
// Self-tests for the Slack digest's guard code, using invented text only: masking (src/mask.js), the OpenRouter
// client's guards, primary retry and primary/secondary fallback (src/openrouter.js, with a fake API so nothing
// leaves the Mac), validation and the noise rules, the customer registry and mention matching, the pipeline end to
// end with a stubbed model (merging, Leadership flag, fallback, unit modes, own conversations, incidents), call
// concurrency and the batch provider check, the headline check, the run and per-call caps, the membership refresh,
// scripts/digest-map.js (on temp configs), the archive file, the DM (top-level and threaded replies) and the
// send-only Slack client (fake Slack), the healthcheck helper, the secret-file check, and bot compression
// (src/digest/compress.js). Run after changing any of them: node scripts/digest-selftest.js
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
    external: { units: ['Unit B'], internalPrefixes: ['success-', 'grp'] } };
  cfg.rules = [{ bu: 'Unit B', sub: null, label: 'r', test: () => true }];
  const ext = (name, extra = {}) => placeChannel(cfg, { id: 'C1', name, type: 'public', ...extra }).external;
  check('external: customer channel in the external unit is external', ext('acme-coordination') === true);
  check('external: success- prefix is internal', ext('success-acme') === false);
  check('external: a second internal prefix is internal, case-insensitive', ext('grp-team-notes') === false && ext('Grpwork-ops') === false);
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
// randomImpl 0: no retry jitter, so backoffs are exact (jitter has its own test).
const base = { routes: ROUTES, system: 'Reply in json.', user: 'Invented text: the widget shipped.', keyReader: () => FAKE_KEY, sleepImpl: async () => {}, randomImpl: () => 0 };
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
    const f = fakeOpenRouter([json(429, {}), { content: '{}', provider: 'Google' }, { content: '{}', provider: 'Google' }]);
    const r = await chat({ ...base, fetchImpl: f, only: 'secondary' });
    const f2 = fakeOpenRouter([json(503, {}), json(503, {}), { content: '{}', provider: 'Google' }]);
    const e2 = await errOf(chat({ ...base, fetchImpl: f2, only: 'primary' }));
    check('openrouter: a single-route call (only) gets the one retry and never falls back',
      r.route === 'secondary' && r.retried && f.calls.chat.length === 2 && e2?.code === 'server-error' && f2.calls.chat.length === 2, `${f.calls.chat.length}, ${f2.calls.chat.length}`);
  }
  {
    const slept = [];
    const f = fakeOpenRouter([json(429, {}, { 'retry-after': '60' }), { content: '{}', provider: 'DeepInfra' }]);
    await chat({ ...base, fetchImpl: f, sleepImpl: async (ms) => { slept.push(ms); } });
    check('openrouter: Retry-After is honored but capped at 10 s', slept[0] === 10_000, JSON.stringify(slept));
  }
  {
    const slept = [];
    const f = fakeOpenRouter([json(429, {}, { 'retry-after': '4' }), { content: '{}', provider: 'DeepInfra' }]);
    await chat({ ...base, fetchImpl: f, randomImpl: () => 0.5, sleepImpl: async (ms) => { slept.push(ms); } });
    check('openrouter: the primary retry waits Retry-After plus jitter (up to 1 s)', slept[0] === 4500, JSON.stringify(slept));
  }
  {
    // Deferred provider check (the digest): only the reply's field during the call, the stats later in a batch.
    const f = fakeOpenRouter([{ content: '{}', replyProvider: 'SomeOtherCo', provider: 'SomeOtherCo' }, { content: '{}', replyProvider: 'Google', provider: 'Google' }]);
    const r = await chat({ ...base, fetchImpl: f, deferStats: true });
    check('openrouter: deferred check: a reply naming a non-pinned provider is a mismatch at once and falls back, no stats read',
      r.route === 'secondary' && r.fellBack && r.primaryErrors[0] === 'provider-mismatch' && f.calls.generation.length === 0, JSON.stringify({ route: r.route, gen: f.calls.generation.length }));
    const f2 = fakeOpenRouter([{ content: '{}', provider: 'DeepInfra' }]);
    const r2 = await chat({ ...base, fetchImpl: f2, deferStats: true });
    check('openrouter: deferred check: no provider in the reply returns at once, pending the batch', r2.route === 'primary' && r2.statsPending && r2.replyProvider === null && f2.calls.generation.length === 0);
    const { verifyGenerations } = require('../src/openrouter');
    const f3 = fakeOpenRouter([{ content: '{}', provider: 'DeepInfra' }, { content: '{}', provider: 'SomeOtherCo' }, { content: '{}' }, { content: '{}', replyProvider: 'DeepInfra' }]);
    const rs = [];
    for (let i = 0; i < 4; i++) rs.push(await chat({ ...base, fetchImpl: f3, deferStats: true, only: 'primary' }));
    const sleeps = [];
    const v = await verifyGenerations(rs, { fetchImpl: f3, keyReader: () => FAKE_KEY, sleepImpl: async (ms) => { sleeps.push(ms); } });
    check('openrouter: batch check: pinned confirmed, other provider and no source at all are mismatches, a pinned reply field alone confirms',
      JSON.stringify(v.map((x) => x.ok)) === '[true,false,false,true]', JSON.stringify(v));
    check('openrouter: batch check waits once for the whole batch (about 30 s at most), not per call',
      sleeps.reduce((a, b) => a + b, 0) <= 30_000 && f3.calls.generation.filter((g) => g).length <= 4 + 2 * 7, JSON.stringify({ sleeps, gen: f3.calls.generation.length }));
    const f4 = fakeOpenRouter([json(503, {})]);
    const e4 = await errOf(chat({ ...base, fetchImpl: f4, secondaryOnce: true }));
    check('openrouter: secondaryOnce makes exactly one secondary attempt, no retry', e4?.code === 'server-error' && f4.calls.chat.length === 1 && f4.calls.chat[0].body.model === 'google/gemini-3.8-flash');
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

  // ---------- Validation and the noise rules (invented data) ----------
  {
    const { prepare, validate, sanitize, analyzeAll } = require('../src/digest/analyze');
    const ext = { id: 'C-EXT', external: true };
    const int = { id: 'C-INT', external: false };
    const counts = newCounts();
    const { lines, refMap } = prepare([
      { conv: ext, ts: '100.000001', who: 'Pat', text: 'mail pat@example.test, call 555-123-4567' },
      { conv: int, ts: '200.000002', who: 'Sam', text: 'mail sam@example.test, key sk-abcdefghijklmnop1234', threadTs: '150.000000' },
      { conv: int, ts: '300.000003', who: 'RiskBot (bot)', text: 'Risk: invented renewal at risk', bot: true },
    ], counts);
    check('validate: references m001.. map to conversation, timestamp and bot flag', lines[0].ref === 'm001' && refMap.get('m002').conv === 'C-INT' && refMap.get('m002').threadTs === '150.000000' && refMap.get('m003').bot === true);
    check('validate: external text fully masked, internal only secrets, names kept',
      lines[0].text === 'mail [email], call [phone]' && lines[1].text === 'mail sam@example.test, key [secret]' && lines[0].who === 'Pat' && counts.email === 1 && counts.secret === 1, JSON.stringify(lines));
    const v = validate('customer', { items: [
      { summary: 'Calls dropped', kind: 'problem', severity: 'HIGH', category: 'incident', refs: ['m001', 'm999'] },
      { summary: 'Invented with no source', severity: 'high', category: 'incident', refs: [] },
      { summary: 'EOD report not posted', severity: 'low', category: 'bot-hygiene', refs: ['m003'] },
      { summary: 'An employee was late again', severity: 'medium', category: 'personnel', refs: ['m002'] },
      { summary: 'Thanks for the call', severity: 'low', category: 'other', refs: ['m002'] },
      { summary: 'Renewal at risk per the risk report', kind: 'risk', severity: 'medium', category: 'commercial', refs: ['m003'] },
    ] }, refMap);
    check('noise: only cited evidence items survive; bot hygiene, personnel and other are dropped and counted',
      v.items.length === 2 && v.items[0].refs.join() === 'm001' && v.items[0].severity === 'high' && v.drops.badRef === 1 && v.drops.botHygiene === 1
      && v.drops.personnel === 1 && v.drops.notEvidence === 1 && v.dropped === 4, JSON.stringify(v));
    check('noise: an item resting only on bot posts is labeled a bot report (in code)', v.items[1].botReport === true && v.items[0].botReport === false);
    const v2 = validate('customer', { items: [{ summary: 'x', category: 'incident', refs: ['m404'] }] }, refMap);
    check('validate: "notable" is decided by code, not the model', v2.notable === false && v2.dropped === 1);
    const six = Array.from({ length: 6 }, (_, i) => ({ summary: `p${i}`, category: 'work', refs: ['m001'] }));
    check('validate: at most 5 unit points, 3 brief points', validate('unit', { points: six }, refMap).points.length === 5 && validate('brief', { points: six }, refMap).points.length === 3);
    const longBrief = validate('brief', { points: [{ summary: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen', category: 'work', refs: ['m001'] }] }, refMap).points[0].summary;
    check('validate: brief items are never cut (the DM drops whole lines instead)', longBrief.split(' ').length === 14 && !longBrief.endsWith('…'));
    check('validate: personnel points are dropped from unit summaries too', validate('unit', { points: [{ summary: 'Invented discipline matter', category: 'personnel', refs: ['m002'] }] }, refMap).points.length === 0);
    let shapeErr = null;
    try { validate('customer', { items: 'oops' }, refMap); } catch (e) { shapeErr = e.code; }
    check('validate: a wrong shape is rejected', shapeErr === 'bad-shape');
    const dirty = 'See <https://evil.test/x|here>, [click](https://evil.test) or https://evil.test/a and www.evil.test, ping <@U123> <!channel> @everyone, mail a@b.test';
    const clean = sanitize(dirty);
    check('validate: model text loses links, mentions, emails and markup', !/https?:|www\.|evil\.test|<|@|\]\(/.test(clean), clean);
    // Synthesis: code decides severity, the Leadership flag and the best evidence; the headline is cut to 20 words.
    const sp = prepare([
      { conv: int, ts: '1.0', who: 'Pat', text: 'a' },
      { conv: { id: 'C-LEAD', external: false }, ts: '2.0', who: 'Dana', text: 'b', mention: 'leadership' },
    ], newCounts(), 's');
    const sv = validate('synth', { headline: Array.from({ length: 30 }, (_, i) => `w${i}`).join(' '), points: [
      { summary: 'Medium point', severity: 'medium', category: 'deadline', refs: ['s001'] },
      { summary: 'Personnel point', severity: 'high', category: 'personnel', refs: ['s002'] },
    ] }, sp.refMap);
    check('synthesis: severity is the strongest kept point, not the model\'s claim; a long headline is kept whole and gives no short headline',
      sv.severity === 'medium' && sv.headline.split(' ').length === 30 && !sv.headline.includes('…') && sv.short === '' && sv.bestRef === 's001' && sv.leadership === false, JSON.stringify(sv));
    const svShort = validate('synth', { headline: 'Calls failed twice and the customer is considering a competitor before renewal next month', short_headline: 'Call failures; customer considering a competitor',
      headline_refs: ['s001', 's999'], points: [{ summary: 'Calls failed', severity: 'high', category: 'incident', refs: ['s001'] }] }, sp.refMap);
    check('synthesis: the short headline is kept verbatim; headline references are checked against the input',
      svShort.short === 'Call failures; customer considering a competitor' && JSON.stringify(svShort.headlineRefs) === '["s001"]', JSON.stringify(svShort));
    const sv3 = validate('synth', { headline: 'Short and complete', short_headline: 'one two three four five six seven eight nine ten eleven twelve thirteen', points: [{ summary: 'x', severity: 'high', category: 'incident', refs: ['s002'] }] }, sp.refMap);
    check('synthesis: a short headline over 12 words is not used (never cut); a 12-word headline stands in; no headline refs means the strong points\' refs',
      sv3.short === 'Short and complete' && JSON.stringify(sv3.headlineRefs) === '["s002"]', JSON.stringify(sv3));
    const vf = (reply) => validate('verify', reply, sp.refMap);
    check('verify: verdicts are checked; overstated needs a correction (else unsupported); the corrected short headline is never cut',
      vf({ verdict: 'supported' }).verdict === 'supported' && vf({ verdict: 'overstated', corrected_headline: 'Per Delaine, the customer is considering Rivalco.', corrected_short_headline: 'Per Delaine, considering Rivalco' }).short === 'Per Delaine, considering Rivalco'
      && vf({ verdict: 'overstated', corrected_headline: '' }).verdict === 'unsupported' && (() => { try { vf({ verdict: 'maybe' }); return false; } catch (e) { return e.code === 'bad-shape'; } })());
    const sv2 = validate('synth', { headline: 'h', points: [{ summary: 'Leadership asked for an owner', severity: 'medium', category: 'ownership', refs: ['s002'] }] }, sp.refMap);
    check('synthesis: Leadership flag only when a kept point cites a Leadership message', sv2.leadership === true);
    check('incident: null and a cited incident both validate', validate('incident', { incident: null }, refMap).incident === null
      && validate('incident', { incident: { summary: 'Calls failing for all customers', refs: ['m001'] } }, refMap).incident.refs[0] === 'm001');
    // A run-level cap stops the remaining calls; a bad reply shape fails only its own job.
    const jobs = [0, 1, 2].map((i) => ({ kind: 'unit', key: `k${i}`, header: 'h', messages: [{ conv: int, ts: `${i}.0`, who: 'x', text: 'y' }] }));
    let n = 0;
    const stub = async () => {
      n++;
      if (n === 1) return { route: 'primary', model: 'm', provider: 'P', json: { points: 'nope' }, usage: {}, costUsd: 0 };
      const e = new Error('cap'); e.code = 'cost-cap'; throw e;
    };
    const out = await analyzeAll(jobs, { routes: {}, budget: null, maskCounts: newCounts(), concurrency: 1, startGapMs: 0, chatImpl: stub });
    check('validate: bad shape fails one job; a cost cap stops the rest without calling',
      out[0].error === 'bad-shape' && out[1].error === 'cost-cap' && out[2].error === 'not sent: cost-cap' && n === 2, JSON.stringify(out.map((o) => o.error)));
  }

  // ---------- Customer registry (invented names) ----------
  const { buildRegistry, mentionedCustomers } = require('../src/digest/customers');
  const REG_CFG = {
    customerSources: ['Unit B > Success', 'Unit B > Customer channels'], anchorSources: ['Unit B > Success'],
    mentionSources: [{ unit: 'Unit B > Leadership', leadership: true }, { unit: 'Unit B > Internal', leadership: false }],
    stripPrefixes: ['success-', 'partner-and-'], stripSuffixes: ['-ourco-coordination', '-coordination', '-external'],
    dropWords: new Set(['ourco', 'and', 'coordination', 'external']), minContainLength: 5, minAliasLength: 4,
    customers: { birchhealth: { name: 'Birch Health', keys: ['birchhq'], aliases: ['Birch'] } },
    notCustomers: new Set(['partner-updates']), noMention: new Set(),
  };
  const ch = (id, name, sub, type = 'public') => ({ id, name, type, bu: 'Unit B', sub, label: `#${name}` });
  const REG_CONVS = [
    ch('S1', 'success-acme-corp', 'Success'), ch('S2', 'success-birch-health', 'Success'), ch('S3', 'success-ash', 'Success'),
    ch('X1', 'acmecorp-ourco-coordination', 'Customer channels'), ch('X2', 'partner-and-acme-corp-external', 'Customer channels'),
    ch('X3', 'birchhq-coordination', 'Customer channels'), ch('X4', 'zenith-coordination', 'Customer channels'),
    ch('X5', 'partner-and-zenith', 'Customer channels'), ch('X6', 'partner-updates', 'Customer channels'),
    { id: 'G1', name: 'mpdm-a--b-1', type: 'group_dm', bu: 'Unit B', sub: 'Customer channels', label: 'DM: A, B' },
    ch('L1', 'leadership', 'Leadership'), ch('I1', 'team-internal', 'Internal'), ch('O1', 'ops', 'Ops'),
  ];
  {
    const reg = buildRegistry(REG_CONVS, REG_CFG);
    const cust = (k) => reg.customers.find((c) => c.key === k);
    check('registry: success channels define customers; coordination and external channels join by key',
      JSON.stringify(cust('acmecorp')?.convIds) === '["S1","X1","X2"]' && cust('acmecorp').name === 'Acme Corp', JSON.stringify(cust('acmecorp')));
    check('registry: a configured extra key joins a differently spelled channel', JSON.stringify(cust('birchhealth')?.convIds) === '["S2","X3"]' && cust('birchhealth').name === 'Birch Health');
    const z = reg.customers.find((c) => c.key === 'unmatched:zenith');
    check('registry: channels matching no customer are listed, grouped by key, and still get a record',
      z?.unmatched && JSON.stringify(z.convIds) === '["X4","X5"]' && reg.unmatched.length === 3 && reg.customers.some((c) => c.key === 'unmatched:G1'), JSON.stringify(reg.unmatched.map((u) => u.conv.id)));
    check('registry: general channels are not customers', reg.general.map((c) => c.id).join() === 'X6' && !reg.byConv.has('X6'));
    check('registry: mention channels with the Leadership flag', reg.mentionConvs.get('L1') === 'leadership' && reg.mentionConvs.get('I1') === 'internal' && !reg.mentionConvs.has('O1'));
    check('registry: automatic aliases skip short names (set those by hand)', cust('ash').aliases.length === 0 && cust('acmecorp').aliases.includes('acme corp'));
    const m = (t) => mentionedCustomers(t, reg).sort().join();
    check('mentions: whole-word, case-insensitive, hyphen or space or nothing between words',
      m('Is ACME-Corp ok?') === 'acmecorp' && m('acmecorp renewal') === 'acmecorp' && m('Birch is unhappy') === 'birchhealth' && m('birchwood trees') === '' && m('the acme corporation') === '', [m('Is ACME-Corp ok?'), m('birchwood trees'), m('the acme corporation')].join('|'));
  }
  // Configured customers without a success channel, case-sensitive aliases, mention matching switched off, and the
  // "other" bucket for customer-unit conversations that are not customers.
  const REG_CFG2 = { ...REG_CFG, customers: { ...REG_CFG.customers, ash: { name: 'ASH', exactAliases: ['ASH'] }, zenith: { name: 'Zenith' } },
    otherBucket: { name: 'Other B', channels: new Set(['G1']) }, noMention: new Set(['acme corp']) };
  {
    const reg = buildRegistry(REG_CONVS, REG_CFG2);
    const cust = (k) => reg.customers.find((c) => c.key === k);
    check('registry: a configured customer with no success channel collects its channels by key and is not unmatched',
      JSON.stringify(cust('zenith')?.convIds) === '["X4","X5"]' && !cust('zenith').unmatched && reg.unmatched.length === 0, JSON.stringify(reg.unmatched.map((u) => u.conv.id)));
    check('registry: other-bucket conversations are neither customers nor unmatched',
      reg.other?.name === 'Other B' && reg.other.convIds.has('G1') && !reg.byConv.has('G1') && !reg.customers.some((c) => c.convIds.includes('G1')));
    const m = (t) => mentionedCustomers(t, reg).sort().join();
    check('mentions: exact-case aliases match only in that case, whole word', m('ASH called about invoices') === 'ash' && m('the ash tree') === '' && m('ASHFORD office') === '', [m('the ash tree'), m('ASHFORD office')].join('|'));
    check('mentions: an automatic alias in noMention is not matched (configured aliases still are)', m('acme corp renewal') === '' && m('Birch is unhappy') === 'birchhealth');
  }

  // ---------- The pipeline end to end, stubbed model (invented data) ----------
  const { runPipeline } = require('../src/digest/pipeline');
  const P = require('../src/digest/prompts');
  const ME = 'U0INVENTED1';
  const comp = (humans, bots = []) => ({ humans, botGroups: bots, stats: { messagesIn: humans.length + bots.reduce((t, g) => t + g.count, 0), botMessagesIn: bots.reduce((t, g) => t + g.count, 0) } });
  const hm = (ts, user, text) => ({ ts, user, text, threadTs: null });
  const blk = (conv, compressed) => ({ conv: { external: false, noCloud: false, ...conv }, compressed, error: null });
  function pipelineBlocks() {
    const c = Object.fromEntries(REG_CONVS.map((x) => [x.id, x]));
    return [
      blk(c.S1, comp([hm('10.0', 'U1', 'Calls failed all morning for Acme'), hm('11.0', 'U2', 'Looking')])),
      blk(c.X1, comp([hm('12.0', 'U1', 'Acme says this risks the renewal')])),
      blk(c.S2, comp([hm('13.0', 'U3', 'Birch report is late')])),
      blk(c.S3, comp([])),
      blk(c.L1, comp([hm('14.0', 'U4', 'Acme Corp is unhappy, who owns this?'), hm('14.5', 'U4', 'Unrelated leadership topic')])),
      blk({ ...c.I1, bu: 'Internal', sub: 'Eng', label: '#eng' }, comp([hm('15.0', 'U5', 'Outbound calls failing for all customers')])),
      blk({ id: 'A1', name: 'sales', type: 'public', bu: 'Unit A', sub: null, label: '#sales' }, comp([hm('16.0', 'U6', 'Signed a renewal')], [{ botName: 'EODBot', count: 4, examples: [{ ts: '16.5', text: 'EOD report not posted' }], alerts: [] }])),
      blk({ id: 'A2', name: 'my-notes', type: 'public', bu: 'Unit A', sub: null, label: '#my-notes' }, comp([hm('17.0', ME, 'My plan for today'), hm('17.1', ME, 'More of my plan'), hm('17.2', 'U6', 'ok')])),
    ];
  }
  const MODES = { 'Unit B > Success': 'full', 'Unit B > Customer channels': 'full', 'Unit B > Leadership': 'full', 'Unit B > Internal': 'off', 'Unit A': 'brief', Internal: 'off' };
  function stubChat(log) {
    return async (o) => {
      log.push(o.system === P.CUSTOMER_SYSTEM ? 'customer' : o.system === P.SYNTH_SYSTEM ? 'synth' : o.system === P.BRIEF_SYSTEM ? 'brief' : o.system === P.INCIDENT_SYSTEM ? 'incident' : o.system === P.VERIFY_SYSTEM ? 'verify' : 'unit');
      log.users = [...(log.users ?? []), o.user];
      const r = { route: 'primary', model: 'm', provider: 'P', usage: { prompt: 10, completion: 5 }, costUsd: 0.0001 };
      if (o.system === P.CUSTOMER_SYSTEM) {
        if (o.user.includes('Birch')) return { ...r, json: { items: [{ summary: 'Birch report late', kind: 'problem', severity: 'medium', category: 'deadline', refs: ['m001'] },
          { summary: 'Invented low note', kind: 'risk', severity: 'low', category: 'sentiment', refs: ['m001'] }] } };
        if (o.user.includes('renewal')) return { ...r, json: { items: [{ summary: 'Renewal at risk', kind: 'risk', severity: 'high', category: 'commercial', refs: ['m001'] }] } };
        return { ...r, json: { items: [{ summary: 'Calls failed all morning', kind: 'problem', severity: 'high', category: 'incident', refs: ['m001'] },
          { summary: 'An agent was rude, discipline them', kind: 'problem', severity: 'medium', category: 'personnel', refs: ['m002'] }] } };
      }
      if (o.system === P.SYNTH_SYSTEM) {
        if (o.user.includes('Birch')) { const e = new Error('server'); e.code = 'server-error'; throw e; }
        const lead = o.user.match(/(s\d{3}) \[[^\]]+\] [^\n]*\(leadership\)/)?.[1];
        return { ...r, json: { headline: 'Repeated call failures put the Acme renewal at risk and leadership wants an owner',
          short_headline: 'Call failures put the Acme renewal at risk', headline_refs: ['s001', 's002'], points: [
          { summary: 'Calls failed all morning', severity: 'high', category: 'incident', refs: ['s001'] },
          { summary: 'Renewal at risk', severity: 'high', category: 'commercial', refs: ['s002'] },
          { summary: 'Leadership asked who owns it', severity: 'medium', category: 'ownership', refs: [lead] },
          { summary: 'Minor invented note', severity: 'low', category: 'sentiment', refs: ['s001'] }] } };
      }
      if (o.system === P.VERIFY_SYSTEM) return { ...r, json: { verdict: 'supported' } };
      if (o.system === P.BRIEF_SYSTEM) return { ...r, json: { points: [{ summary: 'Renewal signed', category: 'work', refs: ['m001'] }] } };
      if (o.system === P.INCIDENT_SYSTEM) return { ...r, json: o.user.includes('Outbound') ? { incident: { summary: 'Outbound calls failed for all customers', refs: ['m001'] } } : { incident: null } };
      return { ...r, json: { points: [{ summary: 'Leadership topic', category: 'work', refs: ['m001'] }] } };
    };
  }
  async function runStubPipeline(extra = {}) {
    const log = [];
    const reg = buildRegistry(REG_CONVS, REG_CFG);
    const model = await runPipeline({ blocks: pipelineBlocks(), registry: reg, modes: MODES, me: ME, nameOf: (id) => `Person ${id}`, routes: {}, budget: null,
      maskCounts: newCounts(), runCap: 400_000, callCap: 100_000, startGapMs: 0, chatImpl: stubChat(log), ...extra });
    return { model, log };
  }
  {
    const { model, log } = await runStubPipeline();
    const acme = model.records.find((r) => r.key === 'acmecorp');
    const birch = model.records.find((r) => r.key === 'birchhealth');
    check('pipeline: one record per customer, merged across its channels', model.records.filter((r) => r.key === 'acmecorp').length === 1 && acme.merged && acme.convs.length === 2, JSON.stringify(acme?.convs));
    check('pipeline: Leadership mentions reach the synthesis; flag set from the cited message', acme.leadership === true && acme.leadershipMentions === 1 && acme.mentions === 1);
    check('pipeline: personnel item from stage 1 dropped and counted', model.skipped.personnel === 1 && !JSON.stringify(acme.points).includes('rude'));
    check('pipeline: record severity high, ranked first, best evidence is the strongest point\'s message', model.records[0].key === 'acmecorp' && acme.severity === 'high' && acme.best.conv === 'S1');
    check('pipeline: failed synthesis falls back to stage-1 findings, not merged', birch.notable && !birch.merged && birch.synthError === 'server-error' && birch.severity === 'medium');
    check('pipeline: your own conversation is left out of the brief summary', model.skipped.ownConversations === 1 && !(log.users ?? []).some((u) => u.includes('My plan')));
    check('pipeline: brief unit, full Leadership summary and off-unit incident check each made', log.includes('brief') && log.includes('unit') && log.filter((k) => k === 'incident').length === 1);
    check('pipeline: an off-unit incident and customer incidents are listed', model.incidents.some((i) => i.source === 'Internal') && model.incidents.some((i) => i.source === 'Acme Corp'));
    check('pipeline: bot posts and quiet channels counted as skipped', model.skipped.botPosts === 4 && model.skipped.quietConversations === 1);
    // The archive file keeps low items and builds every link in code.
    const { renderArchive } = require('../src/digest/render');
    const md = renderArchive({ model, window: { start: 0, end: 86400, hours: 24, reason: 'test' }, footer: ['- footer'], ctx: { workspaceUrl: 'https://ws.example.test', writtenBy: 'm via P' } });
    const urls = md.match(/https?:\/\/[^\s)]+/g) ?? [];
    check('archive: merged by customer, low items kept, Leadership flagged, every link code-built',
      md.includes('### Acme Corp (HIGH · also discussed in Leadership)') && md.includes('Minor invented note') && md.includes('not merged (server-error)')
      && urls.length > 0 && urls.every((u) => u.startsWith('https://ws.example.test/archives/')), urls.join(' '));

    // ---------- The DM (top-level and thread) ----------
    const { buildDm, TOP_MAX, REPLY_MAX, MAX_REPLIES } = require('../src/digest/dm');
    const ctx = { workspaceUrl: 'https://ws.example.test', writtenBy: 'm via P' };
    const dm = buildDm({ model, window: { start: 0, end: 86400, hours: 24 }, ctx, footer: ['Model: m via P', '$0.0100'] });
    const t = dm.top;
    const thread = dm.replies.join('\n');
    check('dm: sections in order: title, Needs attention, Watch-or-not, Incident, Other units, Skipped',
      /^\*Slack digest · /.test(t) && t.indexOf('*Needs attention*') < t.indexOf('*Incident*') && t.indexOf('*Incident*') < t.indexOf('*Other units*') && t.indexOf('*Other units*') < t.indexOf('*Skipped*'), t);
    check('dm: needs-attention line: bold name, icon, the short headline verbatim, one link',
      t.includes('• *Acme Corp* 🔴 Call failures put the Acme renewal at risk <https://ws.example.test/archives/S1/p100|›>'), t);
    check('dm: a customer incident is marked on its Needs-attention line, not repeated as the Incident line',
      /• \*Acme Corp\* 🔴 .*\(incident\)$/m.test(t) && !t.includes('*Incident*: Acme Corp') && t.includes('*Incident*: Internal:'), t);
    check('dm: verification ran for the customers shown under Needs attention', model.stats.verification.checked === 2 && model.stats.verification.supported === 2 && log.filter((k) => k === 'verify').length === 2, JSON.stringify(model.stats.verification));
    check('dm: low items never in the DM or thread; model and cost only in the last reply', !t.includes('Minor invented') && !thread.includes('Minor invented') && !t.includes('Model:') && dm.replies.at(-1).includes('Model: m via P'));
    check('dm: skipped line counts bot posts and quiet channels', /\*Skipped\*: 0 bot-hygiene items, 4 bot posts, 1 quiet channel/.test(t), t.split('\n').at(-1));
    check('dm: thread has the full headline, bullets with links and the Leadership note', thread.includes('*Acme Corp* 🔴 Repeated call failures put the Acme renewal at risk and leadership wants an owner') && thread.includes('(also discussed in Leadership)') && /<https:\/\/ws\.example\.test\/archives\/[^|]+\|1>/.test(thread));
    // Oversized: 40 customers with long headlines and long bullets, many long unit items and incidents.
    const longText = (i, n) => `Invented point ${i}: ${Array.from({ length: n }, (_, k) => `word${k}`).join(' ')}.`;
    const ev = [{ conv: 'S1', ts: '100', threadTs: null }];
    const many = { ...model,
      records: Array.from({ length: 40 }, (_, i) => ({ ...model.records[0], key: `k${i}`, name: `Invented Customer ${i} <&>`, leadership: i % 3 === 0,
        headline: longText(i, 19), short: `Invented short headline ${i} that reads whole`, severity: i < 10 ? 'high' : 'medium',
        points: [0, 1, 2, 3].map((k) => ({ summary: longText(`${i}.${k}`, 22), severity: k === 3 ? 'low' : 'high', category: 'incident', evidence: ev })) })),
      units: [1, 2, 3, 4].map((u) => ({ kind: 'brief', status: 'ok', bu: `Invented Unit ${u}`, points: [1, 2, 3].map((k) => ({ summary: longText(`u${u}.${k}`, 11), evidence: ev })) })),
      incidents: [{ source: 'Invented Ops', summary: longText('inc', 15), evidence: ev }] };
    const big = buildDm({ model: many, window: { start: 0, end: 86400, hours: 24 }, ctx, footer: ['Model: m via P', '$0.0100', '3 unmapped: #a, #b, #c'] });
    const names = [...big.top.matchAll(/Invented Customer (\d+)/g)].map((x) => x[1]);
    check('dm: hard cap of 1,500 characters; at most 5 in Needs attention; each customer at most once',
      big.top.length <= TOP_MAX && big.stats.needsAttention <= 5 && new Set(names).size === names.length, `${big.top.length} chars, ${big.stats.needsAttention} attention, ${names.length} names`);
    check('dm: no line ends in an ellipsis, top-level or thread (nothing is cut mid-sentence)',
      [big.top, ...big.replies, t, ...dm.replies].every((x) => x.split('\n').every((l) => !/(…|\.\.\.)\s*$/.test(l))));
    check('dm: names and model text are escaped for Slack', big.top.includes('&lt;&amp;&gt;') && !big.top.includes('<&>'));
    const bigThread = big.replies.join('\n');
    const also = big.replies.at(-1).split('\n').find((l) => l.startsWith('*Also notable*')) ?? '';
    check('dm: oversized thread: at most 5 replies of at most 3,500 characters, footer in the last one only',
      big.replies.length <= MAX_REPLIES && big.replies.every((r) => r.length <= REPLY_MAX) && big.replies.at(-1).includes('3 unmapped: #a, #b, #c') && big.replies.slice(0, -1).every((r) => !r.includes('Model:')),
      JSON.stringify(big.stats.replyChars));
    check('dm: every medium or high customer is in a section or on the "Also notable" line, at most 3 bullets each',
      Array.from({ length: 40 }, (_, i) => `Invented Customer ${i} &lt;&amp;&gt;`).every((n) => bigThread.includes(`*${n}*`) || also.includes(n)) && also.includes('(medium)')
      && !bigThread.includes('Invented point 0.3') && bigThread.includes('Invented point 0.2'), also.slice(0, 120));
    check('dm: the thread never mentions the archive file', !/archive file|data\/digests|\.md\b|on the mini/i.test(bigThread + thread));
    // A customer whose headline the check found unsupported is not under Needs attention (it moves to Watch).
    const dropped = { ...model, records: model.records.map((r) => (r.key === 'acmecorp' ? { ...r, headline: '', short: '', headlineDropped: true } : r)) };
    const dd = buildDm({ model: dropped, window: { start: 0, end: 86400, hours: 24 }, ctx, footer: ['x'] });
    check('dm: an unsupported headline is dropped: the customer moves to Watch, its thread section has no headline',
      !/• \*Acme Corp\*/.test(dd.top) && /\*Watch\*: .*Acme Corp/.test(dd.top) && /\*Acme Corp\* 🔴( _\(also discussed in Leadership\)_)?\n•/.test(dd.replies.join('\n')), dd.top);
  }
  {
    // Over the run cap: the busiest customers are summarized, the rest are "not summarized (cap)" in the archive.
    const { model } = await runStubPipeline({ runCap: 1200 });
    const capped = model.records.flatMap((r) => r.convs).filter((c) => c.status === 'cap');
    const { renderArchive } = require('../src/digest/render');
    const md = renderArchive({ model, window: { start: 0, end: 86400, hours: 24, reason: 'test' }, footer: [], ctx: { workspaceUrl: 'https://ws.example.test', writtenBy: 'm' } });
    check('caps: a tiny run cap marks calls "not summarized (cap)" with counts instead of aborting',
      model.stats.notSummarizedCap.calls > 0 && capped.length > 0 && /Not summarized: .*messages; cap/.test(md), JSON.stringify(model.stats.notSummarizedCap));
  }

  // ---------- Caps: an oversized invented window ----------
  {
    const { planJobs, analyzeAll: runAll } = require('../src/digest/analyze');
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
      plan.skippedCalls > 0 && Math.min(...keptCustomers) >= Math.max(...skippedCustomers, 0), JSON.stringify({ skipped: plan.skippedCalls, kept: keptCustomers.length }));
    check('caps: customers come before other calls', jobs.filter((j) => j.kind === 'unit').every((j) => j.capSkipped) || jobs.filter((j) => j.kind === 'customer').every((j) => !j.capSkipped));
    let sent = 0;
    const stub = async () => { sent++; return { route: 'primary', model: 'm', provider: 'P', json: { items: [], points: [] }, usage: {}, costUsd: 0 }; };
    const out = await runAll(jobs, { routes: {}, budget: null, maskCounts: newCounts(), concurrency: 3, startGapMs: 0, chatImpl: stub });
    check('caps: skipped calls are never sent', sent === kept.length && out.filter((r) => r.capSkipped).length === plan.skippedCalls, `${sent} sent, ${kept.length} planned`);
  }

  {
    // The "other" bucket: one brief call under its name, never a customer record.
    const log = [];
    const c = Object.fromEntries(REG_CONVS.map((x) => [x.id, x]));
    const blocks = [...pipelineBlocks(), blk(c.G1, comp([hm('18.0', 'U7', 'Demo for a prospect went fine')]))];
    const model = await runPipeline({ blocks, registry: buildRegistry(REG_CONVS, REG_CFG2), modes: MODES, me: ME, nameOf: (id) => `Person ${id}`, routes: {}, budget: null,
      maskCounts: newCounts(), runCap: 400_000, callCap: 100_000, startGapMs: 0, chatImpl: stubChat(log) });
    const other = model.units.find((u) => u.bu === 'Other B');
    check('pipeline: the other bucket gets one brief summary under its name and no customer record',
      other?.kind === 'brief' && other.points.length === 1 && !model.records.some((r) => r.convs.some((x) => x.id === 'G1')) && log.users.some((u) => u.includes('Unit: Other B.')));
  }
  {
    // Model calls: at most 3 at once, and starts spaced by startGapMs.
    const { analyzeAll: runAll } = require('../src/digest/analyze');
    const starts = [];
    let running = 0;
    let peak = 0;
    const stub = async () => {
      starts.push(Date.now()); running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 120));
      running--;
      return { route: 'primary', model: 'm', provider: 'P', json: { items: [] }, usage: {}, costUsd: 0 };
    };
    const jobs = Array.from({ length: 6 }, (_, i) => ({ kind: 'customer', key: `K${i}`, header: 'Customer channel: #k.', messages: [{ conv: { id: 'K', external: false }, ts: '1.0', who: 'Invented Person', text: 'hello' }] }));
    await runAll(jobs, { routes: {}, budget: null, maskCounts: newCounts(), concurrency: 3, startGapMs: 40, chatImpl: stub });
    const gaps = starts.slice(1).map((t, i) => t - starts[i]);
    check('calls: at most 3 at once, starts at least the gap apart', peak <= 3 && peak >= 2 && gaps.every((g) => g >= 35), JSON.stringify({ peak, gaps }));
  }

  // ---------- Daily membership refresh (invented IDs and names) ----------
  {
    const { applyListing, listConversations } = require('../src/slack');
    const pages = [[{ id: 'C1', name: 'renamed-one', is_member: true, num_members: 4 }, { id: 'G9', name: 'mpdm-ann--bo-1', is_mpim: true, is_private: true }],
      [{ id: 'C3', name: 'brand-new', is_member: true, num_members: 2 }, { id: 'C4', name: 'not-mine', is_member: false }, { id: 'P5', name: 'secret-room', is_private: true }]];
    const calls = [];
    const fake = { paginate: async (method, params) => { calls.push(method); return pages.flat(); } };
    const listing = await listConversations(fake);
    check('refresh: membership from conversations.list only; private and group DMs without is_member count as member',
      calls.join() === 'conversations.list' && [...listing.memberIds].sort().join() === 'C1,C3,G9,P5' && listing.assumedMember === 2);
    const saved = { scope: 'member', channels: [
      { id: 'C1', name: 'old-one', type: 'public', lastActivity: '2026-01-01T00:00:00Z' },
      { id: 'C2', name: 'left-this', type: 'public' },
      { id: 'G9', name: 'mpdm-ann--bo-1', type: 'group_dm', memberNames: ['Ann', 'Bo'] }] };
    const r = applyListing(saved, listing);
    const byId = Object.fromEntries(r.channels.map((c) => [c.id, c]));
    check('refresh: kept conversations keep saved details with the new name; new ones added; left ones dropped',
      byId.C1?.name === 'renamed-one' && byId.C1.lastActivity === '2026-01-01T00:00:00Z' && byId.G9?.memberNames.join() === 'Ann,Bo'
      && r.added.map((c) => c.id).sort().join() === 'C3,P5' && r.removed.map((c) => c.id).join() === 'C2' && !byId.C4 && byId.P5.type === 'private', JSON.stringify(r.channels.map((c) => c.id)));
    const { unmappedLabel } = require('../src/digest/render');
    check('refresh: new unmapped conversations are named by channel name or group DM handles',
      unmappedLabel({ type: 'public', name: 'brand-new' }) === '#brand-new' && unmappedLabel({ type: 'group_dm', name: 'mpdm-ann--bo--cy-1' }) === 'DM: ann, bo, cy');
  }

  // ---------- The batch provider check and the headline check (stubbed model) ----------
  {
    const { analyzeAll: runAll } = require('../src/digest/analyze');
    const job = (k) => ({ kind: 'customer', key: k, header: 'Customer channel: #k.', messages: [{ conv: { id: 'K', external: false }, ts: '1.0', who: 'Invented Person', text: 'hello' }] });
    const sent = [];
    const stub = async (o) => {
      sent.push(o.secondaryOnce ? 'secondary' : 'primary');
      const route = o.secondaryOnce ? 'secondary' : 'primary';
      return { route, model: 'm', provider: null, replyProvider: null, statsPending: Boolean(o.deferStats), id: `g${sent.length}`, pinnedNames: ['P'], fellBack: Boolean(o.secondaryOnce),
        primaryErrors: o.secondaryOnce ? ['provider-mismatch'] : [], json: { items: [] }, usage: {}, costUsd: 0.001 };
    };
    // g1 confirmed; g2 unconfirmed -> re-sent once to the secondary (g4), which is confirmed; g3 unconfirmed -> its rerun (g5) is unconfirmed too.
    const verdicts = { g1: true, g2: false, g3: false, g4: true, g5: false };
    const batches = [];
    const verify = async (items) => { batches.push(items.length); return items.map((it) => ({ ok: verdicts[it.id], provider: verdicts[it.id] ? 'P' : 'X', costUsd: 0.002 })); };
    const budget = createBudget({});
    const out = await runAll([job('a'), job('b'), job('c')], { routes: { primary: {}, secondary: {} }, budget, maskCounts: newCounts(), concurrency: 3, startGapMs: 0, chatImpl: stub, verify });
    check('provider batch: one batch per pass; an unconfirmed primary reply is re-sent once to the secondary; an unconfirmed secondary fails the call',
      JSON.stringify(batches) === '[3,2]' && out[0].ok && out[1].ok && out[1].route === 'secondary' && !out[2].ok && out[2].error === 'provider-mismatch'
      && sent.filter((x) => x === 'secondary').length === 2 && out.meta.providerMismatches === 3 && out.meta.reruns === 2, JSON.stringify({ batches, sent, e: out.map((r) => r.error ?? r.route) }));
    check('provider batch: the stats cost replaces the provisional cost in the budget (the stub adds nothing itself)', Math.abs(budget.used.costUsd - 5 * (0.002 - 0.001)) < 1e-9, String(budget.used.costUsd));
  }
  {
    // Verification outcomes: overstated -> corrected and softened; unsupported -> headline dropped, not under Needs attention.
    const verdictFor = (user) => (user.includes('Acme') ? { verdict: 'overstated', corrected_headline: 'Per Pat, Acme is considering other vendors after the call failures.', corrected_short_headline: 'Per Pat, Acme considering other vendors' }
      : { verdict: 'unsupported' });
    const log = [];
    const base = stubChat(log);
    const chatImpl = async (o) => (o.system === P.VERIFY_SYSTEM ? { route: 'primary', model: 'm', provider: 'P', usage: {}, costUsd: 0, json: verdictFor(o.user) } : base(o));
    const model = await runPipeline({ blocks: pipelineBlocks(), registry: buildRegistry(REG_CONVS, REG_CFG), modes: MODES, me: ME, nameOf: (id) => `Person ${id}`, routes: {}, budget: null,
      maskCounts: newCounts(), runCap: 400_000, callCap: 100_000, startGapMs: 0, chatImpl });
    const acme = model.records.find((r) => r.key === 'acmecorp');
    const birch = model.records.find((r) => r.key === 'birchhealth');
    check('verify: an overstated headline is replaced by the correction and marked softened; unsupported is dropped',
      acme.softened && acme.short === 'Per Pat, Acme considering other vendors' && acme.headline.startsWith('Per Pat') && birch.headlineDropped && birch.headline === ''
      && model.stats.verification.overstated === 1 && model.stats.verification.unsupported === 1, JSON.stringify(model.stats.verification));
    const { renderArchive } = require('../src/digest/render');
    const md = renderArchive({ model, window: { start: 0, end: 86400, hours: 24, reason: 'test' }, footer: [], ctx: { workspaceUrl: 'https://ws.example.test', writtenBy: 'm' } });
    const { buildDm } = require('../src/digest/dm');
    const dm = buildDm({ model, window: { start: 0, end: 86400, hours: 24 }, ctx: { workspaceUrl: 'https://ws.example.test' }, footer: ['x'] });
    check('verify: "(softened)" and the dropped headline appear in the archive file only, never in the DM',
      md.includes('(softened)') && md.includes('Headline dropped') && !dm.top.includes('softened') && !dm.replies.join('').includes('softened') && !/• \*Birch Health\*/.test(dm.top));
  }
  {
    // The check's input: the headline and ONLY the messages it cites.
    const { verifyJob, prepare } = require('../src/digest/analyze');
    const msgs = [{ conv: { id: 'C1', external: true }, ts: '2.0', who: 'Pat', text: 'Considering Rivalco, write to pat@example.com' }];
    const vj = verifyJob({ key: 'k', name: 'Acme', headline: 'Acme signed with Rivalco', short: 'Acme signed with Rivalco' }, msgs);
    const prep = prepare(vj.messages, newCounts(), 'v');
    check('verify: the job holds only the cited messages; external text is masked before the check',
      vj.messages.length === 1 && prep.lines[0].ref === 'v001' && prep.lines[0].text.includes('[email]') && P.renderVerify('Acme', vj.headline, vj.short, prep.lines).includes('"Acme signed with Rivalco"'));
  }

  // ---------- scripts/digest-map.js on invented temp configs ----------
  {
    const { run: mapRun } = require('./digest-map');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-map-'));
    const paths = { bus: path.join(dir, 'bus.json'), customers: path.join(dir, 'cust.json'), channels: path.join(dir, 'ch.json'), digest: path.join(dir, 'dig.json') };
    const writeAll = () => {
      fs.writeFileSync(paths.bus, JSON.stringify({ rules: [{ bu: 'Unit B', sub: 'Success', prefix: 'success-' }, { bu: 'Unit B', sub: 'Customer channels', glob: '*-coordination' }, { bu: 'Unit A', name: 'sales' }],
        overrides: {}, groupDms: { G0: { bu: 'Unit A', members: ['Ann Lee', 'Me Person'] } } }), { mode: 0o600 });
      fs.writeFileSync(paths.customers, JSON.stringify({ customerSources: ['Unit B > Success', 'Unit B > Customer channels'], anchorSources: ['Unit B > Success'], stripPrefixes: ['success-'], stripSuffixes: ['-coordination'],
        customers: {}, otherBucket: { name: 'Other B', channels: ['C5'] } }), { mode: 0o600 });
      fs.writeFileSync(paths.digest, JSON.stringify({ myName: 'Me Person' }));
      fs.writeFileSync(paths.channels, JSON.stringify({ scope: 'member', channels: [
        { id: 'C1', name: 'success-acme', type: 'public' }, { id: 'C2', name: 'new-ops', type: 'public' }, { id: 'C3', name: 'new-ops-2', type: 'public' },
        { id: 'C4', name: 'acme-team-coordination', type: 'private' }, { id: 'C5', name: 'prospect-coordination', type: 'public' },
        { id: 'G1', name: 'mpdm-ann--bo--me-1', type: 'group_dm', memberNames: ['Ann Lee', 'Bo Diaz', 'Me Person'] },
        { id: 'G2', name: 'mpdm-ann--bo--cy--me-1', type: 'group_dm', memberNames: ['Ann Lee', 'Bo Diaz', 'Cy Fox', 'Me Person'] },
        { id: 'G0', name: 'mpdm-ann--me-1', type: 'group_dm', memberNames: ['Ann Lee', 'Me Person'] }] }));
    };
    writeAll();
    const bus = () => JSON.parse(fs.readFileSync(paths.bus, 'utf8'));
    const cust = () => JSON.parse(fs.readFileSync(paths.customers, 'utf8'));
    const lu = mapRun(['list-unmapped'], paths);
    check('map: list-unmapped lists only conversations no rule, override or group DM entry maps', /Unmapped .*: 4;/.test(lu.lines[0]) && lu.lines.join('\n').includes('#new-ops ') && !lu.lines.join('\n').includes('#sales'), lu.lines.join(' | '));
    const before = fs.readFileSync(paths.bus, 'utf8');
    const amb = mapRun(['map', 'new-op', 'Unit A'], paths);
    check('map: no exact match lists candidates and writes nothing', amb.code === 1 && amb.lines.some((l) => l.includes('C2')) && amb.lines.some((l) => l.includes('C3')) && fs.readFileSync(paths.bus, 'utf8') === before, amb.lines.join(' | '));
    const bad = mapRun(['map', 'new-ops', 'Unit Q'], paths);
    check('map: an unknown unit is refused without --new; nothing written', bad.code === 1 && fs.readFileSync(paths.bus, 'utf8') === before);
    const ok1 = mapRun(['map', '#new-ops', 'Unit A'], paths);
    check('map: a channel gets an override; the change is printed', ok1.code === 0 && JSON.stringify(bus().overrides.C2) === '{"bu":"Unit A"}' && ok1.lines[0].includes('-> Unit A'), ok1.lines.join(' | '));
    const g = mapRun(['map', 'Ann Lee, Bo Diaz', 'Unit B/Customer channels'], paths);
    check('map: a group DM is matched by its full member set (own name optional), recorded with members',
      g.code === 0 && bus().groupDms.G1?.sub === 'Customer channels' && JSON.stringify(bus().groupDms.G1.members) === '["Ann Lee","Bo Diaz","Me Person"]' && !bus().groupDms.G2, g.lines.join(' | '));
    const part = mapRun(['map', 'Bo Diaz', 'Unit A'], paths);
    check('map: a partial member list never matches a group DM; candidates listed, nothing written', part.code === 1 && part.lines.some((l) => l.includes('G2')));
    const ig = mapRun(['ignore', 'Ann Lee, Bo Diaz, Cy Fox'], paths);
    check('map: ignore adds an unmapped conversation to the ignore list; mapped ones are refused',
      ig.code === 0 && bus().ignore.G2 && mapRun(['ignore', 'new-ops'], paths).code === 1, ig.lines.join(' | '));
    const lu2 = mapRun(['list-unmapped'], paths);
    check('map: ignored and mapped conversations leave the unmapped list', /: 1; ignored: 1\./.test(lu2.lines[0]), lu2.lines[0]);
    const mc = mapRun(['map-customer', 'prospect-coordination', 'Acme'], paths);
    check('map-customer: attaches the channel to the customer and takes it out of the other bucket',
      mc.code === 0 && JSON.stringify(cust().customers.acme?.channels) === '["C5"]' && cust().otherBucket.channels.length === 0, mc.lines.join(' | '));
    check('map-customer: a channel outside the customer units is refused', mapRun(['map-customer', 'new-ops', 'Acme'], paths).code === 1);
    check('map-customer: an unknown customer lists candidates and writes nothing', mapRun(['map-customer', 'acme-team-coordination', 'Zed'], paths).code === 1);
    const rm = mapRun(['remove', 'C5'], paths);
    const rm2 = mapRun(['remove', 'G2'], paths);
    check('remove: drops customer assignments and ignore entries and prints them', rm.code === 0 && !cust().customers.acme.channels.length && !bus().ignore.G2 && rm.lines[0].includes('customer acme') && rm2.lines[0].includes('ignore entry'));
    check('map: config files stay mode 600 and no temp file is left', (fs.statSync(paths.bus).mode & 0o777) === 0o600 && (fs.statSync(paths.customers).mode & 0o777) === 0o600 && !fs.readdirSync(dir).some((f) => f.endsWith('.tmp')));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---------- Slack DM delivery: send-only client (invented IDs and text) ----------
  {
    const { createSender, METHODS } = require('../src/slack-send');
    const BOT_TOKEN = 'invented-bot-token';
    function fakeSlack({ openReply } = {}) {
      const calls = [];
      let n = 0;
      const f = async (url, init = {}) => {
        const u = new URL(url);
        calls.push({ host: u.hostname, method: u.pathname.replace('/api/', ''), init });
        const ok = (b) => json(200, { ok: true, ...b });
        switch (u.pathname) {
          case '/api/conversations.open': return ok(openReply ?? { channel: { id: 'D0INVENTED', is_im: true, user: ME } });
          case '/api/chat.postMessage': return ok({ channel: 'D0INVENTED', ts: `${++n}.0` });
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
      const top = await s.postText('Invented top line.');
      await s.postText('Invented thread reply.', top.ts);
      let badThread;
      try { await s.postText('x', '999.0'); } catch (e) { badThread = e.code; }
      const posts = f.calls.filter((c) => c.method === 'chat.postMessage').map((c) => JSON.parse(c.init.body));
      check('deliver: nothing is posted before the DM is verified', early === 'dm-not-verified');
      check('deliver: top message, then one threaded reply under it, into the verified DM only',
        posts.length === 2 && posts.every((p) => p.channel === 'D0INVENTED') && !('thread_ts' in posts[0]) && posts[1].thread_ts === top.ts, JSON.stringify(posts.map((p) => p.thread_ts ?? null)));
      check('deliver: replies only under a message this run posted', badThread === 'bad-thread');
      check('deliver: bot token only in the Authorization header', f.calls.every((c) => c.init.headers.Authorization === `Bearer ${BOT_TOKEN}` && !String(c.init.body).includes(BOT_TOKEN)));
      check('deliver: links are not unfurled', posts[0].unfurl_links === false && posts[0].unfurl_media === false);
      check('deliver: only two methods are known (no uploads, no reads)', [...METHODS].sort().join(',') === 'chat.postMessage,conversations.open');
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
      let tok;
      try { createSender({ recipient: ME, tokenReader: () => { throw new Error('mode'); } }); } catch (e) { tok = e.code; }
      check('deliver: an unreadable or loose bot-token file stops delivery', tok === 'bot-token');
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
