'use strict';

// EIM (Ethics and Integrity in Ministry) helper. Centralises the renewal
// math so PersonDetail, the import path, and any future ministry roster
// view all derive expiration the same way.
//
// Diocesan EIM programs commonly require renewal every 3 years, but a few
// run a 5-year cycle. The renewal interval lives in the settings table
// under `eim.renewal_years`; if unset, default to 3. Whenever the operator
// supplies a completion date without an explicit expiration, we compute
// expiration = completion + renewal_years.
//
// Status flow:
//   pending    — paperwork in flight, not yet certified
//   certified  — completed, current-day is on or before eim_expires_on
//   expired    — current-day is past eim_expires_on
//
// `recomputeStatus` flips certified rows to expired without touching any
// other state. Run it once at boot (cheap UPDATE on an indexed column) and
// then daily, the same way the audit sweep runs.

const DEFAULT_RENEWAL_YEARS = 3;
const DEFAULT_EXPIRING_SOON_DAYS = 60;

function _readSetting(db, key) {
  const row = db.prepare(`SELECT value_json FROM settings WHERE key = ?`).get(key);
  if (!row) return null;
  try { return JSON.parse(row.value_json); } catch (_) { return null; }
}

function renewalYears(db) {
  const v = _readSetting(db, 'eim.renewal_years');
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  return DEFAULT_RENEWAL_YEARS;
}

function expiringSoonDays(db) {
  const v = _readSetting(db, 'eim.expiring_soon_days');
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  return DEFAULT_EXPIRING_SOON_DAYS;
}

function _addYearsIso(isoDate, years) {
  if (!isoDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // Calendar arithmetic: same month/day, year + N. Feb-29 rolls back to
  // Feb-28 in non-leap years (Date constructor handles this correctly).
  const dt = new Date(Date.UTC(y + years, mo - 1, d));
  if (Number.isNaN(dt.getTime())) return null;
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// Given an input patch and the current settings, fill in a missing
// expiration date when the caller provides only a completion date.
// Returns a new object; never mutates the input.
function deriveExpiration(db, input) {
  if (!input) return input;
  const out = { ...input };
  const hasCompleted = 'eim_completed_on' in out && out.eim_completed_on;
  const hasExplicitExpires = 'eim_expires_on' in out && out.eim_expires_on;
  if (hasCompleted && !hasExplicitExpires) {
    const years = renewalYears(db);
    const exp = _addYearsIso(out.eim_completed_on, years);
    if (exp) out.eim_expires_on = exp;
  }
  return out;
}

function _todayIso() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Flip eim_status to 'expired' for any certified row whose eim_expires_on
// has passed. Cheap UPDATE on an indexed column. Returns the number of
// rows changed for log/test visibility.
function recomputeStatus(db) {
  const today = _todayIso();
  const r = db.prepare(
    `UPDATE persons
        SET eim_status = 'expired',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE eim_status = 'certified'
        AND eim_expires_on IS NOT NULL
        AND eim_expires_on < ?`
  ).run(today);
  return r.changes;
}

// Convenience: persons whose current eim_expires_on falls between today and
// today + window_days. Operator can poll this for a "send renewal nudge"
// workflow. Returns rows with code, eim_status, eim_completed_on,
// eim_expires_on — no PII, so safe to call from any auth scope.
function listExpiringSoon(db, { windowDays } = {}) {
  const days = Number.isFinite(windowDays) && windowDays > 0
    ? windowDays
    : expiringSoonDays(db);
  const today = _todayIso();
  const end = (() => {
    const dt = new Date(`${today}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + days);
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  })();
  const rows = db.prepare(
    `SELECT code, eim_status, eim_completed_on, eim_expires_on
       FROM persons
      WHERE status = 'active'
        AND eim_expires_on IS NOT NULL
        AND eim_expires_on >= ?
        AND eim_expires_on <= ?
      ORDER BY eim_expires_on ASC`
  ).all(today, end);
  return { window_days: days, today, items: rows };
}

module.exports = {
  DEFAULT_RENEWAL_YEARS,
  DEFAULT_EXPIRING_SOON_DAYS,
  renewalYears,
  expiringSoonDays,
  deriveExpiration,
  recomputeStatus,
  listExpiringSoon,
  _addYearsIso,
};
