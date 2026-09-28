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

module.exports = { lookup, link, refsFor, countBySource, SOURCE_RE };
