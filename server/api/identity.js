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
const crosswalk = require('../identity/crosswalk');
const audit = require('../audit');
const enc = require('../crypto/encryption');
const log = require('../log');

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

// Tag a just-opened conflict with the caller's provenance (source + source_ref)
// by merging into the conflict's metadata JSON. This is deliberately opaque:
// FamilyGraph stores whatever `source_ref` string the consuming app supplied
// (e.g. its own record id or a link) so an operator resolving the conflict can
// see where it came from — without FamilyGraph knowing anything about that app.
function _tagConflictSource(db, conflictCode, source, sourceRef) {
  if (!conflictCode || (!source && !sourceRef)) return;
  try {
    const row = db.prepare('SELECT metadata FROM conflicts WHERE code = ?').get(conflictCode);
    if (!row) return;
    let meta = {};
    if (row.metadata) { try { meta = JSON.parse(row.metadata) || {}; } catch (_) { meta = {}; } }
    if (source) meta.source = source;
    if (sourceRef) meta.source_ref = sourceRef;
    db.prepare('UPDATE conflicts SET metadata = ? WHERE code = ?').run(JSON.stringify(meta), conflictCode);
  } catch (_) { /* best effort — provenance is advisory */ }
}

// The person's current (active) families, newest first. More than one is
// normal (divorced parents, a duplicate contact confirmed as the same
// person), so callers must not just take the first.
function _activeFamilies(db, personCode) {
  const seen = new Set();
  for (const r of db.prepare(
    `SELECT family_code FROM memberships
       WHERE person_code = ? AND ended_at IS NULL
       ORDER BY started_at DESC`
  ).all(personCode)) seen.add(r.family_code);
  return [...seen];
}

// Derive a family display name from an incoming record (e.g. "Smith Family").
function _familyDisplayName(incoming) {
  const ln = incoming && incoming.family_name ? String(incoming.family_name).trim() : '';
  if (!ln) return null;
  return `${ln.charAt(0).toUpperCase()}${ln.slice(1)} Family`;
}

