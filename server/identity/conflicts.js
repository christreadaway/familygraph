'use strict';

const aliases = require('./aliases');
const people = require('./people');
const families = require('./families');
const audit = require('../audit');

function list(db, { status = 'open', limit = 100 } = {}) {
  return db
    .prepare(
      `SELECT * FROM conflicts WHERE status = ? ORDER BY score DESC, created_at ASC LIMIT ?`
    )
    .all(status, Math.max(1, Math.min(1000, Number(limit) || 100)))
    .map(r => ({ ...r, reasons: r.reasons ? JSON.parse(r.reasons) : [] }));
}

function get(db, code) {
  const row = db.prepare('SELECT * FROM conflicts WHERE code = ?').get(code);
  if (!row) return null;
  return { ...row, reasons: row.reasons ? JSON.parse(row.reasons) : [] };
}

function resolveMerge(db, secrets, conflictCode, { winnerCode, actor = 'operator' } = {}) {
  const c = get(db, conflictCode);
  if (!c) throw new Error('conflict not found');
  if (c.status !== 'open') throw new Error('conflict already resolved');
  const left = aliases.resolveAlias(db, c.left_code);
  const right = aliases.resolveAlias(db, c.right_code);
  if (winnerCode !== left && winnerCode !== right) {
    throw new Error('winner must be one of the conflict pair');
  }
  const loser = winnerCode === left ? right : left;
  if (c.kind === 'person') {
    people.merge(db, secrets, loser, winnerCode);
  } else if (c.kind === 'family') {
    families.merge(db, secrets, loser, winnerCode);
  }
  db.prepare(
    `UPDATE conflicts SET status = 'merged', resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ?`
  ).run(actor, conflictCode);
  audit.record(db, {
    action: 'conflict_merged',
    actor,
    entityCode: winnerCode,
    entityKind: c.kind,
    metadata: { conflict: conflictCode, loser },
  });
  return winnerCode;
}

function resolveReject(db, conflictCode, { actor = 'operator' } = {}) {
  const c = get(db, conflictCode);
  if (!c) throw new Error('conflict not found');
  if (c.status !== 'open') throw new Error('conflict already resolved');
  db.prepare(
    `UPDATE conflicts SET status = 'rejected', resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ?`
  ).run(actor, conflictCode);
  audit.record(db, {
    action: 'conflict_rejected',
    actor,
    entityKind: c.kind,
    metadata: { conflict: conflictCode },
  });
}

function resolveDismiss(db, conflictCode, { actor = 'operator' } = {}) {
  db.prepare(
    `UPDATE conflicts SET status = 'dismissed', resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ?`
  ).run(actor, conflictCode);
  audit.record(db, {
    action: 'conflict_dismissed',
    actor,
    metadata: { conflict: conflictCode },
  });
}

module.exports = { list, get, resolveMerge, resolveReject, resolveDismiss };
