'use strict';

const { newCode } = require('../crypto/identifiers');
const enc = require('../crypto/encryption');
const people = require('./people');
const families = require('./families');
const contacts = require('./contacts');
const resolver = require('./resolver');
const audit = require('../audit');
const tagsLib = require('./tags');

// Import a parsed canonical row (the output of source handler.applyMapping).
// Pure function over the database; the caller decides whether to wrap N rows
// in a single transaction.
//
// ctx options:
//   source         — short source name (csv | facts | … | manual)
//   sourceRef      — file path or row reference
//   actor          — actor for audit + resolver
//   category       — operator file classification (church | school | other)
//   tags           — JSON-encoded array of operator tags (or a real array)
//   importRunCode  — link to the parent import_runs row (set by importBatch)
//
// Returns per-row outcome plus a `stats` object with the counts of what
// happened (used by importBatch to aggregate the import_runs row).
function importRow(db, secrets, thresholds, canonical, ctx = {}) {
  const sourceCode = newCode('source');
  const tagsJson = ctx.tags == null
    ? null
    : (Array.isArray(ctx.tags) ? JSON.stringify(ctx.tags) : String(ctx.tags));
  db.prepare(
    `INSERT INTO source_records (code, source, source_ref, category, tags, import_run_code, raw_payload_ct)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sourceCode,
    ctx.source || 'manual',
    ctx.sourceRef || null,
    ctx.category || null,
    tagsJson,
    ctx.importRunCode || null,
    enc.encrypt(secrets, JSON.stringify(canonical))
  );

  const stats = {
    families_created: 0,
    families_attached: 0,
    persons_created: 0,
    persons_attached: 0,
    persons_enqueued: 0,
    conflicts_opened: 0,
    addresses_attached: 0,
    emails_attached: 0,
    phones_attached: 0,
    memberships_opened: 0,
  };

  const customTagsArr = ctx.tags == null
    ? []
    : (Array.isArray(ctx.tags) ? ctx.tags : (() => { try { const v = JSON.parse(ctx.tags); return Array.isArray(v) ? v : []; } catch (_) { return []; } })());
  const autoTags = tagsLib.autoTagsForRow(ctx.category, canonical, customTagsArr);

  const personOutcomes = [];
  const personCodes = [];
  for (let pi = 0; pi < (canonical.persons || []).length; pi++) {
    const incoming = canonical.persons[pi];
    const r = resolver.resolveOrCreatePerson(db, secrets, thresholds, incoming, {
      actor: ctx.actor || 'import',
    });
    personOutcomes.push({ ...r, incoming });
    personCodes.push(r.code);

    if (incoming.grade) {
      db.prepare(`UPDATE persons SET grade = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ?`)
        .run(String(incoming.grade), r.code);
    }
    const tagsForPerson = autoTags.personTags[pi] || [];
    if (tagsForPerson.length) {
      tagsLib.addPersonTags(db, r.code, tagsForPerson);
    }

    if (r.action === 'created') stats.persons_created += 1;
    else if (r.action === 'attached') stats.persons_attached += 1;
    else if (r.action === 'enqueued') {
      stats.persons_enqueued += 1;
      stats.persons_created += 1;        // the enqueued path also created a row
      stats.conflicts_opened += 1;
    }

    for (const email of incoming.emails || []) {
      const ec = contacts.upsertEmail(db, secrets, email);
      if (ec) {
        contacts.attachEmailToPerson(db, r.code, ec, { isPrimary: false });
        stats.emails_attached += 1;
      }
    }
    for (const phone of incoming.phones || []) {
      const pc = contacts.upsertPhone(db, secrets, phone);
      if (pc) {
        contacts.attachPhoneToPerson(db, r.code, pc, { isPrimary: false });
        stats.phones_attached += 1;
      }
    }

    db.prepare(
      `INSERT OR IGNORE INTO provenance (source_code, entity_code, field) VALUES (?, ?, ?)`
    ).run(sourceCode, r.code, 'person');
  }

  // Resolve or create the family.
  let familyOutcome = null;
  if (personCodes.length > 0 || canonical.family?.display_name) {
    familyOutcome = resolver.resolveOrCreateFamily(
      db,
      secrets,
      thresholds,
      {
        display_name: canonical.family?.display_name,
        notes: canonical.family?.notes,
        personCodes,
      },
      { actor: ctx.actor || 'import' }
    );
    if (familyOutcome.action === 'created') stats.families_created += 1;
    else if (familyOutcome.action === 'attached') stats.families_attached += 1;

    if (autoTags.familyTags.length) {
      tagsLib.addFamilyTags(db, familyOutcome.code, autoTags.familyTags);
    }

    for (let i = 0; i < personCodes.length; i++) {
      const pc = personCodes[i];
      const tmpl = canonical.persons[i];
      const existing = db
        .prepare(
          `SELECT 1 FROM memberships WHERE family_code = ? AND person_code = ? AND ended_at IS NULL`
        )
        .get(familyOutcome.code, pc);
      if (!existing) {
        families.addMember(db, secrets, familyOutcome.code, pc, {
          role: tmpl.role || 'member',
          custody: tmpl.custody || null,
        });
        stats.memberships_opened += 1;
      }
    }

    db.prepare(
      `INSERT OR IGNORE INTO provenance (source_code, entity_code, field) VALUES (?, ?, ?)`
    ).run(sourceCode, familyOutcome.code, 'family');

    if (canonical.address && (canonical.address.line1 || canonical.address.city)) {
      const ac = contacts.upsertAddress(db, secrets, canonical.address);
      if (ac) {
        contacts.attachAddressToFamily(db, familyOutcome.code, ac, {
          label: canonical.address.label || 'home',
          isPrimary: true,
        });
        stats.addresses_attached += 1;
        db.prepare(
          `INSERT OR IGNORE INTO provenance (source_code, entity_code, field) VALUES (?, ?, ?)`
        ).run(sourceCode, ac, 'address');
      }
    }
  }

  audit.record(db, {
    action: 'import_row',
    actor: ctx.actor || 'import',
    entityKind: 'family',
    entityCode: familyOutcome?.code,
    metadata: {
      source: ctx.source || 'manual',
      category: ctx.category || null,
      personOutcomes: personOutcomes.map(o => ({ code: o.code, action: o.action, score: o.score })),
      familyOutcome: familyOutcome ? { code: familyOutcome.code, action: familyOutcome.action } : null,
    },
  });

  return {
    sourceRecord: sourceCode,
    family: familyOutcome,
    persons: personOutcomes,
    stats,
  };
}

// importBatch: write an import_runs row first (so child source_records can
// link to it), run each row inside a single transaction, accumulate stats,
// then UPDATE the import_runs row with the totals.
function importBatch(db, secrets, thresholds, canonicalRows, ctx = {}) {
  const importRunCode = newCode('audit').replace(/^au_/, 'imp_');
  const tagsJson = ctx.tags == null
    ? null
    : (Array.isArray(ctx.tags) ? JSON.stringify(ctx.tags) : String(ctx.tags));
  db.prepare(
    `INSERT INTO import_runs (code, source, source_ref, category, tags, rows, actor)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    importRunCode,
    ctx.source || 'manual',
    ctx.sourceRef || null,
    ctx.category || null,
    tagsJson,
    canonicalRows.length,
    ctx.actor || 'import',
  );

  const totals = {
    families_created: 0,
    families_attached: 0,
    persons_created: 0,
    persons_attached: 0,
    persons_enqueued: 0,
    conflicts_opened: 0,
    addresses_attached: 0,
    emails_attached: 0,
    phones_attached: 0,
    memberships_opened: 0,
    memberships_ended: 0,        // not produced by import path, kept for symmetry
  };
  const results = [];
  const tx = db.transaction(() => {
    for (let i = 0; i < canonicalRows.length; i++) {
      const row = canonicalRows[i];
      const r = importRow(db, secrets, thresholds, row, {
        ...ctx,
        sourceRef: `${ctx.sourceRef || ''}#${i + 1}`,
        importRunCode,
      });
      for (const k of Object.keys(totals)) totals[k] += (r.stats && r.stats[k]) || 0;
      results.push(r);
    }
  });
  tx();

  db.prepare(
    `UPDATE import_runs SET
       families_created = ?, families_attached = ?,
       persons_created = ?, persons_attached = ?, persons_enqueued = ?,
       conflicts_opened = ?,
       addresses_attached = ?, emails_attached = ?, phones_attached = ?,
       memberships_opened = ?, memberships_ended = ?
     WHERE code = ?`
  ).run(
    totals.families_created, totals.families_attached,
    totals.persons_created, totals.persons_attached, totals.persons_enqueued,
    totals.conflicts_opened,
    totals.addresses_attached, totals.emails_attached, totals.phones_attached,
    totals.memberships_opened, totals.memberships_ended,
    importRunCode,
  );

  audit.record(db, {
    action: 'import_run',
    actor: ctx.actor || 'import',
    entityKind: 'import',
    entityCode: importRunCode,
    metadata: {
      source: ctx.source || 'manual',
      category: ctx.category || null,
      tags: tagsJson ? JSON.parse(tagsJson) : null,
      rows: canonicalRows.length,
      totals,
    },
  });

  return { importRunCode, totals, results };
}

function getImportRun(db, code) {
  const row = db.prepare(`SELECT * FROM import_runs WHERE code = ?`).get(code);
  if (!row) return null;
  return { ...row, tags: row.tags ? JSON.parse(row.tags) : [] };
}

function listImportRuns(db, { limit = 50, category = null } = {}) {
  const filters = [];
  const params = [];
  if (category) { filters.push('category = ?'); params.push(category); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  params.push(Math.max(1, Math.min(500, Number(limit) || 50)));
  return db
    .prepare(`SELECT * FROM import_runs ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params)
    .map(r => ({ ...r, tags: r.tags ? JSON.parse(r.tags) : [] }));
}

// affectedEntities: for an import-run detail page, list every distinct
// entity (family/person/address) the run touched, by joining provenance
// against the source_records that share this import_run_code.
function affectedEntities(db, importRunCode) {
  return db
    .prepare(
      `SELECT DISTINCT p.entity_code, p.field
         FROM provenance p
         JOIN source_records sr ON sr.code = p.source_code
        WHERE sr.import_run_code = ?
        ORDER BY p.field, p.entity_code`
    )
    .all(importRunCode);
}

module.exports = { importRow, importBatch, getImportRun, listImportRuns, affectedEntities };
