'use strict';

// MissionIQ import robustness (fg-miq):
//  - the MissionIQ file is read as one snapshot, so a family and its contact
//    written by a running MissionIQ between two SELECTs are never split into
//    an orphan one-person household;
//  - an operator answer that contradicts another answer (attach to someone
//    already marked "leave out") never throws away every answer: that one
//    item is asked again and the rest are kept.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');

const missioniq = require('../server/identity/missioniq');
const { newDb, newSecrets, defaultThresholds, cleanup, tmpDir } = require('./_helpers');

function setup(t) {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  return { db, secrets, th: defaultThresholds(), dir };
}

const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

function fakeMissionIQ(dir, { families = [], contacts = [], children = [] }) {
  const p = path.join(dir, `missioniq-${crypto.randomBytes(4).toString('hex')}.sqlite`);
  const m = new Database(p);
  // MissionIQ itself runs in WAL mode.
  m.pragma('journal_mode = WAL');
  m.exec(`
    CREATE TABLE families (id TEXT PRIMARY KEY, family_name TEXT, address_line1 TEXT, city TEXT, state TEXT, zip TEXT,
      deceased INTEGER DEFAULT 0, fg_family_code TEXT, created_at TEXT DEFAULT '2026-01-01 00:00:00');
    CREATE TABLE contacts (id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, email TEXT, phone TEXT,
      family_id TEXT, role TEXT DEFAULT 'parent', relationship TEXT DEFAULT 'parent', birthday TEXT,
      fg_person_code TEXT, created_at TEXT DEFAULT '2026-01-01 00:00:00');
    CREATE TABLE children (id INTEGER PRIMARY KEY AUTOINCREMENT, family_id TEXT NOT NULL, first_name TEXT,
      last_name TEXT, grade TEXT, birthday TEXT, enrolled INTEGER DEFAULT 1);
  `);
  const ins = (table, row) => {
    const cols = Object.keys(row);
    m.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map(c => row[c]));
  };
  families.forEach(f => ins('families', f));
  contacts.forEach(c => ins('contacts', c));
  children.forEach(k => ins('children', k));
  m.close();
  return p;
}

// ---------------------------------------------------------------------------
// 37: one snapshot
// ---------------------------------------------------------------------------

test('read > a family written between the families and contacts reads is not split into an orphan household', t => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const p = fakeMissionIQ(dir, {
    families: [{ id: 'fam-a', family_name: 'Adams Family' }],
    contacts: [{ id: 'c-1', first_name: 'Ann', last_name: 'Adams', family_id: 'fam-a' }],
  });
  // A running MissionIQ: keep a writer connection open (so the WAL stays).
  const writer = new Database(p);
  writer.pragma('journal_mode = WAL');
  t.after(() => writer.close());

  // Land a MissionIQ write in the gap just before the contacts SELECT.
  const realPrepare = Database.prototype.prepare;
  let wrote = false;
  Database.prototype.prepare = function (sql) {
    if (this !== writer && !wrote && /FROM contacts/.test(sql)) {
      wrote = true;
      writer.prepare("INSERT INTO families (id, family_name) VALUES ('fam-b', 'Baker Family')").run();
      writer.prepare("INSERT INTO contacts (id, first_name, last_name, family_id) VALUES ('c-2', 'Bea', 'Baker', 'fam-b')").run();
    }
    return realPrepare.call(this, sql);
  };
  let out;
  try {
    out = missioniq.readMissionIQ(p);
  } finally {
    Database.prototype.prepare = realPrepare;
  }
  assert.equal(wrote, true, 'the concurrent write happened mid-read');
  assert.equal(out.stats.contacts_without_family, 0, 'no contact is orphaned by a torn read');
  assert.equal(out.households.every(h => h.ref), true, 'every household keeps its MissionIQ family ref');
  // The snapshot is the one from before the write; the next run picks it up whole.
  assert.equal(out.stats.families, 1);
  const next = missioniq.readMissionIQ(p);
  assert.equal(next.stats.families, 2);
  assert.equal(next.stats.contacts_without_family, 0);
});

// ---------------------------------------------------------------------------
// 38: a contradictory answer is asked again; the rest are kept
// ---------------------------------------------------------------------------

