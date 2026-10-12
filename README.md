# Lab job dispatcher

A small service on the home-lab Mac mini that runs **named shell jobs on request**. Something (a person with `curl`, or a scheduled launchd task) says "run `hello`", and the service runs `jobs/hello.sh`, records what happened, and returns the output. It can only run files that live in `jobs/`; it can never run arbitrary commands.

## How it fits together
```
 launchd (06:00) ──> src/schedule-run.js ──┐                    ┌──> jobs/<name>.sh
                                           ├─> POST /run/<name> ┤
 you / curl ───────────────────────────────┘   src/server.js    └──> data/dispatcher.db (run log)
                                                    │
                          healthchecks.io <─────────┘ (scheduled runs only, pinged by schedule-run.js)
```

## Repository map
| Path | What it is | Why it exists |
|---|---|---|
| `src/server.js` | The Fastify service | Auth, job lookup, timeout, response |
| `src/db.js` | SQLite run log | Audit trail of every request |
| `src/schedule-run.js` | Scheduled-run wrapper | Calls the dispatcher, then pings healthchecks.io |
| `jobs/` | The runnable jobs (`<name>.sh`) | The only things the service can execute. See `jobs/README.md` |
| `launchd/` | LaunchAgent plist templates | Keep the service and schedules running; one file per agent |
| `scripts/` | Operator helpers | `install-agent.sh` installs a plist from `launchd/` |
| `data/` | Runtime data (git-ignored) | Holds `dispatcher.db` |
| `docs/` | Detailed documentation | Architecture, operations, adding jobs, design decisions |
| `CLAUDE.md` | Rules for Claude Code sessions | Binding rules and conventions; humans should read it too |

## Quick start
```bash
npm install                              # one dependency: fastify
umask 077; mkdir -p ~/.lab; openssl rand -hex 32 > ~/.lab/token   # the API token (never commit)
scripts/install-agent.sh launchd/com.lab.dispatcher.plist         # start the service
curl -s localhost:8787/health                                     # -> {"ok":true}
curl -s -X POST -H "Authorization: Bearer $(cat ~/.lab/token)" localhost:8787/run/hello
```

## Where to read next
- **Understand the design:** [docs/architecture.md](docs/architecture.md)
- **Run and troubleshoot it:** [docs/operations.md](docs/operations.md)
- **Add a job or a schedule:** [docs/adding-jobs.md](docs/adding-jobs.md)
- **Why things are the way they are:** [docs/decisions.md](docs/decisions.md)

## Secrets
All secrets live in `~/.lab/` (directory 700, files 600) and never in this repo: `token` and `healthcheck-url-<job>`.
