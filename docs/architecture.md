# Architecture

## Components
- **Dispatcher (`src/server.js`)**: a Fastify HTTP service bound to `127.0.0.1:8787` only. Managed by the `com.lab.dispatcher` LaunchAgent (RunAtLoad + KeepAlive).
- **Run log (`src/db.js`)**: SQLite database `data/dispatcher.db`, table `runs`.
- **Scheduler wrapper (`src/schedule-run.js`)**: invoked by launchd calendar agents. It is a client of the dispatcher, not part of it.
- **Jobs (`jobs/*.sh`)**: the executable allowlist.
- **LLM helper (`src/llm.js`, templates in `src/llm-prompts.js`)**: a command-line tool that jobs call to classify, extract or summarize text. It is not part of the server; a job runs it as a child process. It talks only to the local Ollama service (Homebrew, `127.0.0.1:11434`, model `qwen2.5:7b`).

## Endpoints
| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness check; returns `{"ok":true}` and nothing else |
| `POST /run/:job` | Bearer token | Run `jobs/<job>.sh`; returns `{job, exitCode, durationMs, timedOut, output}` |

## Request flow for `POST /run/:job` (checks happen in this order)
1. **Token check.** `Authorization: Bearer <token>` is compared in constant time with `~/.lab/token`. Failure: 401.
2. **Name check.** The name must match `^[a-z0-9-]+$`. Failure: 400.
3. **Lookup.** `jobs/<name>.sh` is resolved with `realpath`; it must be an executable regular file **directly inside** `jobs/`. Symlinks that point elsewhere are rejected. Failure: 404.
4. **Run.** `spawn` (no shell), no arguments, `cwd=jobs/`, minimal environment (`PATH` only), in a **new process group**. After 60s, or if output passes 1 MB, the whole group gets SIGKILL, so any program the job started dies with it. Output is stdout followed by stderr; a killed job reports exit code `-1`.
5. **Log + respond.** One row is written to `runs` and the result is returned. Steps 1 to 3 also write a row (status `unauthorized`, `bad-name`, `not-found`), so rejected attempts are visible.

## The `runs` table
`id, job, source, started_at, duration_ms, exit_code, status, output`. `status` is one of `ok`, `timeout`, `unauthorized`, `bad-name`, `not-found`. `source` is the client IP plus the optional `X-Source` header (scheduled runs use `launchd-schedule`). Query it with `sqlite3 data/dispatcher.db`.

## Scheduled runs
`launchd` fires a calendar agent (`com.lab.schedule.<job>`), which runs `src/schedule-run.js <job>`. The wrapper calls the dispatcher like any other client (so the run is logged and goes through the same guards), then pings that job's healthchecks.io check: success ping, or `/fail` if the dispatcher was unreachable, returned non-200, the job exited non-zero, or it timed out. If a run never happens, healthchecks.io alerts when its grace time expires.

## LLM helper
A job pipes text into `node ../src/llm.js <task>` and reads the result on stdout. The helper picks the task's prompt template, sends one request to Ollama's `/api/chat`, and checks the answer before printing it:
- `classify` and `extract` use Ollama structured output (a JSON schema; for classify the labels are an `enum`), so the model can only return the allowed shape.
- Every request sets temperature 0.1, a per-task output cap (`num_predict`: 20 / 200 / 120), a 4096-token context, and `keep_alive: 1m`, so the model unloads from memory after a minute idle.
- Limits: 8,000 input characters, and a 50s timeout per call.
- Task types other than the three local ones fail with "needs cloud model" (exit 3) without any network call.
The helper writes nothing to disk and never echoes the input, even in errors.

## Trust boundaries
- Only local processes can reach the port (loopback bind).
- The token is the second layer: any local process without read access to `~/.lab/token` cannot run jobs.
- Jobs receive no request data, so a caller can choose *which* job runs but never *what* it does.
- Text given to the LLM helper stays on this machine (Ollama on loopback). Nothing is sent to a cloud model.
