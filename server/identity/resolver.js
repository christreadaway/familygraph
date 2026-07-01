'use strict';

// Identity resolver. Vendored from the upstream identity engine — both the matching primitives
// (in ./matching.js) and the auto-merge / prompt-the-user gate that this
// module wraps.
//
// Behavior:
//   - For each incoming person record, gather candidates by hashing every
//     deterministic signal (last-name, first-name, every email, every phone,
//     and the address) and looking each one up in the indexed hash columns.
//   - Score each candidate using matching.scoreMatch — vendored from
//     the upstream identity engine — which returns { confidence, reasons, definitive }.
//   - DECISION GATE:
//       definitive (exact email/phone/strong address) AND no address conflict
//                                            → auto_merge
//       confidence ≥ thresholds.autoMerge   → auto_merge (attach)
//       confidence ≥ thresholds.review      → enqueue conflict
//       else                                  → create new person
//   - For families, the same approach plus the existing "attach to the family
//     that contains a majority of the incoming persons" heuristic.

const enc = require('../crypto/encryption');
const people = require('./people');
const families = require('./families');
const aliases = require('./aliases');
const rules = require('./rules');
const audit = require('../audit');
const matching = require('./matching');
const conflictsMod = require('./conflicts');
const { newCode } = require('../crypto/identifiers');

// Re-exported for backwards compat — some callers (and tests) import these
// from the resolver directly.
const { similarity, scoreMatch } = matching;

// Cross-source conflict detection. PRD §5.6: when a conflict is opened
// and the candidate's most recent provenance source differs from the
// incoming source, mark `cross_source: true` so the operator can filter
// the conflicts queue to "school + parish" pairs. Returns null when the
// information isn't available (no incoming source recorded, or the
// candidate has no provenance), in which case the conflict is stored
// with no metadata.
function _crossSourceMetadata(db, candidateCode, incomingSource) {
  if (!incomingSource) return null;
  const row = db.prepare(
    `SELECT sr.source AS source
       FROM provenance p
       JOIN source_records sr ON sr.code = p.source_code
      WHERE p.entity_code = ?
      ORDER BY sr.imported_at DESC
      LIMIT 1`
  ).get(candidateCode);
  if (!row || !row.source) return null;
  if (row.source === incomingSource) return null;
  return {
    cross_source: true,
    sources: [row.source, incomingSource].sort(),
  };
}

// Most-recent provenance source for a person. Returns null when there's no
// provenance row — typically a manually-created person.
function _mostRecentSource(db, personCode) {
  const row = db.prepare(
    `SELECT sr.source AS source
       FROM provenance p
       JOIN source_records sr ON sr.code = p.source_code
      WHERE p.entity_code = ?
      ORDER BY sr.imported_at DESC
      LIMIT 1`
  ).get(personCode);
  return row && row.source ? row.source : null;
}

// Cross-source metadata for a pair of existing persons. Used by the
// rescore pass where neither side is "incoming" — both have provenance.
function _crossSourceMetadataForPair(db, leftCode, rightCode) {
  const leftSource = _mostRecentSource(db, leftCode);
  const rightSource = _mostRecentSource(db, rightCode);
  if (!leftSource || !rightSource) return null;
  if (leftSource === rightSource) return null;
  return {
    cross_source: true,
    sources: [leftSource, rightSource].sort(),
  };
}

// ---------- candidate enrichment ----------

