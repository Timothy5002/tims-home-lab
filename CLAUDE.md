# Lab job dispatcher

Node + Fastify service on this Mac mini that runs named jobs on request. Rules below are binding for every session. Start with `README.md` for the map of the repo; details are in `docs/`.

## Rules
- `POST /run/:job` runs `./jobs/<job>.sh` with a 60s timeout (SIGKILL on expiry).
- Auth: Bearer token read from `~/.lab/token` (dir 700, file 600). The token never goes in the repo, in chat, in logs, or in the plist. The server refuses to start if the file is looser than 600.
- Job names must match `^[a-z0-9-]+$` and map only to executable regular files directly inside `./jobs/` (realpath-checked). No arbitrary commands, no shell, no request data passed to jobs.
- Listen on `127.0.0.1:8787` only. The host is hardcoded; do not add an env override or bind to 0.0.0.0.
- `GET /health` is the only unauthenticated route.
- Every request to `/run/:job` is logged to SQLite (`dispatcher.db`: job, source, start time, duration, exit code, status, output), including rejected ones.
- Runs as a LaunchAgent (`com.lab.dispatcher`, RunAtLoad + KeepAlive). Logs go to `~/Library/Logs/lab-dispatcher/`.
- `.gitignore` must keep covering `node_modules`, `*.db*`, logs, and secrets. Never commit tokens.
- Changing any rule above needs the user's explicit approval. Tell the user when something needs sudo or a GUI click; do not work around it.

## Repository layout (keep it this way)
- `src/` service code; `jobs/` runnable jobs only; `launchd/` plist templates (the repo copy is the source of truth, installed via `scripts/install-agent.sh`); `scripts/` operator helpers; `data/` git-ignored runtime data; `docs/` documentation.
- Do not put code, plists or docs in the repo root. The root holds only `README.md`, `CLAUDE.md`, `package.json`, `package-lock.json`, `.gitignore`.

## Documentation rules
- Any change that adds, moves, renames or removes a file, job, schedule, endpoint, secret or setting must update the docs in the same commit: `README.md` (repository map), the relevant file in `docs/`, `jobs/README.md` (job and schedule table), and this file if a rule or convention changed.
- Every source file starts with a comment saying what it is and why it exists; every job script has a one-line purpose comment.
- Write for a newcomer: say what a thing does and why, not just how. Use plain names, and put design reasoning in `docs/decisions.md`.
- Never write secrets (token, ping URLs) into docs, examples or commit messages; refer to the `~/.lab/` file instead.

## Notes
- Node comes from Homebrew (`/opt/homebrew/bin/node`). SQLite uses the built-in `node:sqlite`, so there is no native dependency.
- Add a job by dropping an executable `jobs/<name>.sh`; no server change needed. Full steps: `docs/adding-jobs.md`.

## Scheduled jobs
- Schedules call the dispatcher; they never run job files directly. `src/schedule-run.js <job>` POSTs to `/run/<job>` (source `launchd-schedule`, so runs land in SQLite), then pings healthchecks.io: `GET <url>` on success, `<url>/fail` on any failure (dispatcher down, non-200, non-zero exit, timeout). The ping URL is read from `~/.lab/healthcheck-url-<job>` (one file per job, mode 600, never in the repo, logs, or chat); the wrapper fails without pinging if the file is missing or looser than 600.
- **Always prompt for a healthcheck URL.** Whenever the user asks for a new scheduled job (or a new job that will run on a schedule), do not create the plist or the schedule until you have told the user to create a new healthchecks.io check for it and put its URL in `~/.lab/healthcheck-url-<name>` (`umask 077; pbpaste > ~/.lab/healthcheck-url-<name>`, then chmod 600). Suggest a period and grace time that match the schedule. Never reuse another job's URL. Confirm the file exists with mode 600 before installing the schedule. A job that is only run on demand (no schedule) needs no check.
- To add a schedule: (1) the job must already exist as `jobs/<name>.sh`; (2) copy `launchd/com.lab.schedule.hello.plist` to `launchd/com.lab.schedule.<name>.plist`, change `Label`, the job argument, the `StartCalendarInterval`, and the log path; (3) create the job's own healthchecks.io check and write its URL to `~/.lab/healthcheck-url-<name>` (`umask 077`, chmod 600); (4) install it with `scripts/install-agent.sh launchd/com.lab.schedule.<name>.plist`.
- Test with `launchctl kickstart -k gui/$(id -u)/com.lab.schedule.<name>` and read `~/Library/Logs/lab-dispatcher/schedule-<name>.log`. Do not use `RunAtLoad` on schedules.
- The Mac must stay awake (`pmset` sleep 0; display sleep is fine) and logged in (auto-login is on). Missed runs fire on wake but are skipped if the Mac was powered off; the healthchecks grace period catches that.
