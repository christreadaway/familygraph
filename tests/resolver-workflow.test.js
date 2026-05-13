'use strict';

// End-to-end exercise of the resolver conflict queue against a synthetic
// three-family tree. Walks the operator's actual workflow:
//   1. Import builds the tree.
//   2. Periodic duplicate-scan opens conflicts.
//   3. Operator picks merge / reject / dismiss, with notes.
//   4. Family split moves a person out of a wrong household.
//   5. Alias chain resolves through the merge.

const test = require('node:test');
const assert = require('node:assert/strict');

const people = require('../server/identity/people');
const families = require('../server/identity/families');
const importPipeline = require('../server/identity/import');
const resolver = require('../server/identity/resolver');
const conflictsMod = require('../server/identity/conflicts');
const aliases = require('../server/identity/aliases');
const contacts = require('../server/identity/contacts');
const { newDb, newSecrets, defaultThresholds, cleanup } = require('./_helpers');

function buildTree(db, s, t_) {
  // Three families:
  //  - Smith household: Mary (parent, DOB), John (parent), Lucy (child)
  //  - Torre household: same address as Smith — blended household next door
  //  - Wojtyła household: unrelated
  const r1 = importPipeline.importRow(db, s, t_, {
    family: { display_name: 'Smith' },
    persons: [
      { given_name: 'Mary',  family_name: 'Smith', date_of_birth: '1985-04-12', role: 'parent' },
      { given_name: 'John',  family_name: 'Smith', role: 'parent' },
      { given_name: 'Lucy',  family_name: 'Smith', role: 'child' },
    ],
    address: { line1: '12 Maple Ave', city: 'Lima', region: 'OH', postal: '45801' },
  }, { source: 'parish_directory' });

  const r2 = importPipeline.importRow(db, s, t_, {
    family: { display_name: 'Torre-Smith' },
    persons: [
      { given_name: 'Anna',  family_name: 'Torre', role: 'parent' },
    ],
    address: { line1: '14 Maple Ave', city: 'Lima', region: 'OH', postal: '45801' },
  }, { source: 'parish_directory' });

  const r3 = importPipeline.importRow(db, s, t_, {
    family: { display_name: 'Wojtyła' },
    persons: [
      { given_name: 'Karol', family_name: 'Wojtyła', role: 'parent' },
    ],
    address: { line1: '500 Oak St', city: 'Lima', region: 'OH', postal: '45801' },
  }, { source: 'parish_directory' });

  return { r1, r2, r3 };
}

test('workflow > merge resolves a duplicate Mary from a second source', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const t_ = defaultThresholds();
  const { r1 } = buildTree(db, s, t_);
  const maryCode = r1.persons[0].code;

  // School roster imports Mary with the same DOB — definitive auto-merge,
  // so no conflict opens.
  const r4 = importPipeline.importRow(db, s, t_, {
    family: { display_name: 'Smith' },
    persons: [{ given_name: 'Mary', family_name: 'Smith', date_of_birth: '1985-04-12', role: 'parent' }],
  }, { source: 'school_roster' });
  assert.equal(r4.persons[0].action, 'attached');
  assert.equal(r4.persons[0].code, maryCode);

  // A second Mary lands later WITHOUT a DOB — the import resolver lacks a
  // definitive signal, so it enqueues a conflict.
  const r5 = importPipeline.importRow(db, s, t_, {
    family: { display_name: 'Smith' },
    persons: [{ given_name: 'Mary', family_name: 'Smith', role: 'parent' }],
  }, { source: 'school_roster' });
  assert.equal(r5.persons[0].action, 'enqueued');
  const conflict = r5.persons[0].conflict;
  assert.ok(conflict);

  // Operator merges the duplicate into the original.
  const winner = conflictsMod.resolveMerge(db, s, conflict, {
    winnerCode: maryCode,
    actor: 'operator',
    notes: 'same parent, school roster missed the DOB column',
  });
  assert.equal(winner, maryCode);

  // The loser code redirects to the winner via alias.
  assert.equal(aliases.resolveAlias(db, r5.persons[0].code), maryCode);

  // Status reflects the merge plus notes.
  const closed = conflictsMod.list(db, { status: 'merged' });
  assert.equal(closed.length, 1);
  assert.equal(closed[0].resolved_by, 'operator');
  assert.match(closed[0].resolution_notes, /school roster missed the DOB/);
});

test('workflow > reject creates a sticky non-match that survives a rescore', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const t_ = defaultThresholds();

  // Two Pio Pietrelcinas — same name, different humans (father / son).
  const a = people.create(db, s, { given_name: 'Pio', family_name: 'Pietrelcina' });
  const b = people.create(db, s, { given_name: 'Pio', family_name: 'Pietrelcina' });

  resolver.rescorePerson(db, s, t_, b);
  const open = conflictsMod.list(db, { status: 'open' });
  assert.equal(open.length, 1);

  conflictsMod.resolveReject(db, open[0].code, {
    actor: 'operator',
    notes: 'father and son, confirmed via parish records',
  });

  // Re-running the scan must not re-open the pair.
  resolver.rescorePerson(db, s, t_, b);
  assert.equal(conflictsMod.list(db, { status: 'open' }).length, 0);
});

