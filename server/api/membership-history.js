'use strict';

const express = require('express');
const aliases = require('../identity/aliases');
const enc = require('../crypto/encryption');
const { isValidCode } = require('../crypto/identifiers');

// Membership history: walks the memberships table for a person OR a family,
// returning every row (active and ended) with reason annotation. Used to show
// "this child was emancipated on date X", "this person was a parent in family
// A then merged into family B", etc.

function build({ db, secrets }) {
  const r = express.Router();

  r.get('/person/:code', (req, res) => {
    if (!isValidCode(req.params.code, 'person')) {
      return res.status(400).json({ error: 'invalid person code' });
    }
    const target = aliases.resolveAlias(db, req.params.code);
    const rows = db
      .prepare(
        `SELECT m.*, f.display_name_ct
           FROM memberships m
           JOIN families f ON f.code = m.family_code
          WHERE m.person_code = ?
          ORDER BY m.started_at ASC`
      )
      .all(target);
    res.json({
      person_code: target,
      items: rows.map(row => ({
        membership_code: row.code,
        family_code: row.family_code,
        family_display_name: enc.decrypt(secrets, row.display_name_ct),
        role: row.role,
        custody: row.custody,
        started_at: row.started_at,
        ended_at: row.ended_at,
        reason: row.reason,
      })),
    });
  });

  r.get('/family/:code', (req, res) => {
    if (!isValidCode(req.params.code, 'family')) {
      return res.status(400).json({ error: 'invalid family code' });
    }
    const target = aliases.resolveAlias(db, req.params.code);
    const rows = db
      .prepare(
        `SELECT m.*, p.display_name_ct
           FROM memberships m
           JOIN persons p ON p.code = m.person_code
          WHERE m.family_code = ?
          ORDER BY m.started_at ASC`
      )
      .all(target);
    res.json({
      family_code: target,
      items: rows.map(row => ({
        membership_code: row.code,
        person_code: row.person_code,
        person_display_name: enc.decrypt(secrets, row.display_name_ct),
        role: row.role,
        custody: row.custody,
        started_at: row.started_at,
        ended_at: row.ended_at,
        reason: row.reason,
      })),
    });
  });

  return r;
}

module.exports = build;
