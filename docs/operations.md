# Operations

## Requirements
macOS with Homebrew Node (`/opt/homebrew/bin/node`, v24 or newer: SQLite is the built-in `node:sqlite`). The Mac is set to never sleep (`pmset` sleep 0, display sleep is fine) and logs in automatically, because LaunchAgents only run in a logged-in session.

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
| `~/Library/LaunchAgents/com.lab.*.plist` | Installed copies of `launchd/*.plist` |
| `~/Library/Logs/lab-dispatcher/` | `out.log`, `err.log` (service), `schedule-<job>.log` (scheduled runs) |

## Everyday commands
```bash
launchctl print gui/$(id -u)/com.lab.dispatcher | grep -E 'state|pid'      # is it running?
launchctl kickstart -k gui/$(id -u)/com.lab.dispatcher                     # restart it
launchctl kickstart -k gui/$(id -u)/com.lab.schedule.hello                 # run a schedule now
sqlite3 -header -column data/dispatcher.db "select * from runs order by id desc limit 10"
```
After editing a file in `launchd/`, reinstall it with `scripts/install-agent.sh launchd/<file>.plist`. After editing `src/`, restart the dispatcher with the `kickstart -k` command above.

## Troubleshooting
| Symptom | Likely cause |
|---|---|
| Service won't start; `err.log` mentions mode 600 | `chmod 600 ~/.lab/token` |
| 401 on every request | Wrong or missing `Authorization: Bearer` header |
| 404 for a job that exists | File missing `chmod +x`, wrong name, or symlink pointing outside `jobs/` |
| Healthchecks.io shows down | Check `~/Library/Logs/lab-dispatcher/schedule-<job>.log`; was the Mac off at run time, or the job failing? |
| Nothing runs after a reboot | Auto-login is off, or the agent isn't installed in `~/Library/LaunchAgents/` |
