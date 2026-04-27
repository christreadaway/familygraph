'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const SCHEMA_VERSION = 1;

function open(dbPath, options = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(dbPath, { fileMustExist: false, ...options });
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  return db;
}

function migrate(db) {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
  const current = row && row.v ? row.v : 0;
  if (current < SCHEMA_VERSION) {
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
  }
  return SCHEMA_VERSION;
}

function init(dbPath) {
  const db = open(dbPath);
  migrate(db);
  return db;
}

module.exports = { open, migrate, init, SCHEMA_VERSION };
