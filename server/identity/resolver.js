'use strict';

// Identity resolver. Vendored from MissionIQ's resolution rules conceptually.
// Behavior:
//   - For each incoming person record, score it against existing persons using
//     deterministic blocking (last-name hash) followed by per-field similarity.
//   - score >= autoMerge threshold: auto-merge silently (or auto-attach).
//   - score >= review threshold: enqueue a conflict for the operator.
//   - score <  review threshold: treat as a new person.
//   - For families, the same approach applies, using surname + address hash as
//     the blocking key.
//
// The resolver is intentionally simple. It is the right shape for v1 — the
// thresholds are tunable, additional rules can be encoded in the
// `resolution_rules` table, and the conflict queue absorbs the rest.

const enc = require('../crypto/encryption');
const people = require('./people');
const families = require('./families');
const contacts = require('./contacts');
const aliases = require('./aliases');
const rules = require('./rules');
const audit = require('../audit');
const { newCode } = require('../crypto/identifiers');

function similarity(a, b) {
  if (!a && !b) return 0;
  if (!a || !b) return 0;
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  if (x === y) return 1;
  // Damerau-Levenshtein-ish length-normalized similarity. Pure-JS, no deps.
  const dist = levenshtein(x, y);
  const maxLen = Math.max(x.length, y.length);
  if (maxLen === 0) return 0;
  return 1 - dist / maxLen;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const al = a.length;
  const bl = b.length;
  const v0 = new Array(bl + 1);
  const v1 = new Array(bl + 1);
  for (let i = 0; i <= bl; i++) v0[i] = i;
  for (let i = 0; i < al; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < bl; j++) {
      const cost = a.charCodeAt(i) === b.charCodeAt(j) ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    for (let j = 0; j <= bl; j++) v0[j] = v1[j];
  }
  return v0[bl];
}

function scorePerson(incoming, candidate) {
  // candidate has decrypted PII, incoming is plaintext input.
  const reasons = [];
  let score = 0;
  let weight = 0;

  const family = similarity(
    enc.normalizeName(incoming.family_name),
    enc.normalizeName(candidate.family_name)
  );
  score += family * 0.45;
  weight += 0.45;
  if (family >= 0.95) reasons.push('family_name_exact');
  else if (family >= 0.8) reasons.push('family_name_close');

  const given = similarity(
    enc.normalizeName(incoming.given_name),
    enc.normalizeName(candidate.given_name)
  );
  score += given * 0.35;
  weight += 0.35;
  if (given >= 0.95) reasons.push('given_name_exact');
  else if (given >= 0.8) reasons.push('given_name_close');

  if (incoming.date_of_birth && candidate.date_of_birth) {
    const dob =
      enc.normalizeName(incoming.date_of_birth) === enc.normalizeName(candidate.date_of_birth)
        ? 1
        : 0;
    score += dob * 0.2;
    weight += 0.2;
    if (dob === 1) reasons.push('dob_exact');
  }

  if (weight === 0) return { score: 0, reasons: [] };
  return { score: score / weight, reasons };
}

function findCandidates(db, secrets, incoming) {
  // Block by last-name hash, fall back to first-name if no match.
  const fh = enc.hmac(secrets, enc.normalizeName(incoming.family_name));
  const gh = enc.hmac(secrets, enc.normalizeName(incoming.given_name));
  const candidates = [];
  if (fh) {
    const rows = db
      .prepare(
        `SELECT * FROM persons WHERE status = 'active' AND family_name_hash = ? LIMIT 50`
      )
      .all(fh);
    candidates.push(...rows);
  }
  if (candidates.length === 0 && gh) {
    const rows = db
      .prepare(
        `SELECT * FROM persons WHERE status = 'active' AND given_name_hash = ? LIMIT 25`
      )
      .all(gh);
    candidates.push(...rows);
  }
  return candidates.map(r => ({
    code: r.code,
    given_name: enc.decrypt(secrets, r.given_name_ct),
    family_name: enc.decrypt(secrets, r.family_name_ct),
    date_of_birth: enc.decrypt(secrets, r.date_of_birth_ct),
  }));
}

