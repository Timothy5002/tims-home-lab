# Slack digest: how to run it

The design, rules and phases are in [slack-digest-design.md](slack-digest-design.md). This page covers what is built and how to run it. **Built so far: phase 0 (groundwork).** Phase 1 adds the code-only digest.

## Files and secrets
| What | Where | Notes |
|---|---|---|
| Slack user token (read-only) | `~/.lab/slack-token` | mode 600; shared with the measurement scripts |
| DeepSeek API key | `~/.lab/deepseek-key` | mode 600; never printed, logged or committed |
| Unit rules and the external rule | `config/slack-bus.json` | git-ignored; template `config/slack-bus.example.json` |
| Digest settings (workspace URL, window, caps) | `config/slack-digest.json` | git-ignored; template `config/slack-digest.example.json` |
| Workspace-specific notes, open questions | `docs/private/` | git-ignored |

## Check the DeepSeek setup
```bash
node scripts/deepseek-check.js
```
This uses invented text only. It lists the model ids the key can use and makes one JSON call with thinking off. It prints the model id that answered, token usage, the estimated cost, and the price that applies at the 06:00 run time. Only those figures are printed, never the key. HTTP 401 means DeepSeek rejected the key: create a new one on DeepSeek's platform and save it with `umask 077; pbpaste > ~/.lab/deepseek-key`.

## Self-tests
```bash
node scripts/digest-selftest.js
```
Run this after changing masking (`src/mask.js`), the DeepSeek client (`src/deepseek.js`) or bot compression. Everything in it is invented, and it makes no network calls: the DeepSeek tests use a fake API. It covers:
- masking: emails (plain, in angle brackets, Slack `<mailto:…|…>`), phone numbers with dashes, dots, spaces, brackets and `+` codes, long numbers, URLs with queries or tokens, secret-looking strings, and things that must **not** be masked (dates, amounts, versions, mentions)
- the secret-file check (loose mode refused, empty file refused)
- the DeepSeek guards: request shape, key only in the header, input cap, 429 with `Retry-After`, 5xx, empty and invalid JSON, 401, timeout, peak and off-peak rates, cost arithmetic

## Which conversations are masked
```bash
node scripts/slack-channels.js --from-cache
```
Section 6 of that report lists the **external** conversations by unit and sub-group, with counts. Their text is masked before any model call. External means either:
- **the unit rule:** `external` in `config/slack-bus.json` lists units and internal name prefixes, and a conversation in one of those units whose name lacks an internal prefix is external
- **Slack's own flag:** Slack marks the conversation as shared with another organization (`is_ext_shared`)

Listings saved before this field was recorded don't have it, and the report says so. The next full channel listing records it, with no extra Slack calls.
