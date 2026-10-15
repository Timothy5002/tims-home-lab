'use strict';
// Checks the DeepSeek setup with invented text only: lists the model ids the key can use, makes one JSON call
// through src/deepseek.js (thinking off), and prints the model id the API answered with, token usage, the
// estimated cost and the price that applies at the digest's 06:00 local run time. Never prints the key.
// Usage: node scripts/deepseek-check.js [--model deepseek-flash]
const { parseArgs } = require('node:util');
const { chat, listModels, rateAt, PRICES, DEFAULT_MODEL } = require('../src/deepseek');

(async () => {
  const { values: opts } = parseArgs({ options: { model: { type: 'string', default: DEFAULT_MODEL } } });
  const models = await listModels();
  console.log(`Models available to this key: ${models.join(', ') || '(none listed)'}`);
  if (!models.includes(opts.model)) console.log(`  Note: ${opts.model} is not in that list.`);

  // Invented text, no Slack data.
  const r = await chat({
    model: opts.model,
    system: 'You extract facts. Reply in json like {"product": "...", "problem": "...", "severity": "low|medium|high"}.',
    user: 'Invented example: The Zephyr 3000 kettle at Example Cafe stopped heating twice this morning; staff are annoyed.',
    maxTokens: 200,
  });
  console.log(`Reply model id: ${r.model}  (requested ${opts.model}, thinking off)`);
  console.log(`Parsed JSON keys: ${Object.keys(r.json).join(', ')}  attempts: ${r.attempts}  finish: ${r.finishReason}`);
  const u = r.usage ?? {};
  console.log(`Usage: prompt ${u.prompt_tokens} (cache hit ${u.prompt_cache_hit_tokens ?? '?'}, miss ${u.prompt_cache_miss_tokens ?? '?'}), output ${u.completion_tokens}`);
  console.log(`Estimated cost of this call: $${r.costUsd?.toFixed(6)} at the ${r.rate} rate (now)`);

  // The digest runs at 06:00 local time; show the rate and prices that apply then.
  const six = new Date(); six.setDate(six.getDate() + 1); six.setHours(6, 0, 0, 0);
  const rate = rateAt(six);
  const p = PRICES[opts.model]?.[rate];
  console.log(`At 06:00 local (${six.toISOString().slice(11, 16)} UTC) the ${rate} rate applies: ` +
    (p ? `input cache hit $${p.hit}, cache miss $${p.miss}, output $${p.out} per million tokens (prices checked ${PRICES.checked})` : 'no price table for this model'));
})().catch((e) => {
  console.error(`deepseek-check: ${e.code ?? 'error'}: ${e.message}`);
  process.exit(1);
});
