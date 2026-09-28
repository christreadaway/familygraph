'use strict';

// Strict-mode surname-block pre-filter (resolver.js _strictBlockFilter).
//
// Roster imports score candidates with { strict: true }. Before enrichment,
// a candidate that ONLY the surname query found is dropped when scoreMatch
// could not give it a first-name reason, an exact birthdate, or a shared
// email / phone. These tests pin both halves: what gets dropped, and what
// must never be (typos, phonetic variants, nicknames, a matching birthdate,
// anyone another query found). Non-strict matching is untouched.

const test = require('node:test');
const assert = require('node:assert/strict');

const resolver = require('../server/identity/resolver');
const people = require('../server/identity/people');
const families = require('../server/identity/families');
const contacts = require('../server/identity/contacts');
const matching = require('../server/identity/matching');
const enc = require('../server/crypto/encryption');
const { newDb, newSecrets, cleanup } = require('./_helpers');

const STRICT = { strict: true, includeArchived: true };
const SIGNAL = /first_name|nickname_or_short_form|exact_date_of_birth|exact_email_match|exact_phone_match/;

function setup(t) {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  return { db, s };
}

const codesOf = list => list.map(c => c.code);
const byCode = (list, code) => list.find(x => x.candidate.code === code);

// What scoreMatch(strict) says about one stored person, with no pre-filter.
function fullScore(db, s, incoming, code) {
  const row = db.prepare('SELECT * FROM persons WHERE code = ?').get(code);
  return matching.scoreMatch(resolver.toMatcherRecord(incoming), resolver.enrichCandidate(db, s, row), { strict: true });
}

test('strict pre-filter > surname-only candidate with an unrelated first name and no shared DOB is dropped; non-strict keeps it', t => {
  const { db, s } = setup(t);
  const maria = people.create(db, s, { given_name: 'Maria', family_name: 'Garcia' });
  const paul = people.create(db, s, { given_name: 'Paul', family_name: 'Garcia', date_of_birth: '2010-01-01' });
  const incoming = { given_name: 'John', family_name: 'Garcia', date_of_birth: '2012-03-04' };

  // Premise: the full scorer gives neither of them anything but the surname.
  for (const code of [maria, paul]) {
    const r = fullScore(db, s, incoming, code);
    assert.equal(r.definitive, false);
    assert.ok(!r.reasons.some(x => SIGNAL.test(x)), `unexpected signal: ${r.reasons}`);
  }

  const strict = codesOf(resolver.findCandidates(db, s, incoming, STRICT));
  assert.ok(!strict.includes(maria));
  assert.ok(!strict.includes(paul));
  assert.deepEqual(resolver.scoreCandidates(db, s, incoming, STRICT), []);

  const loose = codesOf(resolver.findCandidates(db, s, incoming));
  assert.ok(loose.includes(maria), 'non-strict still returns the unrelated Garcia');
  assert.ok(loose.includes(paul));
  assert.equal(resolver.scoreCandidates(db, s, incoming).length, 2);
});

test('strict pre-filter > typo, phonetic, nickname and matching-DOB candidates are kept with the reason scoreMatch gives', t => {
  const { db, s } = setup(t);
  const jonh = people.create(db, s, { given_name: 'Jonh', family_name: 'Garcia' });
  const joan = people.create(db, s, { given_name: 'Joan', family_name: 'Garcia' });
  const jack = people.create(db, s, { given_name: 'Jack', family_name: 'Garcia' });
  const peter = people.create(db, s, { given_name: 'Peter', family_name: 'Garcia', date_of_birth: '2012-03-04' });
  const pedro = people.create(db, s, { given_name: 'Pedro', family_name: 'Garcia', date_of_birth: '3/4/2012' });
  const maria = people.create(db, s, { given_name: 'Maria', family_name: 'Garcia', date_of_birth: '2011-05-06' });
  const incoming = { given_name: 'John', family_name: 'Garcia', date_of_birth: '2012-03-04' };

  const scored = resolver.scoreCandidates(db, s, incoming, STRICT);
  const expect = [
    [jonh, 'first_name_typo'],
    [joan, 'phonetic_first_name'],
    [jack, 'nickname_or_short_form'],
    [peter, 'exact_date_of_birth'],
    [pedro, 'exact_date_of_birth'],   // 3/4/2012 normalizes to 2012-03-04
  ];
  for (const [code, reason] of expect) {
    const hit = byCode(scored, code);
    assert.ok(hit, `${reason} candidate was dropped`);
    assert.ok(hit.reasons.includes(reason), `expected ${reason}, got ${hit.reasons}`);
  }
  assert.equal(byCode(scored, maria), undefined, 'unrelated name + different DOB is dropped');

  // A phonetic variant only the fs > 0.60 band admits: Pio / Pia scores
  // 0.667 on both helpers, below the 0.75 typo band. (Joan / John above also
  // clears the typo band, so it alone would not pin the 0.60 cut.)
  const pia = people.create(db, s, { given_name: 'Pia', family_name: 'Garcia' });
  assert.ok(matching.transposedSimilarity('Pio', 'Pia') < 0.75);
  const pio = byCode(resolver.scoreCandidates(db, s, { given_name: 'Pio', family_name: 'Garcia' }, STRICT), pia);
  assert.ok(pio, 'phonetic-only candidate was dropped');
  assert.ok(pio.reasons.includes('phonetic_first_name'));
});

