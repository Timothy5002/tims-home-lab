# Slack digest: how to run it

The design, rules and phases are in [slack-digest-design.md](slack-digest-design.md). This page covers what is built and how to run it. **Built so far: phases 0, 1 and 2** (groundwork, the fetch and code-only digest, and model analysis).

## Files and secrets
| What | Where | Notes |
|---|---|---|
| Slack user token (read-only) | `~/.lab/slack-token` | mode 600; shared with the measurement scripts |
| OpenRouter API key | `~/.lab/openrouter-key` | mode 600; never printed, logged or committed; monthly spend limit set in OpenRouter's dashboard |
| Unit rules and the external rule | `config/slack-bus.json` | git-ignored; template `config/slack-bus.example.json` |
| Digest settings (workspace URL, model routes, window, caps, noCloud) | `config/slack-digest.json` | git-ignored; template `config/slack-digest.example.json` |
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

**In a digest run (phase 2 onward)**, the primary is tried first. After a timeout, 5xx, 429 or provider mismatch, the secondary is tried once, never more.

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
  - the fallback on timeout, 5xx, 429 and provider mismatch, and never a third attempt
  - no fallback on 401, 404, empty or invalid JSON
  - the input, output and cost caps
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

## Run the digest
```bash
node src/digest/run.js                # window: since the last recorded run (max 72 h), or the last 24 h
node src/digest/run.js --no-model     # code-only digest (no model calls)
node src/digest/run.js --reasoning    # turn the primary model's reasoning on (off by default)
node src/digest/run.js --hours 48     # a fixed window, for testing
node src/digest/run.js --record       # also record this run as the last success (scheduled runs do this)
node src/digest/run.js --from <ISO> --to <ISO>   # a fixed window (never recorded)
```
It takes about 5 minutes, because Slack calls are spaced to stay under the rate limits. The steps:
1. **Fetch** every conversation mapped to a unit. Unassigned group DMs are left out. The fetch reads the window plus a 14-day lookback, so older threads with new replies are found.
2. **Compress bot posts** in code (`src/digest/compress.js`). Messages from one bot that share a template (the text with numbers, IDs, links and dates replaced) become one line with a count, plus the latest example. Instances with alert words (failed, error, outage, cancel…) are always listed.
3. **Write** `data/digests/<date>.md` (mode 600, git-ignored):
   - the customer group first, each active customer with its busiest threads, latest messages from people and compressed bot posts, every item linked to its message
   - quiet customers on one line, then the other units
   - a footer: counts, compression ratio, how many tokens phase 2 would send, masking counts from a dry run, API calls and runtime

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
- **Counts only, no text:** stdout, the run row in `data/dispatcher.db` (job `slack-digest`, source `manual` or `launchd-direct`) and `data/digest-state.json` (a timestamp).

Settings are in `config/slack-digest.json`:
- workspace URL for links
- unit order, and which unit > sub-group is the customer group
- your display name, which is left out of group DM labels
- window limits, thread lookback, input cap and run deadline

The run stops by itself after the deadline (25 minutes) and logs `deadline`.
