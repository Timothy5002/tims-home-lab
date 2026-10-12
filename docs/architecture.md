# Architecture

## Components
- **Dispatcher (`src/server.js`)**: a Fastify HTTP service bound to `127.0.0.1:8787` only. Managed by the `com.lab.dispatcher` LaunchAgent (RunAtLoad + KeepAlive).
- **Run log (`src/db.js`)**: SQLite database `data/dispatcher.db`, table `runs`.
- **Scheduler wrapper (`src/schedule-run.js`)**: invoked by launchd calendar agents. It is a client of the dispatcher, not part of it.
- **Jobs (`jobs/*.sh`)**: the executable allowlist.

## Endpoints
| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness check; returns `{"ok":true}` and nothing else |
| `POST /run/:job` | Bearer token | Run `jobs/<job>.sh`; returns `{job, exitCode, durationMs, timedOut, output}` |

## Request flow for `POST /run/:job` (checks happen in this order)
1. **Token check.** `Authorization: Bearer <token>` is compared in constant time with `~/.lab/token`. Failure: 401.
2. **Name check.** The name must match `^[a-z0-9-]+$`. Failure: 400.
3. **Lookup.** `jobs/<name>.sh` is resolved with `realpath`; it must be an executable regular file **directly inside** `jobs/`. Symlinks that point elsewhere are rejected. Failure: 404.
4. **Run.** `execFile` (no shell), no arguments, `cwd=jobs/`, minimal environment (`PATH` only), 60s timeout (then SIGKILL), 1 MB output cap.
5. **Log + respond.** One row is written to `runs` and the result is returned. Steps 1 to 3 also write a row (status `unauthorized`, `bad-name`, `not-found`), so rejected attempts are visible.

## The `runs` table
`id, job, source, started_at, duration_ms, exit_code, status, output`. `status` is one of `ok`, `timeout`, `unauthorized`, `bad-name`, `not-found`. `source` is the client IP plus the optional `X-Source` header (scheduled runs use `launchd-schedule`). Query it with `sqlite3 data/dispatcher.db`.

## Scheduled runs
`launchd` fires a calendar agent (`com.lab.schedule.<job>`), which runs `src/schedule-run.js <job>`. The wrapper calls the dispatcher like any other client (so the run is logged and goes through the same guards), then pings that job's healthchecks.io check: success ping, or `/fail` if the dispatcher was unreachable, returned non-200, the job exited non-zero, or it timed out. If a run never happens, healthchecks.io alerts when its grace time expires.

## Trust boundaries
- Only local processes can reach the port (loopback bind).
- The token is the second layer: any local process without read access to `~/.lab/token` cannot run jobs.
- Jobs receive no request data, so a caller can choose *which* job runs but never *what* it does.