// Decrypt a person row into the loose record shape that matching.scoreMatch
// expects. Pulls every email/phone/address attached to the person too, so
// the scorer can compare multi-value fields against multi-value candidates.
function _enrichCandidate(db, secrets, row) {
  const cand = {
    code: row.code,
    given_name: enc.decrypt(secrets, row.given_name_ct),
    family_name: enc.decrypt(secrets, row.family_name_ct),
    date_of_birth: enc.decrypt(secrets, row.date_of_birth_ct),
    emails: [],
    phones: [],
    address_line1: null,
    city: null,
    state: null,
    zip: null,
  };

  const emailRows = db.prepare(
    `SELECT e.value_ct FROM person_emails pe JOIN emails e ON e.code = pe.email_code WHERE pe.person_code = ?`
  ).all(row.code);
  for (const er of emailRows) {
    const v = enc.decrypt(secrets, er.value_ct);
    if (v) cand.emails.push(String(v).toLowerCase().trim());
  }

  const phoneRows = db.prepare(
    `SELECT ph.value_ct FROM person_phones partner JOIN phones ph ON ph.code = partner.phone_code WHERE partner.person_code = ?`
  ).all(row.code);
  for (const pr of phoneRows) {
    const v = enc.decrypt(secrets, pr.value_ct);
    if (v) {
      for (const p of matching.splitPhones(v)) {
        if (!cand.phones.includes(p)) cand.phones.push(p);
      }
    }
  }

  // Address: prefer person_addresses, fall back to family primary.
  const addrRow = db.prepare(
    `SELECT a.* FROM person_addresses pa JOIN addresses a ON a.code = pa.address_code
       WHERE pa.person_code = ? ORDER BY pa.is_primary DESC LIMIT 1`
  ).get(row.code);
  let addr = addrRow;
  if (!addr) {
    addr = db.prepare(
      `SELECT a.* FROM memberships m
         JOIN family_addresses fa ON fa.family_code = m.family_code
         JOIN addresses a ON a.code = fa.address_code
        WHERE m.person_code = ? AND m.ended_at IS NULL
        ORDER BY fa.is_primary DESC LIMIT 1`
    ).get(row.code);
  }
  if (addr) {
    cand.address_line1 = enc.decrypt(secrets, addr.line1_ct);
    cand.city = enc.decrypt(secrets, addr.city_ct);
    cand.state = enc.decrypt(secrets, addr.region_ct);
    cand.zip = enc.decrypt(secrets, addr.postal_ct);
  }

  return cand;
}

// Cast an `incoming` record (the canonical-import shape) into the same record
// shape `matching.scoreMatch` consumes.
function _toMatcherRecord(incoming) {
  return {
    given_name: incoming.given_name || null,
    family_name: incoming.family_name || null,
    date_of_birth: incoming.date_of_birth || null,
    emails: Array.isArray(incoming.emails) ? incoming.emails.map(String) : [],
    phones: Array.isArray(incoming.phones)
      ? incoming.phones.flatMap(p => matching.splitPhones(p))
      : [],
    address_line1: incoming.address_line1 || (incoming.address && incoming.address.line1) || null,
    city: incoming.city || (incoming.address && incoming.address.city) || null,
    state: incoming.state || incoming.region || (incoming.address && incoming.address.region) || null,
    zip: incoming.zip || incoming.postal || (incoming.address && incoming.address.postal) || null,
  };
}

