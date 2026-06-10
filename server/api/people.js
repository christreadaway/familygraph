'use strict';


const { userFacingMessage } = require('./_errors');
const express = require('express');
const people = require('../identity/people');
const contacts = require('../identity/contacts');
const tagsLib = require('../identity/tags');
const audit = require('../audit');
const { isValidCode } = require('../crypto/identifiers');

function build({ db, secrets, includePii }) {
  const r = express.Router();

  // Audit context forwarded into the entity_changes snapshot log so the
  // before/after row names the human or app that made the change, not
  // 'system' (any change must have an audit trail — with attribution).
  const ctx = req => ({
    actor: req.auth?.actor || 'unknown',
    actorKind: req.auth?.kind || null,
    requestId: req.get('x-request-id') || null,
  });

  r.get('/', (req, res) => {
    const list = people.list(db, secrets, {
      limit: req.query.limit ? Number(req.query.limit) : 50,
      status: req.query.status || 'active',
      includePii,
    });
    res.json({ items: list });
  });

  r.post('/', (req, res) => {
    let code;
    try {
      code = people.create(db, secrets, req.body || {}, ctx(req));
    } catch (e) {
      return res.status(400).json({ error: userFacingMessage(e) });
    }
    audit.record(db, {
      action: 'person_create',
      actor: req.auth?.actor || 'unknown',
      entityCode: code,
      entityKind: 'person',
    });
    res.status(201).json({ code });
  });

  r.get('/:code', (req, res) => {
    if (!isValidCode(req.params.code, 'person')) {
      return res.status(400).json({ error: 'invalid person code' });
    }
    const p = people.get(db, secrets, req.params.code, { includePii });
    if (!p) return res.status(404).json({ error: 'not found' });
    if (includePii) {
      audit.record(db, {
        action: 'read_pii',
        actor: req.auth?.actor || 'unknown',
        entityCode: p.code,
        entityKind: 'person',
      });
    }
    res.json({ person: p });
  });

  r.patch('/:code', (req, res) => {
    if (!isValidCode(req.params.code, 'person')) {
      return res.status(400).json({ error: 'invalid person code' });
    }
    let code;
    try {
      code = people.update(db, secrets, req.params.code, req.body || {}, ctx(req));
    } catch (e) {
      return res.status(400).json({ error: userFacingMessage(e) });
    }
    if (!code) return res.status(404).json({ error: 'not found' });
    audit.record(db, {
      action: 'person_update',
      actor: req.auth?.actor || 'unknown',
      entityCode: code,
      entityKind: 'person',
    });
    res.json({ code });
  });

  r.post('/:code/merge', (req, res) => {
    const { winner_code } = req.body || {};
    if (!isValidCode(winner_code, 'person') || !isValidCode(req.params.code, 'person')) {
      return res.status(400).json({ error: 'invalid codes' });
    }
    const code = people.merge(db, secrets, req.params.code, winner_code, ctx(req));
    audit.record(db, {
      action: 'person_merge',
      actor: req.auth?.actor || 'unknown',
      entityCode: code,
      entityKind: 'person',
      metadata: { loser: req.params.code, winner: winner_code },
    });
    res.json({ code });
  });

  r.put('/:code/tags', (req, res) => {
    if (!isValidCode(req.params.code, 'person')) {
      return res.status(400).json({ error: 'invalid person code' });
    }
    const { tags = [] } = req.body || {};
    if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags must be an array' });
    const updated = tagsLib.setPersonTags(db, req.params.code, tags);
    if (updated == null) return res.status(404).json({ error: 'not found' });
    audit.record(db, {
      action: 'person_set_tags',
      actor: req.auth?.actor || 'unknown',
      entityCode: req.params.code,
      entityKind: 'person',
      metadata: { tags: updated },
    });
    res.json({ tags: updated });
  });

  r.delete('/:code/tags/:tag', (req, res) => {
    if (!isValidCode(req.params.code, 'person')) {
      return res.status(400).json({ error: 'invalid person code' });
    }
    const updated = tagsLib.removePersonTag(db, req.params.code, req.params.tag);
    if (updated == null) return res.status(404).json({ error: 'not found' });
    audit.record(db, {
      action: 'person_remove_tag',
      actor: req.auth?.actor || 'unknown',
      entityCode: req.params.code,
      entityKind: 'person',
      metadata: { tag: req.params.tag, tags: updated },
    });
    res.json({ tags: updated });
  });

  r.post('/:code/emails', (req, res) => {
    const { email, is_primary = false } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });
    const ec = contacts.upsertEmail(db, secrets, email);
    if (!ec) return res.status(400).json({ error: 'invalid email' });
    contacts.attachEmailToPerson(db, req.params.code, ec, { isPrimary: !!is_primary });
    audit.record(db, {
      action: 'person_add_email',
      actor: req.auth?.actor || 'unknown',
      entityCode: req.params.code,
      entityKind: 'person',
    });
    res.status(201).json({ code: ec });
  });

  r.post('/:code/phones', (req, res) => {
    const { phone, kind = 'other', is_primary = false } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const pc = contacts.upsertPhone(db, secrets, phone, { kind });
    if (!pc) return res.status(400).json({ error: 'invalid phone' });
    contacts.attachPhoneToPerson(db, req.params.code, pc, { isPrimary: !!is_primary });
    audit.record(db, {
      action: 'person_add_phone',
      actor: req.auth?.actor || 'unknown',
      entityCode: req.params.code,
      entityKind: 'person',
    });
    res.status(201).json({ code: pc });
  });

  return r;
}

module.exports = build;
