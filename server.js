'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const Fastify = require('fastify');
const { logRun } = require('./db');

const HOST = '127.0.0.1';
const PORT = 8787;
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 1024 * 1024;
const JOB_NAME = /^[a-z0-9-]+$/;
const JOBS_DIR = fs.realpathSync(path.join(__dirname, 'jobs'));
const TOKEN_PATH = path.join(os.homedir(), '.lab', 'token');

function loadToken() {
  const st = fs.statSync(TOKEN_PATH);
  if (!st.isFile() || (st.mode & 0o077) !== 0) {
    throw new Error(`${TOKEN_PATH} must be a regular file with mode 600`);
  }
  const token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  if (!token) throw new Error(`${TOKEN_PATH} is empty`);
  return Buffer.from(token);
}
const TOKEN = loadToken();

function tokenOk(header) {
  const m = /^Bearer (.+)$/.exec(header || '');
  if (!m) return false;
  const given = Buffer.from(m[1]);
  return given.length === TOKEN.length && crypto.timingSafeEqual(given, TOKEN);
}

// Returns the real path of an executable regular file inside jobs/, or null.
function resolveJob(name) {
  try {
    const real = fs.realpathSync(path.join(JOBS_DIR, `${name}.sh`));
    if (path.dirname(real) !== JOBS_DIR) return null;
    if (!fs.statSync(real).isFile()) return null;
    fs.accessSync(real, fs.constants.X_OK);
    return real;
  } catch {
    return null;
  }
}

const app = Fastify({ logger: true });

const sourceOf = (req) => `${req.ip}${req.headers['x-source'] ? ` (${String(req.headers['x-source']).slice(0, 100)})` : ''}`;

app.get('/health', async () => ({ ok: true }));

app.post('/run/:job', async (req, reply) => {
  const startedAt = new Date().toISOString();
  const source = sourceOf(req);
  const { job } = req.params;
  const reject = (code, status, error) => {
    logRun({ job: job.slice(0, 100), source, startedAt, status });
    return reply.code(code).send({ error });
  };

  if (!tokenOk(req.headers.authorization)) return reject(401, 'unauthorized', 'unauthorized');
  if (!JOB_NAME.test(job)) return reject(400, 'bad-name', 'invalid job name');
  const file = resolveJob(job);
  if (!file) return reject(404, 'not-found', 'no such job');

  const t0 = process.hrtime.bigint();
  const result = await new Promise((resolve) => {
    execFile(file, [], { cwd: JOBS_DIR, timeout: TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin' } },
      (err, stdout, stderr) => {
        const timedOut = !!(err && err.killed && err.signal === 'SIGKILL');
        const exitCode = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
        resolve({ exitCode, timedOut, output: `${stdout}${stderr}` });
      });
  });
  const durationMs = Number((process.hrtime.bigint() - t0) / 1_000_000n);
  const status = result.timedOut ? 'timeout' : 'ok';
  logRun({ job, source, startedAt, durationMs, exitCode: result.exitCode, status, output: result.output });
  return { job, exitCode: result.exitCode, durationMs, timedOut: result.timedOut, output: result.output };
});

app.listen({ host: HOST, port: PORT }).catch((e) => { app.log.error(e); process.exit(1); });
