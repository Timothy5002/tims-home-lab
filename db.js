'use strict';
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.join(__dirname, 'dispatcher.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job         TEXT,
    source      TEXT,
    started_at  TEXT NOT NULL,
    duration_ms INTEGER,
    exit_code   INTEGER,
    status      TEXT NOT NULL,
    output      TEXT
  );
`);

const insert = db.prepare(
  `INSERT INTO runs (job, source, started_at, duration_ms, exit_code, status, output)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);

function logRun({ job, source, startedAt, durationMs, exitCode, status, output }) {
  insert.run(job ?? null, source ?? null, startedAt, durationMs ?? null, exitCode ?? null, status, output ?? null);
}

module.exports = { logRun, db };
