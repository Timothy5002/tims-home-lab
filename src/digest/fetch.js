'use strict';
// Fetches one conversation's messages for the digest window with the read-only Slack client (src/slack.js).
// Top-level messages come from conversations.history. Thread replies come from conversations.replies, for any
// thread whose latest reply falls in the window, including threads started up to the lookback before it.
// Messages stay in memory; nothing is written or logged here.
const { SKIP_SUBTYPES, SlackError, messageText, isBot } = require('../slack');

function toMessage(conv, m, extra = {}) {
  return {
    conv: conv.id,
    ts: m.ts,
    threadTs: m.thread_ts ?? null,
    user: m.user ?? null,
    bot: isBot(m),
    botKey: m.bot_id || m.username || m.subtype || 'bot',
    botName: m.bot_profile?.name || m.username || null,
    text: messageText(m),
    replyCount: m.reply_count ?? 0,
    ...extra,
  };
}

// Returns { messages, parents, error }. messages are in the window; parents maps a thread's ts to its first
// message (which may be older than the window) so the digest can name the thread.
async function fetchConversation(slack, conv, { windowStart, windowEnd, lookbackStart }) {
  const messages = [];
  const parents = new Map();
  const threads = [];
  const inWindow = (ts) => Number(ts) >= windowStart && Number(ts) < windowEnd;
  try {
    await slack.paginate('conversations.history',
      { channel: conv.id, oldest: String(lookbackStart), latest: String(windowEnd), limit: '200' }, 'messages', (page) => {
        for (const m of page) {
          if (SKIP_SUBTYPES.has(m.subtype)) continue;
          // Replies also sent to the channel appear in history and in the thread; take them from the thread.
          if (inWindow(m.ts) && m.subtype !== 'thread_broadcast') messages.push(toMessage(conv, m));
          if (m.reply_count > 0 && Number(m.latest_reply) >= windowStart) {
            threads.push(m.ts);
            parents.set(m.ts, toMessage(conv, m, { context: !inWindow(m.ts) }));
          }
        }
      });
    for (const ts of threads) {
      await slack.paginate('conversations.replies',
        { channel: conv.id, ts, oldest: String(windowStart), latest: String(windowEnd), limit: '200' }, 'messages', (page) => {
          for (const m of page) {
            if (m.ts === ts || SKIP_SUBTYPES.has(m.subtype) || !inWindow(m.ts)) continue;
            messages.push(toMessage(conv, m, { threadTs: ts, isReply: true }));
          }
        });
    }
  } catch (e) {
    if (!(e instanceof SlackError)) throw e;
    return { messages: [], parents: new Map(), error: e.code };
  }
  return { messages, parents, error: null };
}

module.exports = { fetchConversation };