// Gather candidate persons by every deterministic signal we can hash against.
// Vendored conceptually from the upstream resolver.
function findCandidates(db, secrets, incoming) {
  const seen = new Map();   // code → row
  const fh = enc.hmac(secrets, enc.normalizeName(incoming.family_name));
  const gh = enc.hmac(secrets, enc.normalizeName(incoming.given_name));

  // 1. Block on family-name hash. (Suffix-aware: also try the suffix-stripped
  //    base name so "Smith Jr." finds existing "Smith" rows.)
  function fetchByFamily(name) {
    if (!name) return;
    const h = enc.hmac(secrets, enc.normalizeName(name));
    if (!h) return;
    for (const r of db.prepare(
      `SELECT * FROM persons WHERE status = 'active' AND family_name_hash = ? LIMIT 50`
    ).all(h)) {
      seen.set(r.code, r);
    }
  }
  fetchByFamily(incoming.family_name);
  if (incoming.family_name) {
    const { baseName } = matching.stripSuffix(incoming.family_name);
    if (baseName && baseName !== incoming.family_name) fetchByFamily(baseName);
  }

  // 2. Block on email hashes.
  for (const email of incoming.emails || []) {
    const norm = enc.normalizeEmail(email);
    if (!norm) continue;
    const h = enc.hmac(secrets, norm);
    const rows = db.prepare(
      `SELECT p.* FROM persons p
         JOIN person_emails pe ON pe.person_code = p.code
         JOIN emails e ON e.code = pe.email_code
        WHERE p.status = 'active' AND e.norm_hash = ? LIMIT 25`
    ).all(h);
    for (const r of rows) seen.set(r.code, r);
  }

  // 3. Block on phone hashes.
  for (const phone of incoming.phones || []) {
    for (const p of matching.splitPhones(phone)) {
      const norm = enc.normalizePhone(p);
      if (!norm) continue;
      const h = enc.hmac(secrets, norm);
      const rows = db.prepare(
        `SELECT p.* FROM persons p
           JOIN person_phones partner ON partner.person_code = p.code
           JOIN phones ph ON ph.code = partner.phone_code
          WHERE p.status = 'active' AND ph.norm_hash = ? LIMIT 25`
      ).all(h);
      for (const r of rows) seen.set(r.code, r);
    }
  }

  // 4. Block on address hash — pulls every person who lives at this address,
  //    even if their last name is different.
  const addrParts = incoming.address || {};
  const addrLine1 = incoming.address_line1 || addrParts.line1;
  if (addrLine1) {
    const norm = enc.normalizeAddress({
      line1: addrLine1,
      line2: incoming.address_line2 || addrParts.line2,
      city: incoming.city || addrParts.city,
      region: incoming.region || addrParts.region,
      postal: incoming.postal || addrParts.postal,
      country: incoming.country || addrParts.country,
    });
    if (norm) {
      const h = enc.hmac(secrets, norm);
      const rows = db.prepare(
        `SELECT p.* FROM persons p
           JOIN memberships m ON m.person_code = p.code AND m.ended_at IS NULL
           JOIN family_addresses fa ON fa.family_code = m.family_code
           JOIN addresses a ON a.code = fa.address_code
          WHERE p.status = 'active' AND a.norm_hash = ? LIMIT 50`
      ).all(h);
      for (const r of rows) seen.set(r.code, r);
    }
  }

  // 5. Last-resort: first-name hash (only if nothing else hit).
  if (seen.size === 0 && gh) {
    for (const r of db.prepare(
      `SELECT * FROM persons WHERE status = 'active' AND given_name_hash = ? LIMIT 25`
    ).all(gh)) {
      seen.set(r.code, r);
    }
  }

  return Array.from(seen.values()).map(r => _enrichCandidate(db, secrets, r));
}

// ---------- the gate ----------
//
// Returns { action, candidate?, confidence, reasons, definitive }.
// The shape is the same one the calling code already consumed.
function decideMatch(scored, thresholds) {
  if (!scored) return { action: 'create', confidence: 0, reasons: [], definitive: false };
  const { confidence, reasons, definitive } = scored;
  if (definitive) return { action: 'auto_merge', confidence, reasons, definitive: true };
  if (confidence >= thresholds.autoMerge) return { action: 'auto_merge', confidence, reasons, definitive: false };
  if (confidence >= thresholds.review) return { action: 'review', confidence, reasons, definitive: false };
  return { action: 'create', confidence, reasons, definitive: false };
}

// ---------- public API ----------

