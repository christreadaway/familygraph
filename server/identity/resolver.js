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
//       definitive (exact email/phone with a first name that lines up, or
//       exact first + last name with the same birthdate or home address;
//       no birthdate or Jr/Sr conflict) AND no address conflict
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

// ---------- prepared statements ----------
//
// better-sqlite3 compiles SQL on every db.prepare(). The candidate path runs
// the same few statements thousands of times per roster import (every
// candidate is enriched with four queries), and recompiling them was about a
// third of all CPU in a 500-row roster plan. One cache per database handle;
// a WeakMap, so a closed database takes its statements with it. Only used
// with .all() / .get(), which finish before returning, so sharing is safe.
const _stmtCache = new WeakMap();
function _stmt(db, sql) {
  let byDb = _stmtCache.get(db);
  if (!byDb) {
    byDb = new Map();
    _stmtCache.set(db, byDb);
  }
  let st = byDb.get(sql);
  if (!st) {
    st = db.prepare(sql);
    byDb.set(sql, st);
  }
  return st;
}

// ---------- candidate enrichment ----------

// Decrypt a person row into the loose record shape that matching.scoreMatch
// expects. Pulls every email/phone/address attached to the person too, so
// the scorer can compare multi-value fields against multi-value candidates.
function _enrichCandidate(db, secrets, row) {
  const cand = {
    code: row.code,
    status: row.status,
    kind: row.kind || null,
    given_name: enc.decrypt(secrets, row.given_name_ct),
    family_name: enc.decrypt(secrets, row.family_name_ct),
    suffix: enc.decrypt(secrets, row.suffix_ct),
    date_of_birth: enc.decrypt(secrets, row.date_of_birth_ct),
    emails: [],
    phones: [],
    address_line1: null,
    city: null,
    state: null,
    zip: null,
  };

  const emailRows = _stmt(db,
    `SELECT e.value_ct FROM person_emails pe JOIN emails e ON e.code = pe.email_code WHERE pe.person_code = ?`
  ).all(row.code);
  for (const er of emailRows) {
    const v = enc.decrypt(secrets, er.value_ct);
    if (v) cand.emails.push(String(v).toLowerCase().trim());
  }

  const phoneRows = _stmt(db,
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
  const addrRow = _stmt(db,
    `SELECT a.* FROM person_addresses pa JOIN addresses a ON a.code = pa.address_code
       WHERE pa.person_code = ? ORDER BY pa.is_primary DESC LIMIT 1`
  ).get(row.code);
  let addr = addrRow;
  if (!addr) {
    addr = _stmt(db,
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
    suffix: incoming.suffix || null,
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
//
// opts.strict (roster imports): the surname block is not capped at 50 - in a
// parish with 60 Garcias the right Garcia must never fall off the end of an
// unordered LIMIT and come back as "new" - and exact first+last matches are
// fetched first. opts.includeArchived: archived (soft-deleted) persons are
// candidates too, so someone who returns gets their old identifier back
// instead of a second one. Merged persons are never candidates; their alias
// points at the survivor.
//
// Strict mode also pre-filters the surname block before enrichment (see
// _strictBlockFilter): a Garcia whom only the surname query found, and who
// cannot earn a first-name, birthdate, email or phone reason from
// scoreMatch, is dropped. Anyone another query found is always kept.
// Non-strict results are unchanged.
function findCandidates(db, secrets, incoming, opts = {}) {
  const seen = new Map();   // code → row
  // Codes returned by any query other than the plain surname block (exact
  // name, email, phone, address, first-name fallback). Never pre-filtered.
  const pinned = new Set();
  const take = (r, pin) => {
    seen.set(r.code, r);
    if (pin) pinned.add(r.code);
  };
  // Email hashes whose block query hit its LIMIT (strict pre-filter only).
  const emailHashesAtLimit = [];
  const fh = enc.hmac(secrets, enc.normalizeName(incoming.family_name));
  const gh = enc.hmac(secrets, enc.normalizeName(incoming.given_name));
  const statusSql = opts.includeArchived ? `status IN ('active','archived')` : `status = 'active'`;
  const pStatusSql = opts.includeArchived ? `p.status IN ('active','archived')` : `p.status = 'active'`;
  const familyLimit = opts.strict ? 2000 : 50;

  // 1. Block on family-name hash. (Suffix-aware: also try the suffix-stripped
  //    base name so "Smith Jr." finds existing "Smith" rows.)
  function fetchByFamily(name) {
    if (!name) return;
    const h = enc.hmac(secrets, enc.normalizeName(name));
    if (!h) return;
    if (opts.strict && gh) {
      for (const r of _stmt(db,
        `SELECT * FROM persons WHERE ${statusSql} AND family_name_hash = ? AND given_name_hash = ?`
      ).all(h, gh)) {
        take(r, true);
      }
    }
    for (const r of _stmt(db,
      `SELECT code, status, kind, given_name_ct, family_name_ct, suffix_ct, date_of_birth_ct FROM persons WHERE ${statusSql} AND family_name_hash = ? LIMIT ${familyLimit}`
    ).all(h)) {
      take(r, false);
    }
  }
  fetchByFamily(incoming.family_name);
  if (incoming.family_name) {
    const { baseName } = matching.stripSuffix(incoming.family_name);
    if (baseName && baseName !== incoming.family_name) fetchByFamily(baseName);
  }

  // Strict (roster) lookups for email, phone and address drive the join from
  // the one matching email / phone / address row. The link tables have no
  // index on email_code / phone_code / address_code, so the plain joins below
  // make SQLite walk EVERY person and probe the link table for each - about
  // 3 ms per address lookup at 4,000 people, most of a re-plan. The ORDER BY
  // pins the order that plan produced (status, then rowid, then membership
  // rowid), so the rows and the LIMIT cut are the same. Non-strict lookups
  // keep the original SQL untouched.

  // 2. Block on email hashes.
  const emailSql = opts.strict
    ? `SELECT p.* FROM emails e
         CROSS JOIN person_emails pe
         CROSS JOIN persons p
        WHERE e.norm_hash = ? AND pe.email_code = e.code AND p.code = pe.person_code AND ${pStatusSql}
        ORDER BY p.status, p.rowid LIMIT 25`
    : `SELECT p.* FROM persons p
         JOIN person_emails pe ON pe.person_code = p.code
         JOIN emails e ON e.code = pe.email_code
        WHERE ${pStatusSql} AND e.norm_hash = ? LIMIT 25`;
  for (const email of incoming.emails || []) {
    const norm = enc.normalizeEmail(email);
    if (!norm) continue;
    const h = enc.hmac(secrets, norm);
    const rows = _stmt(db, emailSql).all(h);
    for (const r of rows) take(r, true);
    if (rows.length >= 25) emailHashesAtLimit.push(h);
  }

  // 3. Block on phone hashes.
  const phoneSql = opts.strict
    ? `SELECT p.* FROM phones ph
         CROSS JOIN person_phones partner
         CROSS JOIN persons p
        WHERE ph.norm_hash = ? AND partner.phone_code = ph.code AND p.code = partner.person_code AND ${pStatusSql}
        ORDER BY p.status, p.rowid LIMIT 25`
    : `SELECT p.* FROM persons p
           JOIN person_phones partner ON partner.person_code = p.code
           JOIN phones ph ON ph.code = partner.phone_code
          WHERE ${pStatusSql} AND ph.norm_hash = ? LIMIT 25`;
  for (const phone of incoming.phones || []) {
    for (const p of matching.splitPhones(phone)) {
      const norm = enc.normalizePhone(p);
      if (!norm) continue;
      const h = enc.hmac(secrets, norm);
      const rows = _stmt(db, phoneSql).all(h);
      for (const r of rows) take(r, true);
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
      const addressSql = opts.strict
        ? `SELECT p.* FROM addresses a
             CROSS JOIN family_addresses fa
             CROSS JOIN memberships m
             CROSS JOIN persons p
            WHERE a.norm_hash = ? AND fa.address_code = a.code
              AND m.family_code = fa.family_code AND m.ended_at IS NULL
              AND p.code = m.person_code AND ${pStatusSql}
            ORDER BY p.status, p.rowid, m.rowid LIMIT 50`
        : `SELECT p.* FROM persons p
           JOIN memberships m ON m.person_code = p.code AND m.ended_at IS NULL
           JOIN family_addresses fa ON fa.family_code = m.family_code
           JOIN addresses a ON a.code = fa.address_code
          WHERE ${pStatusSql} AND a.norm_hash = ? LIMIT 50`;
      const rows = _stmt(db, addressSql).all(h);
      for (const r of rows) take(r, true);
    }
  }

  // 5. Last-resort: first-name hash (only if nothing else hit).
  if (seen.size === 0 && gh) {
    for (const r of _stmt(db,
      `SELECT * FROM persons WHERE ${statusSql} AND given_name_hash = ? LIMIT 25`
    ).all(gh)) {
      take(r, true);
    }
  }

  let rows = Array.from(seen.values());
  if (opts.strict) rows = _strictBlockFilter(db, secrets, incoming, rows, pinned, emailHashesAtLimit);
  return rows.map(r => _enrichCandidate(db, secrets, r));
}

// Strict-mode surname-block pre-filter. In a parish with 80 people sharing
// one surname, enriching and scoring every one of them for every incoming
// person was most of a roster plan's time. Using only what the persons row
// already carries (first name, birthdate), plus one batched phone lookup,
// drop a row the surname query alone found when scoreMatch(strict) could
// not give it any of:
//   - a first-name reason: fs > 0.60 is the weakest band
//     (phonetic_first_name); below that, transposedSimilarity >= 0.75 is
//     first_name_typo. Same helpers, same argument order as scoreMatch.
//   - exact_date_of_birth: the same comparison scoreMatch makes.
//   - exact_email_match / exact_phone_match (see below).
// Without one of those a candidate can never be definitive in strict mode
// (every definitive path needs an aligned first name, an exact birthdate,
// or a shared contact) and carries nothing but surname / address / zip /
// city signals. Rules cannot make a pair definitive either.
//
// Contacts: an exact email match implies equal email hashes, so the email
// query already pinned that person - unless it hit its LIMIT, in which case
// every holder of that hash is pinned here. Phones differ: the phone query
// hashes the whole stored value while scoreMatch splits it ("512-555-0101
// x23", two numbers in one field), so a shared phone can go unnoticed by the
// query. When the incoming person has phones, the remaining rows' phones are
// fetched in one query and compared the way scoreMatch compares them.
//
// Incoming without a first name: nothing is filtered. Order is preserved.
function _strictBlockFilter(db, secrets, incoming, rows, pinned, emailHashesAtLimit) {
  const givenIn = incoming.given_name || null;
  if (!givenIn) return rows;
  if (rows.every(r => pinned.has(r.code))) return rows;

  for (const h of emailHashesAtLimit) {
    for (const r of _stmt(db,
      `SELECT pe.person_code AS code FROM person_emails pe
         JOIN emails e ON e.code = pe.email_code
        WHERE e.norm_hash = ?`
    ).all(h)) {
      pinned.add(r.code);
    }
  }

  const dobIn = incoming.date_of_birth || null;
  const dobInNorm = dobIn ? (matching.normalizeDob(dobIn) || null) : null;
  const undecided = new Set();
  for (const r of rows) {
    if (pinned.has(r.code)) continue;
    const given = enc.decrypt(secrets, r.given_name_ct);
    if (given) {
      if (matching.firstNameMatchesCompound(givenIn, given) > 0.60) continue;
      if (matching.transposedSimilarity(givenIn, given) >= 0.75) continue;
    }
    if (dobIn) {
      const dob = enc.decrypt(secrets, r.date_of_birth_ct);
      if (dob) {
        // scoreMatch: both readable -> equal ISO dates; otherwise equal raw
        // text. The same raw text always normalizes the same, so this OR is
        // the identical test.
        const dobNorm = matching.normalizeDob(dob) || null;
        if (dobInNorm && dobNorm && dobInNorm === dobNorm) continue;
        if (String(dobIn).trim() === String(dob).trim()) continue;
      }
    }
    undecided.add(r.code);
  }
  if (!undecided.size) return rows;

  const phonesIn = new Set(_toMatcherRecord(incoming).phones);
  if (phonesIn.size) {
    for (const pr of _stmt(db,
      `SELECT partner.person_code AS code, ph.value_ct FROM person_phones partner
         JOIN phones ph ON ph.code = partner.phone_code
        WHERE partner.person_code IN (SELECT value FROM json_each(?))`
    ).all(JSON.stringify([...undecided]))) {
      if (!undecided.has(pr.code)) continue;
      const v = enc.decrypt(secrets, pr.value_ct);
      if (v && matching.splitPhones(v).some(p => phonesIn.has(p))) undecided.delete(pr.code);
    }
  }
  if (!undecided.size) return rows;
  return rows.filter(r => !undecided.has(r.code));
}

// Score every candidate for `incoming`, apply the operator's resolution
// rules, and return the list sorted best-first (stable, so ties keep
// candidate order - which is what the old single-best loop picked).
// opts.strict / opts.includeArchived pass through to findCandidates and
// scoreMatch.
function scoreCandidates(db, secrets, incoming, opts = {}) {
  const candidates = findCandidates(db, secrets, incoming, opts);
  const incomingRec = _toMatcherRecord(incoming);
  const activeRules = rules.loadActive(db, 'person');
  const scoredList = [];
  for (const c of candidates) {
    let scored = matching.scoreMatch(incomingRec, c, { strict: !!opts.strict });
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
    scoredList.push({ ...scored, candidate: c });
  }
  scoredList.sort((x, y) => y.confidence - x.confidence);
  return scoredList;
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
  const best = scoreCandidates(db, secrets, incoming)[0] || null;

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
  scoreCandidates,
  toMatcherRecord: _toMatcherRecord,
  enrichCandidate: _enrichCandidate,
  resolveOrCreatePerson,
  resolveOrCreateFamily,
  rescorePerson,
};
