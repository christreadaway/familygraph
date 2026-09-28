'use strict';

// Roster imports that issue community identifiers (owner decision 2026-09-28).
//
// A school roster or parishioner list comes in as sheets of rows. Every person
// on it must end up with exactly ONE identifier for life (I + hex) and every
// household with one family identifier (F + hex) - the same ones Family Graph
// already holds, so a person who was on last year's roster, or on the parish
// list, keeps the id they already have. A wrong merge would give two humans
// one id and nobody would ever find out, so:
//
//   1. Matching is strict (matching.js `strict`): contact matches need the
//      first name to line up, Jr/Sr and birthdate conflicts veto, ambiguous
//      nicknames don't count, and a candidate that is already someone else in
//      the same row is never matched again.
//   2. Anything short of certain goes to a human. A person or family is
//      matched automatically only when exactly one candidate qualifies; two
//      qualifying candidates, an archived candidate, a role mismatch (a child
//      row against an adult record), or a soft score all become REVIEW items.
//   3. Nothing is minted on a guess. PLAN runs the real import inside a
//      transaction and rolls it back, so it shows exactly what COMMIT will do
//      - including duplicates within the sheet (a parent listed once per
//      child) - without writing anything. COMMIT refuses, and writes nothing,
//      while any review item lacks a decision.
//
// Decisions are keyed "<sheet>:<row>:<slot>" for people and
// "<sheet>:<row>:family" for households:
//   { action: 'attach', target: 'I…' | 'F…' | '<sheet>:<row>:<slot|family>' }
//   { action: 'create' }   // a different person / household: new id
//   { action: 'skip' }     // not a real person (people only)
// A target may be an earlier row of the same upload - the id it gets at
// commit time is not known when the operator decides.
//
// Never logs names or any other PII - counts, codes, and timings only.

const enc = require('../crypto/encryption');
const ids = require('../crypto/identifiers');
const people = require('./people');
const families = require('./families');
const aliases = require('./aliases');
const resolver = require('./resolver');
const matching = require('./matching');
const importPipeline = require('./import');
const audit = require('../audit');
const csv = require('../sources/csv');
const { applyMapping, surnameFromDisplayName } = require('../sources/normalize');
const log = require('../log');

const LIMITS = {
  sheets: 25,
  rows: 20000,        // across all sheets
  columns: 300,
  cellChars: 4000,
  headerChars: 200,
};

const ADULT_ROLES = new Set(['parent', 'guardian', 'grandparent', 'spouse', 'head', 'other_adult']);
const VETO_REASONS = new Set(['dob_conflict', 'suffix_conflict', 'suffix_one_sided']);
// A candidate is worth a human's time only if something about the PERSON
// lines up: a compatible first name, a shared email or phone, or the same
// birthdate. Sharing a surname and an address is what siblings and spouses
// do - Family Graph's general review bar (0.30) would put every sibling and
// every unrelated Garcia in front of the operator.
const PLAUSIBLE_REASONS = new Set([
  'exact_first_name', 'nickname_or_short_form', 'similar_first_name',
  'phonetic_first_name', 'first_name_typo',
  'exact_email_match', 'exact_phone_match', 'similar_email',
  'exact_date_of_birth',
]);
const _plausible = s => s.reasons.some(r => PLAUSIBLE_REASONS.has(r));

// Not names: a roster's stand-ins for "we don't know yet". Minting an
// identifier for "TBD Smith" creates a person who does not exist.
const PLACEHOLDER_NAME_RE = /^(tbd|tba|unknown|unk|n\/?a|none|null|nil|test|x+|\?+|-+|parent|guardian|mom|dad|mother|father|student|child|kid|baby|spouse|other)$/i;

// A business or parish in a name column (donor lists do this) is not a person.
const ORG_WORD_RE = /\b(inc|llc|ltd|corp|corporation|company|co|construction|church|parish|school|academy|foundation|sons|bank|trust|associates|group|ministries|ministry|society|club|fund|council|knights|committee|dept|department|services|enterprises|partners)\b\.?/i;

function _nameProblem(incoming) {
  const g = String(incoming.given_name || '').trim();
  if (!g) return 'no_first_name';
  if (PLACEHOLDER_NAME_RE.test(g.replace(/\.$/, ''))) return 'placeholder_name';
  if (/^[A-Za-z]\.?$/.test(g)) return 'initial_only';
  const whole = [incoming.given_name, incoming.middle_name, incoming.family_name].filter(Boolean).join(' ');
  if (ORG_WORD_RE.test(whole)) return 'looks_like_organization';
  return null;
}

class RosterError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const ROLLBACK = Symbol('roster-plan-rollback');

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