test('workflow > family split moves persons into a new household', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const t_ = defaultThresholds();
  const { r1 } = buildTree(db, s, t_);
  const familyCode = r1.family.code;
  const [maryCode, johnCode, lucyCode] = r1.persons.map(p => p.code);

  // The Smith household imported with Mary + John + Lucy; turns out Lucy
  // is fostered from another household and should be promoted to her own
  // family. Split moves her out.
  const newFamily = families.split(db, s, familyCode, [lucyCode], {
    displayName: 'Lucy (foster)',
    notes: 'Moved to her own household pending guardianship update',
  });
  assert.ok(newFamily);
  assert.notEqual(newFamily, familyCode);

  // Lucy's old membership is closed with reason='split'.
  const oldMembership = db
    .prepare(`SELECT ended_at, reason FROM memberships WHERE family_code = ? AND person_code = ?`)
    .get(familyCode, lucyCode);
  assert.ok(oldMembership.ended_at);
  assert.equal(oldMembership.reason, 'split');

  // Lucy has a new active membership in the new family.
  const newMembership = db
    .prepare(`SELECT * FROM memberships WHERE family_code = ? AND person_code = ? AND ended_at IS NULL`)
    .get(newFamily, lucyCode);
  assert.ok(newMembership);

  // Mary and John stay put.
  const maryStill = db
    .prepare(`SELECT 1 FROM memberships WHERE family_code = ? AND person_code = ? AND ended_at IS NULL`)
    .get(familyCode, maryCode);
  const johnStill = db
    .prepare(`SELECT 1 FROM memberships WHERE family_code = ? AND person_code = ? AND ended_at IS NULL`)
    .get(familyCode, johnCode);
  assert.ok(maryStill);
  assert.ok(johnStill);
});

test('workflow > alias chain follows through repeated merges (A → B → C)', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });

  // Three duplicates of the same person, merged in two steps. Final
  // resolveAlias must walk the chain back to C.
  const a = people.create(db, s, { given_name: 'Mary', family_name: 'Smith' });
  const b = people.create(db, s, { given_name: 'Mary', family_name: 'Smith' });
  const c = people.create(db, s, { given_name: 'Mary', family_name: 'Smith' });

  people.merge(db, s, a, b);          // A → B
  assert.equal(aliases.resolveAlias(db, a), b);

  people.merge(db, s, b, c);          // B → C — A must follow
  assert.equal(aliases.resolveAlias(db, a), c, 'alias chain follows the second merge');
  assert.equal(aliases.resolveAlias(db, b), c);
  assert.equal(aliases.resolveAlias(db, c), c);
});

test('workflow > merge carries memberships, emails, and phones onto the winner', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const t_ = defaultThresholds();

  const { r1 } = buildTree(db, s, t_);
  const maryCode = r1.persons[0].code;

  // A second Mary record with a different email + phone attached.
  const duplicateMary = people.create(db, s, { given_name: 'Mary', family_name: 'Smith' });
  const ec = contacts.upsertEmail(db, s, 'mary.smith@example.org');
  contacts.attachEmailToPerson(db, duplicateMary, ec);
  const pc = contacts.upsertPhone(db, s, '555-867-5309');
  contacts.attachPhoneToPerson(db, duplicateMary, pc);

  people.merge(db, s, duplicateMary, maryCode);

  const winnerEmails = db.prepare(
    `SELECT 1 FROM person_emails WHERE person_code = ? AND email_code = ?`
  ).get(maryCode, ec);
  const winnerPhones = db.prepare(
    `SELECT 1 FROM person_phones WHERE person_code = ? AND phone_code = ?`
  ).get(maryCode, pc);
  assert.ok(winnerEmails, 'email carried to winner');
  assert.ok(winnerPhones, 'phone carried to winner');

  // The loser row is marked merged and points at the winner.
  const loserRow = db.prepare('SELECT status, merged_into FROM persons WHERE code = ?').get(duplicateMary);
  assert.equal(loserRow.status, 'merged');
  assert.equal(loserRow.merged_into, maryCode);
});

test('workflow > dismiss closes a conflict without merging', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const t_ = defaultThresholds();

  const a = people.create(db, s, { given_name: 'Pio', family_name: 'Pietrelcina' });
  const b = people.create(db, s, { given_name: 'Pio', family_name: 'Pietrelcina' });
  resolver.rescorePerson(db, s, t_, b);
  const open = conflictsMod.list(db, { status: 'open' });
  assert.equal(open.length, 1);

  conflictsMod.resolveDismiss(db, open[0].code, { actor: 'operator', notes: 'low signal' });
  assert.equal(conflictsMod.list(db, { status: 'open' }).length, 0);
  assert.equal(conflictsMod.list(db, { status: 'dismissed' }).length, 1);

  // Both persons still exist as active; nothing was merged.
  const aRow = db.prepare(`SELECT status FROM persons WHERE code = ?`).get(a);
  const bRow = db.prepare(`SELECT status FROM persons WHERE code = ?`).get(b);
  assert.equal(aRow.status, 'active');
  assert.equal(bRow.status, 'active');
});
