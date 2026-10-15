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
| `src/llm.js` | Shared LLM helper for jobs | Lets a job classify, extract or summarize text with the local Ollama model; see `docs/adding-jobs.md` |
| `src/llm-prompts.js` | Prompt templates for `src/llm.js` | One tested template per task type, kept apart from the plumbing |
| `jobs/` | The runnable jobs (`<name>.sh`) | The only things the service can execute. See `jobs/README.md` |
| `launchd/` | LaunchAgent plist templates | Keep the service and schedules running; one file per agent |
| `scripts/` | Operator helpers | `install-agent.sh` installs a plist from `launchd/`; `llm-eval.js` checks the LLM prompt templates |
| `src/slack.js` | Shared read-only Slack client and unit rules | Used by the measurement scripts and the digest; also decides which conversations are external (masked) |
| `src/secrets.js` | Reads `~/.lab/<name>` with the mode-600 check | One secret check for every client |
| `src/deepseek.js` | DeepSeek client (cloud model for the Slack digest) | No tools, JSON mode, thinking off by default, input cap, timeouts, retries, usage and cost; see `docs/slack-digest.md` |
| `src/mask.js` | Masks emails, phones, long numbers, URLs with tokens and secrets | Applied to external conversations before any text goes to a model |
| `scripts/slack-channels.js`, `scripts/slack-measure.js` | Slack measurement (terminal only) | Count how many tokens a daily Slack digest would read, to choose between the local and a cloud model. See `docs/slack-measurement.md` |
| `scripts/deepseek-check.js` | Live check of the DeepSeek key and model id | Uses invented text only |
| `scripts/digest-selftest.js` | Self-tests for masking, the DeepSeek guards and bot compression | Invented data, no network; run after changing any of them |
| `config/` | Settings that are not secrets | `slack-bus.example.json` is the template; the real `slack-bus.json` (Slack channel to business unit rules) is git-ignored |
| `data/` | Runtime data (everything except `.gitkeep` is git-ignored) | Holds `dispatcher.db`, `slack-channels.json`, `slack-measure-<date>.json` |
| `docs/` | Detailed documentation | Architecture, operations, adding jobs, design decisions, Slack digest design |
| `docs/private/` | Workspace-specific notes (git-ignored) | Real channel names, IDs and open questions that committed docs leave out |
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
- **Measure Slack volume for a digest:** [docs/slack-measurement.md](docs/slack-measurement.md)
- **Daily Slack digest (design and phases):** [docs/slack-digest-design.md](docs/slack-digest-design.md); **running it:** [docs/slack-digest.md](docs/slack-digest.md)
- **Why things are the way they are:** [docs/decisions.md](docs/decisions.md)

## Secrets
All secrets live in `~/.lab/` (directory 700, files 600) and never in this repo: `token`, `healthcheck-url-<job>`, `slack-token` and `deepseek-key`.
