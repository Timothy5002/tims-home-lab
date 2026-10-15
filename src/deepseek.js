'use strict';
// Client for DeepSeek's chat API, the cloud model the Slack digest uses for judgment (approved by the user;
// see docs/slack-digest-design.md). One function, chat(), sends one request with no tools and returns text or
// parsed JSON plus token usage and an estimated cost. It never logs prompts or replies; callers may log only
// the usage, cost and error codes it returns.
//
// Guards: the key is read from ~/.lab/deepseek-key (mode 600) and only ever sent in the Authorization header;
// the host is hardcoded; thinking mode is off unless asked for; every call has a timeout, an input-size cap and
// retries with backoff (429 honors Retry-After; 5xx, network errors and empty or invalid JSON are retried).
const { readSecret } = require('./secrets');

const API_URL = 'https://api.deepseek.com/chat/completions'; // hardcoded on purpose, like the Ollama URL in llm.js
const DEFAULT_MODEL = 'deepseek-flash';

// USD per million tokens, from https://api-docs.deepseek.com/quick_start/pricing, checked 2026-10-14.
const PRICES = {
  checked: '2026-10-14',
  'deepseek-flash': {
    offPeak: { hit: 0.003, miss: 0.15, out: 0.60 },
    peak: { hit: 0.006, miss: 0.30, out: 1.20 },
  },
};

// Peak hours (UTC), weekdays only: 01:00-04:00 and 06:00-10:00. Chinese public holidays are also off-peak,
// which this ignores, so on those days the estimate is a little high, never low.
function rateAt(date = new Date()) {
  const day = date.getUTCDay();
  const h = date.getUTCHours();
  const weekday = day >= 1 && day <= 5;
  return weekday && ((h >= 1 && h < 4) || (h >= 6 && h < 10)) ? 'peak' : 'offPeak';
}

function estimateCost(model, usage, rate) {
  const p = PRICES[model]?.[rate];
  if (!p || !usage) return null;
  const hit = usage.prompt_cache_hit_tokens ?? 0;
  const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, (usage.prompt_tokens ?? 0) - hit);
  return (hit * p.hit + miss * p.miss + (usage.completion_tokens ?? 0) * p.out) / 1e6;
}

const estimateTokens = (s) => Math.ceil(String(s ?? '').length / 4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ModelError extends Error {
  constructor(code, message, { retryable = false, retryAfterMs = null } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

// opts: { system, user, json = true, model, maxTokens = 1500, temperature = 0.1, thinking = false,
//         timeoutMs = 90000, retries = 3, maxInputTokens = 122000, fetchImpl, keyReader, now }
async function chat(opts) {
  const {
    system, user, json = true, model = DEFAULT_MODEL, maxTokens = 1500, temperature = 0.1, thinking = false,
    timeoutMs = 90_000, retries = 3, maxInputTokens = 122_000,
    fetchImpl = fetch, keyReader = () => readSecret('deepseek-key'), now = () => new Date(),
  } = opts;
  if (typeof system !== 'string' || typeof user !== 'string') throw new ModelError('bad-request', 'system and user prompts are required');
  const inputEstimate = estimateTokens(system) + estimateTokens(user);
  if (inputEstimate > maxInputTokens) {
    throw new ModelError('input-cap', `input estimate ${inputEstimate} tokens is over the cap of ${maxInputTokens}`);
  }
  if (json && !/json/i.test(system + user)) throw new ModelError('bad-request', 'JSON output needs the word "json" in the prompt');

  const key = keyReader();
  const body = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_tokens: maxTokens,
    stream: false,
    thinking: { type: thinking ? 'enabled' : 'disabled' },
    // Thinking mode ignores temperature; it is only sent when it can take effect.
    ...(thinking ? {} : { temperature }),
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  };

  let attempts = 0;
  for (;;) {
    attempts++;
    const rate = rateAt(now());
    try {
      const res = await fetchImpl(API_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429) {
        const ra = Number(res.headers.get('retry-after'));
        throw new ModelError('rate-limited', 'HTTP 429', { retryable: true, retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : null });
      }
      if (res.status >= 500) throw new ModelError('server-error', `HTTP ${res.status}`, { retryable: true });
      if (res.status === 401 || res.status === 403) throw new ModelError('auth', `HTTP ${res.status}: check ~/.lab/deepseek-key`);
      if (res.status === 402) throw new ModelError('balance', 'HTTP 402: account balance is too low');
      if (!res.ok) throw new ModelError('http', `HTTP ${res.status}`);
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content ?? '';
      const usage = data.usage ?? null;
      const result = {
        model: data.model ?? model, usage, rate, attempts,
        costUsd: estimateCost(model, usage, rate),
        finishReason: data.choices?.[0]?.finish_reason ?? null,
      };
      if (!content.trim()) throw new ModelError('empty', 'empty reply', { retryable: true });
      if (!json) return { ...result, text: content };
      try {
        return { ...result, json: JSON.parse(content) };
      } catch {
        throw new ModelError('invalid-json', `reply is not valid JSON (finish_reason ${result.finishReason})`, { retryable: true });
      }
    } catch (e) {
      const err = e instanceof ModelError ? e
        : e.name === 'TimeoutError' || e.name === 'AbortError' ? new ModelError('timeout', `no reply within ${timeoutMs / 1000}s`, { retryable: true })
          : new ModelError('network', `network error (${e.cause?.code ?? e.name})`, { retryable: true });
      if (!err.retryable || attempts > retries) {
        err.attempts = attempts;
        throw err;
      }
      // Exponential backoff with jitter: about 1s, 2s, 4s; Retry-After wins when the server sends it.
      await sleep(err.retryAfterMs ?? 1000 * 2 ** (attempts - 1) + Math.floor(Math.random() * 500));
    }
  }
}

// Model ids the account can use (GET /models). Used by scripts/deepseek-check.js to confirm the id.
async function listModels({ fetchImpl = fetch, keyReader = () => readSecret('deepseek-key'), timeoutMs = 30_000 } = {}) {
  const res = await fetchImpl(API_URL.replace('/chat/completions', '/models'), {
    headers: { Authorization: `Bearer ${keyReader()}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new ModelError('http', `GET /models returned HTTP ${res.status}`);
  const data = await res.json();
  return (data.data ?? []).map((m) => m.id).sort();
}

module.exports = { chat, listModels, rateAt, estimateCost, estimateTokens, PRICES, DEFAULT_MODEL, ModelError, API_URL };