function _cell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.length > LIMITS.cellChars) {
    throw new RosterError(`a cell is longer than ${LIMITS.cellChars} characters`);
  }
  return s.trim();
}

// Header list -> unique, non-empty names (csv-parse would silently let a
// duplicate header overwrite the first column's value).
function _uniqueHeaders(headers) {
  const out = [];
  const seen = new Map();
  headers.forEach((h, i) => {
    let name = _cell(h).slice(0, LIMITS.headerChars) || `Column ${i + 1}`;
    const base = name;
    let n = 1;
    while (seen.has(name.toLowerCase())) {
      n += 1;
      name = `${base} (${n})`;
    }
    seen.set(name.toLowerCase(), i);
    out.push(name);
  });
  return out;
}

function _householdDisplayName(canonical) {
  if (canonical.family && canonical.family.display_name) return canonical.family.display_name;
  const withSurname = (canonical.persons || []).find(p => p.family_name);
  if (!withSurname) return null;
  const ln = String(withSurname.family_name).trim();
  return ln ? `${ln.charAt(0).toUpperCase()}${ln.slice(1)} Family` : null;
}

function _roleClass(role) {
  if (role === 'child') return 'child';
  if (ADULT_ROLES.has(role)) return 'adult';
  return null;
}

function prepare(body) {
  if (!body || typeof body !== 'object') throw new RosterError('body required');
  const sheets = body.sheets;
  if (!Array.isArray(sheets) || sheets.length === 0) throw new RosterError('sheets array required');
  if (sheets.length > LIMITS.sheets) throw new RosterError(`too many sheets (max ${LIMITS.sheets})`);
  let totalRows = 0;

  return sheets.map((sheet, si) => {
    if (!sheet || !Array.isArray(sheet.headers) || !Array.isArray(sheet.rows)) {
      throw new RosterError(`sheet ${si}: headers and rows arrays required`);
    }
    if (sheet.headers.length > LIMITS.columns) {
      throw new RosterError(`sheet ${si}: too many columns (max ${LIMITS.columns})`);
    }
    totalRows += sheet.rows.length;
    if (totalRows > LIMITS.rows) throw new RosterError(`too many rows (max ${LIMITS.rows})`);

    const headers = _uniqueHeaders(sheet.headers);
    const colOf = new Map(headers.map((h, i) => [h, i]));
    const mapping = sheet.mapping && typeof sheet.mapping === 'object'
      ? sheet.mapping
      : csv.inferMapping(headers);
    const warning = sheet.mapping ? null : csv.buildMappingWarning(mapping._flat);
    const out = {
      index: si,
      name: typeof sheet.name === 'string' ? sheet.name.slice(0, 200) : null,
      headers,
      colOf,
      mapping,
      skipped: warning ? 'no_identity_columns' : null,
      rows: [],
    };
    if (warning) return out;

    sheet.rows.forEach((raw, ri) => {
      if (!Array.isArray(raw)) throw new RosterError(`sheet ${si} row ${ri}: must be an array`);
      const obj = {};
      let any = false;
      headers.forEach((h, ci) => {
        const v = _cell(raw[ci]);
        obj[h] = v;
        if (v) any = true;
      });
      if (!any) { out.rows.push({ index: ri, skipped: 'blank' }); return; }
      if (csv.isSummaryRow(obj, headers)) { out.rows.push({ index: ri, skipped: 'summary' }); return; }
      const canonical = applyMapping(obj, mapping);
      if (!(canonical.persons || []).length) {
        out.rows.push({ index: ri, skipped: 'no_person' });
        return;
      }
      canonical.family = canonical.family || {};
      canonical.family.display_name = _householdDisplayName(canonical);
      for (const p of canonical.persons) {
        const cls = _roleClass(p.role);
        if (cls) p.kind = cls;
      }
      out.rows.push({ index: ri, canonical });
    });
    return out;
  });
}

// ---------------------------------------------------------------------------
// Lookups used while resolving
// ---------------------------------------------------------------------------

function _activeFamiliesOf(db, personCode, { includeArchived = false } = {}) {
  const statusSql = includeArchived ? `f.status IN ('active','archived')` : `f.status = 'active'`;
  return db.prepare(
    `SELECT m.family_code AS code, f.status AS status
       FROM memberships m JOIN families f ON f.code = m.family_code
      WHERE m.person_code = ? AND m.ended_at IS NULL AND ${statusSql}`
  ).all(personCode);
}

function _candidateClass(db, cand) {
  if (cand.kind === 'child' || cand.kind === 'adult') return cand.kind;
  const roles = db.prepare(
    `SELECT role FROM memberships WHERE person_code = ? AND ended_at IS NULL`
  ).all(cand.code).map(r => r.role);
  if (roles.includes('child')) return 'child';
  if (roles.some(r => ADULT_ROLES.has(r))) return 'adult';
  return null;
}

