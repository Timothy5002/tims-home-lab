'use strict';
// Checks the LLM helper's prompt templates (src/llm-prompts.js) against inputs with known answers.
// Run after editing a template or changing the model: node scripts/llm-eval.js
// It calls src/llm.js exactly as a job would (stdin in, stdout out), so it tests the CLI too.
// Needs Ollama running; takes about a minute. Exits non-zero if any case fails.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HELPER = path.join(__dirname, '..', 'src', 'llm.js');
// Same labels and descriptions as jobs/llm-test.sh. Bare names like "reply" are ambiguous to a 7B model
// (it filed a newsletter as "reply" without descriptions), so give labels descriptions.
const EMAIL_LABELS = [
  '--label', 'urgent=needs action today',
  '--label', 'reply=needs a personal response, but not today',
  '--label', 'fyi=informational, no action needed',
  '--label', 'noise=marketing, newsletters or automated promotions',
];

const CASES = [
  // classify: the label must match exactly
  { name: 'classify outage', args: ['classify', ...EMAIL_LABELS], input: 'Subject: Site is down\nOur website has been returning errors for 20 minutes. Customers cannot log in. Please fix ASAP.', expect: (o) => o === 'urgent' },
  { name: 'classify newsletter', args: ['classify', ...EMAIL_LABELS], input: 'Subject: This week in gadgets\nOur top 10 deals of the week! Click to shop. Unsubscribe at any time.', expect: (o) => o === 'noise' },
  { name: 'classify personal ask', args: ['classify', ...EMAIL_LABELS], input: 'Subject: Reference?\nWould you be willing to be a reference for my new job application? No rush, sometime this month.', expect: (o) => o === 'reply' },
  { name: 'classify sentiment', args: ['classify', '--labels', 'positive,negative,neutral'], input: 'The replacement part arrived broken and support never called me back.', expect: (o) => o === 'negative' },
  // extract: stated fields found, unstated fields null
  {
    name: 'extract order',
    args: ['extract', '--fields', 'customer,order_number,ship_date,tracking_number'],
    input: 'Hello Dana, your order #A-5531 shipped on June 4 and should arrive within 3 days.',
    expect: (o) => { const j = JSON.parse(o); return j.customer === 'Dana' && /A-5531/.test(j.order_number) && /June 4/.test(j.ship_date) && j.tracking_number === null; },
  },
  // summarize-short: non-empty, at most 3 sentences, mentions the key fact
  {
    name: 'summarize notice',
    args: ['summarize-short'],
    input: 'Reminder: the quarterly fire drill is this Friday at 11am. When the alarm sounds, leave by the nearest stairwell and gather in the north parking lot. Elevators will be disabled during the drill. It should take about 15 minutes.',
    expect: (o) => o.length > 0 && (o.match(/[.!?](\s|$)/g) || []).length <= 3 && /friday/i.test(o),
  },
  // guards: no model call needed
  { name: 'unknown task -> cloud', args: ['translate'], input: 'hola', expect: (o, code) => code === 3 && /needs cloud model/.test(o) },
  { name: 'input over cap', args: ['summarize-short'], input: 'x'.repeat(8001), expect: (o, code) => code === 2 && /over 8000/.test(o) },
  { name: 'empty input', args: ['summarize-short'], input: '  ', expect: (o, code) => code === 2 && /empty/.test(o) },
];

let failed = 0;
for (const c of CASES) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [HELPER, ...c.args], { input: c.input, encoding: 'utf8', timeout: 55_000 });
  const out = (r.stdout || r.stderr || '').trim();
  let ok = false;
  try { ok = c.expect(out, r.status); } catch { ok = false; }
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(24)} ${String(Date.now() - t0).padStart(6)}ms  exit=${r.status}  ${out.slice(0, 160)}`);
}
console.log(`\n${CASES.length - failed}/${CASES.length} passed`);
process.exit(failed ? 1 : 0);
