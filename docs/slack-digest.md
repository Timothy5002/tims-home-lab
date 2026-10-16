# Slack digest: how to run it

The design, rules and phases are in [slack-digest-design.md](slack-digest-design.md). This page covers what is built and how to run it. **Built so far: phases 0 to 3 and the redesign** (groundwork, the fetch and code-only digest, model analysis, the 06:00 schedule with Slack DM delivery, then the customer registry, per-customer synthesis, noise rules, unit modes and the two-part DM).

## Files and secrets
| What | Where | Notes |
|---|---|---|
| Slack user token (read-only) | `~/.lab/slack-token` | mode 600; shared with the measurement scripts |
| Slack bot token (sending the DM only) | `~/.lab/slack-bot-token` | mode 600; same Slack app as the user token; scopes `chat:write`, `im:write` |
| Healthcheck ping URL | `~/.lab/healthcheck-url-slack-digest` | mode 600; the digest's own check (period 1 day, grace 2 hours) |
| OpenRouter API key | `~/.lab/openrouter-key` | mode 600; never printed, logged or committed; monthly spend limit set in OpenRouter's dashboard |
| Unit rules and the external rule | `config/slack-bus.json` | git-ignored; template `config/slack-bus.example.json` |
| Digest settings (workspace URL, model routes, window, caps, noCloud, unit modes, DM recipient `deliverTo`) | `config/slack-digest.json` | git-ignored; template `config/slack-digest.example.json` |
| Customer registry settings (prefixes, suffixes, aliases, hand assignments, mention channels) | `config/digest-customers.json` | git-ignored; template `config/digest-customers.example.json` |
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

**In a digest run (phase 2 onward)**, the primary is tried first. After a timeout, 5xx or 429 it is retried once after about 3 seconds (Retry-After is honored up to 10 seconds), plus up to 1 second of random jitter so parallel calls do not retry at the same moment. If it still fails that way, or was served by a provider that is not pinned, the secondary is tried once. That is never more than three requests per call.

**Served-provider check in a digest run:** each reply's own `provider` field is checked at once (a provider that is not pinned is a mismatch and goes to the secondary). OpenRouter's generation stats, which take about 15 seconds to appear, are read afterwards for a whole stage in one batch: all at once, with one wait of up to about 30 seconds. The rule is unchanged: at least one source must name a provider and every source that names one must name a pinned one. A primary reply that fails the batch check is discarded and its call is sent once to the secondary, whose reply must pass the check too; otherwise the call fails. The model check and the eval still check each call on its own. Retries and fallbacks are counted with their reasons (error codes only) in the stats, the digest footer and the healthcheck ping.

## Self-tests
```bash
node scripts/digest-selftest.js
```
Run this after changing masking (`src/mask.js`), the OpenRouter client (`src/openrouter.js`), validation, the registry, the pipeline, call concurrency, the membership refresh, the archive, the DM, the send-only client or bot compression. Everything in it is invented, and it makes no network calls: the OpenRouter and Slack tests use fake APIs, and the pipeline test uses a stubbed model. It covers:
- **Masking:**
  - emails (plain, in angle brackets, Slack `<mailto:…|…>`), phone numbers with dashes, dots, spaces, brackets and `+` codes, long numbers, URLs with queries or tokens, and secret-looking strings
  - things that must **not** be masked: dates, amounts, versions, mentions, and names, emails and numbers in secrets-only masking
- **The secret-file check:** a loose mode or an empty file is refused.
- **The OpenRouter client:**
  - request bodies for both routes (pins, data policy, reasoning, temperature), and the key only in headers
  - one primary retry after a backoff on timeout, 5xx and 429 (Retry-After capped at 10 s), recovery on the retry, then the fallback; no retry on a provider mismatch; never a fourth attempt
  - no fallback on 401, 404, empty or invalid JSON
  - the input, output and cost caps, the per-call context check, and the worst-case cost of timed-out requests
  - reasoning tokens in cost and caps, and the cost arithmetic; single-route calls retry once and never fall back
