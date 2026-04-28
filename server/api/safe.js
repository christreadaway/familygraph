'use strict';

const express = require('express');
const families = require('../identity/families');
const people = require('../identity/people');
const contacts = require('../identity/contacts');
const { isValidCode } = require('../crypto/identifiers');

// The pseudonym surface. No PII may be returned. We deliberately strip every
// decryptable field; only opaque identifiers, structural shape, status, and
// timestamps are exposed. AI workflows and exports use this surface.

function build({ db, secrets }) {
  const r = express.Router();

  r.get('/families/:code', (req, res) => {
    if (!isValidCode(req.params.code, 'family')) return res.status(400).json({ error: 'invalid family code' });
    const fam = families.get(db, secrets, req.params.code, { includePii: false });
    if (!fam) return res.status(404).json({ error: 'not found' });
    const members = families.members(db, secrets, fam.code, { includePii: false, activeOnly: true });
    const c = contacts.familyContacts(db, secrets, fam.code, { includePii: false });
    res.json({ family: fam, members, contacts: c });
  });

  r.get('/people/:code', (req, res) => {
    if (!isValidCode(req.params.code, 'person')) return res.status(400).json({ error: 'invalid person code' });
    const p = people.get(db, secrets, req.params.code, { includePii: false });
    if (!p) return res.status(404).json({ error: 'not found' });
    res.json({ person: p });
  });

  r.get('/families', (req, res) => {
    res.json({ items: families.list(db, secrets, { includePii: false, limit: req.query.limit }) });
  });

  r.get('/people', (req, res) => {
    res.json({ items: people.list(db, secrets, { includePii: false, limit: req.query.limit }) });
  });

  return r;
}

module.exports = build;
