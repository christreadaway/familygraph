'use strict';


const { userFacingMessage } = require('./_errors');
// External-app identity API. Lets consuming apps bring in their own data
// while delegating the match-or-create-or-conflict decision to Family
// Graph. This is the
// "back-and-forth" the architectural memo describes:
//
//   1. POST /api/identity/match   — peek (read-only). Given a record, return
//      the best candidate, confidence, reasons, and the action Family Graph
//      WOULD take. Caller can decide whether to commit.
//   2. POST /api/identity/resolve — commit. Same input shape; runs the
//      resolver and writes the outcome (auto-merge, conflict, or new
//      person). Returns the resulting person code so the caller can store
//      its domain data (donations, engagement events, etc.) keyed by it.
//   3. POST /api/identity/feedback — confirm or reject a previous match.
//      Lets the calling app surface "this is the same person" / "no, these
//      are different" decisions back into Family Graph's conflict store.
//
// The shape of the input record is intentionally loose — every field is
// optional and the matcher uses what's available. This mirrors the matching
// primitives in server/identity/matching.js.

const express = require('express');
const matching = require('../identity/matching');
const resolver = require('../identity/resolver');
const conflictsMod = require('../identity/conflicts');
const families = require('../identity/families');
const contacts = require('../identity/contacts');
const history = require('../identity/history');
const profiles = require('../identity/profiles');
const audit = require('../audit');
const enc = require('../crypto/encryption');

// Attach the incoming record's emails and phones to the resolved person, the
// same way the bulk import pipeline does. Without this the identity API creates
// persons with no contact channels, so a later resolve of the same email can't
// match on it and a duplicate is created — the exact opposite of what a
// consuming app calling /resolve wants. Idempotent: upsert + attach no-op when
// the channel is already linked.
function _attachContacts(db, secrets, personCode, incoming) {
  for (const email of incoming.emails || []) {
    const ec = contacts.upsertEmail(db, secrets, email);
    if (ec) contacts.attachEmailToPerson(db, personCode, ec, { isPrimary: false });
  }
  for (const phone of incoming.phones || []) {
    const pc = contacts.upsertPhone(db, secrets, phone);
    if (pc) contacts.attachPhoneToPerson(db, personCode, pc, { isPrimary: false });
  }
}

// The person's current (active) family, or null. Cheap membership lookup used
// to enrich resolve responses so a consuming app can key its family-scoped
// domain data (e.g. giving totals) to the canonical family code.
function _familyForPerson(db, personCode) {
  const row = db.prepare(
    `SELECT family_code FROM memberships
       WHERE person_code = ? AND ended_at IS NULL
       ORDER BY started_at DESC LIMIT 1`
  ).get(personCode);
  return row ? row.family_code : null;
}

// Derive a family display name from an incoming record (e.g. "Smith Family").
function _familyDisplayName(incoming) {
  const ln = incoming && incoming.family_name ? String(incoming.family_name).trim() : '';
  if (!ln) return null;
  return `${ln.charAt(0).toUpperCase()}${ln.slice(1)} Family`;
}

// Resolve the family for a just-resolved person.
//   - Always returns the person's existing active family if they have one
//     ({ code, action: 'existing' }).
//   - When `create` is true and the person has no family, resolve-or-create a
//     family from the incoming record (reusing the resolver's person-overlap
//     and address-overlap attach heuristics) and attach the person.
//   - Returns null when there's no family and creation wasn't requested.
function _resolveFamily(db, secrets, thresholds, personCode, incoming, { create = false, actor = 'external_app' } = {}) {
  const existing = _familyForPerson(db, personCode);
  if (existing) return { code: existing, action: 'existing' };
  if (!create) return null;

  const fam = resolver.resolveOrCreateFamily(db, secrets, thresholds, {
    display_name: _familyDisplayName(incoming),
    personCodes: [personCode],
    address: incoming.address || null,
  }, { actor });

  const already = db.prepare(
    `SELECT 1 FROM memberships WHERE family_code = ? AND person_code = ? AND ended_at IS NULL`
  ).get(fam.code, personCode);
  if (!already) {
    families.addMember(db, secrets, fam.code, personCode, { role: 'member' });
  }
  return { code: fam.code, action: fam.action };
}

// Translate the loose external-record shape into our internal canonical
// person + address. Accepts both flat (first_name/last_name) and structured
// (given_name/family_name) keys.
function _toIncoming(record) {
  if (!record || typeof record !== 'object') return null;
  const r = record;
  return {
    given_name: r.given_name || r.first_name || null,
    family_name: r.family_name || r.last_name || null,
    middle_name: r.middle_name || null,
    date_of_birth: r.date_of_birth || r.dob || null,
    gender: r.gender || null,
    emails: Array.isArray(r.emails)
      ? r.emails
      : (r.email ? [r.email] : []),
    phones: Array.isArray(r.phones)
      ? r.phones
      : (r.phone ? [r.phone] : []),
    address: r.address || (
      r.address_line1 || r.city || r.zip || r.postal
        ? {
            line1: r.address_line1 || null,
            line2: r.address_line2 || null,
            city: r.city || null,
            region: r.state || r.region || null,
            postal: r.postal || r.zip || null,
            country: r.country || null,
          }
        : null
    ),
  };
}

