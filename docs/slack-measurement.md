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
```
It asks Slack for every public channel, private channel and group DM the token can see (archived ones excluded). By default it then keeps only the ones the token's user is a **member of**, using the `is_member` field from that same list, so the filter costs no extra calls. Public channels you are not in are usually not digest material, and skipping them saves one call each. `--all` keeps them.

For each kept conversation it records the ID, name, type, member count and last activity, plus member names for group DMs. It saves this to `data/slack-channels.json` (git-ignored, mode 600) and prints:
- conversations seen vs member of, per type (public, private, group DM)
- channel counts per business unit
- channels it could not place (sorted by last activity, so the busy ones come first)
- group DMs that are not included, with their members, so you can pick the ones that matter

Last activity costs one API call per conversation, and each group DM needs one more call for its members, so with a few hundred conversations this step takes 10 to 15 minutes. `--no-activity` skips the last-activity call. `slack-measure.js` only measures conversations in this saved list, so a channel left out here (for example a public channel you are not in, without `--all`) is not measured even if a rule matches it.

## Step 2: write the business-unit rules
Copy the example and edit it (the real file is git-ignored because channel IDs and unit names are private):
```bash
cp config/slack-bus.example.json config/slack-bus.json
```
| Key | Meaning |
|---|---|
| `rules` | List of `{ "bu": "<unit>", "prefix": "<text>" }` or `{ "bu": "<unit>", "regex": "<pattern>" }`. Applies to public and private channels; first match wins; case-insensitive. |
| `overrides` | `{ "<channel ID>": "<unit>" }`. Beats the rules. A value of `null` leaves the channel out on purpose (it stops showing up as unplaced). |
| `groupDms` | `{ "<group DM ID>": "<unit>" }`. Group DMs are measured **only** if listed here. |

Keys that start with `_` are comments. Re-run step 1 to check the result. Step 2's rules are re-applied every time step 3 runs, so you only need to re-list channels when channels are added.

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
- a per-business-unit table
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