function resolveOrCreatePerson(db, secrets, thresholds, incoming, opts = {}) {
  const candidates = findCandidates(db, secrets, incoming);
  const incomingRec = _toMatcherRecord(incoming);
  const activeRules = rules.loadActive(db, 'person');

  let best = null;
  for (const c of candidates) {
    let scored = matching.scoreMatch(incomingRec, c);
    if (activeRules.length > 0) {
      const adjusted = rules.applyToScore(
        activeRules,
        { score: scored.confidence, reasons: scored.reasons },
        incoming,
        c,
        {
          incoming: { email: (incomingRec.emails || [])[0], postal: incomingRec.zip },
          candidate: { email: (c.emails || [])[0], postal: c.zip },
        }
      );
      scored = {
        confidence: adjusted.score,
        reasons: adjusted.reasons,
        definitive: scored.definitive && !adjusted.override,
      };
    }
    if (!best || scored.confidence > best.confidence) best = { ...scored, candidate: c };
  }

  const decision = decideMatch(best, thresholds);

  if (decision.action === 'auto_merge') {
    audit.record(db, {
      action: 'resolver_attach',
      actor: opts.actor || 'resolver',
      entityCode: best.candidate.code,
      entityKind: 'person',
      metadata: {
        confidence: decision.confidence,
        reasons: decision.reasons,
        definitive: decision.definitive,
      },
    });
    // Patch in any new fields the existing record was missing.
    const patch = {};
    if (!best.candidate.given_name && incoming.given_name) patch.given_name = incoming.given_name;
    if (!best.candidate.family_name && incoming.family_name) patch.family_name = incoming.family_name;
    if (!best.candidate.date_of_birth && incoming.date_of_birth) patch.date_of_birth = incoming.date_of_birth;
    if (Object.keys(patch).length) people.update(db, secrets, best.candidate.code, patch);
    return {
      code: best.candidate.code,
      action: 'attached',
      score: decision.confidence,
      reasons: decision.reasons,
      definitive: decision.definitive,
    };
  }

  if (decision.action === 'review') {
    // Sticky non-match: if the operator already triaged a pair involving
    // this candidate as not-the-same, don't re-flag it. The new record is
    // created as a fresh person with no conflict opened. The check below
    // is intentionally on the post-creation `newPerson` code — the
    // self-pair check that used to sit here was dead code (same code on
    // both sides never matches) and has been removed.
    const newPerson = people.create(db, secrets, incoming);
    if (conflictsMod.hasStickyNonMatch(db, newPerson, best.candidate.code)) {
      audit.record(db, {
        action: 'resolver_sticky_skip',
        actor: opts.actor || 'resolver',
        entityCode: newPerson,
        entityKind: 'person',
        metadata: {
          reason: 'prior_decision_rejected_or_dismissed',
          peer: best.candidate.code,
        },
      });
      return {
        code: newPerson,
        action: 'created',
        score: decision.confidence,
        reasons: decision.reasons,
        sticky_skip: true,
      };
    }
    const conflictCode = newCode('conflict');
    const meta = _crossSourceMetadata(db, best.candidate.code, opts.source || null);
    db.prepare(
      `INSERT INTO conflicts (code, kind, left_code, right_code, score, reasons, metadata)
       VALUES (?, 'person', ?, ?, ?, ?, ?)`
    ).run(
      conflictCode, newPerson, best.candidate.code,
      decision.confidence, JSON.stringify(decision.reasons),
      meta ? JSON.stringify(meta) : null,
    );
    audit.record(db, {
      action: 'resolver_enqueued',
      actor: opts.actor || 'resolver',
      entityCode: newPerson,
      entityKind: 'person',
      metadata: { confidence: decision.confidence, reasons: decision.reasons, conflict: conflictCode },
    });
    return {
      code: newPerson,
      action: 'enqueued',
      score: decision.confidence,
      reasons: decision.reasons,
      conflict: conflictCode,
    };
  }

  const code = people.create(db, secrets, incoming);
  audit.record(db, {
    action: 'resolver_created',
    actor: opts.actor || 'resolver',
    entityCode: code,
    entityKind: 'person',
  });
  return { code, action: 'created', score: best ? best.confidence : 0, reasons: [] };
}