- **Validation and the noise rules:** references and masking, uncited items dropped, bot hygiene, personnel and non-evidence items dropped and counted, bot reports labeled in code, item limits, brief items cut to 12 words; synthesis severity from the strongest kept point, a 20-word headline, and the Leadership flag only from a cited Leadership message.
- **The registry:** success channels define customers; coordination and external channels join by key or extra keys; a configured customer with no success channel collects its channels by key; unmatched channels are grouped and still get a record; general channels; the "other" bucket (neither a customer nor unmatched); mention channels; whole-word, case-insensitive alias matching; exact-case aliases; automatic aliases switched off with `noMention`.
- **The pipeline end to end** (stubbed model): the "other" bucket as one brief summary and no customer record; one merged record per customer across its channels, Leadership mentions reaching the synthesis, personnel dropped, ranking, the fallback when a synthesis call fails, your own conversation left out of the brief summary, unit modes, incidents, skipped counts, and the archive file's structure and links.
- **The DM:** section order, the short headline verbatim, "(incident)" instead of a repeated Incident line, no low items anywhere in the DM, the footer only in the last reply, the 1,500-character cap, no line ending in an ellipsis, escaping, and an oversized invented digest (40 customers): at most 5 replies of at most 3,500 characters, every customer in a section or on the "Also notable" line, at most 3 bullets each, no mention of the archive file.
- **Model calls:** at most 3 at once, starts spaced by the gap; the retry's jitter; the deferred provider check (a non-pinned reply field is a mismatch at once), the batch check (one wait for the whole batch; confirmed, other provider, no source), the one-time rerun on the secondary and the stats cost replacing the estimate; `secondaryOnce` makes exactly one attempt.
- **The headline check:** verdicts validated; overstated headlines replaced and marked softened (archive only); unsupported ones dropped from Needs attention; the check sees only the cited messages, masked.
- **`scripts/digest-map.js`** on invented temp configs: list-unmapped, map (channel override, group DM by full member set), ambiguity and partial member lists change nothing, unknown units refused without `--new`, ignore, map-customer (and its refusals), remove, mode 600 and no temp files left.
- **The membership refresh:** membership from `conversations.list` only (private channels and group DMs without `is_member` count as member); kept conversations keep their saved details under the new name, new ones are added, left or archived ones dropped; names for new unmapped conversations.
- **Cap planning** on an oversized invented window (about 840,000 tokens): the plan stays under 400,000, the busiest customers come first, a call over the per-call cap keeps its newest messages, skipped calls are never sent, and the archive lists them as not summarized with counts.
- **Delivery:** the send-only client (fake Slack) opens the DM, refuses a DM that is not the recipient's, a channel, a non-user recipient and any post before the DM is verified, replies only under a message it posted, knows only two methods, and sends the token only in the Authorization header.
- **The healthcheck helper:** a loose or missing URL file is refused; success and `/fail` pings; the body is cut to 10 kB.

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
2. Refreshes the conversation list (see "Daily membership refresh" below).
3. Covers everything since the last success, capped at 72 hours (24 hours if none is recorded).
4. Writes the digest file, then deletes all but the newest 14 digests.
5. Sends the DM (below).
6. Only if the DM was delivered, records the success in `data/digest-state.json` (written to a temp file and renamed, so it is never half-written). A failed delivery leaves the record where it was, so the next run covers the same window again.
7. Pings the healthcheck: success, or `/fail` on any error, the 60-minute deadline or a failed delivery. The ping body is stats only: model and provider, retries and fallbacks with reasons, customers merged and notable, items kept and dropped (by reason), calls over the cap, cost, headline checks, provider checks, the membership refresh and unmapped counts, the time of each phase, runtime and delivery status.

The log is `~/Library/Logs/lab-dispatcher/schedule-slack-digest.log`. It holds stats only, with no per-conversation progress and never any text. To run it now: `launchctl kickstart -k gui/$(id -u)/com.lab.schedule.slack-digest`. That is a real run: it sends the DM, records the success and pings.

