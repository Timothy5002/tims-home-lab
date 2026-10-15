'use strict';
// Masks personal and secret-looking details in Slack text from external conversations before any of it is
// sent to a cloud model (docs/slack-digest-design.md, "Masking"). It works on a string in memory and returns
// the masked string; it never logs or stores text. Callers pass a counts object to tally what was masked by
// type, which is the only thing that may be logged.
//
// Order matters: secrets first (so a long token is not half-eaten as a [number]), then Slack link markup and
// URLs, then emails, phone numbers and finally long digit runs.

const TYPES = ['email', 'phone', 'number', 'url', 'secret'];

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,                              // OpenAI-style and similar API keys
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,                      // Slack tokens
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,           // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,                                  // AWS access key IDs
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWTs
  /\b[0-9a-fA-F]{32,}\b/g,                                  // long hex (hashes, keys)
];
// Long base64-like strings: only counted as secrets if they mix letters and digits (plain words never match).
const BASE64ISH = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/_-])/g;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /\bhttps?:\/\/[^\s<>|]+/g;
// A path segment that looks like a token: 20+ characters with both letters and digits.
const TOKENISH_SEGMENT = /[/=]([A-Za-z0-9_-]{20,})/;
// Phone candidates: optional +country, then digits separated by spaces, dots, dashes or brackets.
const PHONE_CANDIDATE = /(?<![\w+])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}(?:[\s.-]\d{2,4}){1,4}(?![\w])/g;
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}$|^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/;
const LONG_DIGITS = /\d{6,}/g;

const mixed = (s) => /[A-Za-z]/.test(s) && /\d/.test(s);

function newCounts() {
  return Object.fromEntries(TYPES.map((t) => [t, 0]));
}

function maskText(text, counts = newCounts()) {
  if (!text) return text ?? '';
  const hit = (type, replacement) => () => { counts[type]++; return replacement; };
  let s = String(text);

  // 1. Secrets
  for (const re of SECRET_PATTERNS) s = s.replace(re, hit('secret', '[secret]'));
  s = s.replace(BASE64ISH, (m) => (mixed(m) ? (counts.secret++, '[secret]') : m));

  // 2. Slack markup: <mailto:a@b|label> is an email whatever the label says; <url|label> keeps the label.
  s = s.replace(/<mailto:[^>|]+(?:\|[^>]*)?>/g, hit('email', '[email]'));
  s = s.replace(/<(https?:\/\/[^>|]+)\|([^>]*)>/g, (_, url, label) => `${label} (${url})`);
  s = s.replace(/<(https?:\/\/[^>|]+)>/g, '$1');

  // 3. URLs with a query string or a token-like segment
  s = s.replace(URL_RE, (match) => {
    // Trailing punctuation (a closing bracket, full stop, comma...) belongs to the sentence, not the URL.
    const [, u, tail] = /^(.*?)([).,;:!?'"]*)$/.exec(match);
    const tokenish = TOKENISH_SEGMENT.exec(u);
    if (u.includes('?') || (tokenish && mixed(tokenish[1]))) { counts.url++; return `[url]${tail}`; }
    return match;
  });

  // 4. Emails (plain, or in angle brackets like <a@b.com>)
  s = s.replace(EMAIL, hit('email', '[email]'));

  // 5. Phone numbers: 7 to 15 digits with separators, or a leading +; dates are left alone
  s = s.replace(PHONE_CANDIDATE, (m) => {
    const digits = m.replace(/\D/g, '');
    if (DATE_LIKE.test(m.trim()) || digits.length < 7 || digits.length > 15) return m;
    counts.phone++;
    return '[phone]';
  });

  // 6. Any remaining run of 6+ digits (IDs, account numbers)
  s = s.replace(LONG_DIGITS, hit('number', '[number]'));
  return s;
}

module.exports = { maskText, newCounts, MASK_TYPES: TYPES };
