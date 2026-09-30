'use strict';

// Per-entity tags (families, persons). Stored as JSON array TEXT on the entity
// row. Tags are case-insensitive, deduped, and trimmed.
//
// Auto-tags are applied by the import pipeline based on the import's category
// and detected fields:
//   category = 'church'       -> persons get 'parishioner'
//   category = 'school'       -> families get 'school-parent'
//                                persons with grade=8 also get 'school-alumni-incoming'
// Custom tags supplied with the import are unioned on top.
//
// Every read and write follows the merge alias first, the same way
// relationships.ensure does: a tag sent to a merged-away family or person
// lands on (and is read from) the survivor, never on the dead row.

const aliases = require('./aliases');

function _norm(t) {
  return String(t || '').trim().toLowerCase().replace(/\s+/g, '-');
}

// The code a tag call should act on: the merge survivor of `code`.
function resolveCode(db, code) { return aliases.resolveAlias(db, code); }

function _read(db, table, code) {
  const row = db.prepare(`SELECT tags FROM ${table} WHERE code = ?`).get(resolveCode(db, code));
  if (!row) return null;
  if (!row.tags) return [];
  try { const arr = JSON.parse(row.tags); return Array.isArray(arr) ? arr : []; }
  catch (_) { return []; }
}

function _write(db, table, code, tags) {
  const clean = Array.from(new Set((tags || []).map(_norm).filter(Boolean))).sort();
  db.prepare(`UPDATE ${table} SET tags = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ?`)
    .run(clean.length ? JSON.stringify(clean) : null, resolveCode(db, code));
  return clean;
}

function getFamilyTags(db, code) { return _read(db, 'families', code) || []; }
function getPersonTags(db, code) { return _read(db, 'persons', code) || []; }

// Union tags into the list. The read and the write share one transaction
// (better-sqlite3 is synchronous, so nothing interleaves between them), so
// two apps adding different tags never lose each other's write.
function _add(db, table, code, tags) {
  return db.transaction(() => {
    const existing = _read(db, table, code);
    if (existing == null) return null;
    return _write(db, table, code, [...existing, ...(tags || [])]);
  })();
}
function addFamilyTags(db, code, tags) { return _add(db, 'families', code, tags); }
function addPersonTags(db, code, tags) { return _add(db, 'persons', code, tags); }

function setFamilyTags(db, code, tags) {
  if (_read(db, 'families', code) == null) return null;
  return _write(db, 'families', code, tags || []);
}
function setPersonTags(db, code, tags) {
  if (_read(db, 'persons', code) == null) return null;
  return _write(db, 'persons', code, tags || []);
}

function removeFamilyTag(db, code, tag) {
  const existing = _read(db, 'families', code);
  if (existing == null) return null;
  const t = _norm(tag);
  return _write(db, 'families', code, existing.filter(x => _norm(x) !== t));
}
function removePersonTag(db, code, tag) {
  const existing = _read(db, 'persons', code);
  if (existing == null) return null;
  const t = _norm(tag);
  return _write(db, 'persons', code, existing.filter(x => _norm(x) !== t));
}

// Detect 8th grade from a free-form grade string. Accepts '8', '8th', 'Grade 8',
// 'Eighth', 'VIII'. Returns true only when we're confident.
function isEighthGrade(grade) {
  if (grade == null) return false;
  const s = String(grade).trim().toLowerCase();
  if (!s) return false;
  if (s === '8' || s === '08') return true;
  if (/^8(th|st|nd|rd)?$/.test(s)) return true;
  if (/(^|\b)grade\s*0?8(\b|$)/.test(s)) return true;
  if (/(^|\b)g0?8(\b|$)/.test(s)) return true;
  if (/^(eighth|viii)$/.test(s)) return true;
  return false;
}

// autoTagsForRow: derive the auto-tags to apply to families and persons of a
// single canonical row, given the import's category. Returns
// { familyTags: [...], personTags: { '<index>': [...] } } where personTags is
// keyed by canonical.persons index.
function autoTagsForRow(category, canonical, customTags = []) {
  const customNorm = (customTags || []).map(_norm).filter(Boolean);
  const familyTags = [...customNorm];
  const personTags = {};
  const cat = category ? String(category).toLowerCase() : null;

  if (cat === 'church') {
    // Person-level: every person in a church import is a parishioner.
    for (let i = 0; i < (canonical.persons || []).length; i++) {
      personTags[i] = [...customNorm, 'parishioner'];
    }
  } else if (cat === 'school') {
    familyTags.push('school-parent');
    for (let i = 0; i < (canonical.persons || []).length; i++) {
      const p = canonical.persons[i];
      const tags = [...customNorm];
      if (p.role === 'parent') tags.push('school-parent');
      if (p.role === 'child' && isEighthGrade(p.grade)) tags.push('school-alumni-incoming');
      personTags[i] = tags;
    }
  } else {
    for (let i = 0; i < (canonical.persons || []).length; i++) {
      personTags[i] = [...customNorm];
    }
  }

  return { familyTags, personTags };
}

module.exports = {
  resolveCode,
  getFamilyTags, getPersonTags,
  addFamilyTags, addPersonTags,
  setFamilyTags, setPersonTags,
  removeFamilyTag, removePersonTag,
  isEighthGrade, autoTagsForRow,
  _norm,
};
