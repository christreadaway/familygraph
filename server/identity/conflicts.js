'use strict';

const aliases = require('./aliases');
const people = require('./people');
const families = require('./families');
const audit = require('../audit');
const notify = require('../notify');
const templates = require('../notify/templates');

// Assignment TTL is restricted to the operator-spec values. Anything else is
// rejected at the API and helper boundaries so that auditors and the sweeper
// have a small, fixed set of expirations to reason about.
const ALLOWED_TTL_HOURS = new Set([4, 12, 24, 48, 72]);

// Lightweight email shape check. We intentionally do not RFC-5322 — the value
// is operator-entered and is used as a label, not a delivery mechanism.
function _validEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function list(db, { status = 'open', limit = 100, assignedTo = null, assigned = null, crossSource = null } = {}) {
  const filters = [];
  const params = [];
  if (status) { filters.push('status = ?'); params.push(status); }
  if (assignedTo) { filters.push('assigned_to = ?'); params.push(String(assignedTo).trim().toLowerCase()); }
  if (assigned === 'unassigned') filters.push('assigned_to IS NULL');
  if (assigned === 'assigned') filters.push('assigned_to IS NOT NULL');
  // Cross-source filter: conflicts whose metadata JSON has cross_source=true.
  // Use a JSON predicate so the filter is server-side rather than per-row in JS.
  if (crossSource === true || crossSource === 'true') {
    filters.push("metadata IS NOT NULL AND json_extract(metadata, '$.cross_source') = 1");
  } else if (crossSource === false || crossSource === 'false') {
    filters.push("(metadata IS NULL OR json_extract(metadata, '$.cross_source') IS NOT 1)");
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  params.push(Math.max(1, Math.min(1000, Number(limit) || 100)));
  return db
    .prepare(`SELECT * FROM conflicts ${where} ORDER BY score DESC, created_at ASC LIMIT ?`)
    .all(...params)
    .map(r => ({
      ...r,
      reasons: r.reasons ? JSON.parse(r.reasons) : [],
      metadata: r.metadata ? _safeJson(r.metadata) : null,
    }));
}

function get(db, code) {
  const row = db.prepare('SELECT * FROM conflicts WHERE code = ?').get(code);
  if (!row) return null;
  return {
    ...row,
    reasons: row.reasons ? JSON.parse(row.reasons) : [],
    metadata: row.metadata ? _safeJson(row.metadata) : null,
  };
}

function _safeJson(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}

function resolveMerge(db, secrets, conflictCode, { winnerCode, actor = 'operator', notes = null } = {}) {
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
    `UPDATE conflicts SET status = 'merged', resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                          resolution_notes = ? WHERE code = ?`
  ).run(actor, notes ? String(notes).slice(0, 2000) : null, conflictCode);
  audit.record(db, {
    action: 'conflict_merged',
    actor,
    entityCode: winnerCode,
    entityKind: c.kind,
    metadata: { conflict: conflictCode, loser, notes: notes || null },
  });
  return winnerCode;
}

function resolveReject(db, conflictCode, { actor = 'operator', notes = null } = {}) {
  const c = get(db, conflictCode);
  if (!c) throw new Error('conflict not found');
  if (c.status !== 'open') throw new Error('conflict already resolved');
  db.prepare(
    `UPDATE conflicts SET status = 'rejected', resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                          resolution_notes = ? WHERE code = ?`
  ).run(actor, notes ? String(notes).slice(0, 2000) : null, conflictCode);
  audit.record(db, {
    action: 'conflict_rejected',
    actor,
    entityKind: c.kind,
    metadata: { conflict: conflictCode, notes: notes || null },
  });
}

function resolveDismiss(db, conflictCode, { actor = 'operator', notes = null } = {}) {
  db.prepare(
    `UPDATE conflicts SET status = 'dismissed', resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                          resolution_notes = ? WHERE code = ?`
  ).run(actor, notes ? String(notes).slice(0, 2000) : null, conflictCode);
  audit.record(db, {
    action: 'conflict_dismissed',
    actor,
    metadata: { conflict: conflictCode, notes: notes || null },
  });
}

// Returns true if the (left, right) pair has already been decided as
// "they're not the same" — rejected or dismissed. Used by the resolver to
// avoid re-flagging a pair the operator already triaged. Order-independent.
function hasStickyNonMatch(db, leftCode, rightCode) {
  const row = db.prepare(
    `SELECT 1 FROM conflicts
      WHERE kind = 'person'
        AND status IN ('rejected', 'dismissed')
        AND ((left_code = ? AND right_code = ?) OR (left_code = ? AND right_code = ?))
      LIMIT 1`
  ).get(leftCode, rightCode, rightCode, leftCode);
  return !!row;
}

