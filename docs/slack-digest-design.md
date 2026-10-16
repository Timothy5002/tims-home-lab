# Slack digest: design and build plan

**Status.** Phases 0, 1, 2 and 3 are built, and so is the **redesign** that followed them: the customer registry, per-customer synthesis with Leadership mentions, noise rules, unit modes, and a two-part DM (top-level message and one thread reply, no file). Phase 3 includes Slack DM delivery, which was first planned as phase 6. How it runs: `docs/slack-digest.md`. Later phases are built only after the user approves each one.

**Workspace details live elsewhere.** This doc names no real channels, business units or people. Those details, plus the open questions, are in `docs/private/` (git-ignored), and the rules themselves are in `config/` (git-ignored, with tracked examples).

## What it is for
Every morning, one digest of the user's Slack, grouped by business unit and sub-group (the rules in `config/slack-bus.json`). The most important part is the **customer-success unit**. It has one success channel per customer, plus external channels shared with customers, and there are too many to keep up with.

For each of that unit's customers with activity since the last digest, the digest shows **what went wrong** and **potential risks**. Every item links to the Slack message it came from. Customers with nothing notable collapse to one line, and other units get a short summary.

**Sizing** comes from `scripts/slack-measure.js` over 7 days:
- Assigned conversations averaged about **43,000 tokens/day** and peaked at **61,000**.
- The customer-success unit was 85% of that, and its per-customer success channels 69%.
- Bots wrote 54% of all characters.
- The local 7B model would need about 20 minutes and 23 to 33 calls a day, and is too weak for this kind of judgment, so judgment steps use a cloud model through OpenRouter, approved by the user.

## Hard rules (every phase)
1. **Slack is read-only.**
   - The reader uses the existing user token (`~/.lab/slack-token`) and its fixed list of read methods. Its scopes are not widened, and it never writes.
   - Delivery by DM (built in phase 3) uses the **same Slack app's bot token** (`~/.lab/slack-bot-token`), in a separate send-only client, `src/slack-send.js`. That client never reads, never uploads, and can post only into the verified DM with the configured user, plus one reply under its own message (user decision; a separate app was the earlier plan).
2. **Message text is untrusted data.**
   - The model gets no tools. Its system prompt says messages are data to analyze, never instructions.
   - Messages are sent as JSON-escaped fields.
   - Output is JSON or plain text, checked against a schema in code.
3. **No evidence, no claim.**
   - The model cites short references (`m017`) and never writes links. Code checks every reference against the messages it sent, drops claims with no valid reference, and builds the Slack link itself.
   - Where quotes are required, code checks that each quote is an exact part of the **masked** text the model saw. The link still points to the original message.
4. **Masking before any model call.** Secrets are masked in every conversation; the full masking applies to external conversations (see below). Names are never masked.
5. **Retention.**
   - Message text lives only in the process's memory until the digest is written. There are no temp files.
   - Logs, the SQLite run row and cost records hold counts, token usage, cost, durations and error codes, never text (masked or original).
   - Only the digest persists: `data/digests/<date>.md`, mode 600, git-ignored.
   - Requests ask OpenRouter for providers that do not store data (`data_collection: "deny"`).
6. **No real Slack text goes to any model until phase 2 is approved.** Phases 0 and 1 use invented text for every model call. Phase 1 makes no model calls at all. A configurable `noCloud` list names conversations that are never sent to any model; the digest shows them as "not summarized" with counts only.
7. **Secrets.** The OpenRouter key is read only from `~/.lab/openrouter-key`, with mode 600 enforced. It goes only in the `Authorization` header, never on a command line, in an env var, in a log or in the repo. A monthly spend limit is set on the key in OpenRouter's dashboard.
8. **Evals before trust.** No prompt is trusted until `scripts/digest-eval.js` passes on labeled, invented sample days. Every prompt change re-runs it.

## Masking
**Data-sharing decision (recorded by the user).** Slack text may go to the pinned providers below, names included.
- **Internal conversations go unmasked**, except for secrets. Internal means the customer unit's conversations whose names start with one of its internal prefixes (the per-customer success channels, and its own Leadership and internal channels) and every conversation in every other unit.
- **External conversations get the full masking.** A conversation is external when it belongs to a unit listed in the config's external units **and** its name does not start with one of that unit's internal prefixes (`external` in `config/slack-bus.json`). This covers the unit's group DMs too. Nothing outside those units is external.
- **Slack's shared flag is not used.** The channel listing records `is_ext_shared` (Slack Connect) for reference, but most shared conversations here are shared between the company's own workspaces, so the user decided that the flag alone does not make a conversation external.
- **Secrets are masked in every conversation**, internal ones included, and counted per run.

