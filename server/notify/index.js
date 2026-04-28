'use strict';

const path = require('path');
const { newCode } = require('../crypto/identifiers');
const audit = require('../audit');
const config = require('../config');
const postmark = require('./transports/postmark');
const logTransport = require('./transports/log');

const MAX_ATTEMPTS = 5;
// Backoff schedule (ms): 30s, 2m, 10m, 1h, 6h. Cumulative tail = ~7h, well
// under any reasonable TTL.
const BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000];

function _getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value_json); } catch (_) { return fallback; }
}

function effectiveConfig(db, env = process.env) {
  return {
    enabled: _getSetting(db, 'notifications.enabled', false) === true,
    transport: _getSetting(db, 'notifications.transport', 'log'),
    dashboardUrl: _getSetting(db, 'dashboard_url', null) || `http://${config.bind}:${config.port}`,
    institution: _getSetting(db, 'institution_name', null),
    postmark: {
      token: env.CUSTOS_POSTMARK_TOKEN || null,
      from: _getSetting(db, 'postmark.from', null),
      messageStream: _getSetting(db, 'postmark.message_stream', 'outbound'),
    },
    reminderHours: Number(_getSetting(db, 'notifications.reminder_hours', 1)),
    logPath: path.join(config.home, 'notifications.jsonl'),
  };
}

// Enqueue a single message. The body is rendered by the caller (see
// `templates.js`). The dispatcher picks the row up on its next pass.
function enqueue(db, { kind, to, subject, text, html = null, related = [] }) {
  if (!to) throw new Error('notify.enqueue: to required');
  const code = newCode('audit').replace(/^au_/, 'note_');
  db.prepare(
    `INSERT INTO notifications (code, kind, to_email, subject, body_text, body_html, related_codes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    code,
    kind,
    String(to).trim().toLowerCase(),
    subject,
    text,
    html,
    related && related.length ? JSON.stringify(related) : null
  );
  audit.record(db, {
    action: 'notification_enqueue',
    actor: 'system',
    metadata: { code, kind, to_email: String(to).trim().toLowerCase() },
  });
  return code;
}

function listPending(db, { limit = 50, asOf = new Date() } = {}) {
  return db
    .prepare(
      `SELECT * FROM notifications
        WHERE status = 'pending'
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY created_at ASC LIMIT ?`
    )
    .all(asOf.toISOString(), Math.max(1, Math.min(500, limit)))
    .map(r => ({ ...r, related_codes: r.related_codes ? JSON.parse(r.related_codes) : [] }));
}

function listAll(db, { limit = 200, status = null, kind = null } = {}) {
  const filters = [];
  const params = [];
  if (status) { filters.push('status = ?'); params.push(status); }
  if (kind) { filters.push('kind = ?'); params.push(kind); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  params.push(Math.max(1, Math.min(1000, limit)));
  return db
    .prepare(`SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params)
    .map(r => ({ ...r, related_codes: r.related_codes ? JSON.parse(r.related_codes) : [] }));
}

function _markSent(db, code, transport, providerMessageId) {
  db.prepare(
    `UPDATE notifications
        SET status = 'sent',
            sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            transport = ?,
            provider_message_id = ?
      WHERE code = ?`
  ).run(transport, providerMessageId, code);
  audit.record(db, {
    action: 'notification_sent',
    actor: 'system',
    metadata: { code, transport, provider_message_id: providerMessageId || null },
  });
}

function _markFailed(db, code, transport, attempts, errMsg) {
  if (attempts >= MAX_ATTEMPTS) {
    db.prepare(
      `UPDATE notifications SET status = 'failed', attempts = ?, last_error = ?, transport = ? WHERE code = ?`
    ).run(attempts, errMsg, transport, code);
    audit.record(db, {
      action: 'notification_failed',
      actor: 'system',
      metadata: { code, transport, attempts, error: errMsg },
    });
    return;
  }
  const delayMs = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
  const nextAt = new Date(Date.now() + delayMs).toISOString();
  db.prepare(
    `UPDATE notifications SET attempts = ?, last_error = ?, transport = ?, next_attempt_at = ? WHERE code = ?`
  ).run(attempts, errMsg, transport, nextAt, code);
}

async function dispatchOne(db, row, cfg) {
  const transportName = cfg.transport === 'postmark' ? 'postmark' : 'log';
  const msg = { to: row.to_email, subject: row.subject, text: row.body_text, html: row.body_html };
  const attempts = (row.attempts || 0) + 1;
  try {
    let result;
    if (transportName === 'postmark') {
      result = await postmark.send(cfg.postmark, msg);
    } else {
      result = await logTransport.send({ logPath: cfg.logPath }, msg);
    }
    _markSent(db, row.code, transportName, result.provider_message_id || null);
    return { ok: true, code: row.code, transport: transportName };
  } catch (e) {
    const retryable = e && e.retryable !== false;
    if (!retryable) {
      // Non-retryable error: mark failed immediately so the operator notices.
      db.prepare(
        `UPDATE notifications SET status = 'failed', attempts = ?, last_error = ?, transport = ? WHERE code = ?`
      ).run(attempts, String(e.message || e), transportName, row.code);
      audit.record(db, {
        action: 'notification_failed',
        actor: 'system',
        metadata: { code: row.code, transport: transportName, attempts, error: String(e.message || e), retryable: false },
      });
      return { ok: false, code: row.code, transport: transportName, error: String(e.message || e) };
    }
    _markFailed(db, row.code, transportName, attempts, String(e.message || e));
    return { ok: false, code: row.code, transport: transportName, error: String(e.message || e), retryable: true };
  }
}

// Dispatch all pending rows whose `next_attempt_at` has elapsed. If
// notifications are disabled in settings, this is a no-op so the queue
// continues to accumulate harmlessly.
async function dispatchPending(db, { now = new Date(), env = process.env } = {}) {
  const cfg = effectiveConfig(db, env);
  if (!cfg.enabled) return { skipped: true, reason: 'notifications disabled' };
  const pending = listPending(db, { asOf: now });
  const results = [];
  for (const row of pending) results.push(await dispatchOne(db, row, cfg));
  return { skipped: false, dispatched: results.length, results };
}

function retry(db, code) {
  const row = db.prepare('SELECT * FROM notifications WHERE code = ?').get(code);
  if (!row) return false;
  db.prepare(
    `UPDATE notifications SET status = 'pending', next_attempt_at = NULL, attempts = 0, last_error = NULL WHERE code = ?`
  ).run(code);
  audit.record(db, { action: 'notification_retry', actor: 'operator', metadata: { code } });
  return true;
}

function cancel(db, code) {
  const r = db.prepare(
    `UPDATE notifications SET status = 'cancelled' WHERE code = ? AND status = 'pending'`
  ).run(code);
  if (r.changes) {
    audit.record(db, { action: 'notification_cancel', actor: 'operator', metadata: { code } });
  }
  return r.changes > 0;
}

module.exports = {
  enqueue,
  listPending,
  listAll,
  dispatchPending,
  dispatchOne,
  effectiveConfig,
  retry,
  cancel,
  MAX_ATTEMPTS,
  BACKOFF_MS,
};