function _familySummary(db, secrets, code) {
  if (!code) return null;
  const row = db.prepare('SELECT code, status, display_name_ct FROM families WHERE code = ?').get(code);
  if (!row) return null;
  return { code: row.code, status: row.status, display_name: enc.decrypt(secrets, row.display_name_ct) };
}

function _personSummary(db, secrets, code) {
  const row = db.prepare('SELECT * FROM persons WHERE code = ?').get(code);
  if (!row) return null;
  return {
    code: row.code,
    status: row.status,
    given_name: enc.decrypt(secrets, row.given_name_ct),
    family_name: enc.decrypt(secrets, row.family_name_ct),
    suffix: enc.decrypt(secrets, row.suffix_ct),
    date_of_birth: enc.decrypt(secrets, row.date_of_birth_ct),
    grade: row.grade || null,
    kind: row.kind || null,
  };
}

// Strict household rule: someone listed by name only (a child with no
// birthdate or email) still matches when the row's own household - found
// through the adults already matched on this row, or the exact home address
// - has exactly one member with that exact first and last name, the same
// role (child/adult), and no birthdate or Jr/Sr contradiction.
function _householdMatches(db, secrets, incoming, rowCodes, canonical) {
  const famCodes = new Set();
  for (const pc of rowCodes) {
    for (const f of _activeFamiliesOf(db, pc)) famCodes.add(f.code);
  }
  const addr = canonical.address;
  if (addr && addr.line1) {
    const norm = enc.normalizeAddress(addr);
    const h = norm ? enc.hmac(secrets, norm) : null;
    if (h) {
      for (const r of db.prepare(
        `SELECT fa.family_code AS code FROM addresses a
           JOIN family_addresses fa ON fa.address_code = a.code
           JOIN families f ON f.code = fa.family_code
          WHERE a.norm_hash = ? AND f.status = 'active'`
      ).all(h)) famCodes.add(r.code);
    }
  }
  if (!famCodes.size) return [];
  const gh = enc.hmac(secrets, enc.normalizeName(incoming.given_name));
  const fh = enc.hmac(secrets, enc.normalizeName(incoming.family_name));
  if (!gh || !fh) return [];
  const incomingClass = _roleClass(incoming.role);
  const rec = resolver.toMatcherRecord(incoming);
  const found = new Map();
  for (const fc of famCodes) {
    const rows = db.prepare(
      `SELECT p.*, m.role AS m_role FROM memberships m JOIN persons p ON p.code = m.person_code
        WHERE m.family_code = ? AND m.ended_at IS NULL AND p.status = 'active'
          AND p.given_name_hash = ? AND p.family_name_hash = ?`
    ).all(fc, gh, fh);
    for (const r of rows) {
      if (rowCodes.includes(r.code) || found.has(r.code)) continue;
      const memberClass = r.kind || _roleClass(r.m_role);
      if (incomingClass && memberClass && incomingClass !== memberClass) continue;
      const cand = resolver.enrichCandidate(db, secrets, r);
      const scored = matching.scoreMatch(rec, cand, { strict: true });
      if (scored.reasons.some(x => VETO_REASONS.has(x))) continue;
      found.set(r.code, { candidate: cand, confidence: Math.max(scored.confidence, 0.9), reasons: [...scored.reasons, 'household_exact_name'], definitive: true });
    }
  }
  return [...found.values()];
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function run(db, secrets, thresholds, body, { mode, actor = 'roster' } = {}) {
  if (mode !== 'plan' && mode !== 'commit') throw new Error('mode must be plan or commit');
  const started = Date.now();
  const sheets = prepare(body);
  const decisions = (body.decisions && typeof body.decisions === 'object') ? body.decisions : {};
  const source = typeof body.source === 'string' && body.source ? body.source.slice(0, 64) : 'roster';
  const sourceRef = typeof body.source_ref === 'string' ? body.source_ref.slice(0, 200) : null;
  const category = ['church', 'school', 'other'].includes(body.category) ? body.category : null;
  const tags = Array.isArray(body.tags) ? body.tags.map(String).slice(0, 20) : null;

  // Validate decision shapes up front: a malformed decision is a caller bug,
  // never something to guess around.
  for (const [key, d] of Object.entries(decisions)) {
    if (!/^\d+:\d+:(\d+|family)$/.test(key)) throw new RosterError(`bad decision key: ${key}`);
    if (!d || typeof d !== 'object') throw new RosterError(`decision ${key}: object required`);
    const isFamily = key.endsWith(':family');
    const allowed = isFamily ? ['attach', 'create'] : ['attach', 'create', 'skip'];
    if (!allowed.includes(d.action)) throw new RosterError(`decision ${key}: action must be ${allowed.join(' | ')}`);
    if (d.action === 'attach' && typeof d.target !== 'string') {
      throw new RosterError(`decision ${key}: attach needs a target`);
    }
  }

  const createdPersons = new Map();   // code -> person key (minted in this run)
  const createdFamilies = new Map();  // code -> family key
  const personCodeByKey = new Map();
  const familyCodeByKey = new Map();
  const pending = [];
  const output = sheets.map(s => ({
    index: s.index,
    name: s.name,
    skipped: s.skipped,
    columns: s.headers,
    mapping: _mappingSummary(s),
    rows: [],
  }));

  // An id minted during this run exists only if the run commits. A plan
  // never shows one; a commit that is refused (pending reviews) is rolled
  // back, and every id it would have minted is blanked before responding
  // (see _blankIds below).
  function communityIdFor(code, createdMap) {
    if (mode === 'plan' && createdMap.has(code)) return null;
    return ids.toCommunityId(code);
  }

  function describePerson(scored) {
    const c = scored.candidate;
    const fam = _activeFamiliesOf(db, c.code, { includeArchived: true })[0];
    const famSummary = fam ? _familySummary(db, secrets, fam.code) : null;
    const d = {
      community_id: communityIdFor(c.code, createdPersons),
      sheet_ref: createdPersons.get(c.code) || null,
      status: c.status || 'active',
      given_name: c.given_name || null,
      family_name: c.family_name || null,
      suffix: c.suffix || null,
      date_of_birth: c.date_of_birth || null,
      role: _candidateClass(db, c),
      family: famSummary ? {
        community_id: communityIdFor(famSummary.code, createdFamilies),
        sheet_ref: createdFamilies.get(famSummary.code) || null,
        display_name: famSummary.display_name,
      } : null,
      confidence: Math.round(scored.confidence * 100) / 100,
      reasons: scored.reasons,
    };
    const grade = db.prepare('SELECT grade FROM persons WHERE code = ?').get(c.code);
    d.grade = grade ? grade.grade || null : null;
    return d;
  }

  function resolveTargetPerson(target) {
    if (/^\d+:\d+:\d+$/.test(target)) {
      const code = personCodeByKey.get(target);
      if (!code) throw new RosterError(`decision target ${target} is not an earlier person on this upload`, 409);
      return code;
    }
    const code = ids.fromCommunityId(target);
    if (!code || ids.kindOf(code) !== 'person') throw new RosterError(`decision target ${target} is not an individual id`, 409);
    const resolved = aliases.resolveAlias(db, code);
    const row = db.prepare('SELECT code, status FROM persons WHERE code = ?').get(resolved);
    if (!row) throw new RosterError(`decision target ${target} does not exist`, 409);
    return row.code;
  }

  function resolveTargetFamily(target) {
    if (/^\d+:\d+:family$/.test(target)) {
      const code = familyCodeByKey.get(target);
      if (!code) throw new RosterError(`decision target ${target} is not an earlier household on this upload`, 409);
      return code;
    }
    const code = ids.fromCommunityId(target);
    if (!code || ids.kindOf(code) !== 'family') throw new RosterError(`decision target ${target} is not a family id`, 409);
    const resolved = aliases.resolveAlias(db, code);
    const row = db.prepare('SELECT code, status FROM families WHERE code = ?').get(resolved);
    if (!row) throw new RosterError(`decision target ${target} does not exist`, 409);
    return row.code;
  }

  function attachPerson(code, incoming, { via, reasons, confidence }) {
    const row = db.prepare('SELECT status FROM persons WHERE code = ?').get(code);
    if (row && row.status === 'archived') {
      people.reinstate(db, code, { actor, reason: 'returned on a roster import' });
    }
    const cur = _personSummary(db, secrets, code);
    const patch = {};
    if (!cur.given_name && incoming.given_name) patch.given_name = incoming.given_name;
    if (!cur.family_name && incoming.family_name) patch.family_name = incoming.family_name;
    if (!cur.date_of_birth && incoming.date_of_birth) patch.date_of_birth = incoming.date_of_birth;
    if (!cur.suffix && incoming.suffix) patch.suffix = incoming.suffix;
    if (!cur.kind && incoming.kind) patch.kind = incoming.kind;
    if (Object.keys(patch).length) people.update(db, secrets, code, patch, { actor, reason: 'roster import filled a blank field' });
    audit.record(db, {
      action: via === 'decision' ? 'resolver_attach_manual' : 'resolver_attach',
      actor,
      entityCode: code,
      entityKind: 'person',
      metadata: { via, confidence, reasons, strict: true },
    });
    return { code, action: 'attached', score: confidence || 1, reasons: reasons || [] };
  }

  function createPerson(incoming, key, { rejected = [] } = {}) {
    const code = people.create(db, secrets, incoming, { actor, reason: 'roster import' });
    createdPersons.set(code, key);
    for (const r of rejected) {
      if (!r || !r.code || createdPersons.has(r.code)) continue;
      db.prepare(
        `INSERT INTO conflicts (code, kind, left_code, right_code, score, reasons, status, resolved_by, resolved_at, resolution_notes)
         VALUES (?, 'person', ?, ?, ?, ?, 'rejected', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)`
      ).run(ids.newCode('conflict'), code, r.code, r.confidence || 0, JSON.stringify(r.reasons || []),
        actor, 'roster review: operator said these are different people');
    }
    audit.record(db, {
      action: 'resolver_created',
      actor,
      entityCode: code,
      entityKind: 'person',
      metadata: { strict: true, reviewed_against: rejected.map(r => r.code) },
    });
    return { code, action: 'created', score: 0, reasons: [] };
  }

  const summary = {
    sheets: sheets.length,
    rows: 0,
    persons: { matched: 0, new: 0, review: 0, skipped: 0 },
    families: { matched: 0, new: 0, review: 0 },
  };

  function processSheet(sheet) {
    const outSheet = output[sheet.index];
    if (sheet.skipped) return;
    const rowsToImport = [];
    for (const row of sheet.rows) {
      if (row.skipped) {
        outSheet.rows.push({ index: row.index, skipped: row.skipped });
        continue;
      }
      summary.rows += 1;
      const outRow = { index: row.index, persons: [], family: null };
      outSheet.rows.push(outRow);

      // Slots the operator marked "not a person" leave the row before import.
      const kept = [];
      row.canonical.persons.forEach((p, slot) => {
        const key = `${sheet.index}:${row.index}:${slot}`;
        const d = decisions[key];
        const desc = _slotDescription(sheet, p, slot, key);
        if (d && d.action === 'skip') {
          outRow.persons.push({ ...desc, action: 'skip', decided: true });
          summary.persons.skipped += 1;
          return;
        }
        outRow.persons.push(desc);
        kept.push({ p, slot, key, out: desc });
      });
      if (!kept.length) continue;
      const canonical = { ...row.canonical, persons: kept.map(k => k.p) };
      rowsToImport.push({ row, outRow, canonical, kept });
    }

    for (const item of rowsToImport) {
      const { row, outRow, canonical, kept } = item;
      const familyKey = `${sheet.index}:${row.index}:family`;

      const resolvePerson = (incoming, pi, { personOutcomes }) => {
        const { key, out } = kept[pi];
        const rowCodes = personOutcomes.map(o => o.code).filter(Boolean);
        const d = decisions[key];

        const scored = resolver
          .scoreCandidates(db, secrets, incoming, { strict: true, includeArchived: true })
          .filter(s => !rowCodes.includes(s.candidate.code));
        const t = thresholds;
        const incomingClass = _roleClass(incoming.role);
        const strong = [];
        const reviewReasons = new Set();
        for (const s of scored) {
          if (!(s.definitive || s.confidence >= t.autoMerge)) continue;
          const candClass = _candidateClass(db, s.candidate);
          if (incomingClass && candClass && incomingClass !== candClass) {
            reviewReasons.add('role_mismatch');
            s.reasons = [...s.reasons, 'role_mismatch'];
            continue;
          }
          strong.push(s);
        }
        const household = _householdMatches(db, secrets, incoming, rowCodes, canonical);

        let verdict;   // { kind: 'match', best } | { kind: 'review', cands } | { kind: 'new' }
        const activeStrong = strong.filter(s => s.candidate.status !== 'archived');
        const nameProblem = _nameProblem(incoming);
        if (nameProblem) {
          verdict = { kind: 'review', cands: scored.filter(_plausible).slice(0, 3) };
          reviewReasons.add(nameProblem);
        } else if (strong.length === 1 && activeStrong.length === 1 &&
                   !(household.length && !household.some(h => h.candidate.code === strong[0].candidate.code))) {
          verdict = { kind: 'match', best: strong[0], via: 'score' };
        } else if (strong.length > 1) {
          verdict = { kind: 'review', cands: strong.slice(0, 5) };
          reviewReasons.add('several_strong_candidates');
        } else if (strong.length === 1) {
          verdict = { kind: 'review', cands: [strong[0], ...household].slice(0, 5) };
          reviewReasons.add(strong[0].candidate.status === 'archived' ? 'candidate_archived' : 'household_disagrees');
        } else if (household.length === 1) {
          verdict = { kind: 'match', best: household[0], via: 'household' };
        } else if (household.length > 1) {
          verdict = { kind: 'review', cands: household.slice(0, 5) };
          reviewReasons.add('several_household_namesakes');
        } else if (scored.some(s => s.confidence >= t.review && _plausible(s))) {
          verdict = { kind: 'review', cands: scored.filter(s => s.confidence >= t.review && _plausible(s)).slice(0, 3) };
          reviewReasons.add('possible_match');
        } else if (reviewReasons.has('role_mismatch')) {
          verdict = { kind: 'review', cands: scored.filter(s => s.reasons.includes('role_mismatch')).slice(0, 3) };
        } else {
          verdict = { kind: 'new' };
        }

        if (verdict.kind === 'review') {
          out.candidates = verdict.cands.map(describePerson);
          out.review_reasons = [...reviewReasons];
        }

        let result;
        if (d) {
          out.decided = true;
          if (d.action === 'attach') {
            const code = resolveTargetPerson(d.target);
            if (rowCodes.includes(code)) {
              throw new RosterError(`decision ${key}: that id is already another person on the same row`, 409);
            }
            result = attachPerson(code, incoming, { via: 'decision', reasons: ['operator_decision'], confidence: 1 });
          } else {
            const rejected = (verdict.cands || []).map(s => ({ code: s.candidate.code, confidence: s.confidence, reasons: s.reasons }));
            result = createPerson(incoming, key, { rejected });
          }
          out.action = verdict.kind === 'review' ? 'review' : (result.action === 'attached' ? 'matched' : 'new');
        } else if (verdict.kind === 'match') {
          result = attachPerson(verdict.best.candidate.code, incoming, {
            via: verdict.via, reasons: verdict.best.reasons, confidence: verdict.best.confidence,
          });
          out.action = 'matched';
          out.matched = { ...describePerson(verdict.best), via: verdict.via };
        } else if (verdict.kind === 'new') {
          result = createPerson(incoming, key);
          out.action = 'new';
        } else {
          // Undecided review. PLAN carries on as if it were a new person so
          // later rows can still see this one; COMMIT will refuse at the end.
          pending.push(key);
          result = createPerson(incoming, key);
          out.action = 'review';
        }

        personCodeByKey.set(key, result.code);
        out.code_state = createdPersons.has(result.code) ? 'new' : 'existing';
        out.community_id = communityIdFor(result.code, createdPersons);
        if (result.action === 'attached' && createdPersons.has(result.code)) {
          out.same_as = createdPersons.get(result.code);
        }
        if (out.action === 'matched') summary.persons.matched += 1;
        else if (out.action === 'new') summary.persons.new += 1;
        else summary.persons.review += 1;
        return result;
      };

      const resolveFamily = (input, { personOutcomes }) => {
        const d = decisions[familyKey];
        const rowCodes = personOutcomes.map(o => o.code).filter(Boolean);
        const outFam = {
          key: familyKey,
          display_name: input.display_name || null,
          cell: _familyCell(sheet),
        };
        outRow.family = outFam;

        // Families every already-known person on the row belongs to.
        const sets = [];
        const union = new Map();
        for (const pc of rowCodes) {
          const fams = _activeFamiliesOf(db, pc, { includeArchived: true });
          if (!fams.length) continue;
          sets.push(new Set(fams.map(f => f.code)));
          for (const f of fams) union.set(f.code, (union.get(f.code) || 0) + 1);
        }
        let verdict;
        const reasons = [];
        if (sets.length) {
          const shared = [...sets[0]].filter(c => sets.every(s => s.has(c)));
          const activeShared = shared.filter(c => _familySummary(db, secrets, c).status === 'active');
          if (shared.length === 1 && activeShared.length === 1) {
            verdict = { kind: 'match', code: shared[0], via: 'members' };
          } else {
            verdict = { kind: 'review', cands: [...union.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]).slice(0, 5) };
            reasons.push(shared.length > 1 ? 'members_in_several_households'
              : shared.length === 1 ? 'household_archived' : 'members_in_different_households');
          }
        } else if (input.address && input.address.line1) {
          const norm = enc.normalizeAddress(input.address);
          const h = norm ? enc.hmac(secrets, norm) : null;
          const fams = h ? db.prepare(
            `SELECT DISTINCT fa.family_code AS code FROM addresses a
               JOIN family_addresses fa ON fa.address_code = a.code
               JOIN families f ON f.code = fa.family_code
              WHERE a.norm_hash = ? AND f.status IN ('active','archived')`
          ).all(h).map(r => r.code) : [];
          if (fams.length) {
            verdict = { kind: 'review', cands: fams.slice(0, 5) };
            reasons.push('same_address_no_known_members');
          } else {
            verdict = { kind: 'new' };
          }
        } else {
          verdict = { kind: 'new' };
        }

        const describeFamily = (code) => {
          const f = _familySummary(db, secrets, code);
          const members = db.prepare(
            `SELECT p.code, p.given_name_ct, p.family_name_ct, m.role FROM memberships m
               JOIN persons p ON p.code = m.person_code
              WHERE m.family_code = ? AND m.ended_at IS NULL LIMIT 12`
          ).all(code).map(r => ({
            community_id: communityIdFor(r.code, createdPersons),
            sheet_ref: createdPersons.get(r.code) || null,
            name: [enc.decrypt(secrets, r.given_name_ct), enc.decrypt(secrets, r.family_name_ct)].filter(Boolean).join(' '),
            role: r.role,
          }));
          return {
            community_id: communityIdFor(code, createdFamilies),
            sheet_ref: createdFamilies.get(code) || null,
            status: f.status,
            display_name: f.display_name,
            members,
          };
        };
        if (verdict.kind === 'review') {
          outFam.candidates = verdict.cands.map(describeFamily);
          outFam.review_reasons = reasons;
        }

        const createFamily = (rejected = []) => {
          const code = families.create(db, secrets, { display_name: input.display_name, notes: input.notes }, { actor, reason: 'roster import' });
          createdFamilies.set(code, familyKey);
          for (const other of rejected) {
            if (createdFamilies.has(other)) continue;
            db.prepare(
              `INSERT INTO conflicts (code, kind, left_code, right_code, score, reasons, status, resolved_by, resolved_at, resolution_notes)
               VALUES (?, 'family', ?, ?, 0, ?, 'rejected', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)`
            ).run(ids.newCode('conflict'), code, other, JSON.stringify(reasons), actor,
              'roster review: operator said these are different households');
          }
          audit.record(db, { action: 'resolver_created', actor, entityCode: code, entityKind: 'family', metadata: { strict: true } });
          return { code, action: 'created' };
        };
        const attachFamily = (code, via) => {
          const f = _familySummary(db, secrets, code);
          if (f.status === 'archived') families.reinstate(db, code, { actor, reason: 'returned on a roster import' });
          audit.record(db, {
            action: via === 'decision' ? 'resolver_attach_manual' : 'resolver_attach',
            actor, entityCode: code, entityKind: 'family', metadata: { via, strict: true },
          });
          return { code, action: 'attached' };
        };

        let result;
        if (d) {
          outFam.decided = true;
          if (d.action === 'attach') {
            result = attachFamily(resolveTargetFamily(d.target), 'decision');
          } else {
            result = createFamily(verdict.cands || []);
          }
          outFam.action = verdict.kind === 'review' ? 'review' : (result.action === 'attached' ? 'matched' : 'new');
        } else if (verdict.kind === 'match') {
          result = attachFamily(verdict.code, verdict.via);
          outFam.action = 'matched';
        } else if (verdict.kind === 'new') {
          result = createFamily();
          outFam.action = 'new';
        } else {
          pending.push(familyKey);
          result = createFamily();
          outFam.action = 'review';
        }
        familyCodeByKey.set(familyKey, result.code);
        outFam.code_state = createdFamilies.has(result.code) ? 'new' : 'existing';
        outFam.community_id = communityIdFor(result.code, createdFamilies);
        if (result.action === 'attached' && createdFamilies.has(result.code)) {
          outFam.same_as = createdFamilies.get(result.code);
        }
        if (outFam.action === 'matched') summary.families.matched += 1;
        else if (outFam.action === 'new') summary.families.new += 1;
        else summary.families.review += 1;
        return result;
      };

      item.resolvePerson = resolvePerson;
      item.resolveFamily = resolveFamily;
    }
    return rowsToImport;
  }

  let importRunCode = null;
  const exec = () => {
    const batches = sheets.map(processSheetLazy);
    for (const b of batches) {
      if (!b.length) continue;
      // One import_runs row per sheet; rows run through the shared import
      // path with this module's resolvers plugged in.
      const canonicalRows = b.map(it => it.canonical);
      const ctxBase = {
        source,
        sourceRef: sourceRef ? `${sourceRef}#sheet${b.sheetIndex}` : `sheet${b.sheetIndex}`,
        actor,
        category,
        tags,
      };
      const res = importPipeline.importBatch(db, secrets, thresholds, canonicalRows, {
        ...ctxBase,
        rowHooks: b.map(it => ({ resolvePerson: it.resolvePerson, resolveFamily: it.resolveFamily })),
      });
      if (!importRunCode) importRunCode = res.importRunCode;
      output[b.sheetIndex].import_run = res.importRunCode;
    }
  };

  function processSheetLazy(sheet) {
    const rows = processSheet(sheet) || [];
    rows.sheetIndex = sheet.index;
    return rows;
  }

  let committed = false;
  try {
    db.transaction(() => {
      exec();
      if (mode === 'plan' || pending.length) throw ROLLBACK;
    })();
    committed = true;
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }

  // A rolled-back run's import_runs rows and minted ids no longer exist.
  if (!committed) {
    for (const s of output) delete s.import_run;
    const minted = new Set([
      ...[...createdPersons.keys()].map(ids.toCommunityId),
      ...[...createdFamilies.keys()].map(ids.toCommunityId),
    ]);
    _blankIds(output, minted);
  }
  const result = {
    mode,
    committed,
    summary,
    pending,
    sheets: output,
  };
  if (committed) result.import_runs = output.map(s => s.import_run).filter(Boolean);
  const ms = Date.now() - started;

  // Outside the transaction: a plan's audit row must survive its rollback.
  audit.record(db, {
    action: mode === 'plan' ? 'roster_plan' : (committed ? 'roster_commit' : 'roster_commit_refused'),
    actor,
    metadata: {
      source,
      source_ref: sourceRef,
      sheets: summary.sheets,
      rows: summary.rows,
      persons: summary.persons,
      families: summary.families,
      pending: pending.length,
      decisions: Object.keys(decisions).length,
      import_runs: result.import_runs || null,
      ms,
    },
  });
  log.info(`roster.${mode}`, {
    actor,
    committed,
    sheets: summary.sheets,
    rows: summary.rows,
    persons_matched: summary.persons.matched,
    persons_new: summary.persons.new,
    persons_review: summary.persons.review,
    persons_skipped: summary.persons.skipped,
    families_matched: summary.families.matched,
    families_new: summary.families.new,
    families_review: summary.families.review,
    pending: pending.length,
    ms,
  });
  return result;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function _blankIds(node, minted) {
  if (Array.isArray(node)) { node.forEach(n => _blankIds(n, minted)); return; }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'community_id' && typeof v === 'string' && minted.has(v)) node[k] = null;
    else if (v && typeof v === 'object') _blankIds(v, minted);
  }
}

