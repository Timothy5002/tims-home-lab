'use strict';
// Sends one invented line to the digest's DM recipient (deliverTo in config/slack-digest.json) through the
// send-only client (src/slack-send.js), to check the bot token, its scopes and the DM check before a real run.
// Prints stats only: never the token or the recipient's ID. Usage: node scripts/digest-dm-test.js
const fs = require('node:fs');
const path = require('node:path');
const { createSender } = require('../src/slack-send');

(async () => {
  const started = Date.now();
  const stats = { status: 'failed' };
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'slack-digest.json'), 'utf8'));
    const sender = createSender({ recipient: cfg.deliverTo });
    await sender.openDm();
    stats.dmVerified = true;
    const text = `Lab digest delivery test (invented text), ${new Date().toISOString()}.`;
    await sender.postText(text);
    Object.assign(stats, { status: 'ok', messageChars: text.length, slackCalls: sender.stats.calls });
  } catch (e) {
    stats.code = e.code ?? 'error';
  }
  stats.runtimeMs = Date.now() - started;
  console.log(JSON.stringify(stats, null, 2));
  process.exit(stats.status === 'ok' ? 0 : 1);
})();
