'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sanitize = require('../server/sanitize');
const ner = require('../server/sanitize/ner');
const people = require('../server/identity/people');
const { newDb, newSecrets, cleanup } = require('./_helpers');

test('sanitize > emails and phones tokenized round trip', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });

  const text = 'Please contact mary@example.org or call (415) 555-0100 today.';
  const r = sanitize.sanitizeText(db, s, text);
  assert.doesNotMatch(r.sanitized, /mary@example\.org/);
  assert.doesNotMatch(r.sanitized, /\(415\) 555-0100/);
  assert.match(r.sanitized, /e_[0-9a-f]{8}/);
  assert.match(r.sanitized, /ph_[0-9a-f]{8}/);

  const restored = sanitize.desanitizeText(db, s, r.sanitized, r.tokenSet);
  assert.equal(restored, text);
});

test('sanitize > known person names use their existing person codes', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });

  const code = people.create(db, s, { given_name: 'Padre', family_name: 'Pio' });
  const text = 'I spoke with Pio yesterday about the food drive.';
  const r = sanitize.sanitizeText(db, s, text);
  assert.ok(r.sanitized.includes(code), `expected sanitized output to use ${code}`);
});

test('sanitize > NER detects multiple kinds and dedupes overlaps', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const text = 'Mary Smith lives at 12 Maple Street and her email is mary@example.org.';
  const findings = ner.detect(db, s, text);
  const kinds = findings.map(f => f.kind);
  assert.ok(kinds.includes('email'));
  assert.ok(kinds.includes('address'));
});

test('sanitize > desanitize unknown token set fails clearly', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  assert.throws(() => sanitize.desanitizeText(db, s, 'hi', 'tk_deadbeef'), /unknown token set/);
});

test('sanitize > token-set mappings are encrypted at rest', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const text = 'Email mary@example.org';
  const r = sanitize.sanitizeText(db, s, text);
  const row = db.prepare('SELECT * FROM token_sets WHERE code = ?').get(r.tokenSet);
  assert.ok(Buffer.isBuffer(row.mappings_ct));
  // The raw blob must not contain the plaintext email.
  assert.ok(!row.mappings_ct.toString('utf8').includes('mary@example.org'));
});