// Assign one or many open conflicts to an email. The assignment expires
// `ttlHours` after `assigned_at`; a periodic sweeper clears expired rows.
//
// Inputs:
//   codes        — explicit list of conflict codes to assign (may be omitted if `allOpen` is true)
//   allOpen      — if true, every conflict whose status='open' is assigned
//   assignee     — colleague's email (loose validation; used as a label, not for delivery)
//   ttlHours     — must be one of ALLOWED_TTL_HOURS
//   actor        — for audit
//
// Re-assignment is allowed: passing an email for a conflict already assigned to
// somebody else just overwrites the assignment and bumps the expiry. Both
// events are auditable.
function assign(db, { codes = [], allOpen = false, assignee, ttlHours, actor = 'operator' }) {
  if (!_validEmail(assignee)) throw new Error('assignee must be an email');
  const ttl = Number(ttlHours);
  if (!ALLOWED_TTL_HOURS.has(ttl)) {
    throw new Error(`ttl_hours must be one of ${[...ALLOWED_TTL_HOURS].join(', ')}`);
  }
  const email = String(assignee).trim().toLowerCase();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttl * 3600 * 1000).toISOString();
  const nowIso = now.toISOString();

  let rows;
  if (allOpen) {
    rows = db.prepare(`SELECT code FROM conflicts WHERE status = 'open'`).all();
  } else {
    if (!Array.isArray(codes) || codes.length === 0) throw new Error('codes or all_open required');
    const placeholders = codes.map(() => '?').join(',');
    rows = db
      .prepare(`SELECT code FROM conflicts WHERE code IN (${placeholders}) AND status = 'open'`)
      .all(...codes);
  }
  if (rows.length === 0) return { assigned: 0, expires_at: expiresAt };

  const update = db.prepare(
    `UPDATE conflicts SET assigned_to = ?, assigned_at = ?, assignment_expires_at = ?, reminder_sent_at = NULL WHERE code = ?`
  );
  const tx = db.transaction(() => {
    for (const r of rows) update.run(email, nowIso, expiresAt, r.code);
  });
  tx();
  audit.record(db, {
    action: 'conflict_assign',
    actor,
    metadata: { count: rows.length, assignee: email, ttl_hours: ttl, expires_at: expiresAt },
  });

  // Enqueue an "assigned" notification. Subject + body include the count, the
  // TTL, and a deep-link to the recipient's filtered queue. Body never
  // contains family/person PII.
  try {
    const cfg = notify.effectiveConfig(db);
    const tpl = templates.assignTemplate({
      count: rows.length,
      expiresAt,
      dashboardUrl: cfg.dashboardUrl,
      assignee: email,
      ttlHours: ttl,
      institution: cfg.institution,
    });
    notify.enqueue(db, {
      kind: 'assign',
      to: email,
      subject: tpl.subject,
      text: tpl.text,
      html: tpl.html,
      related: rows.map(r => r.code),
    });
  } catch (e) {
    // Notification enqueue is best-effort. The assignment itself succeeded;
    // we surface the failure in the audit log but do not roll back.
    audit.record(db, {
      action: 'notification_enqueue_failed',
      actor: 'system',
      metadata: { error: String(e.message || e), kind: 'assign', assignee: email },
    });
  }

  return { assigned: rows.length, expires_at: expiresAt, assignee: email };
}

function unassign(db, code, { actor = 'operator' } = {}) {
  const row = db.prepare(`SELECT assigned_to FROM conflicts WHERE code = ?`).get(code);
  if (!row) return false;
  const r = db.prepare(
    `UPDATE conflicts SET assigned_to = NULL, assigned_at = NULL, assignment_expires_at = NULL WHERE code = ?`
  ).run(code);
  if (r.changes && row.assigned_to) {
    audit.record(db, {
      action: 'conflict_unassign',
      actor,
      metadata: { conflict: code, was_assigned_to: row.assigned_to },
    });
  }
  return r.changes > 0;
}

