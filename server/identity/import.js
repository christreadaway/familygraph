'use strict';

const { newCode } = require('../crypto/identifiers');
const enc = require('../crypto/encryption');
const people = require('./people');
const families = require('./families');
const contacts = require('./contacts');
const resolver = require('./resolver');
const audit = require('../audit');

// Import a parsed canonical row (the output of source handler.applyMapping).
// Pure function over the database; the caller decides whether to wrap N rows
// in a single transaction.
function importRow(db, secrets, thresholds, canonical, ctx = {}) {
  const sourceCode = newCode('source');
  db.prepare(
    `INSERT INTO source_records (code, source, source_ref, raw_payload_ct) VALUES (?, ?, ?, ?)`
  ).run(
    sourceCode,
    ctx.source || 'manual',
    ctx.sourceRef || null,
    enc.encrypt(secrets, JSON.stringify(canonical))
  );

  const personOutcomes = [];
  const personCodes = [];
  for (const incoming of canonical.persons || []) {
    const r = resolver.resolveOrCreatePerson(db, secrets, thresholds, incoming, {
      actor: ctx.actor || 'import',
    });
    personOutcomes.push({ ...r, incoming });
    personCodes.push(r.code);

    // Attach contacts (emails, phones).
    for (const email of incoming.emails || []) {
      const ec = contacts.upsertEmail(db, secrets, email);
      if (ec) contacts.attachEmailToPerson(db, r.code, ec, { isPrimary: false });
    }
    for (const phone of incoming.phones || []) {
      const pc = contacts.upsertPhone(db, secrets, phone);
      if (pc) contacts.attachPhoneToPerson(db, r.code, pc, { isPrimary: false });
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

    // Open active memberships for each person not already a member of this family.
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
      }
    }

    db.prepare(
      `INSERT OR IGNORE INTO provenance (source_code, entity_code, field) VALUES (?, ?, ?)`
    ).run(sourceCode, familyOutcome.code, 'family');

    // Attach address.
    if (canonical.address && (canonical.address.line1 || canonical.address.city)) {
      const ac = contacts.upsertAddress(db, secrets, canonical.address);
      if (ac) {
        contacts.attachAddressToFamily(db, familyOutcome.code, ac, {
          label: canonical.address.label || 'home',
          isPrimary: true,
        });
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
      personOutcomes: personOutcomes.map(o => ({ code: o.code, action: o.action, score: o.score })),
      familyOutcome: familyOutcome ? { code: familyOutcome.code, action: familyOutcome.action } : null,
    },
  });

  return {
    sourceRecord: sourceCode,
    family: familyOutcome,
    persons: personOutcomes,
  };
}

function importBatch(db, secrets, thresholds, canonicalRows, ctx = {}) {
  const results = [];
  const tx = db.transaction(() => {
    for (let i = 0; i < canonicalRows.length; i++) {
      const row = canonicalRows[i];
      results.push(importRow(db, secrets, thresholds, row, { ...ctx, sourceRef: `${ctx.sourceRef || ''}#${i + 1}` }));
    }
  });
  tx();
  return results;
}

module.exports = { importRow, importBatch };
