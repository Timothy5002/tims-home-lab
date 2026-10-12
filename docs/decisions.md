# Design decisions

| Decision | Why |
|---|---|
| Jobs are files in `jobs/`, not commands in the request | A caller can only pick *which* script runs, never what it does. Adding capability means adding a reviewed file. |
| `spawn` without a shell | No shell means no injection through names or arguments. Jobs receive no arguments at all. |
| Each job runs in its own process group, and the timeout kills the group | Killing only the job's shell left its children running: a `du` stuck on a macOS privacy prompt outlived its `disk-check` run. `spawn` is used because `execFile` ignores the `detached` option that creates the group. |
| Bind to `127.0.0.1`, hardcoded | Nothing off this machine can reach it. No env override, so a config slip cannot expose it. |
| Token in `~/.lab/token`, mode enforced at startup | Keeps the secret out of the repo, plists and logs; the server refuses to start with a loose file. |
| `/health` is the only unauthenticated route | Liveness checks need no secret and reveal nothing. |
| SQLite via built-in `node:sqlite` | No native module to build; one dependency (fastify) in total. |
| Log rejected requests too | Failed auth and bad names are the interesting events for an audit trail. |
| Scheduled runs go through the HTTP API | One code path, one set of guards, and every run lands in the same log. |
| One healthchecks.io check per schedule | A shared check would hide which job failed or went silent. |
| LaunchAgents, not LaunchDaemons | No sudo needed; works because the Mac auto-logs in and never sleeps. |
| LLM tasks run on local Ollama first; other tasks fail with "needs cloud model" | Small, bounded tasks (labels, fields, short summaries) are well within a 7B model, and the text never leaves the Mac. No cloud API key exists yet, so an unknown task fails loudly instead of degrading. |
| The LLM helper reads input on stdin, never as an argument | Arguments show up in `ps` for any local user; stdin does not. The helper also never echoes input in errors. |
| LLM call timeout is 50s, not 60s | The dispatcher kills a job at 60s. Stopping the model call first lets the job print a clear error, and the log shows that instead of a bare "timeout". |
| `keep_alive: 1m` is sent per request instead of setting `OLLAMA_KEEP_ALIVE` on the service | Same effect (the model unloads after a minute idle) without editing the Homebrew-managed service, which an upgrade would overwrite. Ollama used from elsewhere keeps its own default. |
| Structured output (JSON schema) for classify and extract | The model cannot return a label outside the list or a malformed object; the helper still re-checks before printing. |
| Prompt templates live apart from the helper and are checked by `scripts/llm-eval.js` | Templates change more often than the plumbing; the eval shows whether a change helped. The eval is a script, not a test folder, to keep the repo layout. |
| `disk-check` measures `/System/Volumes/Data`, not `/` | `/` is the read-only system snapshot; user data and real free space live on the Data volume |
| `disk-check` fails under 25% **or** under 40 GB free | The percentage suits this drive (25% is about 61 GB); the GB floor still protects if the drive is ever replaced with a much larger one |
| Protected home folders stay unreadable; no Full Disk Access for `node` | Granting it would give every Node script on the Mac full disk access, for a nice-to-have folder list. The free-space check, which is what fails the job, is unaffected |
| `disk-check` measures each home folder with a 5 s cap and a 40 s total budget | Under launchd, macOS can make `du` wait on a privacy prompt forever instead of refusing; the cap turns that into an "unreadable" line instead of a 60 s job kill |
| Plist templates live in `launchd/` and are copied to `~/Library/LaunchAgents/` | The repo is the source of truth; `scripts/install-agent.sh` is the only install path. |
