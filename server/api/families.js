'use strict';

const express = require('express');
const families = require('../identity/families');
const contacts = require('../identity/contacts');
const audit = require('../audit');
const { isValidCode } = require('../crypto/identifiers');

function build({ db, secrets, includePii }) {
  const r = express.Router();

  r.get('/', (req, res) => {
    const list = families.list(db, secrets, {
      limit: req.query.limit ? Number(req.query.limit) : 50,
      status: req.query.status || 'active',
      includePii,
    });
    res.json({ items: list });
  });

  r.post('/', (req, res) => {
    const code = families.create(db, secrets, req.body || {});
    audit.record(db, {
      action: 'family_create',
      actor: req.auth?.actor || 'unknown',
      entityCode: code,
      entityKind: 'family',
    });
    res.status(201).json({ code });
  });

  r.get('/:code', (req, res) => {
    if (!isValidCode(req.params.code, 'family')) {
      return res.status(400).json({ error: 'invalid family code' });
    }
    const fam = families.get(db, secrets, req.params.code, { includePii });
    if (!fam) return res.status(404).json({ error: 'not found' });
    const members = families.members(db, secrets, fam.code, { includePii, activeOnly: true });
    const contactsBundle = contacts.familyContacts(db, secrets, fam.code, { includePii });
    if (includePii) {
      audit.record(db, {
        action: 'read_pii',
        actor: req.auth?.actor || 'unknown',
        entityCode: fam.code,
        entityKind: 'family',
      });
    }
    res.json({ family: fam, members, contacts: contactsBundle });
  });

  r.patch('/:code', (req, res) => {
    if (!isValidCode(req.params.code, 'family')) {
      return res.status(400).json({ error: 'invalid family code' });
    }
    const updated = families.update(db, secrets, req.params.code, req.body || {});
    if (!updated) return res.status(404).json({ error: 'not found' });
    audit.record(db, {
      action: 'family_update',
      actor: req.auth?.actor || 'unknown',
      entityCode: updated,
      entityKind: 'family',
    });
    res.json({ code: updated });
  });

  r.post('/:code/members', (req, res) => {
    if (!isValidCode(req.params.code, 'family')) {
      return res.status(400).json({ error: 'invalid family code' });
    }
    const { person_code, role = 'member', custody = null } = req.body || {};
    if (!isValidCode(person_code, 'person')) {
      return res.status(400).json({ error: 'invalid person code' });
    }
    const m = families.addMember(db, secrets, req.params.code, person_code, { role, custody });
    audit.record(db, {
      action: 'family_add_member',
      actor: req.auth?.actor || 'unknown',
      entityCode: req.params.code,
      entityKind: 'family',
      metadata: { person_code, role },
    });
    res.status(201).json({ membership_code: m });
  });

  r.delete('/:code/members/:membership', (req, res) => {
    families.endMembership(db, req.params.membership, req.body?.reason || 'edit');
    audit.record(db, {
      action: 'family_end_membership',
      actor: req.auth?.actor || 'unknown',
      entityCode: req.params.code,
      entityKind: 'family',
      metadata: { membership: req.params.membership },
    });
    res.status(204).end();
  });

  r.post('/:code/merge', (req, res) => {
    const { winner_code } = req.body || {};
    if (!isValidCode(winner_code, 'family') || !isValidCode(req.params.code, 'family')) {
      return res.status(400).json({ error: 'invalid codes' });
    }
    const code = families.merge(db, secrets, req.params.code, winner_code);
    audit.record(db, {
      action: 'family_merge',
      actor: req.auth?.actor || 'unknown',
      entityCode: code,
      entityKind: 'family',
      metadata: { loser: req.params.code, winner: winner_code },
    });
    res.json({ code });
  });

  r.post('/:code/split', (req, res) => {
    const { person_codes = [], display_name = null, notes = null } = req.body || {};
    if (!Array.isArray(person_codes) || person_codes.length === 0) {
      return res.status(400).json({ error: 'person_codes required' });
    }
    const newFamily = families.split(db, secrets, req.params.code, person_codes, {
      displayName: display_name,
      notes,
    });
    audit.record(db, {
      action: 'family_split',
      actor: req.auth?.actor || 'unknown',
      entityCode: req.params.code,
      entityKind: 'family',
      metadata: { new_family: newFamily, persons_moved: person_codes.length },
    });
    res.status(201).json({ code: newFamily });
  });

  r.post('/:code/addresses', (req, res) => {
    if (!isValidCode(req.params.code, 'family')) {
      return res.status(400).json({ error: 'invalid family code' });
    }
    const { address, label = 'home', is_primary = false } = req.body || {};
    if (!address) return res.status(400).json({ error: 'address required' });
    const addrCode = contacts.upsertAddress(db, secrets, address);
    if (!addrCode) return res.status(400).json({ error: 'invalid address' });
    contacts.attachAddressToFamily(db, req.params.code, addrCode, { label, isPrimary: !!is_primary });
    audit.record(db, {
      action: 'family_add_address',
      actor: req.auth?.actor || 'unknown',
      entityCode: req.params.code,
      entityKind: 'family',
    });
    res.status(201).json({ code: addrCode });
  });

  return r;
}

module.exports = build;
