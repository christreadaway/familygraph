'use strict';

const express = require('express');
const { stringify } = require('csv-stringify/sync');
const enc = require('../crypto/encryption');
const audit = require('../audit');

// Bulk export. Two posture modes:
//   mode=safe  (default) — pseudonyms only. No PII can leave.
//   mode=pii              — full PII. Requires `consent: true` in the body and
//                           records a tier-2 audit event before producing the
//                           file.
//
// Format options: csv | json. CSV is the default because that's what board
// reporting actually consumes.

function build({ db, secrets }) {
  const r = express.Router();

  function exportFamilies({ includePii }) {
    const fams = db.prepare(`SELECT * FROM families WHERE status = 'active' ORDER BY created_at`).all();
    return fams.map(row => {
      const base = { code: row.code, status: row.status, created_at: row.created_at };
      if (includePii) {
        base.display_name = enc.decrypt(secrets, row.display_name_ct);
        base.notes = enc.decrypt(secrets, row.notes_ct);
      }
      return base;
    });
  }

  function exportPeople({ includePii }) {
    const people = db.prepare(`SELECT * FROM persons WHERE status = 'active' ORDER BY created_at`).all();
    return people.map(row => {
      const base = { code: row.code, status: row.status, created_at: row.created_at };
      if (includePii) {
        base.given_name = enc.decrypt(secrets, row.given_name_ct);
        base.family_name = enc.decrypt(secrets, row.family_name_ct);
        base.display_name = enc.decrypt(secrets, row.display_name_ct);
        base.date_of_birth = enc.decrypt(secrets, row.date_of_birth_ct);
      }
      return base;
    });
  }

  function exportMemberships() {
    return db.prepare(`SELECT code, family_code, person_code, role, custody, started_at, ended_at, reason FROM memberships ORDER BY started_at`).all();
  }

  r.post('/', (req, res) => {
    const {
      entity = 'families',
      mode = 'safe',
      format = 'csv',
      consent = false,
      destination = null,
      reason = null,
    } = req.body || {};
    const includePii = mode === 'pii';
    if (includePii) {
      if (!consent) {
        return res.status(400).json({ error: 'consent: true required for PII export' });
      }
      if (!destination) {
        return res.status(400).json({ error: 'destination required for PII export' });
      }
    }
    let rows = [];
    if (entity === 'families') rows = exportFamilies({ includePii });
    else if (entity === 'people') rows = exportPeople({ includePii });
    else if (entity === 'memberships') rows = exportMemberships();
    else return res.status(400).json({ error: `unknown entity: ${entity}` });

    if (includePii) {
      audit.record(db, {
        tier: 2,
        action: 'export_consent',
        actor: req.auth?.actor || 'unknown',
        destination,
        metadata: { entity, format, count: rows.length, reason },
      });
    } else {
      audit.record(db, {
        action: 'export_safe',
        actor: req.auth?.actor || 'unknown',
        metadata: { entity, format, count: rows.length },
      });
    }

    if (format === 'json') {
      res.json({ entity, mode, count: rows.length, items: rows });
      return;
    }
    if (format === 'csv') {
      const text = stringify(rows, { header: true });
      res.set('content-type', 'text/csv; charset=utf-8');
      res.send(text);
      return;
    }
    res.status(400).json({ error: `unknown format: ${format}` });
  });

  return r;
}

module.exports = build;
