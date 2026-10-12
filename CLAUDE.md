# Lab job dispatcher

Node + Fastify service on this Mac mini that runs named jobs on request. Rules below are binding for every session.

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

## Notes
- Node comes from Homebrew (`/opt/homebrew/bin/node`). SQLite uses the built-in `node:sqlite`, so there is no native dependency.
- Add a job by dropping an executable `jobs/<name>.sh`; no server change needed.
