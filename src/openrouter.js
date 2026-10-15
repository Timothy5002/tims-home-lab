'use strict';
// Client for OpenRouter's OpenAI-compatible chat API: the only path from this repo to a cloud model, used by the
// Slack digest (approved by the user; see docs/slack-digest-design.md). It never logs prompts or replies; callers
// may log only the model, provider, token counts, cost and error codes it returns.
//
// Two routes, each pinned to its own provider(s) with no OpenRouter fallbacks:
//   primary   (config models.primary)   tried first
//   secondary (config models.secondary) tried ONCE, only if the primary times out, returns 5xx or 429, or is served
//                                       by a provider that is not pinned. Never a third attempt; never two models
//                                       in one request.
// Every request: no tools; provider { order, only, allow_fallbacks: false, require_parameters: true,
// data_collection: "deny" }; reasoning off (or the lowest level, for models that cannot turn it off) unless the
// reasoning flag is set. After each reply the served provider is checked with OpenRouter's generation stats.
//
// Costs come from OpenRouter (the generation's total cost); live endpoint prices are used for the pre-call
// worst-case estimate that the per-run cost cap checks, and as the fallback when OpenRouter reports no cost.
// The key is read from ~/.lab/openrouter-key (mode 600) and only ever sent in the Authorization header.
const { readSecret } = require('./secrets');