**A test run that does not move the last-success record:** `kickstart` cannot pass arguments, so run the schedule's own command by hand with an explicit window. `--from`/`--to` (or `--hours`) is never recorded, even with `--scheduled`, so the next 06:00 run still covers everything since the last real one. It refreshes the conversation list, sends the DM and pings the healthcheck like the schedule does:
```bash
node src/digest/run.js --scheduled --from "$(date -u -v-24H +%Y-%m-%dT%H:%M:%SZ)" --to "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

## Daily membership refresh
Every scheduled run starts by re-reading the conversation list with paged `conversations.list` calls (about 13 calls, under a minute; no other method, no per-channel lookups) and updating `data/slack-channels.json`. A hand run does it with `--refresh`.
- **Conversations you left, or that were archived,** are dropped from the list and counted (`membership.removed` in the stats).
- **New conversations that match a rule, override or group DM entry** in `config/slack-bus.json` are read like any other.
- **Conversations that match nothing** (no rule, override or group DM entry, and not on the ignore list) are never read or sent to any model. **Every run**, the last reply's footer names up to 8 of them with the count (`N unmapped: names`), newest first, and the archive file does the same; the stats and log hold only the count. They stay listed until you map or ignore them with `scripts/digest-map.js` (below).
- **A new group DM** has no member names in the list (none are fetched); it is named by the handles in its internal name. `node scripts/slack-channels.js` fills in members.
- **If the refresh fails** (a Slack error), the run carries on with the saved list, and the stats and the thread footer say so.

**Install or change it:** `scripts/install-agent.sh launchd/com.lab.schedule.slack-digest.plist`. The healthcheck URL file must exist first. In healthchecks.io the suggested period is 1 day, with a 2-hour grace time.

## Mapping and ignoring conversations
`scripts/digest-map.js` edits the git-ignored configs so you never hand-edit JSON for this. It reads names from the cached listing (`data/slack-channels.json`), makes no Slack calls, prints only names and IDs, and writes atomically (temp file, then rename, mode 600). It prints what changed.
```bash
node scripts/digest-map.js list-unmapped                         # everything the footer would count, newest first
node scripts/digest-map.js map <name> <Unit>[/<Sub-group>]       # a channel gets an override; a group DM a groupDms entry with its members
node scripts/digest-map.js map-customer <name> <customer>        # attach a customer-unit channel to a customer (key or name)
node scripts/digest-map.js ignore <name>                         # stop listing an unmapped conversation (config/slack-bus.json "ignore")
node scripts/digest-map.js remove <name>                         # undo: override, group DM entry, ignore entry, customer assignment
```
`<name>` is a channel name (with or without `#`), a conversation ID, or a group DM's **full** member list, comma-separated (your own name may be left out). A name that fits more than one conversation, or none exactly, lists the candidates and changes nothing. `map` refuses a unit or sub-group that no rule uses yet unless you add `--new`. `map-customer` works only for channels already in a customer unit.