test('strict pre-filter > candidates found by the email, phone or address queries are never dropped', t => {
  const { db, s } = setup(t);
  // Shares an email: the email query finds her.
  const rosa = people.create(db, s, { given_name: 'Rosa', family_name: 'Garcia' });
  contacts.attachEmailToPerson(db, rosa, contacts.upsertEmail(db, s, 'garcia.home@example.org'));
  // Lives at the incoming address: the address query finds her.
  const ana = people.create(db, s, { given_name: 'Ana', family_name: 'Garcia' });
  const fam = families.create(db, s, { display_name: 'Garcia household' });
  families.addMember(db, s, fam, ana, { role: 'parent' });
  const address = { line1: '100 Elm St', city: 'Austin', region: 'TX', postal: '78701' };
  contacts.attachAddressToFamily(db, fam, contacts.upsertAddress(db, s, address), { isPrimary: true });
  // Control: nothing but the surname.
  const maria = people.create(db, s, { given_name: 'Maria', family_name: 'Garcia' });

  const incoming = { given_name: 'John', family_name: 'Garcia', emails: ['garcia.home@example.org'], address };
  const strict = codesOf(resolver.findCandidates(db, s, incoming, STRICT));
  assert.ok(strict.includes(rosa), 'email-query candidate kept');
  assert.ok(strict.includes(ana), 'address-query candidate kept');
  assert.ok(!strict.includes(maria), 'surname-only control dropped');
  const rosaScore = byCode(resolver.scoreCandidates(db, s, incoming, STRICT), rosa);
  assert.ok(rosaScore.reasons.includes('exact_email_match'));
});

test('strict pre-filter > a phone the phone query cannot see (stored with an extension) still keeps the candidate', t => {
  const { db, s } = setup(t);
  // The phone query hashes the whole stored value (12 digits with the
  // extension); scoreMatch splits it and compares the first 10 digits.
  const luis = people.create(db, s, { given_name: 'Luis', family_name: 'Garcia' });
  contacts.attachPhoneToPerson(db, luis, contacts.upsertPhone(db, s, '512-555-0199 x12'));
  const withPhone = { given_name: 'John', family_name: 'Garcia', phones: ['512-555-0199'] };

  // Premise: the phone query alone does not find him.
  assert.ok(!codesOf(resolver.findCandidates(db, s, { given_name: 'John', phones: ['512-555-0199'] })).includes(luis));
  assert.ok(fullScore(db, s, withPhone, luis).reasons.includes('exact_phone_match'));

  const hit = byCode(resolver.scoreCandidates(db, s, withPhone, STRICT), luis);
  assert.ok(hit, 'shared phone candidate kept');
  assert.ok(hit.reasons.includes('exact_phone_match'));

  // Without an incoming phone there is nothing to share: dropped.
  const noPhone = { given_name: 'John', family_name: 'Garcia' };
  assert.equal(byCode(resolver.scoreCandidates(db, s, noPhone, STRICT), luis), undefined);
});

test('strict pre-filter > an incoming person without a first name filters nothing', t => {
  const { db, s } = setup(t);
  const maria = people.create(db, s, { given_name: 'Maria', family_name: 'Garcia' });
  const paul = people.create(db, s, { given_name: 'Paul', family_name: 'Garcia' });
  const strict = codesOf(resolver.findCandidates(db, s, { family_name: 'Garcia' }, STRICT));
  assert.deepEqual(strict.sort(), [maria, paul].sort());
});

