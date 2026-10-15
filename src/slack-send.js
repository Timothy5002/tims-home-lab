'use strict';
// Send-only Slack client for the digest's DM delivery. It uses the bot token of the same Slack app whose user
// token src/slack.js reads with; the bot token is read only from ~/.lab/slack-bot-token (mode 600) and only ever
// goes in the Authorization header.
//
// It can do exactly one thing: open the DM between the bot and ONE configured user, check that the DM belongs to
// that user, then post a message and upload a file into that DM. Every other method, channel or upload host is
// refused in code. It never reads conversations, never listens to events, never replies to anyone, and never
// logs message text, file contents or the token. Scopes it needs: chat:write, im:write, files:write.
const { readSecret } = require('./secrets');

const API = 'https://slack.com/api';
// The only methods this client may call. conversations.open (im:write) opens the bot's DM with the recipient;
// the others post into that DM.
const METHODS = new Set(['conversations.open', 'chat.postMessage', 'files.getUploadURLExternal', 'files.completeUploadExternal']);
const USER_ID = /^[UW][A-Z0-9]{6,}$/;

class DeliveryError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.code = code; // short reason code for stats and the healthcheck ping
  }
}

// recipient: the one Slack user ID allowed (from git-ignored config). fetchImpl and tokenReader are for tests.
function createSender({ recipient, fetchImpl = fetch, tokenReader = () => readSecret('slack-bot-token') }) {
  if (!USER_ID.test(String(recipient ?? ''))) throw new DeliveryError('bad-recipient', 'deliverTo must be a Slack user ID');
  let token;
  try { token = tokenReader(); } catch { throw new DeliveryError('bot-token', '~/.lab/slack-bot-token must be a regular, non-empty file with mode 600'); }
  let dm = null; // the verified DM channel ID; nothing is posted until it is set
  const stats = { calls: 0 };

  async function call(method, params, { json = false } = {}) {
    if (!METHODS.has(method)) throw new DeliveryError('refused-method', `refusing to call ${method}`);
    stats.calls++;
    let res;
    try {
      res = await fetchImpl(`${API}/${method}`, {
        method: 'POST',
        headers: json
          ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }
          : { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: json ? JSON.stringify(params) : new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new DeliveryError('network', `${method}: network error (${e.cause?.code ?? e.name})`);
    }
    if (res.status === 429) throw new DeliveryError('rate-limited', `${method}: HTTP 429`);
    if (!res.ok) throw new DeliveryError(`http-${res.status}`, `${method}: HTTP ${res.status}`);
    const body = await res.json();
    // Slack's error codes (missing_scope, not_authed, channel_not_found...) carry no message text.
    if (!body.ok) throw new DeliveryError(String(body.error ?? 'slack-error').slice(0, 60), `${method}: ${body.error}`);
    return body;
  }

  // Opens (or finds) the DM with the recipient and checks Slack's answer: a 1:1 DM whose other member is the
  // recipient. Anything else is refused and nothing is posted.
  async function openDm() {
    const body = await call('conversations.open', { users: recipient, return_im: 'true' });
    const ch = body.channel ?? {};
    if (!/^D[A-Z0-9]+$/.test(String(ch.id ?? '')) || ch.is_im !== true || ch.user !== recipient) {
      throw new DeliveryError('dm-mismatch', 'conversations.open did not return a 1:1 DM with the configured user');
    }
    dm = ch.id;
    return dm;
  }

  const requireDm = () => { if (!dm) throw new DeliveryError('dm-not-verified', 'open and verify the DM first'); return dm; };

  // Posts text into the verified DM. There is no channel argument: the DM is the only possible target.
  async function postText(text) {
    const channel = requireDm();
    const body = await call('chat.postMessage', { channel, text, unfurl_links: false, unfurl_media: false }, { json: true });
    if (body.channel !== channel) throw new DeliveryError('dm-mismatch', 'chat.postMessage answered for another channel');
    return { ts: body.ts };
  }

  // Uploads a file into the verified DM: get an upload URL, send the bytes there, then share it into the DM.
  async function uploadFile(filename, bytes, title) {
    const channel = requireDm();
    const got = await call('files.getUploadURLExternal', { filename, length: String(bytes.length) });
    let host;
    try { host = new URL(got.upload_url); } catch { throw new DeliveryError('bad-upload-url', 'upload URL is not a URL'); }
    // The bytes go only to Slack's own upload host, and the token is not sent there.
    if (host.protocol !== 'https:' || !/(^|\.)slack\.com$/.test(host.hostname)) throw new DeliveryError('bad-upload-url', 'upload URL is not on slack.com');
    let res;
    try {
      res = await fetchImpl(host.toString(), {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes, signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw new DeliveryError('network', `upload: network error (${e.cause?.code ?? e.name})`);
    }
    if (!res.ok) throw new DeliveryError(`upload-http-${res.status}`, `upload: HTTP ${res.status}`);
    stats.calls++;
    await call('files.completeUploadExternal', { files: [{ id: got.file_id, title }], channel_id: channel }, { json: true });
    return { fileId: got.file_id };
  }

  return { openDm, postText, uploadFile, stats, get dm() { return dm; } };
}

// Slack mrkdwn: &, < and > must be escaped in any text that is not a link we built.
const escapeMrkdwn = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

module.exports = { createSender, escapeMrkdwn, DeliveryError, METHODS };
