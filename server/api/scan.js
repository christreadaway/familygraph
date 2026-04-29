'use strict';

const express = require('express');
const resolver = require('../identity/resolver');
const profiles = require('../identity/profiles');
const audit = require('../audit');

// POST /api/scan/duplicates
//
// Iterate every active person and run rescorePerson() against the candidate
// pool. Any pair scoring at or above the review threshold is enqueued as a
// `person` conflict (deduped against already-open conflicts). Returns counts
// for the operator to decide whether to open the conflict queue.
//
// This is a user-invoked sweep — it complements the per-import resolver, which
// only catches duplicates within the incoming batch. Run this after a fresh
// import to surface duplicates between the new rows and existing rows that the
// import-time resolver thresholds did not catch.
function build({ db, secrets, thresholds }) {
  const effective = () => profiles.thresholdsFor(db, thresholds);
  const r = express.Router();

  r.post('/duplicates', (req, res) => {
    const t = effective();
    const limit = req.body && req.body.limit ? Math.max(1, Math.min(50_000, Number(req.body.limit))) : 5000;
    const importRunCode = req.body && req.body.import_run_code ? String(req.body.import_run_code) : null;

    let codes;
    if (importRunCode) {
      codes = db.prepare(
        `SELECT DISTINCT p.entity_code AS code
           FROM provenance p
           JOIN source_records sr ON sr.code = p.source_code
          WHERE sr.import_run_code = ? AND p.field = 'person'`
      ).all(importRunCode).map(r => r.code);
    } else {
      codes = db.prepare(
        `SELECT code FROM persons WHERE status = 'active' ORDER BY created_at DESC LIMIT ?`
      ).all(limit).map(r => r.code);
    }

    const before = db.prepare(`SELECT COUNT(*) AS n FROM conflicts WHERE status = 'open' AND kind = 'person'`).get().n;
    let scanned = 0;
    let matched = 0;
    for (const code of codes) {
      const matches = resolver.rescorePerson(db, secrets, t, code);
      scanned += 1;
      matched += matches.length;
    }
    const after = db.prepare(`SELECT COUNT(*) AS n FROM conflicts WHERE status = 'open' AND kind = 'person'`).get().n;

    audit.record(db, {
      action: 'scan_duplicates',
      actor: req.auth?.actor || 'operator',
      metadata: {
        scope: importRunCode ? `import:${importRunCode}` : `recent:${codes.length}`,
        scanned,
        matches_found: matched,
        new_conflicts_opened: Math.max(0, after - before),
      },
    });

    res.json({
      scope: importRunCode ? { import_run_code: importRunCode } : { recent: codes.length },
      scanned,
      matches_found: matched,
      new_conflicts_opened: Math.max(0, after - before),
      open_person_conflicts: after,
    });
  });

  return r;
}

module.exports = build;
