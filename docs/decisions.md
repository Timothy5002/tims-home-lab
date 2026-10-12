# Design decisions

| Decision | Why |
|---|---|
| Jobs are files in `jobs/`, not commands in the request | A caller can only pick *which* script runs, never what it does. Adding capability means adding a reviewed file. |
| `execFile`, never a shell | No shell means no injection through names or arguments. Jobs receive no arguments at all. |
| Bind to `127.0.0.1`, hardcoded | Nothing off this machine can reach it. No env override, so a config slip cannot expose it. |
| Token in `~/.lab/token`, mode enforced at startup | Keeps the secret out of the repo, plists and logs; the server refuses to start with a loose file. |
| `/health` is the only unauthenticated route | Liveness checks need no secret and reveal nothing. |
| SQLite via built-in `node:sqlite` | No native module to build; one dependency (fastify) in total. |
| Log rejected requests too | Failed auth and bad names are the interesting events for an audit trail. |
| Scheduled runs go through the HTTP API | One code path, one set of guards, and every run lands in the same log. |
| One healthchecks.io check per schedule | A shared check would hide which job failed or went silent. |
| LaunchAgents, not LaunchDaemons | No sudo needed; works because the Mac auto-logs in and never sleeps. |
| Plist templates live in `launchd/` and are copied to `~/Library/LaunchAgents/` | The repo is the source of truth; `scripts/install-agent.sh` is the only install path. |