// resolveOrCreatePerson:
//   action = 'auto_merged' | 'enqueued' | 'attached' | 'created'
function resolveOrCreatePerson(db, secrets, thresholds, incoming, opts = {}) {
  const candidates = findCandidates(db, secrets, incoming);
  const activeRules = rules.loadActive(db, 'person');
  let best = null;
  for (const c of candidates) {
    let r = scorePerson(incoming, c);
    if (activeRules.length > 0) {
      const adjusted = rules.applyToScore(activeRules, r, incoming, c, {
        incoming: { email: (incoming.emails || [])[0], postal: incoming.postal },
        candidate: { email: c.email, postal: c.postal },
      });
      r = { score: adjusted.score, reasons: adjusted.reasons, override: adjusted.override };
    }
    if (!best || r.score > best.score) best = { ...r, candidate: c };
  }

  if (best && best.score >= thresholds.autoMerge) {
    audit.record(db, {
      action: 'resolver_attach',
      actor: opts.actor || 'resolver',
      entityCode: best.candidate.code,
      entityKind: 'person',
      metadata: { score: best.score, reasons: best.reasons },
    });
    // Do not silently overwrite name/dob; leave the existing record. The
    // operator can edit later. If new fields exist on incoming and not on the
    // existing record, fill them.
    const patch = {};
    if (!best.candidate.given_name && incoming.given_name) patch.given_name = incoming.given_name;
    if (!best.candidate.family_name && incoming.family_name) patch.family_name = incoming.family_name;
    if (!best.candidate.date_of_birth && incoming.date_of_birth) patch.date_of_birth = incoming.date_of_birth;
    if (Object.keys(patch).length) people.update(db, secrets, best.candidate.code, patch);
    return { code: best.candidate.code, action: 'attached', score: best.score, reasons: best.reasons };
  }

  if (best && best.score >= thresholds.review) {
    // Create the new person and queue the conflict pair for operator review.
    const newPerson = people.create(db, secrets, incoming);
    const conflictCode = newCode('conflict');
    db.prepare(
      `INSERT INTO conflicts (code, kind, left_code, right_code, score, reasons)
       VALUES (?, 'person', ?, ?, ?, ?)`
    ).run(conflictCode, newPerson, best.candidate.code, best.score, JSON.stringify(best.reasons));
    audit.record(db, {
      action: 'resolver_enqueued',
      actor: opts.actor || 'resolver',
      entityCode: newPerson,
      entityKind: 'person',
      metadata: { score: best.score, reasons: best.reasons, conflict: conflictCode },
    });
    return { code: newPerson, action: 'enqueued', score: best.score, reasons: best.reasons, conflict: conflictCode };
  }

  const code = people.create(db, secrets, incoming);
  audit.record(db, {
    action: 'resolver_created',
    actor: opts.actor || 'resolver',
    entityCode: code,
    entityKind: 'person',
  });
  return { code, action: 'created', score: best ? best.score : 0, reasons: [] };
}

// Family resolution: same shape, blocked on (surname-hash + address-hash) so
// that two families with the same surname at different addresses don't merge.
function resolveOrCreateFamily(db, secrets, thresholds, input, opts = {}) {
  // Heuristic: prefer to attach to an existing family that already contains
  // any of `input.persons` resolved via attached/auto-merge above.
  const linkedFamilyCounts = new Map();
  for (const pc of input.personCodes || []) {
    const fams = db
      .prepare(
        `SELECT family_code FROM memberships WHERE person_code = ? AND ended_at IS NULL`
      )
      .all(aliases.resolveAlias(db, pc));
    for (const r of fams) {
      linkedFamilyCounts.set(r.family_code, (linkedFamilyCounts.get(r.family_code) || 0) + 1);
    }
  }
  // If any family contains a majority of the incoming people, attach there.
  if (linkedFamilyCounts.size > 0 && (input.personCodes || []).length > 0) {
    const sorted = [...linkedFamilyCounts.entries()].sort((a, b) => b[1] - a[1]);
    const [topFamily, count] = sorted[0];
    if (count / input.personCodes.length >= 0.5) {
      return { code: topFamily, action: 'attached' };
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

// Recompute conflicts for a freshly written person. Useful when a write happens
// outside the normal resolver path (manual creation in dashboard).
function rescorePerson(db, secrets, thresholds, personCode) {
  const target = aliases.resolveAlias(db, personCode);
  const row = db.prepare('SELECT * FROM persons WHERE code = ?').get(target);
  if (!row) return [];
  const incoming = {
    given_name: enc.decrypt(secrets, row.given_name_ct),
    family_name: enc.decrypt(secrets, row.family_name_ct),
    date_of_birth: enc.decrypt(secrets, row.date_of_birth_ct),
  };
  const candidates = findCandidates(db, secrets, incoming).filter(c => c.code !== target);
  const matches = [];
  for (const c of candidates) {
    const r = scorePerson(incoming, c);
    if (r.score >= thresholds.review) matches.push({ candidate: c, ...r });
  }
  for (const m of matches) {
    const dupe = db
      .prepare(
        `SELECT 1 FROM conflicts WHERE kind = 'person' AND status = 'open' AND
           ((left_code = ? AND right_code = ?) OR (left_code = ? AND right_code = ?))`
      )
      .get(target, m.candidate.code, m.candidate.code, target);
    if (dupe) continue;
    db.prepare(
      `INSERT INTO conflicts (code, kind, left_code, right_code, score, reasons)
       VALUES (?, 'person', ?, ?, ?, ?)`
    ).run(newCode('conflict'), target, m.candidate.code, m.score, JSON.stringify(m.reasons));
  }
  return matches;
}

module.exports = {
  scorePerson,
  similarity,
  resolveOrCreatePerson,
  resolveOrCreateFamily,
  rescorePerson,
};
