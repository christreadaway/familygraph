'use strict';

const { newCode } = require('../crypto/identifiers');
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
]);

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
};

function add(db, fromCode, toCode, kind, detail = null) {
  if (!VALID_KINDS.has(kind)) throw new Error(`unknown relationship kind: ${kind}`);
  const from = aliases.resolveAlias(db, fromCode);
  const to = aliases.resolveAlias(db, toCode);
  const code = newCode('relationship');
  db.prepare(
    `INSERT INTO relationships (code, from_code, to_code, kind, detail) VALUES (?, ?, ?, ?, ?)`
  ).run(code, from, to, kind, detail);
  // Symmetric back-reference if applicable.
  const inv = INVERSE[kind];
  if (inv) {
    const exists = db
      .prepare(`SELECT 1 FROM relationships WHERE from_code = ? AND to_code = ? AND kind = ?`)
      .get(to, from, inv);
    if (!exists) {
      db.prepare(
        `INSERT INTO relationships (code, from_code, to_code, kind, detail) VALUES (?, ?, ?, ?, ?)`
      ).run(newCode('relationship'), to, from, inv, detail);
    }
  }
  return code;
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

function remove(db, code) {
  return db.prepare('DELETE FROM relationships WHERE code = ?').run(code).changes;
}

module.exports = { add, listFor, remove, VALID_KINDS, INVERSE };
