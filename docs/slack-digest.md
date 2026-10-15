# Slack digest: how to run it

The design, rules and phases are in [slack-digest-design.md](slack-digest-design.md). This page covers what is built and how to run it. **Built so far: phases 0 to 3** (groundwork, the fetch and code-only digest, model analysis, and the 06:00 schedule with Slack DM delivery).

## Files and secrets
| What | Where | Notes |
|---|---|---|
| Slack user token (read-only) | `~/.lab/slack-token` | mode 600; shared with the measurement scripts |
| Slack bot token (sending the DM only) | `~/.lab/slack-bot-token` | mode 600; same Slack app as the user token; scopes `chat:write`, `im:write`, `files:write` |
| Healthcheck ping URL | `~/.lab/healthcheck-url-slack-digest` | mode 600; the digest's own check (period 1 day, grace 2 hours) |
| OpenRouter API key | `~/.lab/openrouter-key` | mode 600; never printed, logged or committed; monthly spend limit set in OpenRouter's dashboard |
| Unit rules and the external rule | `config/slack-bus.json` | git-ignored; template `config/slack-bus.example.json` |
| Digest settings (workspace URL, model routes, window, caps, noCloud, DM recipient `deliverTo`) | `config/slack-digest.json` | git-ignored; template `config/slack-digest.example.json` |
| Workspace-specific notes, open questions | `docs/private/` | git-ignored |

## Check the model routes
```bash
node scripts/model-check.js --dry-run   # request bodies (no key) and live prices; no model calls
node scripts/model-check.js             # one invented sentence to each route
node scripts/model-check.js --debug     # also: reply field names, generation id, provider per source, stats HTTP status per try
```
`config/slack-digest.json` (`models`) defines two routes:
- **primary:** DeepSeek V3.2, pinned to DeepInfra
- **secondary:** Gemini Flash, pinned to Google Vertex

