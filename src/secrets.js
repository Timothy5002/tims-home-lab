'use strict';
// Reads a secret from ~/.lab/<name>. Shared by the Slack client and the OpenRouter client so every secret
// gets the same check: a regular file that nobody but this user can read (mode 600), and not empty.
// The value is returned to the caller only; it is never printed or logged here.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LAB_DIR = path.join(os.homedir(), '.lab');

// dir is only for the self-test (scripts/digest-selftest.js); real callers always use ~/.lab.
function readSecret(name, dir = LAB_DIR) {
  const file = path.join(dir, name);
  const st = fs.statSync(file);
  if (!st.isFile() || (st.mode & 0o077) !== 0) throw new Error(`~/.lab/${name} must be a regular file with mode 600`);
  const v = fs.readFileSync(file, 'utf8').trim();
  if (!v) throw new Error(`~/.lab/${name} is empty`);
  return v;
}

module.exports = { readSecret, LAB_DIR };