The external flag is derived by code from the config and the listing; it is not stored by hand. `node scripts/slack-channels.js --from-cache` prints which conversations are external.

**What is masked** (in code, before any text is sent to a model):

| Found | Replaced with | Where |
|---|---|---|
| Secret-looking strings: `sk-…`, `xox…`, `ghp_…`, AWS key IDs, JWTs, long hex or base64 | `[secret]` | every conversation |
| Email addresses, including `<a@b.com>` and Slack's `<mailto:a@b.com\|label>` markup | `[email]` | external |
| Phone numbers, including spaces, dots, dashes, brackets and `+` country codes | `[phone]` | external |
| Runs of 6 or more digits | `[number]` | external |
| URLs with a query string, or with a token-like path segment (plain URLs are kept) | `[url]` | external |

- **Names are never masked.**
- **Counting:** each run counts masked items by type. Neither the masked nor the original text is logged or stored.
- **Testing:** `scripts/digest-selftest.js` tests masking with invented examples. `node src/digest/run.js --from … --to … --mask-report` lists which pattern fired on which message (pattern name, conversation ID and message time, never text) to check for false positives.

## Model and provider
The digest calls models through **OpenRouter's OpenAI-compatible API** (`POST https://openrouter.ai/api/v1/chat/completions`, host hardcoded) from `src/openrouter.js`. That client is plain `fetch`, with no SDK and no new dependency. `src/llm.js` stays local-only.

**Two routes**, both in `config/slack-digest.json` (`models`), each **pinned to its own provider**:

| Route | Model | Pinned provider | Reasoning |
|---|---|---|---|
| primary | `deepseek/deepseek-v3.2` | DeepInfra | off by default (`reasoning.enabled: false`); a flag turns it on |
| secondary | `google/gemini-3.8-flash` | Google Vertex (standard endpoint) | cannot be turned off; uses the lowest level (`reasoning.effort: "low"`) |

**Every request** carries `provider: { order, only, allow_fallbacks: false, require_parameters: true, data_collection: "deny" }`, so OpenRouter never routes to another provider, to one that ignores a parameter such as `response_format`, or to one that may store data. It also uses JSON mode (`response_format: {type: "json_object"}`) and has no tools. Temperature (0.1) is sent only where the pinned endpoint accepts it and reasoning is off.

**Fallback, in code, never by OpenRouter:**
1. Try the primary.
2. On a timeout, a 5xx or a 429, wait about 3 s (Retry-After is honored, up to 10 s) plus up to 1 s of random jitter, and retry the primary **once** (user decision, phase 3).
3. If it still fails that way, or a reply was served by a provider that is not pinned, try the secondary **once**. That is at most three requests per call, and never two models in one request. Retry and fallback reasons are counted as error codes.
4. Anything else fails the call: auth, out of credit, no endpoint fits the pins or data policy, a call too big for the context, an empty or invalid reply.

Fallbacks should be rare. A digest written by the secondary can read differently, and that is accepted.

**Served-provider check.** Two sources: the reply's own `provider` field, and OpenRouter's generation stats (`GET /api/v1/generation?id=…`), which take about 15 s to appear. At least one source must name a provider, and every source that names one must name a pinned provider. Anything else, including no answer from either source, counts as a mismatch. In a digest run the reply's field is checked per call (a non-pinned name falls back at once), and the stats are read for a whole stage in one batch, concurrently, with one wait of up to about 30 s; a primary reply that fails the batch check is discarded and its call is sent once to the secondary, which must pass too. The model check and the eval check each call on its own, waiting up to about 30 s.

**What is logged and shown:**
- **Per run, no text:** which model and provider served each call.
- **In the digest:** the header names the model that wrote it.
- **In the digest footer and the healthcheck ping:** retries and fallbacks, with their reasons (error codes only).

**Cost** comes from OpenRouter: the generation's total cost. When it is missing, it is computed from **live per-token prices** that the client reads from OpenRouter's public endpoint list (`/api/v1/models/<model>/endpoints`) for the pinned endpoints. Reasoning tokens count as output for both cost and the output cap. There is no time-of-day pricing logic: the pinned endpoints report flat prices. If a pinned slug could also match dearer tiers of the same provider, the per-run cost cap assumes the dearest. `scripts/model-check.js --dry-run` prints the live prices.

