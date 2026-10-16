# Lab job dispatcher

A small service on the home-lab Mac mini that runs **named shell jobs on request**. Something (a person with `curl`, or a scheduled launchd task) says "run `hello`", and the service runs `jobs/hello.sh`, records what happened, and returns the output. It can only run files that live in `jobs/`; it can never run arbitrary commands.

## How it fits together
```
 launchd (06:00) ──> src/schedule-run.js ──┐                    ┌──> jobs/<name>.sh
                                           ├─> POST /run/<name> ┤
 you / curl ───────────────────────────────┘   src/server.js    └──> data/dispatcher.db (run log)
                                                    │
                          healthchecks.io <─────────┘ (scheduled runs only, pinged by schedule-run.js)

 launchd (06:00) ──> src/digest/run.js --scheduled ──> Slack (read) ──> OpenRouter ──> data/digests/<date>.md
                     (Slack digest; the one schedule        │                              │
                      outside the dispatcher)               └── healthchecks.io      Slack DM + thread to you
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
| `launchd/` | LaunchAgent plist templates | Keep the service and schedules running; one file per agent (`com.lab.schedule.slack-digest.plist` runs the digest directly at 06:00) |
| `scripts/` | Operator helpers | `install-agent.sh` installs a plist from `launchd/`; `llm-eval.js` checks the LLM prompt templates |
| `src/slack.js` | Shared read-only Slack client, unit rules and conversation listing | Used by the measurement scripts and the digest; decides which conversations are external (masked) and refreshes the saved conversation list before each scheduled digest |
| `src/secrets.js` | Reads `~/.lab/<name>` with the mode-600 check | One secret check for every client |
| `src/openrouter.js` | OpenRouter client (cloud models for the Slack digest) | Primary and secondary model routes, each pinned to one provider; one primary retry (with jitter), then the fallback, in code; served-provider check per reply and in one batch per stage; live prices; run and per-call input caps, output and cost caps; see `docs/slack-digest.md` |
| `src/slack-send.js` | Send-only Slack client (bot token) for the digest DM | Opens the DM with the one configured user, checks it is theirs, posts there and replies under its own message; every other method or target is refused |
| `src/healthcheck.js` | healthchecks.io ping for the digest's own schedule | Checks the URL file's mode and pings success or `/fail` with stats only |
| `src/mask.js` | Masks secrets (every conversation) and emails, phones, long numbers and URLs with tokens (external conversations) | Applied before any text goes to a model |
| `src/digest/` | The daily Slack digest: `run.js` (entry point), `fetch.js`, `compress.js` (bot posts, in code), `customers.js` (customer registry from channel names, the "other" bucket, mention matching), `pipeline.js` (unit modes, stage 1, synthesis per customer), `analyze.js` (cap planning, model calls, the batch provider check, validation and the noise rules), `prompts.js` (prompt templates, including the headline check), `render.js` (the archive file), `dm.js` (the morning DM and its threaded replies) | Writes the customer-merged digest to `data/digests/` (mode 600, newest 14 kept) and, on scheduled runs, sends it to you by Slack DM; see `docs/slack-digest.md` |
| `scripts/slack-channels.js`, `scripts/slack-measure.js` | Slack measurement (terminal only) | Count how many tokens a daily Slack digest would read, to choose between the local and a cloud model. See `docs/slack-measurement.md` |
| `scripts/model-check.js` | Live check of each model route: model, served provider, tokens, cost, JSON shape | Uses invented text only; `--dry-run` shows request bodies and live prices without calling |
| `scripts/digest-eval.js` | Eval of the digest prompts on invented sample days, both model routes side by side | Run after changing `src/digest/prompts.js`; the primary must pass |
| `scripts/digest-selftest.js` | Self-tests for masking, the OpenRouter client (retry, fallback, caps, guards), validation and noise rules, the registry, the pipeline (stubbed model), call concurrency and the batch provider check, the headline check, cap planning, the membership refresh, `digest-map.js`, the archive, the DM and send-only client, the healthcheck helper and bot compression | Invented data, no network; run after changing any of them |
| `scripts/digest-dm-test.js` | Sends one invented line to your digest DM | Checks the bot token, scopes and DM check; prints stats only |
| `scripts/digest-map.js` | Maps, ignores or un-maps a conversation by name (`list-unmapped`, `map`, `map-customer`, `ignore`, `remove`) | Clears the DM footer's "unmapped" list without hand-editing the git-ignored configs; names from the cached listing, candidates on ambiguity, atomic writes |
| `scripts/digest-customers.js` | Prints the digest's customer registry | Customers with their channels and mention aliases, the "other" bucket, and channels that matched no customer; names only, no Slack calls |
| `config/` | Settings that are not secrets | Tracked templates `slack-bus.example.json`, `slack-digest.example.json` and `digest-customers.example.json`; the real files (unit rules, digest settings, customer registry settings) are git-ignored |
| `data/` | Runtime data (everything except `.gitkeep` is git-ignored) | Holds `dispatcher.db`, `slack-channels.json` (refreshed before each scheduled digest), `slack-measure-<date>.json`, `digests/` (mode 600) and `digest-state.json` |
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
All secrets live in `~/.lab/` (directory 700, files 600) and never in this repo: `token`, `healthcheck-url-<job>` (including `healthcheck-url-slack-digest`), `slack-token` (Slack reading), `slack-bot-token` (Slack sending, same app; scopes `chat:write`, `im:write`) and `openrouter-key`.