// Sweep expired assignments. Returns the codes that were just cleared so the
// caller can audit them or surface them in a UI banner. Also enqueues an
// "expired" notification per affected assignee.
function sweepExpiredAssignments(db) {
  const nowIso = new Date().toISOString();
  const expired = db
    .prepare(
      `SELECT code, assigned_to FROM conflicts
        WHERE assigned_to IS NOT NULL AND assignment_expires_at IS NOT NULL
          AND assignment_expires_at <= ?`
    )
    .all(nowIso);
  if (expired.length === 0) return [];
  const byEmail = new Map();
  for (const r of expired) {
    if (!byEmail.has(r.assigned_to)) byEmail.set(r.assigned_to, []);
    byEmail.get(r.assigned_to).push(r.code);
  }
  const update = db.prepare(
    `UPDATE conflicts SET assigned_to = NULL, assigned_at = NULL, assignment_expires_at = NULL, reminder_sent_at = NULL WHERE code = ?`
  );
  const tx = db.transaction(() => {
    for (const r of expired) update.run(r.code);
  });
  tx();
  audit.record(db, {
    action: 'conflict_assignment_expired',
    actor: 'system',
    metadata: { count: expired.length, codes: expired.map(r => r.code) },
  });
  // One email per affected assignee, batched.
  for (const [email, codes] of byEmail) {
    try {
      const cfg = notify.effectiveConfig(db);
      const tpl = templates.expiredTemplate({
        count: codes.length,
        dashboardUrl: cfg.dashboardUrl,
        assignee: email,
        institution: cfg.institution,
      });
      notify.enqueue(db, { kind: 'expired', to: email, subject: tpl.subject, text: tpl.text, html: tpl.html, related: codes });
    } catch (e) {
      audit.record(db, {
        action: 'notification_enqueue_failed',
        actor: 'system',
        metadata: { error: String(e.message || e), kind: 'expired', assignee: email },
      });
    }
  }
  return expired.map(r => r.code);
}

// Reminder pass. For each assignment whose remaining time is at or below
// `reminderHours` and that hasn't been reminded yet, enqueue a reminder
// email and stamp `reminder_sent_at`. Idempotent: a row marked reminded is
// not re-touched.
function sendDueReminders(db, { reminderHours = null } = {}) {
  const cfg = notify.effectiveConfig(db);
  const hours = Number(reminderHours != null ? reminderHours : cfg.reminderHours);
  if (!Number.isFinite(hours) || hours <= 0) return [];
  const cutoffIso = new Date(Date.now() + hours * 3_600_000).toISOString();
  const due = db
    .prepare(
      `SELECT code, assigned_to, assignment_expires_at FROM conflicts
        WHERE assigned_to IS NOT NULL
          AND assignment_expires_at IS NOT NULL
          AND assignment_expires_at <= ?
          AND assignment_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
          AND reminder_sent_at IS NULL`
    )
    .all(cutoffIso);
  if (due.length === 0) return [];
  const byEmail = new Map();
  for (const r of due) {
    if (!byEmail.has(r.assigned_to)) byEmail.set(r.assigned_to, { codes: [], expiresAt: r.assignment_expires_at });
    byEmail.get(r.assigned_to).codes.push(r.code);
    // Use the earliest expiry across the batch.
    const cur = byEmail.get(r.assigned_to);
    if (new Date(r.assignment_expires_at) < new Date(cur.expiresAt)) cur.expiresAt = r.assignment_expires_at;
  }
  const stamp = db.prepare(
    `UPDATE conflicts SET reminder_sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ?`
  );
  const tx = db.transaction(() => {
    for (const r of due) stamp.run(r.code);
  });
  tx();
  for (const [email, batch] of byEmail) {
    try {
      const tpl = templates.reminderTemplate({
        count: batch.codes.length,
        expiresAt: batch.expiresAt,
        dashboardUrl: cfg.dashboardUrl,
        assignee: email,
        institution: cfg.institution,
      });
      notify.enqueue(db, { kind: 'reminder', to: email, subject: tpl.subject, text: tpl.text, html: tpl.html, related: batch.codes });
    } catch (e) {
      audit.record(db, {
        action: 'notification_enqueue_failed',
        actor: 'system',
        metadata: { error: String(e.message || e), kind: 'reminder', assignee: email },
      });
    }
  }
  return due.map(r => r.code);
}

module.exports = {
  list,
  get,
  resolveMerge,
  resolveReject,
  resolveDismiss,
  hasStickyNonMatch,
  assign,
  unassign,
  sweepExpiredAssignments,
  sendDueReminders,
  ALLOWED_TTL_HOURS,
};
