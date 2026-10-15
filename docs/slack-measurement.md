# Slack measurement

Two terminal scripts that answer one question: **how much text would a daily Slack digest have to read?** The answer (tokens per day, overall and per business unit) decides whether the digest can run on the local model or needs a cheap cloud model. They only count; they never store or print message text, and they never write to Slack.

They run from the terminal, not through the dispatcher, because reading a week of history takes far longer than a job's 60-second limit.

## Before you start
- The Slack **user** token lives in `~/.lab/slack-token` (mode 600). The scripts refuse to run if the file is readable by anyone else. Never paste it anywhere else.
- The token's scopes are read-only: `channels:read`, `channels:history`, `groups:read`, `groups:history`, `mpim:read`, `mpim:history`, `users:read`. The scripts can only call `conversations.list`, `conversations.history`, `conversations.replies`, `conversations.members` and `users.list`; any other method is refused in code (`scripts/slack-lib.js`).

## Step 1: list channels
```bash
node scripts/slack-channels.js            # conversations you are a member of
node scripts/slack-channels.js --all      # also public channels you are not in (much slower)
node scripts/slack-channels.js --no-activity   # skip the "last activity" lookup
node scripts/slack-channels.js --from-cache    # no Slack calls: re-apply the rules to the saved list (use after editing them)
```
It asks Slack for every public channel, private channel and group DM the token can see (archived ones excluded). By default it then keeps only the ones the token's user is a **member of**, using the `is_member` field from that same list, so the filter costs no extra calls. Public channels you are not in are usually not digest material, and skipping them saves one call each. `--all` keeps them.

For each kept conversation it records the ID, name, type, member count and last activity, plus member names for group DMs. It saves this to `data/slack-channels.json` (git-ignored, mode 600) and prints:
- conversations seen vs member of, per type (public, private, group DM)
- the report below

`--from-cache` prints only the report, from the saved list, without touching Slack or the token. The report has five sections:
1. conversations matched per business unit and sub-group
2. channels matched by more than one rule, with every rule that matched and which one won, marked `[DIFFERENT targets]` when the rules disagree
3. channels still unplaced, busiest first
4. group DMs active in the last 30 days that are not assigned, with their full member names
5. group DMs from the config that are not matched: an ID that is no longer in the saved list, a group DM whose members changed, and every entry in `pendingGroupDms` with its candidates

Members whose user ID could not be resolved to a name (usually people from another workspace, whom `users.list` does not return) show as raw IDs like `U0123ABCD`. For those group DMs the report adds the handles from the group DM's internal name (`mpdm-alex--sam-1`), which usually identify them.

Last activity costs one API call per conversation, and each group DM needs one more call for its members, so with a few hundred conversations this step takes 10 to 15 minutes. `--no-activity` skips the last-activity call. `slack-measure.js` only measures conversations in this saved list, so a channel left out here (for example a public channel you are not in, without `--all`) is not measured even if a rule matches it.

## Step 2: write the business-unit rules
Copy the example and edit it (the real file is git-ignored because channel IDs, unit names and member names are private):
```bash
cp config/slack-bus.example.json config/slack-bus.json
```
Units have two levels: a business unit (`bu`) and an optional sub-group (`sub`). Reports show each business unit with its sub-groups under it.

| Key | Meaning |
|---|---|
| `rules` | Ordered list for public and private channels. Each rule has `bu`, optional `sub`, and exactly one of: `name` (an exact channel name, or a list of them), `prefix`, `glob` (`*` means "anything" and the pattern must match the whole name, so `*-coordination*` matches `acme-coordination`) or `regex`. All are case-insensitive. **The first matching rule wins**, so put exact names before broad prefixes and patterns. |
| `overrides` | `{ "<channel ID>": { "bu": "...", "sub": "..." } }`. Beats every rule. A value of `null` leaves the channel out on purpose (it stops showing up as unplaced). |
| `groupDms` | `{ "<group DM ID>": { "bu", "sub", "label", "members" } }`. Group DMs are measured **only** if listed here, and only by ID. `label` is how the group DM looks in your sidebar. `members` is the full member list (you included) that the ID was matched on; if a later listing shows different members, the report flags it in section 5 so the assignment can be re-checked. |
| `pendingGroupDms` | `[{ "label", "bu", "sub", "candidates": [IDs], "note" }]`. Group DMs you want assigned but that are not decided yet. They are never measured; the report lists them with each candidate's members until you move the right ID into `groupDms`. |

