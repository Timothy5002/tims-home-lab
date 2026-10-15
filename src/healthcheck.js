'use strict';
// healthchecks.io pings for jobs that run on their own launchd schedule (today only the Slack digest; dispatcher
// schedules ping from src/schedule-run.js). The ping URL is read from ~/.lab/healthcheck-url-<job> (mode 600) and
// never printed or logged. The ping body must hold stats only; callers never pass message text.
const fs = require('node:fs');
const path = require('node:path');
const { readSecret, LAB_DIR } = require('./secrets');

const MAX_BODY = 10_000; // healthchecks.io keeps the first 10 kB of a ping body

// Checks the URL file exists as a regular file with mode 600, without reading it. Throws if not.
function checkPingFile(job, dir = LAB_DIR) {
  const name = `healthcheck-url-${job}`;
  let st;
  try { st = fs.statSync(path.join(dir, name)); } catch { throw new Error(`~/.lab/${name} not found`); }
  if (!st.isFile() || (st.mode & 0o077) !== 0) throw new Error(`~/.lab/${name} must be a regular file with mode 600`);
}

// POSTs body to the URL (success) or <URL>/fail. fetchImpl and dir are for tests.
async function ping(job, failed, body, { fetchImpl = fetch, dir = LAB_DIR } = {}) {
  const base = readSecret(`healthcheck-url-${job}`, dir);
  if (!/^https:\/\//.test(base)) throw new Error(`~/.lab/healthcheck-url-${job} does not hold an https URL`);
  const url = failed ? `${base.replace(/\/+$/, '')}/fail` : base;
  const res = await fetchImpl(url, { method: 'POST', body: String(body).slice(0, MAX_BODY), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`healthcheck ping returned HTTP ${res.status}`);
}

module.exports = { checkPingFile, ping };