**Check:** `scripts/model-check.js` sends one invented sentence to each route. It prints the model id, the provider that served it, token counts and cost, and checks that the JSON reply has the expected shape. It exits with an error if the provider is not the pinned one, and never prints the key.

## How it runs
A run fetches about 180 conversations (Slack calls spaced 1.3 s apart) and then makes model calls. That is far over the dispatcher's 60-second job limit.

**Approved and built: a standalone launchd schedule** (`com.lab.schedule.slack-digest`, phase 3, 06:00 daily) that runs `node src/digest/run.js --scheduled` directly. This is a recorded exception to "schedules call the dispatcher"; see `docs/decisions.md`. The script:
- pings its own healthchecks.io check: success, or `/fail` on any failure, abort or deadline. The URL comes from `~/.lab/healthcheck-url-slack-digest`, which the user creates before the schedule is installed. Suggested period 1 day, grace 2 hours.
- writes one row to the `runs` table in `data/dispatcher.db`. The source is `launchd-direct`, or `manual` for hand runs, and the row holds counts and cost only.
- enforces its own deadline of 60 minutes (raised from 25 after a real 24-hour run took 21). It is a single process and starts no children. The stats give the time of each phase.
- keeps the newest 14 digests, delivers the DM (see "Delivery by Slack DM"), then records the success, only if the delivery worked (temp file and rename). A failed delivery leaves the record, so the next run covers the window again.

**Window.** Each run covers everything since the last successful scheduled run, capped at 72 hours, so Mondays and missed days are covered. The time of the last success is kept in `data/digest-state.json`, which holds a timestamp only. With no recorded run, the window is the last 24 hours. Hand runs never move that timestamp unless asked to.

## Pipeline
1. **Plan.** Load the config and the saved channel list; on scheduled runs, first refresh that list with paged `conversations.list` calls (conversations left or archived are dropped). Conversations that match no rule or override and are not ignored are never read; every run names up to 8 of them, with the count, in the DM footer until they are mapped or ignored (`scripts/digest-map.js`). Take every conversation mapped to a unit, decide the window, and derive the external flag.
2. **Fetch** with the shared read-only client (`src/slack.js`):
   - history for the window, plus a 14-day thread lookback to find older threads with new replies, then those replies.
   - Each message keeps: conversation, `ts`, thread, author, a bot flag and text (message text plus attachment text). Housekeeping events (joins, topic changes and similar) are skipped.
3. **Compress bot posts** (code only, `src/digest/compress.js`):
   - Group bot messages by bot and by template. The template is the text with numbers, IDs, URLs, emails and dates replaced by placeholders.
   - Per template, keep the first and the latest example (cut to 300 characters), plus a count.
   - Always keep up to 5 instances containing alert words (error, failed, down, outage, escalate, urgent, cancel, refund, churn, complaint and similar).
   - The compression ratio is reported every run.