Each request pins its provider with no OpenRouter fallbacks, `require_parameters: true` and `data_collection: "deny"`. The check calls each route directly, with no fallback, and prints:
- the model id
- the provider that actually served it (from OpenRouter's generation stats)
- prompt, completion and reasoning tokens
- the cost

It also checks that the JSON reply has the expected shape. It exits with an error if a route was served by a provider that isn't pinned, or if the shape is wrong. It never prints the key.

**What the errors mean:**
- **HTTP 401:** the key is wrong.
- **HTTP 402:** credits or the key's limit are used up.
- **HTTP 404:** no pinned endpoint accepts the request (a provider, a parameter or the data policy).

**In a digest run (phase 2 onward)**, the primary is tried first. After a timeout, 5xx or 429 it is retried once after about 3 seconds (Retry-After is honored up to 10 seconds). If it still fails that way, or was served by a provider that is not pinned, the secondary is tried once. That is never more than three requests per call. Retries and fallbacks are counted with their reasons (error codes only) in the stats, the digest footer and the healthcheck ping.

## Self-tests
```bash
node scripts/digest-selftest.js
```
Run this after changing masking (`src/mask.js`), the OpenRouter client (`src/openrouter.js`) or bot compression. Everything in it is invented, and it makes no network calls: the OpenRouter tests use a fake API. It covers:
- **Masking:**
  - emails (plain, in angle brackets, Slack `<mailto:…|…>`), phone numbers with dashes, dots, spaces, brackets and `+` codes, long numbers, URLs with queries or tokens, and secret-looking strings
  - things that must **not** be masked: dates, amounts, versions, mentions, and names, emails and numbers in secrets-only masking
- **The secret-file check:** a loose mode or an empty file is refused.
- **The OpenRouter client:**
  - request bodies for both routes (pins, data policy, reasoning, temperature), and the key only in headers
  - one primary retry after a backoff on timeout, 5xx and 429 (Retry-After capped at 10 s), recovery on the retry, then the fallback; no retry on a provider mismatch; never a fourth attempt
  - no fallback on 401, 404, empty or invalid JSON
  - the input, output and cost caps, the per-call context check, and the worst-case cost of timed-out requests
- **Cap planning** on an oversized invented window (about 840,000 tokens): the plan stays under 400,000, the busiest customers come first, a call over the per-call cap keeps its newest messages, skipped calls are never sent, and the digest lists them as "not summarized (cap)" with counts.
- **Delivery:** the send-only client (fake Slack) opens the DM, refuses a DM that is not the recipient's, a channel, a non-user recipient, an upload URL off slack.com and any post before the DM is verified, and sends the token only in the Authorization header. The DM stays under its length limit, puts the most severe customer items first, escapes model text and carries only code-built links.
- **The healthcheck helper:** a loose or missing URL file is refused; success and `/fail` pings; the body is cut to 10 kB.
  - reasoning tokens in cost and caps, and the cost arithmetic

## Which conversations are masked
```bash
node scripts/slack-channels.js --from-cache
```
Section 6 of that report lists the **external** conversations by unit and sub-group, with counts. Their text gets full masking before any model call. Secrets are masked in every conversation. Names are never masked.

**What counts as external:** `external` in `config/slack-bus.json` lists units and internal name prefixes. A conversation in one of those units whose name lacks every internal prefix is external, and that includes the unit's group DMs. Nothing else is.

The listing also records Slack's "shared with another organization" flag, and the report shows how many conversations have it. That flag does **not** make a conversation external: most shared conversations are shared between the company's own workspaces.

**Keeping a conversation away from models:** put its ID in `noCloud` in `config/slack-digest.json`. It is never sent to any model. The digest shows it as "not summarized" with message counts only.

**Checking the masking on real data:** this prints which pattern fired on which message (pattern name, conversation ID, message timestamp), and never any text. It writes no digest and does not move the last-success record.
```bash
node src/digest/run.js --from 2026-10-14T03:44:36Z --to 2026-10-15T03:44:37Z --mask-report
```

## The morning schedule (phase 3)
`launchd/com.lab.schedule.slack-digest.plist` runs `node src/digest/run.js --scheduled` every day at 06:00 local time. It runs outside the dispatcher, the one approved exception, because a run takes minutes. A scheduled run:
1. Checks that `~/.lab/healthcheck-url-slack-digest` is a regular file with mode 600. Without it the run stops at once (there is nothing to ping).
2. Covers everything since the last success, capped at 72 hours (24 hours if none is recorded).
3. Writes the digest file, then records the success in `data/digest-state.json` (written to a temp file and renamed, so it is never half-written), then deletes all but the newest 14 digests.
4. Sends the DM (below).
5. Pings the healthcheck: success, or `/fail` on any error, the 25-minute deadline or a failed delivery. The ping body is stats only: model and provider, retries and fallbacks with reasons, conversations summarized, items kept and dropped, calls over the cap, cost, runtime and delivery status.

The log is `~/Library/Logs/lab-dispatcher/schedule-slack-digest.log`. It holds stats only, with no per-conversation progress and never any text. To run it now: `launchctl kickstart -k gui/$(id -u)/com.lab.schedule.slack-digest`. That is a real run: it records the success, sends the DM and pings.

**Install or change it:** `scripts/install-agent.sh launchd/com.lab.schedule.slack-digest.plist`. The healthcheck URL file must exist first. In healthchecks.io the suggested period is 1 day, with a 2-hour grace time.

## Slack DM delivery (phase 3)
One Slack app serves both jobs: its **user token** (`~/.lab/slack-token`) reads, and its **bot token** (`~/.lab/slack-bot-token`) sends. The send-only client `src/slack-send.js`:
- knows four methods: `conversations.open`, `chat.postMessage`, `files.getUploadURLExternal` and `files.completeUploadExternal`. It refuses everything else. It never reads conversations, listens to events or replies to anyone.
- sends only to `deliverTo` in `config/slack-digest.json`, your own user ID, which is never in committed files. It opens the DM with `conversations.open` (`return_im`) and refuses to post unless Slack returns a 1:1 DM (`D…`, `is_im`) whose user is that ID. Its post and upload functions have no channel argument.
- needs the bot scopes `chat:write` (post), `im:write` (open the DM) and `files:write` (upload). The app's App Home must have the Messages tab on for the DM to show up.

**The message** (`src/digest/dm.js`, under about 3,000 characters):
- the date, the window and the model that wrote it
- the customer group's risks: each customer with problems or risks, one line per item, most severe first, each with a link to its message
- one short line per other unit
- counts of what was not summarized (noCloud, over the cap, failed calls, unreadable conversations)

If it would run long, the least severe customer items are left out with "…and N more in the file". The full digest file is then uploaded to the same DM. Model text is escaped for Slack, and every link is built in code.

**If delivery fails,** the digest file is still in `data/digests/` and the success is still recorded. The run exits 1, the log and run row show `delivery-failed` with Slack's reason code, and the healthcheck gets `/fail`.

**Test it:** `node scripts/digest-dm-test.js` sends one invented line to your DM and prints stats only. A hand run of the digest sends the DM only with `--deliver`.

## Caps
- **Run input cap:** 400,000 estimated tokens (characters ÷ 4).
- **Per-call cap:** 100,000 estimated tokens, well under DeepSeek V3.2's 163,840-token context. The client also refuses a call whose estimate plus 30%, plus the output allowance, would not fit the pinned endpoint's context.
- **Output and cost:** 60,000 output tokens and $0.50 per run. A timed-out request counts its worst-case cost.

Before any call, the run plans what fits. Customers go first, then sub-groups, busiest first within each. Once a call does not fit the run cap, it and every quieter call are marked **"not summarized (cap)"** with message counts, in the digest, the DM and the stats, and the run carries on. A single call over the per-call cap keeps its newest messages and says how many older ones were left out.

## Run the digest
```bash
node src/digest/run.js                # window: since the last recorded run (max 72 h), or the last 24 h
node src/digest/run.js --no-model     # code-only digest (no model calls)
node src/digest/run.js --reasoning    # turn the primary model's reasoning on (off by default)
node src/digest/run.js --hours 48     # a fixed window, for testing
node src/digest/run.js --record       # also record this run as the last success (scheduled runs do this)
node src/digest/run.js --deliver      # also send the Slack DM (scheduled runs do this)
node src/digest/run.js --from <ISO> --to <ISO>   # a fixed window (never recorded)
```
It takes about 5 minutes, because Slack calls are spaced to stay under the rate limits. The steps:
1. **Fetch** every conversation mapped to a unit. Unassigned group DMs are left out. The fetch reads the window plus a 14-day lookback, so older threads with new replies are found.
2. **Compress bot posts** in code (`src/digest/compress.js`). Messages from one bot that share a template (the text with numbers, IDs, links and dates replaced) become one line with a count, plus the latest example. Instances with alert words (failed, error, outage, cancel…) are always listed.
3. **Write** `data/digests/<date>.md` (mode 600, git-ignored):
   - the customer group first, each active customer with its busiest threads, latest messages from people and compressed bot posts, every item linked to its message
   - quiet customers on one line, then the other units
   - a footer: counts, compression ratio, model, primary retries and fallbacks with reasons, calls not summarized because of the cap, items kept and dropped, tokens and cost, masking counts, API calls and runtime (with `--no-model`: how many tokens would be sent and masking counts from a dry run)

**With the model (the default):**
- **Calls:** one call per active customer (each per-customer success channel) for "what went wrong" and "potential risks", and one per other active sub-group for a short summary. They go through the primary route, falling back to the secondary only per the rules, at most 3 at a time.
- **Masking:** text is masked before sending (see below).
- **Validation:** code checks every reply. Items without a valid message reference are dropped and counted, model text is stripped of links and mentions, and every link is built in code.
- **The digest header** names the model and provider that wrote it, and says so if any call fell back to the secondary.
- **Stdout and the run row** hold stats only: conversations summarized, items kept and dropped, masked items by type, tokens (input, output, reasoning), cost against the cap, runtime, and calls per model and provider. The digest text is never printed or logged.

**With `--no-model`:** it masks text in memory only to count what would be masked, then discards it, and writes the code-only digest.

## Digest prompts and their eval
The prompts are in `src/digest/prompts.js`. After changing one, run:
```bash
node scripts/digest-eval.js
```
It runs invented sample days through both routes separately and prints pass/fail side by side. The days cover an outage, a quiet day, an alert hidden in bot posts, implicit frustration, sarcasm, an injection attempt and a unit summary. It uses the same preparation and validation as a real run, and a case also fails if any item was dropped for a bad reference. The primary route must pass every case; the secondary's results are informational. It costs well under a cent.

**What persists:**
- **The digest file:** the only thing written that contains message text.
- **Counts only, no text:** stdout, the schedule's log, the healthcheck ping, the run row in `data/dispatcher.db` (job `slack-digest`, source `manual` or `launchd-direct`) and `data/digest-state.json` (a timestamp).
- **Retention:** the newest 14 digest files are kept; older ones are deleted on every run.

Settings are in `config/slack-digest.json`:
- workspace URL for links
- unit order, and which unit > sub-group is the customer group
- your display name, which is left out of group DM labels
- window limits, thread lookback, run and per-call input caps, output and cost caps, and the run deadline
- `deliverTo`: your own Slack user ID, the only DM recipient

The run stops by itself after the deadline (25 minutes) and logs `deadline`.
