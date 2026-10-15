# Slack digest: design and build plan

**Status.** Phases 0 and 1 are approved; later phases are not. Each later phase is built only after the user approves it.

**Workspace details live elsewhere.** This doc names no real channels, business units or people. Those details, plus the open questions, are in `docs/private/` (git-ignored), and the rules themselves are in `config/` (git-ignored, with tracked examples).

## What it is for
Every morning, one digest of the user's Slack, grouped by business unit and sub-group (the rules in `config/slack-bus.json`). The most important part is the **customer-success unit**. It has one success channel per customer, plus external channels shared with customers, and there are too many to keep up with.

For each of that unit's customers with activity since the last digest, the digest shows **what went wrong** and **potential risks**. Every item links to the Slack message it came from. Customers with nothing notable collapse to one line, and other units get a short summary.

**Sizing** comes from `scripts/slack-measure.js` over 7 days:
- Assigned conversations averaged about **43,000 tokens/day** and peaked at **61,000**.
- The customer-success unit was 85% of that, and its per-customer success channels 69%.
- Bots wrote 54% of all characters.
- The local 7B model would need about 20 minutes and 23 to 33 calls a day, and is too weak for this kind of judgment, so judgment steps use a cloud model (DeepSeek), approved by the user.

## Hard rules (every phase)
1. **Slack is read-only.**
   - The reader uses the existing user token (`~/.lab/slack-token`) and its fixed list of read methods. Its scopes are not widened, and it never writes.
   - Delivery by DM (phase 6) uses a separate Slack app with its own token.
2. **Message text is untrusted data.**
   - The model gets no tools. Its system prompt says messages are data to analyze, never instructions.
   - Messages are sent as JSON-escaped fields.
   - Output is JSON or plain text, checked against a schema in code.
3. **No evidence, no claim.**
   - The model cites short references (`m017`) and never writes links. Code checks every reference against the messages it sent, drops claims with no valid reference, and builds the Slack link itself.
   - Where quotes are required, code checks that each quote is an exact part of the **masked** text the model saw. The link still points to the original message.
4. **Masking before any model call** (external conversations only; see below).
5. **Retention.**
   - Message text lives only in the process's memory until the digest is written. There are no temp files.
   - Logs, the SQLite run row and cost records hold counts, token usage, cost, durations and error codes, never text (masked or original).
   - Only the digest persists: `data/digests/<date>.md`, mode 600, git-ignored.
   - Text sent to the cloud model is also kept by the provider under its own terms.
6. **No real Slack text goes to any model until phase 2 is approved.** Phases 0 and 1 use invented text for every model call. Phase 1 makes no model calls at all.
7. **Secrets.** The DeepSeek key is read only from `~/.lab/deepseek-key`, with mode 600 enforced. It goes only in the `Authorization` header, never on a command line, in an env var, in a log or in the repo.
8. **Evals before trust.** No prompt is trusted until `scripts/digest-eval.js` passes on labeled, invented sample days. Every prompt change re-runs it.