## Customer registry
The digest merges each customer's channels into one record. The registry is derived in code (`src/digest/customers.js`) from channel names, using `config/digest-customers.json`:
- **Customers:** each channel in `anchorSources` (the Success sub-group) defines a customer. Its key is the channel name, lower case, with `stripPrefixes` and `stripSuffixes` removed (longest first, repeatedly), split on `-`, `_` and `.`, with `dropWords` removed and the rest joined. The display name is the remaining words.
- **Other customer channels** (`customerSources`, such as coordination and external channels) join a customer when their key equals the customer's key or one of its extra `keys`, or when one key contains the other (the shorter at least `minContainLength`, 5). More than one candidate is ambiguous and never guessed.
- **Exceptions:** under `customers`, give a customer a `name`, extra `keys` (spelling or hyphenation differences), `aliases` for mentions, `exactAliases` (matched case-sensitively), or `channels` assigned by hand. A customer listed there with no success channel still collects every customer channel whose key equals its own, so it is a customer, not "unmatched". `notCustomers` lists general channels in the customer sub-groups. They are summarized as a unit, not as a customer.
- **The "other" bucket** (`otherBucket`: a name and a list of channel names or IDs) holds customer-unit conversations that are not customers (prospects, people, demos, group DMs). They get one brief summary under the bucket's name (at most 3 one-line items, shown under Other units in the DM) and are never ranked as customers or used for mentions.
- **Unmatched channels** are still analyzed. Those sharing a key form one record, and the rest (group DMs, ambiguous ones) get one each. They are marked unmatched.
- **Mentions:** messages in `mentionSources` (Leadership, with `leadership: true`, and Internal) are matched to customers by alias, in code. The match is whole-word and case-insensitive, and allows `-`, `_`, a space or nothing between an alias's words. Automatic aliases are the success channel's words. Shorter than `minAliasLength` (4), they are skipped; add short names as aliases by hand, and switch off a bad automatic alias with `noMention` (the customer's own channels still count). A short upper-case name that is also an ordinary word goes in `exactAliases`, which match only in that exact case (still whole word).

**Review it:** `node scripts/digest-customers.js` prints each customer with its channels and mention aliases, the channels that matched no customer (with their key or the ambiguous candidates), the general channels and the mention channels. It shows names only, makes no Slack calls and reads no messages.

## How a model run works
1. **Unit modes** (`unitModes` in `config/slack-digest.json`, by `"Unit"` or `"Unit > Sub-group"`; unlisted units are brief):
   - **full:** customer channels become customer records; other sub-groups (for example Leadership) get a summary in the archive file only.
   - **brief:** one call per unit, at most 3 one-line items (12 words at most). Shown in the DM.
   - **off:** one check per unit for an outage or incident that affected customers, shown as the DM's Incident line if found.
   - **Your own conversations:** a conversation where you (`deliverTo`) wrote most of the messages is left out of unit and brief summaries. Customer channels and the incident check still read it.
2. **Stage 1:** one call per active customer conversation, listing problems and risks. Each item must name its evidence category.
3. **Noise rules, enforced in code:**
   - An item survives only with a valid reference and one of the evidence categories: sentiment or trust change, incident, missed deadline or commitment, commercial (contract, renewal, churn, competitor), escalation, ownership confusion.
   - "Bot hygiene" (an EOD report not posted, scheduled posts) is dropped and only counted on the Skipped line. A bot report naming a real risk is kept, labeled "bot report" when every message it rests on is a bot post.
   - Personnel matters (an employee's performance, discipline and so on) are dropped everywhere, unit summaries included.
4. **Stage 2 (synthesis):** one call per customer with findings or mentions. The model sees the messages stage 1 cited, the mentions (newest 25) and the stage-1 findings. It returns a headline (20 words at most), a short headline (12 words at most, shown verbatim in the DM; over 12 words it is not used, never cut), the references the headline rests on, and supporting points, each one distinct fact (near-duplicates merged) of at most about 160 characters, each citing evidence references, and code checks every one. Code also sets the record's severity (its strongest kept point), the Leadership flag (a kept point cites a Leadership message) and the best link (the strongest point's first message). If the call fails, the record shows the stage-1 findings, marked "not merged".
5. **Certainty rule** (extraction, synthesis and the check): summaries must match the certainty of their source. "Considering", "asked about", "is worried" and "said they signed" are different, and an intention is never upgraded to a fact. When a message reports what someone else did or said, the summary says so ("per Delaine").
6. **The headline check** (verification): for each customer the DM would show under Needs attention (at most 5), one cheap call on the same route and pins gets the headline, the short headline and ONLY the masked text of the messages the headline cites, and answers supported, overstated or unsupported. Overstated headlines are replaced by the model's corrected text and marked "(softened)" in the archive file only; unsupported ones are dropped (the customer is not under Needs attention, and its thread section has no headline). A failed check leaves the headline, marked "not checked" in the archive. Counts are in the stats.
7. **Caps:** stage 1 is planned under 85% of the run cap (customers first, busiest first). The rest is kept for stage 2 and the checks.
8. **Concurrency:** extraction runs 2 calls at a time, synthesis and the checks 3, with starts at least 1.5 s apart.

## Slack DM delivery
One Slack app serves both jobs: its **user token** (`~/.lab/slack-token`) reads, and its **bot token** (`~/.lab/slack-bot-token`) sends. The send-only client `src/slack-send.js`:
- knows two methods, `conversations.open` and `chat.postMessage`, and refuses everything else. It never reads conversations, uploads files, listens to events or replies to anyone else.
- sends only to `deliverTo` in `config/slack-digest.json`, your own user ID, which is never in committed files. It opens the DM with `conversations.open` (`return_im`) and refuses to post unless Slack returns a 1:1 DM (`D…`, `is_im`) whose user is that ID. It has no channel argument, and a threaded reply may go only under a message the same run posted.
- needs the bot scopes `chat:write` and `im:write`. `files:write` is no longer used. The app's App Home must have the Messages tab on.

**Nothing is ever cut mid-sentence.** Code never shortens a headline, bullet or unit item by characters or words; when space runs out, whole lines or names are left out instead.

**The top-level message** (`src/digest/dm.js`, Slack mrkdwn, hard cap 1,500 characters):
1. A title line with the date.
2. **Needs attention:** at most 5 customers, ranked by severity, then Leadership, then the number of strong points, then volume. Each gets one line: the bold name, 🔴 (high) or 🟠 (medium), the **short headline** (at most 12 words, written by the synthesis and checked by the verification pass) exactly as written, and one link to the best evidence. If one of that customer's points is an incident, the line ends with "(incident)". A customer whose headline the check found unsupported is not shown here (it moves to Watch).
3. **Watch:** the names of the other customers with medium or high items.
4. **Incident:** one line for an outage or incident that is not already marked on a Needs-attention line (from another customer or an off-mode unit).
5. **Other units:** one line per brief-mode unit.
6. **Skipped:** bot-hygiene items, bot posts and quiet channels, as counts.

If it would run over 1,500 characters, whole pieces are left out in this order: Watch names, then Other-units items and lines, then the Incident line, then Needs-attention lines from the bottom (those customers are still in the thread).

**The threaded replies** (up to 5, each at most 3,500 characters, split only between sections): every customer with medium or high items, ranked high to low. Each gets its full headline, at most 3 bullets (one distinct fact each, with links; medium and high only) and "(also discussed in Leadership)" when it applies. Then the brief units' items with links and the incidents. If something still does not fit, the last reply ends with one line, "Also notable: …", naming what was left out, so nothing is dropped silently. The footer (model and provider, calls, retries, fallbacks, cost, window, and the unmapped conversations) closes the last reply. Low-severity items appear only in the archive file. Nothing is uploaded.

**If delivery fails,** the digest file is still in `data/digests/`, and the last-success record does **not** move, so the next run covers the same window again. The run exits 1, the log and run row show `delivery-failed` with Slack's reason code, and the healthcheck gets `/fail`.

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
node src/digest/run.js --hours 48     # a fixed window, for testing (never recorded)
node src/digest/run.js --record       # also record this run as the last success (scheduled runs do this)
node src/digest/run.js --deliver      # also send the Slack DM (scheduled runs do this)
node src/digest/run.js --refresh      # also refresh the conversation list first (scheduled runs do this)
node src/digest/run.js --from <ISO> --to <ISO>   # a fixed window (never recorded, even with --scheduled or --record)
```
It takes about 5 minutes, because Slack calls are spaced to stay under the rate limits. The steps:
1. **Fetch** every conversation mapped to a unit (after the membership refresh on scheduled runs). Unassigned group DMs and new unmapped conversations are left out. The fetch reads the window plus a 14-day lookback, so older threads with new replies are found.
2. **Compress bot posts** in code (`src/digest/compress.js`). Messages from one bot that share a template (the text with numbers, IDs, links and dates replaced) become one line with a count, plus the latest example. Instances with alert words (failed, error, outage, cancel…) are always listed.
3. **The model pipeline** (see "How a model run works"): at most 3 calls at a time, their starts at least 1.5 seconds apart, through the primary route with its retry and fallback rules. Text is masked before sending (see below).
4. **Write** `data/digests/<date>.md` (mode 600, git-ignored), merged by customer:
   - each notable customer: severity, Leadership flag, headline, every supporting point (low included) with its category, "bot report" label and links, the channels with message counts, and mention counts
   - customers with nothing notable on one line, and what was not summarized and why
   - incidents, then each unit by mode, then the Skipped counts (bot hygiene, bot posts, quiet channels, your own conversations, items dropped by reason)
   - a footer: counts, compression ratio, model, retries and fallbacks with reasons, customers merged, calls over the cap, items kept and dropped, tokens and cost, masking counts, API calls and runtime

**Stdout and the run row** hold stats only: customers merged and notable, unmatched channels, mention messages, items kept and dropped by reason, masked items by type, tokens, cost against the cap, runtime, calls per model and provider, and delivery status. The digest text is never printed or logged.

**With `--no-model`:** it masks text in memory only to count what would be masked, then discards it, and writes the code-only digest (per conversation, with links). It cannot be delivered.

## Digest prompts and their eval
The prompts are in `src/digest/prompts.js`. After changing one, run:
```bash
node scripts/digest-eval.js
```
It runs invented sample days through both routes separately, one call at a time with the one retry, and prints pass/fail side by side. A case that still hit a rate limit is tried once more after 30 seconds; any other failure stands. The cases:
- **Customer extraction:** an outage, a quiet day, an alert hidden in bot posts, implicit frustration, sarcasm, an injection attempt, a personnel matter (never reported), bot hygiene (not a customer item), a bot risk report (kept, labeled) and a reported intention ("considering a competitor", per a colleague), which must stay an attributed intention.
- **Synthesis:** two channels plus a Leadership mention, merged into one record with a short headline; and a stage-1 finding that overstated "considering" as "signed", which the synthesis must not repeat.
- **The headline check:** "considering X" stated as "signed with X" (overstated, corrected), a headline the messages state (supported), and one they do not (unsupported).
- **The rest:** a brief unit (at most 3 short items), the incident check (one customer-facing outage, one internal-only problem) and a unit summary.

It uses the same preparation and validation as a real run, and a case also fails if any item was dropped for a bad reference. The primary route must pass every case; the secondary's results are informational. It costs well under a cent.

**What persists:**
- **The digest file:** the only thing written that contains message text.
- **Counts only, no text:** stdout, the schedule's log, the healthcheck ping, the run row in `data/dispatcher.db` (job `slack-digest`, source `manual` or `launchd-direct`) and `data/digest-state.json` (a timestamp).
- **Retention:** the newest 14 digest files are kept; older ones are deleted on every run.

Settings are in `config/slack-digest.json`:
- workspace URL for links
- unit order, and which unit > sub-group is the customer group (used by the code-only digest)
- `unitModes`: full, brief or off per unit or sub-group
- your display name, which is left out of group DM labels
- window limits, thread lookback, run and per-call input caps, output and cost caps, and the run deadline
- `deliverTo`: your own Slack user ID, the only DM recipient, also used to recognize your own conversations

The run stops by itself after the deadline (60 minutes, `runDeadlineMinutes`) and logs `deadline`.

**Timing:** the stats, the log and the healthcheck ping give the seconds spent in each phase: `membershipRefreshS`, `slackFetchS`, `extractionS`, `synthesisS`, `verificationS`, `providerChecksS` and `deliveryS`.