const BASE_URL = 'https://openrouter.ai/api/v1'; // hardcoded on purpose, like the Ollama URL in llm.js
const CHAT_URL = `${BASE_URL}/chat/completions`;
const FALLBACK_CODES = new Set(['timeout', 'server-error', 'rate-limited', 'provider-mismatch']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const estimateTokens = (s) => Math.ceil(String(s ?? '').length / 4);

class ModelError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

// A route from config/slack-digest.json (models.primary / models.secondary). Checked before any request.
function checkRoute(name, r) {
  const bad = (m) => { throw new ModelError('bad-config', `models.${name}: ${m}`); };
  if (!r || typeof r !== 'object') bad('missing');
  if (typeof r.model !== 'string' || !/^[a-z0-9._-]+\/[a-z0-9._:-]+$/i.test(r.model)) bad('"model" must be an OpenRouter slug like author/model');
  if (!Array.isArray(r.providers) || r.providers.length === 0 || !r.providers.every((p) => typeof p === 'string' && /^[a-z0-9./-]+$/.test(p))) {
    bad('"providers" must be a non-empty list of provider slugs');
  }
  for (const k of ['reasoningOff', 'reasoningOn']) if (!r[k] || typeof r[k] !== 'object') bad(`"${k}" must be an object`);
  return {
    name,
    model: r.model,
    providers: r.providers,
    temperature: r.temperature === true,             // the pinned endpoint accepts temperature
    reasoningMandatory: r.reasoningMandatory === true, // the model always reasons (count its tokens)
    reasoningOff: r.reasoningOff,
    reasoningOn: r.reasoningOn,
    reasoningAllowance: Number.isInteger(r.reasoningAllowance) && r.reasoningAllowance >= 0 ? r.reasoningAllowance : 0,
  };
}

function loadRoutes(models) {
  if (!models) throw new ModelError('bad-config', 'config/slack-digest.json needs "models" with "primary" (and optionally "secondary")');
  return { primary: checkRoute('primary', models.primary), secondary: models.secondary ? checkRoute('secondary', models.secondary) : null };
}

// The exact request body for one route (no key; the key goes in a header). Exported so tests and
// scripts/model-check.js can show it.
function buildBody(route, { system, user, json = true, maxTokens = 1500, temperature = 0.1, reasoning = false }) {
  const reasoningActive = reasoning || route.reasoningMandatory;
  return {
    model: route.model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    // Reasoning tokens count against max_tokens, so models that reason get an allowance on top.
    max_tokens: maxTokens + (reasoningActive ? route.reasoningAllowance : 0),
    stream: false,
    ...(route.temperature && !reasoningActive ? { temperature } : {}),
    ...(json ? { response_format: { type: 'json_object' } } : {}),
    reasoning: reasoning ? route.reasoningOn : route.reasoningOff,
    provider: {
      order: route.providers,
      only: route.providers,
      allow_fallbacks: false,
      require_parameters: true,
      data_collection: 'deny',
    },
  };
}

// Live prices and provider names for a route's pinned endpoints (public endpoint list; no key needed).
// Prices are USD per token, from the endpoints whose tag equals a pinned slug. OpenRouter's docs do not say
// whether a slug like "google-vertex/global" can also route to its "/flex" or "/priority" tiers, so the worst
// case across every endpoint under the slug is kept too, and the per-run cost cap checks against that.
async function livePricing(route, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const res = await fetchImpl(`${BASE_URL}/models/${route.model}/endpoints`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new ModelError('pricing', `endpoint list for ${route.model} returned HTTP ${res.status}`);
  const endpoints = (await res.json()).data?.endpoints ?? [];
  const under = endpoints.filter((e) => route.providers.some((p) => e.tag === p || String(e.tag).startsWith(`${p}/`)));
  const exact = endpoints.filter((e) => route.providers.includes(e.tag));
  // A slug that names a provider (e.g. "deepinfra") matches its tags ("deepinfra/fp4") rather than equalling one.
  const rows = exact.length ? exact : under;
  if (!rows.length) throw new ModelError('provider-not-listed', `none of ${route.providers.join(', ')} is listed for ${route.model}`);
  const max = (list, k) => Math.max(...list.map((e) => Number(e.pricing?.[k] ?? 0)));
  const priced = (list) => {
    const out = max(list, 'completion');
    return { in: max(list, 'prompt'), out, cacheRead: max(list, 'input_cache_read') || max(list, 'prompt'), reasoning: max(list, 'internal_reasoning') || out };
  };
  return {
    ...priced(rows),
    worst: priced(under),
    maxOutputTokens: Math.min(...rows.map((e) => e.max_completion_tokens ?? Infinity)),
    providerNames: [...new Set(under.map((e) => e.provider_name))],
    tags: rows.map((e) => e.tag),
    tagsUnderSlug: under.map((e) => e.tag),
  };
}

// Cost from token counts and live prices; used only when OpenRouter reports no cost.
function costFromPrices(prices, usage) {
  const cached = usage.cached ?? 0;
  const reasoningTokens = usage.reasoning ?? 0;
  return Math.max(0, usage.prompt - cached) * prices.in + cached * prices.cacheRead
    + Math.max(0, usage.completion - reasoningTokens) * prices.out + reasoningTokens * prices.reasoning;
}

// Per-run limits that apply to whichever model serves: input tokens, output tokens (reasoning included) and cost.
function createBudget({ maxInputTokens = 122_000, maxOutputTokens = 60_000, maxCostUsd = 0.5 } = {}) {
  const used = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0, calls: 0 };
  return {
    used,
    limits: { maxInputTokens, maxOutputTokens, maxCostUsd },
    check(estInput, maxTokens, worstCostUsd) {
      if (used.inputTokens + estInput > maxInputTokens) throw new ModelError('input-cap', `input would reach ${used.inputTokens + estInput} tokens; cap ${maxInputTokens}`);
      if (used.outputTokens + maxTokens > maxOutputTokens) throw new ModelError('output-cap', `output could reach ${used.outputTokens + maxTokens} tokens; cap ${maxOutputTokens}`);
      if (used.costUsd + worstCostUsd > maxCostUsd) throw new ModelError('cost-cap', `cost could reach $${(used.costUsd + worstCostUsd).toFixed(4)}; cap $${maxCostUsd}`);
    },
    add(usage, costUsd) {
      used.calls++;
      used.inputTokens += usage.prompt;
      used.outputTokens += usage.completion;
      used.reasoningTokens += usage.reasoning ?? 0;
      used.costUsd += costUsd ?? 0;
    },
  };
}

// Which provider served a generation, and what it cost (stats can lag a moment behind the reply).
async function generationStats(id, { fetchImpl, key, sleepImpl, tries = 5 }) {
  for (let i = 0; i < tries; i++) {
    const res = await fetchImpl(`${BASE_URL}/generation?id=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const d = (await res.json()).data ?? {};
      if (d.provider_name) return { provider: d.provider_name, costUsd: Number.isFinite(d.total_cost) ? d.total_cost : null };
    } else if (res.status !== 404) {
      break;
    }
    await sleepImpl(500 * (i + 1));
  }
  return null;
}

// One attempt on one route. Throws ModelError; FALLBACK_CODES decide whether the secondary is tried.
async function attempt(route, opts, ctx) {
  const prices = ctx.priceCache.get(route.name) ?? await livePricing(route, { fetchImpl: ctx.fetchImpl });
  ctx.priceCache.set(route.name, prices);
  const body = buildBody(route, opts);
  if (body.max_tokens > prices.maxOutputTokens) {
    throw new ModelError('bad-request', `max_tokens ${body.max_tokens} is over the pinned endpoint's ${prices.maxOutputTokens}`);
  }
  const estInput = estimateTokens(opts.system) + estimateTokens(opts.user);
  const w = prices.worst ?? prices;
  const worst = estInput * w.in + body.max_tokens * Math.max(w.out, w.reasoning);
  if (opts.budget) opts.budget.check(estInput, body.max_tokens, worst);

  let res;
  try {
    res = await ctx.fetchImpl(CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ctx.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new ModelError('timeout', `no reply within ${opts.timeoutMs / 1000}s`);
    throw new ModelError('network', `network error (${e.cause?.code ?? e.name})`);
  }
  if (res.status === 429) throw new ModelError('rate-limited', 'HTTP 429');
  if (res.status >= 500) throw new ModelError('server-error', `HTTP ${res.status}`);
  if (res.status === 401 || res.status === 403) throw new ModelError('auth', `HTTP ${res.status}: check ~/.lab/openrouter-key`);
  if (res.status === 402) throw new ModelError('balance', 'HTTP 402: out of credits or over the key limit');
  if (res.status === 404) throw new ModelError('no-endpoint', 'HTTP 404: no pinned endpoint accepts this request (provider, parameters or data policy)');
  if (!res.ok) throw new ModelError('http', `HTTP ${res.status}`);

  const data = await res.json();
  const u = data.usage ?? {};
  const usage = {
    prompt: u.prompt_tokens ?? 0,
    completion: u.completion_tokens ?? 0,
    reasoning: u.completion_tokens_details?.reasoning_tokens ?? 0,
    cached: u.prompt_tokens_details?.cached_tokens ?? 0,
  };
  const stats = data.id ? await generationStats(data.id, { fetchImpl: ctx.fetchImpl, key: ctx.key, sleepImpl: ctx.sleepImpl }) : null;
  const costUsd = stats?.costUsd ?? (Number.isFinite(u.cost) ? u.cost : costFromPrices(prices, usage));
  if (opts.budget) opts.budget.add(usage, costUsd);
  const result = { route: route.name, model: data.model ?? route.model, provider: stats?.provider ?? null, usage, costUsd, id: data.id ?? null };

  // The pinned provider must have served it; an unverifiable provider counts as a mismatch.
  if (!stats || !prices.providerNames.includes(stats.provider)) {
    throw new ModelError('provider-mismatch', `served by ${stats?.provider ?? 'an unverified provider'}; pinned: ${prices.providerNames.join(', ')}`, { result });
  }
  const content = data.choices?.[0]?.message?.content ?? '';
  if (!content.trim()) throw new ModelError('empty', 'empty reply', { result });
  if (!opts.json) return { ...result, text: content };
  try {
    return { ...result, json: JSON.parse(content) };
  } catch {
    throw new ModelError('invalid-json', `reply is not valid JSON (finish_reason ${data.choices?.[0]?.finish_reason ?? '?'})`, { result });
  }
}

// opts: { routes: { primary, secondary }, system, user, json = true, maxTokens = 1500, temperature = 0.1,
//         reasoning = false, timeoutMs = 90000, budget, only: 'primary' | 'secondary' (no fallback),
//         fetchImpl, keyReader, sleepImpl, priceCache }
async function chat(opts) {
  const o = { json: true, maxTokens: 1500, temperature: 0.1, reasoning: false, timeoutMs: 90_000, ...opts };
  if (typeof o.system !== 'string' || typeof o.user !== 'string') throw new ModelError('bad-request', 'system and user prompts are required');
  if (o.json && !/json/i.test(o.system + o.user)) throw new ModelError('bad-request', 'JSON output needs the word "json" in the prompt');
  const ctx = {
    fetchImpl: o.fetchImpl ?? fetch,
    sleepImpl: o.sleepImpl ?? sleep,
    priceCache: o.priceCache ?? new Map(),
    key: (o.keyReader ?? (() => readSecret('openrouter-key')))(),
  };
  const { primary, secondary } = o.routes;
  if (o.only) return attempt(o.only === 'secondary' ? secondary : primary, o, ctx);
  try {
    return { ...(await attempt(primary, o, ctx)), fellBack: false };
  } catch (e) {
    if (!FALLBACK_CODES.has(e.code) || !secondary) throw e;
    // One attempt on the secondary, never more.
    const r = await attempt(secondary, o, ctx);
    return { ...r, fellBack: true, primaryError: e.code };
  }
}

module.exports = {
  chat, buildBody, livePricing, costFromPrices, createBudget, loadRoutes, estimateTokens,
  ModelError, FALLBACK_CODES, CHAT_URL, BASE_URL,
};
