'use strict';

// Crosswalk: another app's record id -> Family Graph code (migration 0020).
//
//   lookup(db, 'missioniq', 'contact:7f3c…')  -> { code: 'p_…', kind, status } | null
//   link(db, { source, ref, kind, code })      -> 'created' | 'unchanged' | 'relinked'
//
// Entries are created by deliberate imports (roster commits that carry refs,
// the MissionIQ importer) - never guessed. A lookup follows merge aliases, so
// a ref always lands on the surviving record. Refs are opaque record ids, not
// PII, but they are still only logged as counts.

const aliases = require('./aliases');
const { kindOf } = require('../crypto/identifiers');

const SOURCE_RE = /^[a-z0-9][a-z0-9_.-]{0,39}$/;
const MAX_REF = 200;

function _valid(source, ref) {
  return typeof source === 'string' && SOURCE_RE.test(source) &&
    typeof ref === 'string' && ref.length > 0 && ref.length <= MAX_REF && !/[\s\u0000-\u001f]/.test(ref);
}

function lookup(db, source, ref) {
  if (!_valid(source, ref)) return null;
  const row = db.prepare('SELECT kind, code FROM external_refs WHERE source = ? AND ref = ?').get(source, ref);
  if (!row) return null;
  const code = aliases.resolveAlias(db, row.code);
  const table = row.kind === 'person' ? 'persons' : 'families';
  const rec = db.prepare(`SELECT code, status FROM ${table} WHERE code = ?`).get(code);
  if (!rec) return null;
  return { code: rec.code, kind: row.kind, status: rec.status };
}

function link(db, { source, ref, kind, code }) {
  if (!_valid(source, ref)) throw new Error('invalid external ref');
  if (kind !== 'person' && kind !== 'family') throw new Error('kind must be person or family');
  if (kindOf(code) !== kind) throw new Error(`code is not a ${kind} code`);
  const cur = db.prepare('SELECT code FROM external_refs WHERE source = ? AND ref = ?').get(source, ref);
  if (!cur) {
    db.prepare('INSERT INTO external_refs (source, ref, kind, code) VALUES (?, ?, ?, ?)').run(source, ref, kind, code);
    return 'created';
  }
  if (aliases.resolveAlias(db, cur.code) === aliases.resolveAlias(db, code)) return 'unchanged';
  db.prepare(
    `UPDATE external_refs SET code = ?, kind = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE source = ? AND ref = ?`
  ).run(code, kind, source, ref);
  return 'relinked';
}

// Every ref of `source` that lands on `code`, directly or through a merge
// alias (recordAlias keeps alias chains flat, so one level is complete).
function refsFor(db, source, kind, code) {
  return db.prepare(
    `SELECT ref FROM external_refs
      WHERE source = ? AND kind = ?
        AND (code = ? OR code IN (SELECT alias_code FROM aliases WHERE target_code = ?))`
  ).all(source, kind, code, code).map(r => r.ref);
}

function countBySource(db, source) {
  return db.prepare('SELECT kind, COUNT(*) AS n FROM external_refs WHERE source = ? GROUP BY kind').all(source)
    .reduce((acc, r) => ({ ...acc, [r.kind]: r.n }), { person: 0, family: 0 });
}

// Does this incoming record still describe the person a ref is linked to?
// The same rule roster.js applies to a crosswalk hit (linked_record_changed):
// the same first name or a real (unambiguous) nickname of it, or the same
// birthdate with a first name that at least resembles it (a typo fixed) -
// and never a birthdate or Jr/Sr contradiction. Names, birthdate and suffix
// only: a shared email or phone says "same household", not "same person".
// A merely similar name with nothing else (Mark / Mary) is a record reused
// for someone else as often as a typo, so it fails.
const FIRST_NAME_REASONS = new Set([
  'exact_first_name', 'nickname_or_short_form', 'similar_first_name', 'phonetic_first_name', 'first_name_typo',
]);
const LINK_VETOES = new Set(['dob_conflict', 'dob_possible_misreading', 'suffix_conflict']);

function stillSame(db, secrets, incoming, code) {
  // Lazy: keeps this module loadable without the matcher's dependency chain.
  const resolver = require('./resolver');
  const matching = require('./matching');
  const row = db.prepare('SELECT * FROM persons WHERE code = ?').get(code);
  if (!row) return false;
  const cand = resolver.enrichCandidate(db, secrets, row);
  const strip = r => ({ ...r, emails: [], phones: [], email: null, phone: null });
  const sc = matching.scoreMatch(strip(resolver.toMatcherRecord(incoming)), strip(cand), { strict: true });
  const firstSame = sc.reasons.includes('exact_first_name') ||
    (sc.reasons.includes('nickname_or_short_form') && !matching.nicknameAmbiguous(incoming.given_name));
  const dobSame = sc.reasons.includes('exact_date_of_birth') && sc.reasons.some(r => FIRST_NAME_REASONS.has(r));
  return !sc.reasons.some(r => LINK_VETOES.has(r)) && (firstSame || dobSame);
}

module.exports = { lookup, link, refsFor, countBySource, stillSame, SOURCE_RE };
