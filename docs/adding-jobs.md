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

## Use the LLM helper in a job
`src/llm.js` lets a job hand a small text task to the local model (Ollama, `qwen2.5:7b`, on this Mac). The text never leaves the machine. Pipe the text in on stdin and read the result from stdout:
```sh
HELPER="$(dirname "$0")/../src/llm.js"
LABEL=$(printf '%s' "$TEXT" | node "$HELPER" classify --label "urgent=needs action today" --label "fyi=no action needed") || exit 1
FIELDS=$(printf '%s' "$TEXT" | node "$HELPER" extract --fields vendor,amount,due_date)   # one-line JSON, null if not stated
SUMMARY=$(printf '%s' "$TEXT" | node "$HELPER" summarize-short)                         # 1-3 sentences
```

| Task | Options | Prints |
|---|---|---|
| `classify` | `--labels a,b,c` or repeated `--label name=description` (2-20 labels) | exactly one of the labels |
| `extract` | `--fields a,b,c` (1-20 names, lowercase and `_`) | one-line JSON with every field, `null` when not in the text |
| `summarize-short` | none | 1-3 plain sentences |
| anything else | | error `needs cloud model` (exit 3); no cloud API key is set up yet |

All tasks accept `--timeout <seconds>` (default and maximum 50). Exit codes: `0` ok, `2` bad usage or input, `3` needs cloud model, `4` model error or timeout. Errors go to stderr.

Things to know:
- **Give classify labels descriptions.** Bare names like `reply` are ambiguous to a 7B model; `--label "reply=needs a personal response, but not today"` fixes most mistakes.
- **It is slow (~12 tokens/sec), so outputs are short by design.** A warm call takes about 1 s (classify) to 5 s (summarize); the first call after the model unloads adds a few seconds to load it. Several calls in one job share the 60 s job limit, so pass a shrinking `--timeout` (see `jobs/llm-test.sh`).
- **Input is capped at 8,000 characters** and rejected, not cut, above that. Trim it in the job first.
- **Never print the input text** (or secrets) from the job. Whatever the job prints is stored in the dispatcher's run log.
- After editing a template in `src/llm-prompts.js`, run `node scripts/llm-eval.js` and add a case for the behavior you changed.