4. **Group** by the customer registry (each customer's success, coordination and external channels; customer-unit conversations that are not customers go to one brief "other" bucket) and by unit mode (full, brief, off). Mentions of customers in Leadership and Internal channels are found by alias in code.
5. **Plan under the caps.** Estimate input tokens (characters ÷ 4) before any model call. Customers go first, then sub-groups, busiest first. What does not fit the 400,000-token run cap is marked "not summarized (cap)" with counts, and the run does not abort. A call over the 100,000-token per-call cap keeps its newest messages.
6. **Mask** external text (phase 2 onward). Phase 1 runs the masking on the would-be input and reports counts only.
7. **Model calls:**
   - stage 1: one JSON call per active customer conversation (problems and risks, each with an evidence category)
   - stage 2: one synthesis call per customer with findings or mentions (one headline, a short headline of at most 12 words, supporting points that are each one distinct fact, all channels merged)
   - the headline check: one cheap call per customer shown under Needs attention (at most 5), with the headline and only the masked messages it cites; overstated headlines are corrected, unsupported ones dropped
   - one per full-mode sub-group that is not customers (archive only), one per brief-mode unit (at most 3 items), one incident check per off-mode unit
   - extraction 2 at a time, synthesis and checks 3, starts at least 1.5 s apart, each with a timeout, one primary retry (with jitter) and one fallback; served providers checked per stage in one batch
   - every extraction, synthesis and check prompt carries the certainty rule: never upgrade an intention, question or report to a fact; attribute reports ("per Delaine")
8. **Validate** replies against their schema and drop claims with invalid references, and apply the noise rules in code: only evidence categories survive; bot hygiene, personnel and other items are dropped and counted; severity, the Leadership flag, the best link and "bot report" are decided in code. Sanitize model text by removing URLs, `<@…>`, `<!channel>`, `<!here>` and link syntax, so links only come from code and a crafted message cannot make the digest mention or link anyone.
9. **Render** `data/digests/<date>.md` (mode 600), merged by customer: notable customers ranked (severity, Leadership, strong points, volume) with every point including low ones, quiet customers on one line, incidents, units by mode, skipped counts, and a footer with counts, masking counts, tokens, cost and runtime.
10. **Finish.** Record the success, prune old digests, send the DM when scheduled, drop all text, write the run row, and ping the healthcheck when scheduled.

**Links** are built in code from the workspace URL in `config/slack-digest.json`: `<workspace>/archives/<channel>/p<ts without the dot>`. Thread replies add `?thread_ts=<parent>&cid=<channel>`.

## Risk extraction (phase 2, built)
**Input, per customer:** the masked messages from the window, compressed, with references, author names and times. Until phase 4, a customer is one per-customer success channel. Each other sub-group (or a unit without sub-groups) gets one summary call over all its active conversations. Each message's text is sent as a JSON string, under a header that says it is data. Messages longer than 2,000 characters are cut.

**Validation (code, `src/digest/analyze.js`):**
- An item survives only with a non-empty summary and at least one reference that exists in that call's input. Unknown references are removed, and dropped items are counted.
- `notable` is decided by code: a customer is notable only if a cited item survived.
- Model text is sanitized: no URLs, Slack markup, mentions, emails or markdown links, and at most 200 characters.
- A reply in the wrong shape fails only its own call. A run-level cap (input, output or cost) stops the calls that remain.
- Before any call, the whole run's estimated input is checked against the cap, and the run aborts if it is over.

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

## Customer registry (built in the redesign; health not yet approved)
- **`config/digest-customers.json`** (git-ignored, with a tracked example): prefixes, suffixes and filler words for deriving keys from channel names, extra keys, aliases, hand assignments, general channels and mention channels.
- **Derivation is code:** success channels define customers; other customer channels join by key; customers configured without a success channel collect their channels by key; unmatched channels are listed and still analyzed. Conversations that are not customers at all go to the "other" bucket (one brief summary). Short upper-case names can be matched case-sensitively (`exactAliases`). `node scripts/digest-customers.js` prints the registry for review.
- **Not built:** health as runtime state (`set-health red|yellow|green`) and ordering by health, and owners.

## Leadership-contradiction check (phase 5, not yet approved; the redesign only flags that Leadership discussed a customer)
1. **Find candidate pairs in code.** Take messages in the unit's leadership channels from configured people that mention a registered customer. Pair each with that customer's success-channel messages, over the window plus a short lookback.
2. **Ask the model** for conflicts, each with both references and both quotes.
3. **Verify in code.** Keep a conflict only if both quotes are exact parts of the masked text the model saw. Each kept conflict is shown as "**Possible conflict, verify**" with both links.
4. **Test** against real past cases the user supplies, plus invented near-misses that must not be flagged.

## Delivery by Slack DM (built in phase 3, reshaped in the redesign)
- **The same Slack app** as the reader. Its bot token (`~/.lab/slack-bot-token`, mode 600, Authorization header only) uses `chat:write` and `im:write`. No events, no file uploads and no read scopes are used with it.
- **Two methods only:** `conversations.open` and `chat.postMessage`. The client refuses any other method, posts only after `conversations.open` returns a 1:1 DM whose user is the configured ID (`deliverTo`, git-ignored), has no channel argument, and replies only under its own message.
- **What is sent:** a top-level message (hard cap 1,500 characters: title, Needs attention with at most 5 customers and their checked short headlines, Watch names, Incident, Other units, Skipped), then up to 5 threaded replies of at most 3,500 characters with every medium or high customer (full headline, at most 3 bullets with links), an "Also notable" line for anything that did not fit, and the model, provider, fallback, cost and unmapped footer in the last reply. Nothing is ever cut mid-sentence; whole lines are left out instead. Nothing is uploaded; the archive file stays on the mini.
- **If delivery fails:** the digest file is kept, the success is **not** recorded (the next run covers the window again), and the healthcheck gets `/fail` with the reason code.
- **Manual steps for the user:** creating and installing the app, its scopes and the App Home Messages tab are done in Slack's web UI.

## Cost controls
| Control | Value |
|---|---|
| Per-run input cap (estimated tokens) | 400,000, about 6.5× the measured daily peak (a 72-hour window after missed days). The busiest calls are planned first; the rest are "not summarized (cap)" |
| Per-call input cap (estimated tokens) | 100,000, under DeepSeek V3.2's 163,840-token context with a 30% margin for the estimate; longer calls keep their newest messages |
| Per-run output cap | 60,000 tokens, reasoning included |
| Per-run cost cap | $0.50, checked before each call against the worst case for whichever route is about to run; a timed-out request counts its worst case |
| Output cap per call | about 1,500 tokens per customer, about 800 per unit summary, 300 per headline check |
| Timeout per model call | 90 s |
| Retries | one primary retry after about 3 s (Retry-After honored up to 10 s) plus up to 1 s of jitter for a timeout, 5xx or 429; then one attempt on the secondary after a timeout, 5xx, 429 or provider mismatch; at most three requests per call |
| Run deadline | 60 min |
| Concurrency | extraction 2 model calls at once, synthesis and checks 3; starts at least 1.5 s apart |
| Month-to-date spend cap | to be decided |
| Logged per run (no text) | conversations, messages, characters, compression ratio, masked items by type, model calls, fallbacks, model and provider per call, input tokens (cached and not), output and reasoning tokens, cost, runtime, dropped claims |

## Phases
| # | Phase | Status | What it tests |
|---|---|---|---|
| 0 | **Groundwork.** Shared Slack client in `src/`, `src/openrouter.js` (key check, pinned providers, no tools, JSON mode, reasoning handling, timeouts, primary/secondary fallback, served-provider check, live prices, caps), masking, external flag | built | `scripts/model-check.js` sends **invented** text to each route and checks model, provider, tokens, cost and JSON shape. Self-tests with invented data cover masking, fallback, caps and every guard |
| 1 | **Fetch, bot compression, code-only digest** (no model calls) | built | Fetch runtime; compression ratio; masking counts on the would-be input; nothing but the digest on disk; links open the right messages |
| 2 | **Risk extraction and unit summaries**, plus `scripts/digest-eval.js` | built | Eval passes; every claim has a valid reference; the injection is ignored; real cost |
| 3 | **Morning schedule** (standalone launchd) **and Slack DM delivery** (same app, bot token), primary retry, 400k run cap | built | `kickstart` run, healthcheck ping, run row, DM and file in the user's DM only |
| R | **Redesign:** customer registry, synthesis per customer, Leadership mentions, noise rules, unit modes, two-part DM | built | registry printed for review; eval and self-tests; a `kickstart` run delivered to the DM |
| 4 | **Customer health** (the registry itself is built in the redesign) | needs approval | Red first |
| 5 | **Leadership-contradiction check** | needs approval and the past cases | Real cases flagged with verified quotes; near-misses not flagged |
| 6 | ~~Slack DM delivery~~ | moved into phase 3 | |

## Files
- **Code:** `src/slack.js` (shared read-only Slack client and unit rules), `src/slack-send.js` (send-only DM client), `src/secrets.js`, `src/healthcheck.js`, `src/openrouter.js`, `src/mask.js`, `src/digest/` (run, fetch, compress, customers, pipeline, analyze, prompts, render, dm)
- **Schedule:** `launchd/com.lab.schedule.slack-digest.plist`
- **Scripts:** `scripts/model-check.js`, `scripts/digest-selftest.js`, `scripts/digest-eval.js`, `scripts/digest-dm-test.js`, `scripts/digest-customers.js` (prints the registry)
- **Config:** `config/slack-digest.example.json` (workspace URL, model routes, caps, noCloud, unit modes, recipient), `config/digest-customers.example.json` (customer registry settings), `config/slack-bus.example.json` (unit rules and external rule)
- **Docs:** this file, `docs/slack-digest.md` (how to run it), `docs/decisions.md`, README, CLAUDE.md
