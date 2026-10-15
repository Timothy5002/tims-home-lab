# Jobs

Each `<name>.sh` in this folder is a job the dispatcher can run via `POST /run/<name>`. Nothing outside this folder can be run. To add one, follow [../docs/adding-jobs.md](../docs/adding-jobs.md).

Rules: lowercase letters, digits and hyphens in the name; executable (`chmod +x`); no arguments or request data; exit 0 on success; finish within 60 seconds.

| Job | What it does | Scheduled |
|---|---|---|
| `hello` | Prints a greeting with the hostname and time; proves the pipeline works | Daily 06:00 (`com.lab.schedule.hello`) |
| `disk-check` | Reports free space on the internal drive and the 5 largest folders in the home folder; exits 1 (so healthchecks.io gets `/fail`) when free space is under 25% or under 40 GB | Daily 07:00 (`com.lab.schedule.disk-check`) |
| `llm-test` | Classifies four made-up sample emails (urgent / reply / fyi / noise) with the LLM helper; proves Ollama works end to end | No (on demand) |

**Not a job, but on a schedule:** the Slack digest (`src/digest/run.js --scheduled`) runs daily at 06:00 from its own agent, `com.lab.schedule.slack-digest`, outside the dispatcher (approved exception; a run takes minutes). It pings its own healthchecks.io check. See [../docs/slack-digest.md](../docs/slack-digest.md).
