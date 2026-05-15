'use strict';

// PP-pushed enrichment snapshot. §7.3 of the integration doc: ParentPoint
// debounces fanouts per personId to one POST every 5 minutes (server-side
// Cloud Function) and then sends FG the current school context: grade,
// classroom, teacher, activities, allergies.
//
// The contract says the snapshot is *current state, not a log* — FG
// overwrites the previous snapshot on every POST. We model that as an
// upsert keyed by (school_id, person_code). The history of activities
// lives in ParentPoint's own collections.

const { newCode } = require('../crypto/identifiers');
const aliases = require('../identity/aliases');

function _safeJson(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    try { JSON.parse(v); return v; } catch (_) { /* fall through */ }
  }
  return JSON.stringify(v);
}

function _parseJson(v, fallback) {
  if (!v) return fallback;
  try {
    const parsed = JSON.parse(v);
    return parsed == null ? fallback : parsed;
  } catch (_) {
    return fallback;
  }
}

function upsert(db, personCode, snapshot) {
  const target = aliases.resolveAlias(db, personCode);
  if (!db.prepare('SELECT 1 FROM persons WHERE code = ?').get(target)) {
    throw new Error('person not found');
  }
  if (!snapshot || typeof snapshot !== 'object') throw new Error('snapshot required');
  const schoolId = snapshot.school_id || snapshot.schoolId;
  if (!schoolId) throw new Error('schoolId required');

  const teacher = snapshot.homeroom_teacher_person_code || snapshot.homeroomTeacherPersonId || null;
  const activities = _safeJson(snapshot.activities ?? []);
  const allergies = _safeJson(snapshot.allergies ?? []);
  const snapshotAt = snapshot.snapshotAt || snapshot.snapshot_at || new Date().toISOString();
  const sourceApp = snapshot.source_app || snapshot.sourceApp || 'parentpoint';

  const existing = db.prepare(
    `SELECT code FROM school_contexts WHERE person_code = ? AND school_id = ?`
  ).get(target, schoolId);

  if (existing) {
    db.prepare(
      `UPDATE school_contexts
          SET school_year = ?, grade = ?,
              classroom_id = ?, classroom_name = ?,
              homeroom_teacher_person_code = ?,
              activities = ?, allergies = ?,
              snapshot_at = ?, source_app = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE code = ?`
    ).run(
      snapshot.schoolYear || snapshot.school_year || null,
      snapshot.grade || null,
      snapshot.classroomId || snapshot.classroom_id || null,
      snapshot.classroomName || snapshot.classroom_name || null,
      teacher,
      activities,
      allergies,
      snapshotAt,
      sourceApp,
      existing.code,
    );
    return existing.code;
  }

  const code = newCode('audit').replace(/^au_/, 'sc_');
  db.prepare(
    `INSERT INTO school_contexts
       (code, person_code, school_id, school_year, grade, classroom_id, classroom_name,
        homeroom_teacher_person_code, activities, allergies, snapshot_at, source_app)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    code, target, schoolId,
    snapshot.schoolYear || snapshot.school_year || null,
    snapshot.grade || null,
    snapshot.classroomId || snapshot.classroom_id || null,
    snapshot.classroomName || snapshot.classroom_name || null,
    teacher,
    activities,
    allergies,
    snapshotAt,
    sourceApp,
  );
  return code;
}

function _row2object(r) {
  if (!r) return null;
  return {
    schoolId: r.school_id,
    schoolYear: r.school_year,
    grade: r.grade,
    classroomId: r.classroom_id,
    classroomName: r.classroom_name,
    homeroomTeacherPersonId: r.homeroom_teacher_person_code || null,
    activities: _parseJson(r.activities, []),
    allergies: _parseJson(r.allergies, []),
    snapshotAt: r.snapshot_at,
    sourceApp: r.source_app,
    updatedAt: r.updated_at,
  };
}

function getOne(db, personCode, schoolId) {
  const target = aliases.resolveAlias(db, personCode);
  const r = db.prepare(
    `SELECT * FROM school_contexts WHERE person_code = ? AND school_id = ?`
  ).get(target, schoolId);
  return _row2object(r);
}

function listForPerson(db, personCode) {
  const target = aliases.resolveAlias(db, personCode);
  return db.prepare(
    `SELECT * FROM school_contexts WHERE person_code = ? ORDER BY updated_at DESC`
  ).all(target).map(_row2object);
}

module.exports = { upsert, getOne, listForPerson };