function _mappingSummary(sheet) {
  const m = sheet.mapping || {};
  const col = h => (h && sheet.colOf.has(h) ? sheet.colOf.get(h) : null);
  const first = v => (Array.isArray(v) ? v[0] : v) || null;
  return {
    family: col(first(m.family && m.family.display_name)),
    persons: (m.persons || []).map(t => ({
      role: t.role || 'member',
      given: col(first(t.given_name)),
      family: col(first(t.family_name)),
      full: col(first(t.full_name)),
      list: col(first(t.list)),
      email: col(first(t.email)),
      phone: col(first(t.phone)),
      date_of_birth: col(first(t.date_of_birth)),
    })),
    address: m.address ? {
      line1: col(first(m.address.line1)),
      city: col(first(m.address.city)),
      postal: col(first(m.address.postal)),
    } : null,
  };
}

function _familyCell(sheet) {
  const m = sheet.mapping || {};
  const h = m.family && (Array.isArray(m.family.display_name) ? m.family.display_name[0] : m.family.display_name);
  return h && sheet.colOf.has(h) ? { col: sheet.colOf.get(h) } : null;
}

// Where this person's name lives on the sheet, so the caller can put the
// community id in exactly that cell (or that part of a list cell).
function _slotDescription(sheet, p, slot, key) {
  const src = p._src || {};
  const col = h => (h && sheet.colOf.has(h) ? sheet.colOf.get(h) : null);
  const cells = [];
  if (src.list) {
    cells.push({ col: col(src.list), part: 'list', text: src.list_text, start: src.list_start, index: src.list_index });
  } else {
    if (src.full) cells.push({ col: col(src.full), part: 'full' });
    if (src.given) cells.push({ col: col(src.given), part: 'given' });
    if (src.family) cells.push({ col: col(src.family), part: 'family' });
  }
  return {
    key,
    slot,
    role: p.role || 'member',
    given_name: p.given_name || null,
    family_name: p.family_name || null,
    date_of_birth: p.date_of_birth || null,
    name_cells: cells.filter(c => c.col !== null),
  };
}

// Look up a community id (either letter, any case), following merges.
function lookup(db, id) {
  const code = ids.toCode(id);
  if (!code) return null;
  const kind = ids.kindOf(code);
  if (kind !== 'person' && kind !== 'family') return null;
  const target = aliases.resolveAlias(db, code);
  const table = kind === 'person' ? 'persons' : 'families';
  const row = db.prepare(`SELECT code, status, merged_into FROM ${table} WHERE code = ?`).get(target);
  if (!row) return null;
  return {
    kind,
    code: row.code,
    community_id: ids.toCommunityId(row.code),
    status: row.status,
    requested: typeof id === 'string' ? id.trim() : id,
    redirected: target !== code,
  };
}

module.exports = { run, prepare, lookup, RosterError, LIMITS };
