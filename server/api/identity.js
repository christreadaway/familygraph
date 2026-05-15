'use strict';


const { userFacingMessage } = require('./_errors');
// External-app identity API. Lets sibling apps in the portfolio (missionIQ,
// ParentPoint, future tools) bring in their own data while delegating the
// match-or-create-or-conflict decision to Family Graph. This is the
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
const profiles = require('../identity/profiles');
const audit = require('../audit');
const enc = require('../crypto/encryption');

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
    const { record, source = 'api', source_ref = null } = req.body || {};
    const incoming = _toIncoming(record);
    if (!incoming) return res.status(400).json({ error: 'record required' });

    const result = resolver.resolveOrCreatePerson(db, secrets, effective(), incoming, {
      actor: req.auth?.actor || 'external_app',
    });
    audit.record(db, {
      action: 'identity_resolve_commit',
      actor: req.auth?.actor || 'external_app',
      entityCode: result.code,
      entityKind: 'person',
      metadata: {
        source,
        source_ref,
        action: result.action,
        score: result.score,
        reasons: result.reasons,
        conflict: result.conflict || null,
      },
    });
    res.status(201).json(result);
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
