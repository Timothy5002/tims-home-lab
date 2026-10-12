# Adding jobs and schedules

## Add a job (on-demand only)
1. Create `jobs/<name>.sh`. The name must match `^[a-z0-9-]+$`.
2. Start it with `#!/bin/sh` (or bash), make it executable: `chmod +x jobs/<name>.sh`.
3. Write it to be self-contained: it gets no arguments, no request data, and only a minimal `PATH`. It must exit 0 on success and non-zero on failure, because the exit code is what gets logged and what a schedule reports.
4. Keep it under 60 seconds or it is killed.
5. Test: `curl -s -X POST -H "Authorization: Bearer $(cat ~/.lab/token)" localhost:8787/run/<name>`.
6. Update the table in `jobs/README.md`.
No server change or restart is needed.

## Schedule a job
Every scheduled job needs its **own healthchecks.io check**.
1. Create the job above first.
2. In healthchecks.io, create a new check for it (period and grace time that match the schedule), copy its ping URL.
3. Save it: `umask 077; pbpaste > ~/.lab/healthcheck-url-<name>; chmod 600 ~/.lab/healthcheck-url-<name>`.
4. Copy `launchd/com.lab.schedule.hello.plist` to `launchd/com.lab.schedule.<name>.plist`. Change `Label`, the job argument, `StartCalendarInterval`, and both log paths to `schedule-<name>.log`. Do not add `RunAtLoad`.
5. `scripts/install-agent.sh launchd/com.lab.schedule.<name>.plist`
6. Test: `launchctl kickstart -k gui/$(id -u)/com.lab.schedule.<name>`, then read `~/Library/Logs/lab-dispatcher/schedule-<name>.log` and check the check turned green.
7. Update the schedule table in `jobs/README.md`.
