'use strict';

// Incremental change feeds for §6.4:
//   GET /v1/persons/changed?since=<iso>
//   GET /v1/households/changed?since=<iso>
//
// We answer from the existing `updated_at` columns on `persons` and
// `families`. The ParentPoint contract layer bumps `updated_at` on linked
// writes (emails, phones, consents, memberships) so this feed surfaces the
// person/household even when only a sub-record changed.
//
// Deleted (`status != 'active'`) rows are included with `active: false`
// so PP can purge its cached copy. The doc says webhook events include
// 'person.deleted' / 'household.deleted'; the changed-since feed is the
// recovery channel when a webhook delivery dropped on the floor.

const objects = require('./objects');

function _parseSince(since) {
  if (!since) return '1970-01-01T00:00:00.000Z';
  const s = String(since);
  // Accept anything Date can parse; coerce to UTC ISO.
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid 'since' timestamp: ${since}`);
  return d.toISOString();
}

function listChangedPersons(db, secrets, since, { limit = 200 } = {}) {
  const sinceIso = _parseSince(since);
  const lim = Math.max(1, Math.min(1000, Number(limit) || 200));
  // Union the two sources of "person changed": the persons row itself, and
  // its consent row. Each updated_at bumps when its respective record
  // changes, and the ParentPoint write paths bump persons.updated_at on
  // linked email/phone/consent writes — but a webhook to consent.updated
  // might still arrive without a persons.updated_at bump if the operator
  // updated consent through some future surface. The union is cheap.
  const rows = db.prepare(
    `SELECT code, updated_at FROM persons
        WHERE updated_at > ?
        AND status != 'merged'
        UNION
        SELECT person_code AS code, updated_at FROM person_consents
        WHERE updated_at > ?
        ORDER BY updated_at ASC LIMIT ?`
  ).all(sinceIso, sinceIso, lim);

  // Deduplicate (same code can appear from both subqueries). Preserve
  // ascending order of updated_at.
  const seen = new Set();
  const items = [];
  for (const r of rows) {
    if (seen.has(r.code)) continue;
    seen.add(r.code);
    const obj = objects.personObject(db, secrets, r.code);
    if (!obj) continue;
    items.push(obj);
  }

  const lastUpdated = items.length ? items[items.length - 1].updatedAt : sinceIso;
  return {
    since: sinceIso,
    cursor: lastUpdated,
    items,
  };
}

function listChangedHouseholds(db, secrets, since, { limit = 200 } = {}) {
  const sinceIso = _parseSince(since);
  const lim = Math.max(1, Math.min(1000, Number(limit) || 200));
  const rows = db.prepare(
    `SELECT code, updated_at FROM families
        WHERE updated_at > ?
        AND status != 'merged'
        ORDER BY updated_at ASC LIMIT ?`
  ).all(sinceIso, lim);
  const items = rows
    .map(r => objects.householdObject(db, secrets, r.code))
    .filter(Boolean);
  const lastUpdated = items.length ? items[items.length - 1].updatedAt : sinceIso;
  return {
    since: sinceIso,
    cursor: lastUpdated,
    items,
  };
}

module.exports = { listChangedPersons, listChangedHouseholds };
