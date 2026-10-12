'use strict';
// Calls the dispatcher for one job, then pings healthchecks.io with the result.
// Usage: node scheduled/run.js <job>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const job = process.argv[2];
if (!job || !/^[a-z0-9-]+$/.test(job)) {
  console.error('usage: run.js <job> (job must match ^[a-z0-9-]+$)');
  process.exit(2);
}

function readSecret(name) {
  const file = path.join(os.homedir(), '.lab', name);
  const st = fs.statSync(file);
  if (!st.isFile() || (st.mode & 0o077) !== 0) throw new Error(`${file} must be a regular file with mode 600`);
  const v = fs.readFileSync(file, 'utf8').trim();
  if (!v) throw new Error(`${file} is empty`);
  return v;
}

async function ping(base, failed, body) {
  const url = failed ? `${base.replace(/\/+$/, '')}/fail` : base;
  const res = await fetch(url, { method: 'POST', body: body.slice(-10_000), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`healthcheck ping returned HTTP ${res.status}`);
}

(async () => {
  const stamp = new Date().toISOString();
  let failed = true;
  let summary;
  try {
    const token = readSecret('token');
    const res = await fetch(`http://127.0.0.1:8787/run/${job}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'X-Source': 'launchd-schedule' },
      signal: AbortSignal.timeout(70_000),
    });
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch { /* non-JSON error body */ }
    failed = !(res.status === 200 && data.exitCode === 0 && !data.timedOut);
    summary = `${job}: http=${res.status} exit=${data.exitCode} timedOut=${data.timedOut}\n${data.output ?? text}`;
  } catch (e) {
    summary = `${job}: dispatcher call failed: ${e.message}`;
  }
  console.log(`[${stamp}] ${failed ? 'FAIL' : 'OK'} ${summary}`);

  try {
    await ping(readSecret(`healthcheck-url-${job}`), failed, summary);
    console.log(`[${stamp}] healthcheck ping sent (${failed ? 'fail' : 'success'})`);
  } catch (e) {
    console.error(`[${stamp}] healthcheck ping failed: ${e.message}`);
    process.exit(1);
  }
  process.exit(failed ? 1 : 0);
})();