function build({ db, secrets, thresholds }) {
  const effective = () => profiles.thresholdsFor(db, thresholds);
  const r = express.Router();

  // POST /api/identity/match
  // Body: { record: <loose> }
  // Returns: { action, confidence, reasons, definitive, candidate }
  // No write. Caller can preview Family Graph's verdict before committing.
  r.post('/match', (req, res) => {
    const { record } = req.body || {};
    const incoming = _toIncoming(record);
    if (!incoming) return res.status(400).json({ error: 'record required' });

    const candidates = resolver.findCandidates(db, secrets, incoming);
    let best = null;
    for (const c of candidates) {
      const scored = matching.scoreMatch(_internalRec(incoming), c);
      if (!best || scored.confidence > best.confidence) best = { ...scored, candidate: c };
    }
    const t = effective();
    const action = best
      ? (best.definitive
          ? 'auto_merge'
          : best.confidence >= t.autoMerge ? 'auto_merge'
          : best.confidence >= t.review     ? 'review'
          : 'create')
      : 'create';
    audit.record(db, {
      action: 'identity_match_peek',
      actor: req.auth?.actor || 'external_app',
      metadata: { action, confidence: best?.confidence || 0 },
    });
    res.json({
      action,
      confidence: best?.confidence || 0,
      reasons: best?.reasons || [],
      definitive: !!(best && best.definitive),
      candidate: best ? { code: best.candidate.code } : null,
      thresholds: { autoMerge: t.autoMerge, review: t.review },
    });
  });

  // POST /api/identity/resolve
  // Body: { record: <loose>, source?, source_ref?, actor? }
  // Commits the verdict: returns { code, action, score, reasons, conflict? }
  // Same shape as the internal /api/import/run per-row outcome so external
  // apps can persist their domain data keyed by `code` immediately.
  r.post('/resolve', (req, res) => {
    const { record, source = 'api', source_ref = null, with_family = false } = req.body || {};
    const incoming = _toIncoming(record);
    if (!incoming) return res.status(400).json({ error: 'record required' });

    const actor = req.auth?.actor || 'external_app';
    const result = resolver.resolveOrCreatePerson(db, secrets, effective(), incoming, { actor });
    _attachContacts(db, secrets, result.code, incoming);

    // Enrich with the canonical family code so the caller can key family-scoped
    // domain data to it. Always returns an existing family; only creates one
    // when the caller opts in via with_family.
    const family = _resolveFamily(db, secrets, effective(), result.code, incoming, {
      create: !!with_family, actor,
    });
    if (family) result.family = family;

    audit.record(db, {
      action: 'identity_resolve_commit',
      actor,
      entityCode: result.code,
      entityKind: 'person',
      metadata: {
        source,
        source_ref,
        action: result.action,
        score: result.score,
        reasons: result.reasons,
        conflict: result.conflict || null,
        family: family ? { code: family.code, action: family.action } : null,
      },
    });
    res.status(201).json(result);
  });

  // POST /api/identity/resolve-batch
  // Body: { records: [<loose>, ...], source?, source_ref?, with_family? }
  // Commit many records in one round-trip inside a single transaction. Returns
  // { results: [{ index, code, action, score, reasons, conflict?, family? }],
  //   totals: { created, attached, enqueued } }. Same per-row outcome shape as
  // /resolve so a consuming app can persist domain data keyed by each code.
  // Bounded at 1000 records per call to keep a single request predictable.
  const MAX_BATCH = 1000;
  r.post('/resolve-batch', (req, res) => {
    const { records, source = 'api', source_ref = null, with_family = false } = req.body || {};
    if (!Array.isArray(records)) return res.status(400).json({ error: 'records array required' });
    if (records.length === 0) return res.json({ results: [], totals: { created: 0, attached: 0, enqueued: 0 } });
    if (records.length > MAX_BATCH) {
      return res.status(400).json({ error: `too many records (max ${MAX_BATCH})` });
    }
    const actor = req.auth?.actor || 'external_app';
    const t = effective();
    const totals = { created: 0, attached: 0, enqueued: 0 };
    const results = [];

    const run = db.transaction(() => {
      for (let i = 0; i < records.length; i++) {
        const incoming = _toIncoming(records[i]);
        if (!incoming) { results.push({ index: i, error: 'record required' }); continue; }
        const result = resolver.resolveOrCreatePerson(db, secrets, t, incoming, { actor });
        _attachContacts(db, secrets, result.code, incoming);
        const family = _resolveFamily(db, secrets, t, result.code, incoming, { create: !!with_family, actor });
        if (family) result.family = family;
        result.index = i;
        if (result.action === 'created') totals.created += 1;
        else if (result.action === 'attached') totals.attached += 1;
        else if (result.action === 'enqueued') totals.enqueued += 1;
        results.push(result);
      }
    });
    run();

    audit.record(db, {
      action: 'identity_resolve_batch',
      actor,
      metadata: { source, source_ref, rows: records.length, totals },
    });
    res.status(201).json({ results, totals });
  });

  // GET /api/identity/changed?since=<iso>&limit=&kinds=person,family
  // Forward-cursored feed of identity changes (create/update/merge/archive/…)
  // for consuming apps that cache FamilyGraph codes and need to know what moved
  // — the key case being an operator merging families in FamilyGraph's
  // dashboard, which turns a cached code into an alias. Returns only opaque
  // codes, operations, and timestamps (no PII), so it rides the pii.read scope.
  // Page forward by feeding the response's `next_since` back as `since`.
  r.get('/changed', (req, res) => {
    const since = req.query.since ? String(req.query.since) : null;
    const limit = req.query.limit ? Number(req.query.limit) : 500;
    const kinds = req.query.kinds
      ? String(req.query.kinds).split(',').map(s => s.trim()).filter(Boolean)
      : ['person', 'family'];
    const changes = history.changedSince(db, { since, kinds, limit });
    const next_since = changes.length ? changes[changes.length - 1].at : (since || null);
    res.json({ changes, next_since, count: changes.length });
  });

  // POST /api/identity/feedback
  // Body: { left_code, right_code, decision: 'same' | 'different', notes? }
  // Lets the caller record a same/different decision against an open or
  // already-resolved conflict pair. 'same' merges (left into right);
  // 'different' marks the pair as a sticky non-match so future imports
  // don't re-flag it.
  r.post('/feedback', (req, res) => {
    const { left_code, right_code, decision, notes = null, winner_code = null } = req.body || {};
    if (!left_code || !right_code || !decision) {
      return res.status(400).json({ error: 'left_code, right_code, decision required' });
    }
    const actor = req.auth?.actor || 'external_app';
    if (decision !== 'same' && decision !== 'different') {
      return res.status(400).json({ error: 'decision must be same | different' });
    }

    // Look for an existing open conflict for this pair.
    const existing = db.prepare(
      `SELECT code, status FROM conflicts
        WHERE kind = 'person'
          AND ((left_code = ? AND right_code = ?) OR (left_code = ? AND right_code = ?))
        ORDER BY created_at DESC LIMIT 1`
    ).get(left_code, right_code, right_code, left_code);

    let conflictCode;
    if (existing) {
      conflictCode = existing.code;
    } else {
      // Open a placeholder conflict so the decision has somewhere to land.
      const { newCode } = require('../crypto/identifiers');
      conflictCode = newCode('conflict');
      db.prepare(
        `INSERT INTO conflicts (code, kind, left_code, right_code, score, reasons, status)
         VALUES (?, 'person', ?, ?, 0.0, ?, 'open')`
      ).run(conflictCode, left_code, right_code, JSON.stringify(['external_feedback']));
    }

    if (decision === 'same') {
      const winner = winner_code || right_code;
      try {
        conflictsMod.resolveMerge(db, secrets, conflictCode, { winnerCode: winner, actor, notes });
      } catch (e) {
        return res.status(400).json({ error: userFacingMessage(e) });
      }
      return res.json({ ok: true, conflict: conflictCode, decision: 'merged', winner });
    }

    try {
      conflictsMod.resolveReject(db, conflictCode, { actor, notes });
    } catch (e) {
      return res.status(400).json({ error: userFacingMessage(e) });
    }
    res.json({ ok: true, conflict: conflictCode, decision: 'rejected_sticky' });
  });

  return r;
}

// Internal record helper used by /match — a pure mirror of incoming so the
// scorer can read both flat and structured shapes. Lives here (rather than
// importing from resolver) to keep the module dependency clean.
function _internalRec(incoming) {
  return {
    given_name: incoming.given_name,
    family_name: incoming.family_name,
    date_of_birth: incoming.date_of_birth,
    emails: incoming.emails || [],
    phones: incoming.phones
      ? incoming.phones.flatMap(p => matching.splitPhones(p))
      : [],
    address_line1: incoming.address?.line1 || null,
    city: incoming.address?.city || null,
    state: incoming.address?.region || null,
    zip: incoming.address?.postal || null,
  };
}

module.exports = build;
