'use strict';
// Checks each configured model route (config/slack-digest.json "models") with one invented sentence, no Slack
// data: prints the request body (no key), then the model id, the provider that actually served it (from
// OpenRouter's generation stats), token counts, reasoning tokens and cost. It also checks that the JSON reply
// parses into the expected shape. Exits non-zero if a route is served by a provider that is not pinned, or the
// shape is wrong. Never prints the key. Each route is called directly (no primary-to-secondary fallback).
// Usage: node scripts/model-check.js [--dry-run] [--route primary|secondary]
//   --dry-run  print the request bodies and live endpoint prices only; no model calls
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { chat, buildBody, loadRoutes, livePricing } = require('../src/openrouter');

const CONFIG = path.join(__dirname, '..', 'config', 'slack-digest.json');
const SYSTEM = 'You extract facts from a short report. Reply in json exactly like {"product": "...", "problem": "...", "severity": "low|medium|high"}.';
const USER = 'Invented example: The Zephyr 3000 kettle at Example Cafe stopped heating twice this morning; staff are annoyed.';
const perM = (x) => `$${(x * 1e6).toFixed(4)}`;

function shapeOk(j) {
  return j && typeof j.product === 'string' && j.product.length > 0 && typeof j.problem === 'string' && j.problem.length > 0
    && ['low', 'medium', 'high'].includes(String(j.severity).toLowerCase());
}

(async () => {
  const { values: opts } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false }, route: { type: 'string' } } });
  const routes = loadRoutes(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).models);
  const names = opts.route ? [opts.route] : ['primary', 'secondary'].filter((n) => routes[n]);
  let failed = false;
  for (const name of names) {
    const route = routes[name];
    if (!route) throw new Error(`no route named ${name}`);
    const prices = await livePricing(route);
    console.log(`\n=== ${name}: ${route.model} pinned to ${route.providers.join(', ')} (provider name ${prices.providerNames.join(', ')}; priced from ${prices.tags.join(', ')})`);
    if (prices.tagsUnderSlug.length > prices.tags.length) {
      console.log(`Other endpoints under the same slug (the cost cap assumes the dearest): ${prices.tagsUnderSlug.filter((t) => !prices.tags.includes(t)).join(', ')}; worst case per million: input ${perM(prices.worst.in)}, output ${perM(prices.worst.out)}`);
    }
    console.log(`Live prices per million tokens: input ${perM(prices.in)}, cached input ${perM(prices.cacheRead)}, output ${perM(prices.out)}, reasoning ${perM(prices.reasoning)}; max output ${prices.maxOutputTokens}`);
    console.log('Request body (no key; the key goes only in the Authorization header):');
    console.log(JSON.stringify(buildBody(route, { system: SYSTEM, user: USER, maxTokens: 200 }), null, 2));
    if (opts['dry-run']) continue;
    try {
      const r = await chat({ routes, only: name, system: SYSTEM, user: USER, maxTokens: 200 });
      const u = r.usage;
      console.log(`Model id: ${r.model}`);
      console.log(`Served by: ${r.provider} (pinned: ${prices.providerNames.join(', ')})`);
      console.log(`Tokens: prompt ${u.prompt} (cached ${u.cached}), completion ${u.completion} (reasoning ${u.reasoning})`);
      console.log(`Cost: $${r.costUsd?.toFixed(6)}`);
      const ok = shapeOk(r.json);
      console.log(`JSON shape (product, problem, severity): ${ok ? 'OK' : `WRONG: keys ${Object.keys(r.json ?? {}).join(', ')}`}`);
      if (!ok) failed = true;
    } catch (e) {
      failed = true;
      const extra = e.result ? ` (served by ${e.result.provider ?? 'unknown'}, cost $${e.result.costUsd?.toFixed(6)})` : '';
      console.log(`FAILED: ${e.code ?? 'error'}: ${e.message}${extra}`);
    }
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(`model-check: ${e.code ?? 'error'}: ${e.message}`);
  process.exit(1);
});