// Two placeholder students in two households: both wait for a human, and the
// second offers the first (a person new in this import) as a candidate.
const TBD = {
  families: [
    { id: 'fam-a', family_name: 'Lee Family' },
    { id: 'fam-b', family_name: 'Lee-Park Family' },
  ],
  contacts: [
    { id: 'c-1', first_name: 'Grace', last_name: 'Lee', email: 'grace@example.org', family_id: 'fam-a' },
    { id: 'c-2', first_name: 'Henry', last_name: 'Park', email: 'henry@example.org', family_id: 'fam-b' },
  ],
  children: [
    { family_id: 'fam-a', first_name: 'TBD', last_name: 'Lee', grade: '3' },
    { family_id: 'fam-b', first_name: 'TBD', last_name: 'Lee', grade: '3' },
  ],
};

test('runImport > attaching to a person already left out is re-asked, and the other answers are kept', async t => {
  const ctx = setup(t);
  const mdir = tmpDir();
  t.after(() => cleanup(mdir));
  const p = fakeMissionIQ(mdir, TBD);

  const asked = [];
  const events = [];
  let secondFirstTime = true;
  const r = await missioniq.runImport({
    db: ctx.db, secrets: ctx.secrets, thresholds: ctx.th, dbPath: p, actor: 'test',
    say: ev => events.push(ev),
    decide: item => {
      asked.push(item.key);
      if (asked.length === 1) return missioniq.parseAnswer(item, 's');
      if (secondFirstTime) {
        secondFirstTime = false;
        const i = (item.candidates || []).findIndex(c => c.sheet_ref === asked[0]);
        assert.ok(i >= 0, 'the left-out person is offered as a candidate');
        return missioniq.parseAnswer(item, String(i + 1));
      }
      return missioniq.parseAnswer(item, 'n');
    },
    confirm: () => true,
  });

  assert.equal(r.status, 'committed', 'the import still completes');
  assert.equal(asked.length, 3, 'only the contradictory item is asked again');
  assert.equal(asked[2], asked[1]);
  const c = events.find(e => e.type === 'contradiction');
  assert.ok(c, 'the operator is told which answer was contradictory');
  assert.equal(c.item.key, asked[1]);
  assert.match(c.message, /left out/);
  assert.equal(r.result.summary.persons.skipped, 1, 'the "leave out" answer was kept');
  // Two adults plus the one kept student.
  assert.equal(count(ctx.db, 'persons'), 3);
});

test('runImport > an error that names no answer still stops the import', async t => {
  const ctx = setup(t);
  const mdir = tmpDir();
  t.after(() => cleanup(mdir));
  const p = fakeMissionIQ(mdir, TBD);
  await assert.rejects(missioniq.runImport({
    db: ctx.db, secrets: ctx.secrets, thresholds: ctx.th, dbPath: p, actor: 'test',
    decide: () => ({ action: 'bogus' }),
    confirm: () => true,
  }), /action must be/);
  assert.equal(count(ctx.db, 'persons'), 0, 'nothing written');
});

function runCli(home, args, input) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, FAMILY_GRAPH_HOME: home };
    delete env.FAMILY_GRAPH_DB;
    delete env.FAMILY_GRAPH_SECRET;
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'family-graph.js'), ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('cli > import-missioniq re-asks a contradictory answer instead of exiting', async t => {
  const home = tmpDir();
  t.after(() => cleanup(home));
  const mdir = tmpDir();
  t.after(() => cleanup(mdir));
  const p = fakeMissionIQ(mdir, TBD);

  // "s" for the first student, "1" (the first student) for the second, then
  // "n" when the second is asked again, then YES.
  const run = await runCli(home, ['import-missioniq', p], 's\n1\nn\nYES\n');
  assert.equal(run.code, 0, run.stderr + run.stdout);
  assert.doesNotMatch(run.stderr, /error:/);
  assert.match(run.stdout, /conflicts with another answer/);
  assert.match(run.stdout, /your other answers are kept/);
  assert.match(run.stdout, /Done\. Written to Family Graph:/);
  assert.match(run.stdout, /1 left out/);
});