## Masking
**Which conversations are masked.** A conversation is **external** if either rule says so:
- **Rule 1 (configured):** it belongs to a unit listed in the config's external units, and its name does not start with one of that unit's internal prefixes. This covers the unit's group DMs too, since their names never start with the prefix.
- **Rule 2 (Slack's own flag):** Slack marks it as externally shared (`is_ext_shared`, used by Slack Connect). The channel listing records this field from now on. Listings made before that change do not have it, so rule 2 applies only after the next listing. No extra Slack call is made.

The flag is derived by code from the config and the listing; it is not stored by hand. `node scripts/slack-channels.js --from-cache` prints which conversations are external and why.

**What is masked**, in code, in external conversations, before any text is sent to a model:

| Found | Replaced with |
|---|---|
| Email addresses, including `<a@b.com>` and Slack's `<mailto:a@b.com\|label>` markup | `[email]` |
| Phone numbers, including spaces, dots, dashes, brackets and `+` country codes | `[phone]` |
| Runs of 6 or more digits | `[number]` |
| URLs with a query string, or with a token-like path segment | `[url]` (plain URLs without either are kept) |
| Secret-looking strings: `sk-…`, `xox…`, `ghp_…`, AWS key IDs, JWTs, long hex or base64 | `[secret]` |

- Each run keeps a count of masked items by type. Neither the masked nor the original text is logged or stored.
- `scripts/digest-selftest.js` tests masking with invented examples.

## Model and provider
Checked against DeepSeek's documentation on 2026-10-14 ([pricing](https://api-docs.deepseek.com/quick_start/pricing), [change log](https://api-docs.deepseek.com/updates), [thinking mode](https://api-docs.deepseek.com/guides/thinking_mode), [JSON output](https://api-docs.deepseek.com/guides/json_mode)):

- **Model: `deepseek-flash` (DeepSeek-V4.1-Flash).** The originally planned `deepseek-chat` (V3.2) was discontinued on 2026-07-24. `scripts/deepseek-check.js` confirms the exact id with a live call on invented text.
- **Endpoint:** `POST https://api.deepseek.com/chat/completions` (OpenAI format), with `Authorization: Bearer <key>`. The host is hardcoded.
- **Thinking mode is off by default** (`"thinking": {"type": "disabled"}`), with a flag to turn it on. Thinking mode ignores `temperature` and is billed for reasoning tokens.
- **JSON output** uses `"response_format": {"type": "json_object"}`.
  - The prompt must mention "json" and show an example of the shape.
  - `max_tokens` must be high enough that the JSON is not cut off.
  - The docs warn of occasional empty replies, so an empty or invalid reply is a retryable failure.
- **Prices (USD per million tokens), checked 2026-10-14:**

  | `deepseek-flash` | off-peak | peak |
  |---|---|---|
  | input, cache hit | 0.003 | 0.006 |
  | input, cache miss | 0.15 | 0.30 |
  | output | 0.60 | 1.20 |

  Peak is weekdays 01:00 to 04:00 and 06:00 to 10:00 UTC, except Chinese public holidays. The run is at 06:00 on this Mac, which is US Central (11:00 or 12:00 UTC), so it is always **off-peak**. The price table lives in code with its check date, and each run logs which rate applied.
- **Expected cost:** roughly $0.01 to $0.02 per day off-peak, under $1 a month. Phase 2 measures the real figure.
- **Code:** `src/deepseek.js`, built on Node's built-in `fetch` with no SDK and no new dependency. `src/llm.js` stays local-only.

## How it runs
A run fetches about 180 conversations (Slack calls spaced 1.3 s apart) and then makes model calls. That is far over the dispatcher's 60-second job limit.

**Approved: a standalone launchd schedule** (`com.lab.schedule.slack-digest`, phase 3) that runs `node src/digest/run.js --scheduled` directly. This is a recorded exception to "schedules call the dispatcher"; see `docs/decisions.md`. The script:
- pings its own healthchecks.io check: success, or `/fail` on any failure, abort or deadline. The URL comes from `~/.lab/healthcheck-url-slack-digest`, which the user creates before the schedule is installed. Suggested period 1 day, grace 2 hours.
- writes one row to the `runs` table in `data/dispatcher.db`. The source is `launchd-direct`, or `manual` for hand runs, and the row holds counts and cost only.
- enforces its own deadline of 25 minutes. It is a single process and starts no children.

**Window.** Each run covers everything since the last successful scheduled run, capped at 72 hours, so Mondays and missed days are covered. The time of the last success is kept in `data/digest-state.json`, which holds a timestamp only. With no recorded run, the window is the last 24 hours. Hand runs never move that timestamp unless asked to.

## Pipeline
1. **Plan.** Load the config and the saved channel list. Take every conversation mapped to a unit, decide the window, and derive the external flag.
2. **Fetch** with the shared read-only client (`src/slack.js`):
   - history for the window, plus a 14-day thread lookback to find older threads with new replies, then those replies.
   - Each message keeps: conversation, `ts`, thread, author, a bot flag and text (message text plus attachment text). Housekeeping events (joins, topic changes and similar) are skipped.
3. **Compress bot posts** (code only, `src/digest/compress.js`):
   - Group bot messages by bot and by template. The template is the text with numbers, IDs, URLs, emails and dates replaced by placeholders.
   - Per template, keep the first and the latest example (cut to 300 characters), plus a count.
   - Always keep up to 5 instances containing alert words (error, failed, down, outage, escalate, urgent, cancel, refund, churn, complaint and similar).
   - The compression ratio is reported every run.
4. **Group** by unit and sub-group. In the customer-success unit, each per-customer success channel is its own block. Phase 4 widens a block to all of that customer's channels.
5. **Budget check.** Estimate input tokens (characters ÷ 4) before any model call, and abort if over the per-run cap.
6. **Mask** external text (phase 2 onward). Phase 1 runs the masking on the would-be input and reports counts only.
7. **Model calls** (phase 2 onward):
   - one JSON call per active customer (risk extraction)
   - one per other unit (short summary)
   - at most 3 at a time, each with a timeout and retries
8. **Validate** replies against their schema and drop claims with invalid references. Sanitize model text by removing URLs, `<@…>`, `<!channel>`, `<!here>` and link syntax, so links only come from code and a crafted message cannot make the digest mention or link anyone.
9. **Render** `data/digests/<date>.md` (mode 600). Order:
   1. customer blocks (by health once phase 4 exists)
   2. other units
   3. a one-line list of quiet customers
   4. a footer with counts, masking counts, tokens, cost and runtime
10. **Finish.** Drop all text, write the run row, and ping the healthcheck when scheduled.

**Links** are built in code from the workspace URL in `config/slack-digest.json`: `<workspace>/archives/<channel>/p<ts without the dot>`. Thread replies add `?thread_ts=<parent>&cid=<channel>`.

## Risk extraction (phase 2, not yet approved)
**Input, per customer:** the masked messages from the window, compressed, with references, author names and times.

**Output (JSON, temperature 0.1, about 1,500 output tokens at most):**
```json
{ "customer": "acme",
  "went_wrong": [ { "summary": "Calls dropped for 2 hours after the 9am change", "severity": "high", "refs": ["m004", "m009"] } ],
  "risks":      [ { "summary": "Customer asked about cancelling if it happens again", "likelihood": "medium", "refs": ["m011"] } ],
  "notable": true }
```
- `went_wrong` and `risks` each hold up to 5 items, with summaries of at most 200 characters.
- `notable: false` collapses the customer into the quiet line.

**Eval (`scripts/digest-eval.js`).** Invented sample days, committed with the script, covering:
- an outage
- a quiet day
- bot spam with one real alert hidden in it
- a frustrated customer who never says so outright
- sarcasm
- an injection attempt
- a tempting claim with no source

It checks the `notable` flags, the expected issues, that every reference is valid, and that the injection is ignored.

## Customer registry (phase 4, not yet approved)
- **`config/digest-customers.json`** (git-ignored, with a tracked example). For each customer: name, aliases, success channel, external channels and owner.
- **Seeding is code:** proposed entries are matched from channel names, and the user confirms them.
- **Health** is runtime state in `data/digest-health.json`, set with `node scripts/digest-customers.js set-health <customer> red|yellow|green [--note "..."]`.
- **Ordering:** Red customers are listed first.

## Leadership-contradiction check (phase 5, not yet approved)
1. **Find candidate pairs in code.** Take messages in the unit's leadership channels from configured people that mention a registered customer. Pair each with that customer's success-channel messages, over the window plus a short lookback.
2. **Ask the model** for conflicts, each with both references and both quotes.
3. **Verify in code.** Keep a conflict only if both quotes are exact parts of the masked text the model saw. Each kept conflict is shown as "**Possible conflict, verify**" with both links.
4. **Test** against real past cases the user supplies, plus invented near-misses that must not be flagged.

## Delivery by Slack DM (phase 6, not yet approved)
- **A separate Slack app.** Its bot token has only `chat:write` and is stored at `~/.lab/slack-bot-token` (mode 600).
- **One method only:** the delivery client knows only `chat.postMessage`, and code refuses every channel except the user's own ID (from git-ignored config).
- **The file stays the record:** the digest is split under Slack's size limits, and the file is still written.
- **Manual steps for the user:** creating and installing the app happen in Slack's web UI.

## Cost controls
| Control | Value |
|---|---|
| Per-run input cap (estimated tokens) | 122,000, which is 2× the measured peak. Over it, the run aborts before any model call |
| Output cap per call | about 1,500 tokens per customer, about 800 per unit summary |
| Timeout per model call | 90 s |
| Retries | 3, with exponential backoff and jitter, on 429 (honoring `Retry-After`), 5xx, network errors and empty or invalid JSON |
| Run deadline | 25 min |
| Concurrency | at most 3 model calls |
| Month-to-date spend cap | to be decided |
| Logged per run (no text) | conversations, messages, characters, compression ratio, masked items by type, model calls, retries, input tokens (cache hit and miss), output tokens, estimated cost, rate, runtime, dropped claims |

## Phases
| # | Phase | Status | What it tests |
|---|---|---|---|
| 0 | **Groundwork.** Shared Slack client in `src/`, `src/deepseek.js` (key check, no tools, JSON mode, thinking flag, timeouts, retries, usage and cost, input cap), masking, external flag | approved | A live call on **invented** text confirms the model id and logs usage and cost. Self-tests with invented data cover masking and every guard: loose key file, over-cap input, timeout, 429, empty JSON |
| 1 | **Fetch, bot compression, code-only digest** (no model calls) | approved | Fetch runtime; compression ratio; masking counts on the would-be input; nothing but the digest on disk; links open the right messages |
| 2 | **Risk extraction and unit summaries**, plus `scripts/digest-eval.js` | needs approval and the data-sharing answer | Eval passes; every claim has a valid reference; the injection is ignored; real cost |
| 3 | **Morning schedule** (standalone launchd) | needs approval and a new healthchecks.io URL | `kickstart` run, both healthcheck pings, run row |
| 4 | **Customer registry and health** | needs approval | Blocks draw from all of a customer's channels; Red first |
| 5 | **Leadership-contradiction check** | needs approval and the past cases | Real cases flagged with verified quotes; near-misses not flagged |
| 6 | **Slack DM delivery** (separate app) | needs approval and the app | DMs reach only the user; other targets are refused |

## Files
- **Code:** `src/slack.js` (shared read-only Slack client and unit rules), `src/secrets.js`, `src/deepseek.js`, `src/mask.js`, `src/digest/` (run, fetch, compress, render)
- **Scripts:** `scripts/deepseek-check.js`, `scripts/digest-selftest.js`, later `scripts/digest-eval.js` and `scripts/digest-customers.js`
- **Config:** `config/slack-digest.example.json` (workspace URL, caps), `config/slack-bus.example.json` (unit rules and external rule)
- **Docs:** this file, `docs/slack-digest.md` (how to run it), `docs/decisions.md`, README, CLAUDE.md
