'use strict';

const { newCode, kindOf } = require('../crypto/identifiers');
const aliases = require('./aliases');

const VALID_KINDS = new Set([
  'parent_of',
  'child_of',
  'spouse_of',
  'godparent_of',
  'sibling_of',
  'related_household',
  'custody_of',
  'guardian_of',
  'other',
  'grandparent_of',
  'grandchild_of',
]);

// Kinds that only make sense between two of the same entity kind: two
// families (a grandparent household and a grandchild's household) or two
// persons.
const SAME_ENTITY_KINDS = new Set(['grandparent_of', 'grandchild_of']);

const INVERSE = {
  parent_of: 'child_of',
  child_of: 'parent_of',
  spouse_of: 'spouse_of',
  godparent_of: null, // godparent_of has no symmetric inverse in the schema
  sibling_of: 'sibling_of',
  related_household: 'related_household',
  custody_of: null,
  guardian_of: null,
  other: 'other',
  grandparent_of: 'grandchild_of',
  grandchild_of: 'grandparent_of',
};

function _find(db, from, to, kind) {
  return db
    .prepare(`SELECT * FROM relationships WHERE from_code = ? AND to_code = ? AND kind = ? ORDER BY created_at ASC LIMIT 1`)
    .get(from, to, kind);
}

// ensure: idempotent add. Returns { code, existing, reverseAdded }. An
// identical (from, to, kind) returns the row already there; a missing reverse
// is filled in either way (reverseAdded says it was). Runs in one transaction.
function ensure(db, fromCode, toCode, kind, detail = null) {
  if (!VALID_KINDS.has(kind)) throw new Error(`unknown relationship kind: ${kind}`);
  const from = aliases.resolveAlias(db, fromCode);
  const to = aliases.resolveAlias(db, toCode);
  if (SAME_ENTITY_KINDS.has(kind)) {
    const fk = kindOf(from);
    if (!['family', 'person'].includes(fk) || fk !== kindOf(to)) {
      throw new Error(`${kind} must link two families or two persons`);
    }
    if (from === to) throw new Error(`${kind} cannot link a record to itself`);
  }
  const tx = db.transaction(() => {
    const found = _find(db, from, to, kind);
    let code;
    let existing = false;
    if (found) {
      code = found.code;
      existing = true;
    } else {
      code = newCode('relationship');
      db.prepare(
        `INSERT INTO relationships (code, from_code, to_code, kind, detail) VALUES (?, ?, ?, ?, ?)`
      ).run(code, from, to, kind, detail);
    }
    // Symmetric back-reference if applicable.
    const inv = INVERSE[kind];
    let reverseAdded = false;
    if (inv && !_find(db, to, from, inv)) {
      db.prepare(
        `INSERT INTO relationships (code, from_code, to_code, kind, detail) VALUES (?, ?, ?, ?, ?)`
      ).run(newCode('relationship'), to, from, inv, detail);
      reverseAdded = true;
    }
    return { code, existing, reverseAdded };
  });
  return tx();
}

function add(db, fromCode, toCode, kind, detail = null) {
  return ensure(db, fromCode, toCode, kind, detail).code;
}

function get(db, code) {
  return db.prepare('SELECT * FROM relationships WHERE code = ?').get(code) || null;
}

// Remove (from, to, kind) and its reverse. Returns rows deleted (0 = none).
function removeTriple(db, fromCode, toCode, kind) {
  const from = aliases.resolveAlias(db, fromCode);
  const to = aliases.resolveAlias(db, toCode);
  const tx = db.transaction(() => {
    let n = db.prepare('DELETE FROM relationships WHERE from_code = ? AND to_code = ? AND kind = ?')
      .run(from, to, kind).changes;
    if (!n) return 0;
    const inv = INVERSE[kind];
    if (inv) {
      n += db.prepare('DELETE FROM relationships WHERE from_code = ? AND to_code = ? AND kind = ?')
        .run(to, from, inv).changes;
    }
    return n;
  });
  return tx();
}

function listFor(db, code, { kind = null, direction = 'both' } = {}) {
  const target = aliases.resolveAlias(db, code);
  const filters = [];
  const params = [];
  if (direction === 'from' || direction === 'both') {
    filters.push('from_code = ?');
    params.push(target);
  }
  if (direction === 'to' || direction === 'both') {
    filters.push('to_code = ?');
    params.push(target);
  }
  let sql = `SELECT * FROM relationships`;
  if (filters.length) sql += ` WHERE (${filters.join(' OR ')})`;
  if (kind) {
    sql += params.length ? ' AND ' : ' WHERE ';
    sql += 'kind = ?';
    params.push(kind);
  }
  sql += ' ORDER BY created_at ASC';
  return db.prepare(sql).all(...params);
}

// Delete by id. For the grandparent kinds the reverse row goes too, so the
// pair never half-exists. Other kinds keep their historical behavior.
function remove(db, code) {
  const row = get(db, code);
  if (!row) return 0;
  if (SAME_ENTITY_KINDS.has(row.kind)) return removeTriple(db, row.from_code, row.to_code, row.kind);
  return db.prepare('DELETE FROM relationships WHERE code = ?').run(code).changes;
}

module.exports = { add, ensure, get, listFor, remove, removeTriple, VALID_KINDS, INVERSE, SAME_ENTITY_KINDS };