function resolveOrCreateFamily(db, secrets, thresholds, input, opts = {}) {
  // 1. Person-overlap heuristic: if a majority of the incoming persons already
  //    live in some existing family, attach there.
  const linkedFamilyCounts = new Map();
  for (const pc of input.personCodes || []) {
    const fams = db.prepare(
      `SELECT family_code FROM memberships WHERE person_code = ? AND ended_at IS NULL`
    ).all(aliases.resolveAlias(db, pc));
    for (const r of fams) {
      linkedFamilyCounts.set(r.family_code, (linkedFamilyCounts.get(r.family_code) || 0) + 1);
    }
  }
  if (linkedFamilyCounts.size > 0 && (input.personCodes || []).length > 0) {
    const sorted = [...linkedFamilyCounts.entries()].sort((a, b) => b[1] - a[1]);
    const [topFamily, count] = sorted[0];
    if (count / input.personCodes.length >= 0.5) {
      return { code: topFamily, action: 'attached' };
    }
  }

  // 2. Address-overlap: if no person overlapped but the incoming address
  //    matches an existing family's primary address, attach there. This is
  //    the "blended household" / "spouse keeping maiden name" case — same
  //    home, different person, same family. Requires a meaningful line1
  //    (city+zip alone aren't specific enough — many families share a city).
  const addr = input.address || null;
  if (addr && addr.line1) {
    const norm = enc.normalizeAddress({
      line1: addr.line1 || null,
      line2: addr.line2 || null,
      city: addr.city || null,
      region: addr.region || null,
      postal: addr.postal || null,
      country: addr.country || null,
    });
    if (norm) {
      const h = enc.hmac(secrets, norm);
      const fam = db.prepare(
        `SELECT fa.family_code AS code
           FROM addresses a
           JOIN family_addresses fa ON fa.address_code = a.code
           JOIN families f ON f.code = fa.family_code
          WHERE a.norm_hash = ? AND f.status = 'active'
          LIMIT 1`
      ).get(h);
      if (fam) return { code: fam.code, action: 'attached' };
    }
  }

  const code = families.create(db, secrets, {
    display_name: input.display_name,
    notes: input.notes,
  });
  audit.record(db, {
    action: 'resolver_created',
    actor: opts.actor || 'resolver',
    entityCode: code,
    entityKind: 'family',
  });
  return { code, action: 'created' };
}

function rescorePerson(db, secrets, thresholds, personCode) {
  const target = aliases.resolveAlias(db, personCode);
  const row = db.prepare('SELECT * FROM persons WHERE code = ?').get(target);
  if (!row) return [];
  const incoming = _enrichCandidate(db, secrets, row);
  const candidates = findCandidates(db, secrets, incoming).filter(c => c.code !== target);
  const matches = [];
  for (const c of candidates) {
    const scored = matching.scoreMatch(incoming, c);
    if (scored.confidence >= thresholds.review) {
      matches.push({ candidate: c, ...scored });
    }
  }
  for (const m of matches) {
    // Skip if there's an existing OPEN conflict for this pair OR a prior
    // non-match decision the operator already made (rejected/dismissed).
    const dupe = db.prepare(
      `SELECT status FROM conflicts WHERE kind = 'person' AND
         ((left_code = ? AND right_code = ?) OR (left_code = ? AND right_code = ?))`
    ).get(target, m.candidate.code, m.candidate.code, target);
    if (dupe) continue;
    // Cross-source metadata: both sides have provenance here (rescore runs
    // against existing persons), so we compare their most-recent sources.
    // Keeps the cross-source filter in the conflicts queue useful for
    // duplicates surfaced by the periodic scan, not just per-import ones.
    const meta = _crossSourceMetadataForPair(db, target, m.candidate.code);
    db.prepare(
      `INSERT INTO conflicts (code, kind, left_code, right_code, score, reasons, metadata)
       VALUES (?, 'person', ?, ?, ?, ?, ?)`
    ).run(
      newCode('conflict'), target, m.candidate.code, m.confidence,
      JSON.stringify(m.reasons),
      meta ? JSON.stringify(meta) : null,
    );
  }
  return matches;
}

// Backwards-compatible scorePerson — preserved for callers (and tests) that
// still use it. Routes through matching.scoreMatch.
function scorePerson(incoming, candidate) {
  const scored = matching.scoreMatch(_toMatcherRecord(incoming), candidate);
  return { score: scored.confidence, reasons: scored.reasons };
}

module.exports = {
  scorePerson,
  similarity,
  scoreMatch,
  decideMatch,
  findCandidates,
  resolveOrCreatePerson,
  resolveOrCreateFamily,
  rescorePerson,
};