test('strict pre-filter > over a 60-person surname block, keeps exactly the candidates the full scorer gives a signal, unchanged and in order', t => {
  const { db, s } = setup(t);
  const firsts = ['John', 'Jon', 'Johnny', 'Jonh', 'Jhon', 'Joan', 'Jean', 'Juan', 'Sean', 'Jack', 'Johan',
    'Jonathan', 'Johnathan', 'Jo', 'J', 'Maria', 'Paul', 'Peter', 'Luis', 'Ana', 'Rosa', 'Mateo',
    'John & Mary', 'Mary / John', 'JOHN', 'Jóhn', 'Ohn', 'Jhonny', 'Joe', 'Jose'];
  const dobs = [null, '2012-03-04', '2012-03-05', '3/4/2012', 'unknown', null];
  const all = [];   // creation (rowid) order
  const given = new Map();
  for (let i = 0; i < 60; i++) {
    const g = firsts[i % firsts.length];
    const code = people.create(db, s, { given_name: g, family_name: 'Garcia', date_of_birth: dobs[i % dobs.length] });
    all.push(code);
    given.set(code, g);
  }
  for (const incoming of [
    { given_name: 'John', family_name: 'Garcia', date_of_birth: '2012-03-04' },
    { given_name: 'Maria', family_name: 'Garcia' },
    { given_name: 'J', family_name: 'Garcia', date_of_birth: 'unknown' },
  ]) {
    // What strict matching returned before the pre-filter: the exact-name
    // query's rows first, then the rest of the surname block, each scored in
    // full, stable-sorted best-first. The pre-filter may only remove rows
    // with no signal; everything else must be byte-for-byte the same, in the
    // same order.
    const gIn = enc.normalizeName(incoming.given_name);
    const insertion = [
      ...all.filter(c => enc.normalizeName(given.get(c)) === gIn),
      ...all.filter(c => enc.normalizeName(given.get(c)) !== gIn),
    ];
    const unfiltered = insertion.map(code => ({ code, ...fullScore(db, s, incoming, code) }));
    unfiltered.sort((x, y) => y.confidence - x.confidence);
    const want = unfiltered
      .filter(r => r.definitive || r.reasons.some(x => SIGNAL.test(x)))
      .map(r => [r.code, r.confidence, r.reasons, r.definitive]);

    const strict = resolver.scoreCandidates(db, s, incoming, STRICT);
    assert.deepEqual(strict.map(r => [r.candidate.code, r.confidence, r.reasons, r.definitive]), want);
    assert.ok(strict.length > 0 && strict.length < all.length, 'kept some, dropped some');

    // Non-strict: the surname block (capped at 50) is not filtered.
    assert.equal(resolver.scoreCandidates(db, s, incoming, { includeArchived: true }).length, 50);
  }
});

test('strict contact lookups > email, phone and address queries return the same rows in the same order as the original SQL', t => {
  // Strict lookups drive the join from the email / phone / address row (the
  // original joins walk every person). Non-strict still runs the original
  // SQL, so with no name on the incoming record (no surname block, nothing
  // to pre-filter) the two modes must return identical lists - including
  // archived people, the LIMIT cut, and a person in two households at one
  // address.
  const { db, s } = setup(t);
  const address = { line1: '12 Oak St', city: 'Austin', region: 'TX', postal: '78701' };
  const addrCode = contacts.upsertAddress(db, s, address);
  const emailCode = contacts.upsertEmail(db, s, 'shared@example.org');
  const phoneCode = contacts.upsertPhone(db, s, '512-555-0100');
  const fams = [0, 1, 2].map(i => {
    const f = families.create(db, s, { display_name: `Household ${i}` });
    contacts.attachAddressToFamily(db, f, addrCode, { isPrimary: true });
    return f;
  });
  for (let i = 0; i < 70; i++) {
    const code = people.create(db, s, { given_name: `P${i}`, family_name: 'Lee' });
    if (i % 4 === 1) db.prepare(`UPDATE persons SET status = 'archived' WHERE code = ?`).run(code);
    if (i % 9 === 2) db.prepare(`UPDATE persons SET status = 'merged' WHERE code = ?`).run(code);
    families.addMember(db, s, fams[i % 3], code, { role: 'member' });
    if (i % 5 === 0) families.addMember(db, s, fams[(i + 1) % 3], code, { role: 'member' });
    if (i % 7 === 3) {
      // Moved out: an ended membership no longer puts them at the address.
      const m = db.prepare('SELECT code FROM memberships WHERE person_code = ? AND ended_at IS NULL').all(code);
      for (const x of m) families.endMembership(db, x.code, 'edit');
    }
    if (i % 2 === 0) contacts.attachEmailToPerson(db, code, emailCode);
    if (i % 3 !== 1) contacts.attachPhoneToPerson(db, code, phoneCode);
  }
  for (const incoming of [
    { emails: ['shared@example.org'] },
    { phones: ['512-555-0100'] },
    { address },
  ]) {
    for (const includeArchived of [true, false]) {
      const strict = codesOf(resolver.findCandidates(db, s, incoming, { strict: true, includeArchived }));
      const loose = codesOf(resolver.findCandidates(db, s, incoming, { includeArchived }));
      assert.ok(loose.length >= 20, 'fixture reaches the LIMIT');
      assert.deepEqual(strict, loose, `${Object.keys(incoming)[0]} includeArchived=${includeArchived}`);
    }
  }
});

test('strict pre-filter > cached statements are per database handle', t => {
  const one = newDb();
  const s = newSecrets();
  const a = people.create(one.db, s, { given_name: 'John', family_name: 'Garcia' });
  assert.deepEqual(codesOf(resolver.findCandidates(one.db, s, { given_name: 'John', family_name: 'Garcia' }, STRICT)), [a]);
  one.db.close();
  cleanup(one.dir);

  const { db } = setup(t);
  const b = people.create(db, s, { given_name: 'John', family_name: 'Garcia' });
  assert.deepEqual(codesOf(resolver.findCandidates(db, s, { given_name: 'John', family_name: 'Garcia' }, STRICT)), [b]);
});