// Resolve the family for a just-resolved person.
//   - One active family: returned ({ code, action: 'existing' }).
//   - More than one: the caller's household is not ours to guess, because a
//     consuming app stamps the code on its own household once and never
//     corrects it. When the caller may read `source`'s crosswalk and exactly
//     one of those families is linked from that source, that is the one.
//     Otherwise { families: [codes] } and no family, so nothing gets stamped.
//   - None, and `create` is true: resolve-or-create a family from the
//     incoming record (reusing the resolver's person-overlap and
//     address-overlap attach heuristics) and attach the person.
//   - Returns null when there's no family and creation wasn't requested.
function _resolveFamily(db, secrets, thresholds, personCode, incoming, { create = false, actor = 'external_app', source = null, crosswalkOk = false } = {}) {
  const active = _activeFamilies(db, personCode);
  if (active.length === 1) return { code: active[0], action: 'existing' };
  if (active.length > 1) {
    const linked = crosswalkOk
      ? active.filter(f => crosswalk.refsFor(db, source, 'family', f).length > 0)
      : [];
    if (linked.length === 1) return { code: linked[0], action: 'existing' };
    return { families: active };
  }
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

// Put a _resolveFamily outcome on a response row: `family` as before, or
// `families` (codes only) when the person is in several households and none
// could be picked.
function _applyFamily(result, family) {
  if (!family) return;
  if (family.families) result.families = family.families;
  else result.family = family;
}

// Who may read a source's crosswalk: the master token, or the API key named
// after that source (MissionIQ's key is issued as
// `family-graph issue-key missioniq ...`). Anyone else asking with
// source:'missioniq' is ignored and goes through the normal resolver, so one
// app's key cannot map another app's record ids to people.
function _mayReadCrosswalk(auth, source) {
  if (!auth || typeof source !== 'string') return false;
  if (auth.kind === 'master') return true;
  return auth.kind === 'scoped' && auth.actor === source;
}

// A caller that sends a source's record refs but may not read that source's
// crosswalk (a MissionIQ key issued as 'MissionIQ' or 'missioniq-prod') is
// refused, not quietly resolved by name: the resolver could pick or mint a
// different person than the one the record is linked to, and the caller
// would stamp that id - one human, two ids. Fixed 2026-09-28 (third pass):
// this used to fall through with no log line. Only sources that have
// crosswalk entries are guarded, so an app's own fresh source is unaffected.
function _crosswalkRefusal(db, auth, source, hasRef) {
  if (!hasRef || typeof source !== 'string' || _mayReadCrosswalk(auth, source)) return null;
  const n = crosswalk.countBySource(db, source);
  if (!n.person && !n.family) return null;
  log.warn('identity.resolve.crosswalk_forbidden', { source, key: (auth && (auth.key_code || auth.kind)) || null });
  return {
    error: 'crosswalk_forbidden',
    detail: `this key may not use source "${source}": its record links belong to the key named "${source}". ` +
      `Issue one with: family-graph issue-key ${source}`,
  };
}
const _hasRef = v => typeof v === 'string' ? v !== '' : typeof v === 'number';

// A record a deliberate import already linked (the MissionIQ import, a roster
// commit with refs) is that person - returned by its own id, never
// re-matched by name - as long as the record still describes them (the same
// check roster.js applies: crosswalk.stillSame). A record edited into
// someone else returns { mismatch: true }: the caller falls back to the
// resolver and reports via 'crosswalk_mismatch', and the record's email and
// phone never touch the linked person. `action` stays 'attached' so existing
// callers count a hit as before; `via: 'crosswalk'` says how. Only deliberate
// imports write the crosswalk; /resolve reads it and never writes it, so a
// loose match here can never become a permanent link.
function _linked(db, secrets, auth, source, ref, incoming, suffix) {
  if (typeof source !== 'string' || (typeof ref !== 'string' && typeof ref !== 'number')) return null;
  if (!_mayReadCrosswalk(auth, source)) return null;
  const x = crosswalk.lookup(db, source, String(ref));
  if (!x || x.kind !== 'person') return null;
  if (!crosswalk.stillSame(db, secrets, { ...incoming, suffix: suffix || null }, x.code)) return { mismatch: true };
  const out = { code: x.code, action: 'attached', via: 'crosswalk', score: 1, reasons: ['linked_record'] };
  if (x.status !== 'active') out.status = x.status;
  return out;
}

// Crosswalk hit, or the normal resolver (tagged when a link was refused).
function _resolveOne(db, secrets, thresholds, auth, source, ref, record, incoming, actor) {
  const link = _linked(db, secrets, auth, source, ref, incoming, record && record.suffix);
  if (link && !link.mismatch) return link;
  const result = resolver.resolveOrCreatePerson(db, secrets, thresholds, incoming, { actor });
  if (link) result.via = 'crosswalk_mismatch';
  return result;
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
  // Body: { record: <loose>, source?, source_ref?, with_family? }
  // Commits the verdict: returns { code, action, score, reasons, conflict?,
  // via?, family?, families? }. via is 'crosswalk' for a linked record and
  // 'crosswalk_mismatch' when the linked record no longer describes that
  // person and the resolver decided instead. families (codes) replaces
  // family when the person is in several households and none could be picked.
  // Same shape as the internal /api/import/run per-row outcome so external
  // apps can persist their domain data keyed by `code` immediately.
  r.post('/resolve', (req, res) => {
    const { record, source = 'api', source_ref = null, with_family = false } = req.body || {};
    const incoming = _toIncoming(record);
    if (!incoming) return res.status(400).json({ error: 'record required' });

    const refused = _crosswalkRefusal(db, req.auth, source, _hasRef(source_ref));
    if (refused) return res.status(403).json(refused);

    const actor = req.auth?.actor || 'external_app';
    const crosswalkOk = _mayReadCrosswalk(req.auth, source);
    const result = _resolveOne(db, secrets, effective(), req.auth, source, source_ref, record, incoming, actor);
    _attachContacts(db, secrets, result.code, incoming);
    if (result.via === 'crosswalk_mismatch') log.warn('identity.resolve.crosswalk_mismatch', { source, action: result.action });

    // Enrich with the canonical family code so the caller can key family-scoped
    // domain data to it. Returns an existing family (never a guess between
    // several); only creates one when the caller opts in via with_family.
    const family = _resolveFamily(db, secrets, effective(), result.code, incoming, {
      create: !!with_family, actor, source, crosswalkOk,
    });
    _applyFamily(result, family);

    // If this opened a conflict, stamp it with the caller's provenance so the
    // operator can trace it back in the dashboard.
    if (result.conflict) _tagConflictSource(db, result.conflict, source, source_ref);

    audit.record(db, {
      action: 'identity_resolve_commit',
      actor,
      entityCode: result.code,
      entityKind: 'person',
      metadata: {
        source,
        source_ref,
        action: result.action,
        via: result.via || 'resolver',
        score: result.score,
        reasons: result.reasons,
        conflict: result.conflict || null,
        family: family && family.code ? { code: family.code, action: family.action } : null,
        families: family && family.families ? family.families.length : undefined,
      },
    });
    res.status(201).json(result);
  });

  // POST /api/identity/resolve-batch
  // Body: { records: [<loose>, ...], source?, source_ref?, with_family? }
  // Commit many records in one round-trip inside a single transaction. Returns
  // { results: [{ index, code, action, score, reasons, conflict?, via?, family?, families? }],
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
    const refused = _crosswalkRefusal(db, req.auth, source, records.some(r => r && _hasRef(r.source_ref)));
    if (refused) return res.status(403).json(refused);
    const actor = req.auth?.actor || 'external_app';
    const t = effective();
    const totals = { created: 0, attached: 0, enqueued: 0 };
    let linkedCount = 0;
    let mismatchCount = 0;
    const crosswalkOk = _mayReadCrosswalk(req.auth, source);
    const results = [];

    const run = db.transaction(() => {
      for (let i = 0; i < records.length; i++) {
        const incoming = _toIncoming(records[i]);
        if (!incoming) { results.push({ index: i, error: 'record required' }); continue; }
        // Crosswalk by the per-record ref only: the batch-level source_ref
        // names the batch, not a record.
        const result = _resolveOne(db, secrets, t, req.auth, source, records[i].source_ref, records[i], incoming, actor);
        if (result.via === 'crosswalk') linkedCount += 1;
        else if (result.via === 'crosswalk_mismatch') mismatchCount += 1;
        _attachContacts(db, secrets, result.code, incoming);
        const family = _resolveFamily(db, secrets, t, result.code, incoming, { create: !!with_family, actor, source, crosswalkOk });
        _applyFamily(result, family);
        // Per-record source_ref (falls back to the batch-level ref) so each
        // conflict traces back to the exact upstream record.
        if (result.conflict) {
          const rowRef = (records[i] && records[i].source_ref) || source_ref;
          _tagConflictSource(db, result.conflict, source, rowRef);
        }
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
      metadata: { source, source_ref, rows: records.length, totals, linked: linkedCount, crosswalk_mismatch: mismatchCount },
    });
    if (mismatchCount) log.warn('identity.resolve_batch.crosswalk_mismatch', { source, rows: records.length, mismatched: mismatchCount });
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
