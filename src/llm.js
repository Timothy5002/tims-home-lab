'use strict';
// Shared LLM helper for jobs: reads text on stdin, runs one task type, prints the result on stdout.
// Small, well-defined tasks go to the local Ollama model so nothing leaves this Mac; anything else is
// refused with "needs cloud model" until a cloud API key is set up. See docs/adding-jobs.md for usage.
//
// Usage: node src/llm.js <task> [options] < input.txt
//   classify         --labels a,b,c  or  --label name[=description] (repeatable)   -> prints one label
//   extract          --fields f1,f2,...                                             -> prints one-line JSON
//   summarize-short                                                                 -> prints 1-3 sentences
//   all tasks:       --timeout <seconds>  (default and maximum 50)
// Exit codes: 0 ok, 2 bad usage or input, 3 needs cloud model, 4 model error or timeout.
//
// Privacy: this file never logs or echoes the input text, not even in error messages. The only record
// of a run is the calling job's own output, which the dispatcher already stores.
const { TASKS } = require('./llm-prompts');

const OLLAMA_URL = 'http://127.0.0.1:11434/api/chat'; // hardcoded on purpose, like the dispatcher's host
const MODEL = 'qwen2.5:7b';
const KEEP_ALIVE = '1m'; // unload the model after a minute idle; sent per request, so the Ollama service is untouched
const TEMPERATURE = 0.1;
const NUM_CTX = 4096;
const MAX_INPUT_CHARS = 8000; // about 2,000 tokens, leaving room in the 4096 context for the template and output
const MAX_TIMEOUT_S = 50; // below the dispatcher's 60s kill, so the job can still report a clean error
const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const FIELD = /^[a-z][a-z0-9_]{0,39}$/;

class Fail extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function parseArgs(argv) {
  const [task, ...rest] = argv;
  const opts = { labels: [], fields: [], timeoutS: MAX_TIMEOUT_S };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[++i];
    if (value === undefined) throw new Fail(2, `missing value for ${flag}`);
    if (flag === '--labels') {
      for (const name of value.split(',').map((s) => s.trim()).filter(Boolean)) opts.labels.push({ name });
    } else if (flag === '--label') {
      const eq = value.indexOf('=');
      opts.labels.push(eq < 0 ? { name: value.trim() } : { name: value.slice(0, eq).trim(), description: value.slice(eq + 1).trim() });
    } else if (flag === '--fields') {
      opts.fields.push(...value.split(',').map((s) => s.trim()).filter(Boolean));
    } else if (flag === '--timeout') {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0 || n > MAX_TIMEOUT_S) throw new Fail(2, `--timeout must be between 0 and ${MAX_TIMEOUT_S} seconds`);
      opts.timeoutS = n;
    } else {
      throw new Fail(2, `unknown option ${flag}`);
    }
  }
  return { task, opts };
}

function validate(task, opts) {
  if (!task) throw new Fail(2, 'usage: node src/llm.js <task> [options] < input (tasks: classify, extract, summarize-short)');
  if (!/^[a-z0-9-]{1,40}$/.test(task)) throw new Fail(2, 'task names are lowercase letters, digits and hyphens');
  if (!Object.hasOwn(TASKS, task)) {
    throw new Fail(3, `needs cloud model: '${task}' is not available locally (local tasks: ${Object.keys(TASKS).join(', ')}; no cloud API key is configured)`);
  }
  if (task === 'classify') {
    if (opts.labels.length < 2 || opts.labels.length > 20) throw new Fail(2, 'classify needs 2 to 20 labels (--labels a,b,c)');
    for (const l of opts.labels) if (!NAME.test(l.name)) throw new Fail(2, `bad label name '${l.name.slice(0, 40)}' (lowercase letters, digits, - and _)`);
    if (new Set(opts.labels.map((l) => l.name)).size !== opts.labels.length) throw new Fail(2, 'duplicate label');
  }
  if (task === 'extract') {
    if (opts.fields.length < 1 || opts.fields.length > 20) throw new Fail(2, 'extract needs 1 to 20 fields (--fields a,b,c)');
    for (const f of opts.fields) if (!FIELD.test(f)) throw new Fail(2, `bad field name '${f.slice(0, 40)}' (lowercase letters, digits and _)`);
    if (new Set(opts.fields).size !== opts.fields.length) throw new Fail(2, 'duplicate field');
  }
}

// Reads stdin, refusing (not truncating) input over the cap.
async function readInput() {
  if (process.stdin.isTTY) throw new Fail(2, 'pipe the input text on stdin');
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > MAX_INPUT_CHARS) throw new Fail(2, `input is over ${MAX_INPUT_CHARS} characters; shorten it before calling`);
  }
  text = text.trim();
  if (!text) throw new Fail(2, 'input is empty');
  return text;
}

async function run(task, opts, input) {
  const t = TASKS[task];
  const body = {
    model: MODEL,
    messages: t.messages(opts, input),
    stream: false,
    keep_alive: KEEP_ALIVE,
    options: { temperature: TEMPERATURE, num_predict: t.numPredict, num_ctx: NUM_CTX },
  };
  if (t.schema) body.format = t.schema(opts);

  let res;
  try {
    res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutS * 1000),
    });
  } catch (e) {
    if (e.name === 'TimeoutError') throw new Fail(4, `model timed out after ${opts.timeoutS}s`);
    throw new Fail(4, `cannot reach Ollama at 127.0.0.1:11434 (${e.cause?.code ?? e.name}); is the brew service running?`);
  }
  // Ollama's error bodies are short status messages, not our input; still cap them.
  if (!res.ok) throw new Fail(4, `Ollama returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const content = data.message?.content ?? '';
  if (data.done_reason === 'length' && t.schema) throw new Fail(4, 'model output hit the token cap before finishing');

  if (!t.schema) {
    const out = t.format(content);
    if (!out) throw new Fail(4, 'model returned an empty result');
    return out;
  }
  let obj;
  try { obj = JSON.parse(content); } catch { throw new Fail(4, 'model returned invalid JSON'); }
  if (task === 'classify' && !opts.labels.some((l) => l.name === obj.label)) throw new Fail(4, 'model returned a label outside the allowed set');
  if (task === 'extract') {
    obj = Object.fromEntries(opts.fields.map((f) => [f, typeof obj[f] === 'string' && obj[f].trim() ? obj[f].trim() : null]));
  }
  return t.format(obj);
}

(async () => {
  try {
    const { task, opts } = parseArgs(process.argv.slice(2));
    validate(task, opts);
    const input = await readInput();
    process.stdout.write(`${await run(task, opts, input)}\n`);
  } catch (e) {
    process.stderr.write(`llm: ${e instanceof Fail ? e.message : `unexpected error: ${e.name}`}\n`);
    process.exitCode = e instanceof Fail ? e.code : 4;
  }
})();
