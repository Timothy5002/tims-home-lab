# Operations

## Requirements
macOS with Homebrew Node (`/opt/homebrew/bin/node`, v24 or newer: SQLite is the built-in `node:sqlite`). The Mac is set to never sleep (`pmset` sleep 0, display sleep is fine) and logs in automatically, because LaunchAgents only run in a logged-in session.

Optional, for jobs that use the LLM helper: Ollama from Homebrew (`brew services start ollama`) with `ollama pull qwen2.5:7b`.

## First-time setup
1. `npm install`
2. Create the token: `umask 077; mkdir -p ~/.lab; openssl rand -hex 32 > ~/.lab/token` (directory 700, file 600; the server refuses to start otherwise).
3. `scripts/install-agent.sh launchd/com.lab.dispatcher.plist`
4. For each schedule, see [adding-jobs.md](adding-jobs.md).

## Files outside the repo
| Path | Contents |
|---|---|
| `~/.lab/token` | API bearer token (600) |
| `~/.lab/healthcheck-url-<job>` | healthchecks.io ping URL for that job's schedule (600) |
| `~/.lab/slack-token` | Read-only Slack user token for the Slack measurement scripts and the digest (600) |
| `~/.lab/openrouter-key` | OpenRouter API key for the Slack digest (600); its monthly spend limit is set in OpenRouter's dashboard |
| `~/.lab/slack-bot-token` | Bot token of the same Slack app, used only to send the digest DM to you (600) |
| `~/.lab/healthcheck-url-slack-digest` | The digest's own healthchecks.io ping URL (600) |
| `~/Library/LaunchAgents/com.lab.*.plist` | Installed copies of `launchd/*.plist` |
| `~/Library/Logs/lab-dispatcher/` | `out.log`, `err.log` (service), `schedule-<job>.log` (scheduled runs), `schedule-slack-digest.log` (digest stats only) |

## Everyday commands
```bash
launchctl print gui/$(id -u)/com.lab.dispatcher | grep -E 'state|pid'      # is it running?
launchctl kickstart -k gui/$(id -u)/com.lab.dispatcher                     # restart it
launchctl kickstart -k gui/$(id -u)/com.lab.schedule.hello                 # run a schedule now
launchctl kickstart -k gui/$(id -u)/com.lab.schedule.disk-check            # run the disk check now
sqlite3 -header -column data/dispatcher.db "select * from runs order by id desc limit 10"
node scripts/llm-eval.js                                                   # check the LLM prompt templates
curl -s 127.0.0.1:11434/api/ps                                             # is the model loaded right now?
node scripts/slack-channels.js && node scripts/slack-measure.js            # Slack volume; see docs/slack-measurement.md
launchctl kickstart -k gui/$(id -u)/com.lab.schedule.slack-digest          # run the Slack digest now (records, delivers, pings)
tail -n 60 ~/Library/Logs/lab-dispatcher/schedule-slack-digest.log         # digest stats (never message text)
node scripts/digest-dm-test.js                                             # send one invented line to your DM; prints stats
node scripts/digest-selftest.js                                            # digest guard tests (no network)
node scripts/digest-customers.js                                           # print the customer registry (names only)
```
The digest keeps the newest 14 files in `data/digests/` and deletes older ones; its last success is in `data/digest-state.json`. See [slack-digest.md](slack-digest.md).
After editing a file in `launchd/`, reinstall it with `scripts/install-agent.sh launchd/<file>.plist`. After editing `src/`, restart the dispatcher with the `kickstart -k` command above.

## Troubleshooting
| Symptom | Likely cause |
|---|---|
| Service won't start; `err.log` mentions mode 600 | `chmod 600 ~/.lab/token` |
| 401 on every request | Wrong or missing `Authorization: Bearer` header |
| 404 for a job that exists | File missing `chmod +x`, wrong name, or symlink pointing outside `jobs/` |
| Healthchecks.io shows down | Check `~/Library/Logs/lab-dispatcher/schedule-<job>.log`; was the Mac off at run time, or the job failing? |
| A job's `llm:` line says `cannot reach Ollama` | `brew services restart ollama`; check `curl -s 127.0.0.1:11434/api/tags` lists `qwen2.5:7b` |
| `llm: model timed out` | The model was cold and the job was already near its limit; give the call a larger share of the 60s, or make fewer calls per job |
| `disk-check` fails | Free space on the internal drive is under 25% or under 40 GB; the job's output (in `schedule-disk-check.log` and the healthchecks.io ping body) shows the numbers |
| `disk-check` lists `Library`, `Documents` etc. as unreadable | Expected. Jobs run under launchd's `node`, which macOS privacy does not let into protected folders, and Full Disk Access is deliberately not granted. Free space is still exact; only the folder list is incomplete |
| Nothing runs after a reboot | Auto-login is off, or the agent isn't installed in `~/Library/LaunchAgents/` |
| Digest healthcheck is down, log says `delivery-failed` | The digest file was still written, and the last success did not move, so the next run covers the window again. The `delivery.code` in the log is Slack's error code: `missing_scope` (add the scope in the Slack app and reinstall it), `invalid_auth` or `bot-token` (check `~/.lab/slack-bot-token`, mode 600), `dm-mismatch` (Slack returned a DM that is not yours; nothing was posted), `thread-not-posted` (the top message went out but the reply failed) |
| A customer's channels show up as separate records, or "unmatched channels" grows | Run `node scripts/digest-customers.js`, then add extra `keys`, `aliases` or hand-assigned `channels` (or `notCustomers`) in `config/digest-customers.json` |
| Digest log says `not summarized (cap)` or the footer counts calls over the cap | The window held more than the 400k-token run cap (for example after several missed days); the busiest customers were summarized and the rest listed with counts |
| Digest ran but the healthcheck shows `/fail` with `deadline` | The run passed 25 minutes; usually Slack rate limits. No digest was written and the last success did not move |