Keys that start with `_` are comments. After editing, check the result with `node scripts/slack-channels.js --from-cache`. The rules are also re-applied every time step 3 runs, so you only need to list channels from Slack again when channels or group DMs are added.

**Why group DMs are matched by ID and full member set, never by name:** Slack's sidebar shortens group DM names ("Alex Rivera, Sam Ok..."), and the same people are in many group DMs, so a partial name often fits several of them. Only the ID is unique; the recorded member set lets a person check the match and lets the script notice when it changes.

## Step 3: measure
```bash
node scripts/slack-measure.js                                   # last 7 full days
node scripts/slack-measure.js --days 14 --in-price 0.15 --out-price 0.60
```
| Option | Default | Meaning |
|---|---|---|
| `--days N` | 7 | How many full days before today to measure (1 to 90). Today is excluded because it is incomplete. |
| `--thread-lookback N` | 30 | How far back to look for thread starters whose replies fall inside the window (see below). |
| `--out-tokens N` | 1500 | Assumed digest output per business unit per day, used for cost and time. This is a guess, not a measurement. |
| `--in-price`, `--out-price` | none | USD per million input and output tokens. Give both to get a daily and monthly cost. |

The report shows:
- tokens per day for every day in the window
- the average day vs the peak day, and the bot share
- a table per business unit, with a row for each sub-group under it
- the top 10 channels
- channels with no activity
- channels it could not read
- a local-model time estimate (about 65 tokens/s reading, 12 tokens/s writing, plus how many 8,000-character helper calls a day would take)
- the cloud cost, if prices are given

It ends with the API call count and the runtime. The counts per channel per day are saved to `data/slack-measure-<date>.json` (git-ignored, mode 600) so runs can be compared.

## What is counted
- **Messages** in the window, including thread replies. Join, leave, topic, pin and similar housekeeping events are skipped. Replies that were also sent to the channel are counted once.
- **Characters** are the message text plus legacy attachment text (pretext, title, text), which is where many bots post. File contents are not counted.
- **Estimated tokens** are characters divided by 4. Raw Slack markup such as `<@U123>` mentions and long links makes this a slight overestimate of what a cleaned-up digest would send.
- **Threads** are, per day, the number of distinct threads that got at least one reply that day.
- **Days** are local calendar days on this Mac.

**Thread lookback:** Slack's channel history only returns a thread if its first message falls inside the window, so a thread started two weeks ago with replies yesterday would be missed. The script therefore reads history back `--thread-lookback` days. It counts only messages inside the window, and it fetches the replies of any older thread whose latest reply is inside the window. Raising the lookback costs more API calls.

## Speed and rate limits
Calls are spaced a little under Slack's published limits (about 20/min for listing, about 50/min for history and replies). If Slack still answers 429, the script waits as long as the `Retry-After` header says and prints that it is waiting. Expect roughly one history call per channel per 200 messages over the lookback period, plus one call per active thread.

If history calls are much slower than this (each 429 asking for about a minute), the token probably belongs to a Slack app that is distributed outside the Slack Marketplace. Since 2025 Slack limits those apps' history calls to about one per minute. An internal app built for your own workspace is not affected.

## Troubleshooting
| Message | Meaning |
|---|---|
| `must be a regular file with mode 600` | `chmod 600 ~/.lab/slack-token` |
| `missing_scope` | The token lacks one of the scopes above |
| `not_in_channel` / `channel_not_found` for a channel | The token's user cannot read it; it is listed under "Could not read" and left out of the totals |
| `config/slack-bus.json not found` | Copy the example (step 2) |
