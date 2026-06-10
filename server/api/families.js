'use strict';

const express = require('express');
const families = require('../identity/families');
const contacts = require('../identity/contacts');
const tagsLib = require('../identity/tags');
const audit = require('../audit');
const enc = require('../crypto/encryption');
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
    const all = families.list(db, secrets, {
      limit: req.query.limit ? Number(req.query.limit) : 50,
      status: req.query.status || 'active',
      includePii,
    });
    // Optional ?q=<surname> filter — used by the Families list UI to support
    // the school-side do-not-call workflow ("search by last name, then flag").
    // Match strategy: hash the query token the same way persons.family_name_hash
    // is hashed, and keep families whose any active member matches.
    const q = req.query.q ? String(req.query.q).trim() : '';
    if (!q) return res.json({ items: all });
    const fh = enc.hmac(secrets, enc.normalizeName(q));
    if (!fh) return res.json({ items: all });
    const matchingFams = new Set(
      db.prepare(
        `SELECT DISTINCT m.family_code AS code FROM memberships m
           JOIN persons p ON p.code = m.person_code
          WHERE m.ended_at IS NULL AND p.family_name_hash = ?`
      ).all(fh).map(r => r.code)
    );
    res.json({ items: all.filter(f => matchingFams.has(f.code)) });
  });

  r.post('/', (req, res) => {
    const code = families.create(db, secrets, req.body || {}, ctx(req));
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
    const updated = families.update(db, secrets, req.params.code, req.body || {}, ctx(req));
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

  // POST /api/families/:code/do-not-contact
  // Body: { value: true|false, reason?: string }
  // Bulk-flag every active member of this family. The school-side
  // "do-not-call list" workflow: an operator searches for the family,
  // toggles this once, and every adult + child gets the same flag with
  // the same reason. Each per-person update is audited individually so
  // an outbound channel that pulls one person can still see the audit
  // attribution.
  r.post('/:code/do-not-contact', (req, res) => {
    if (!isValidCode(req.params.code, 'family')) {
      return res.status(400).json({ error: 'invalid family code' });
    }
    const value = !!(req.body && req.body.value);
    const reason = req.body && req.body.reason ? String(req.body.reason).slice(0, 500) : null;
    const members = families.members(db, secrets, req.params.code, { activeOnly: true });
    const people = require('../identity/people');
    let updated = 0;
    for (const m of members) {
      const patch = { do_not_contact: value };
      if (value && reason) patch.do_not_contact_reason = reason;
      if (!value) patch.do_not_contact_reason = null;
      const code = people.update(db, secrets, m.person_code, patch);
      if (code) updated += 1;
      audit.record(db, {
        action: 'person_do_not_contact_set',
        actor: req.auth?.actor || 'unknown',
        entityCode: m.person_code,
        entityKind: 'person',
        metadata: { value, reason: reason || null, via: req.params.code },
      });
    }
    audit.record(db, {
      action: 'family_do_not_contact_bulk',
      actor: req.auth?.actor || 'unknown',
      entityCode: req.params.code,
      entityKind: 'family',
      metadata: { value, reason: reason || null, members_updated: updated },
    });
    res.json({ updated, value, reason });
  });

  r.post('/:code/merge', (req, res) => {
    const { winner_code } = req.body || {};
    if (!isValidCode(winner_code, 'family') || !isValidCode(req.params.code, 'family')) {
      return res.status(400).json({ error: 'invalid codes' });
    }
    const code = families.merge(db, secrets, req.params.code, winner_code, ctx(req));
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

  r.put('/:code/tags', (req, res) => {
    if (!isValidCode(req.params.code, 'family')) {
      return res.status(400).json({ error: 'invalid family code' });
    }
    const { tags = [] } = req.body || {};
    if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags must be an array' });
    const updated = tagsLib.setFamilyTags(db, req.params.code, tags);
    if (updated == null) return res.status(404).json({ error: 'not found' });
    audit.record(db, {
      action: 'family_set_tags',
      actor: req.auth?.actor || 'unknown',
      entityCode: req.params.code,
      entityKind: 'family',
      metadata: { tags: updated },
    });
    res.json({ tags: updated });
  });

  r.delete('/:code/tags/:tag', (req, res) => {
    if (!isValidCode(req.params.code, 'family')) {
      return res.status(400).json({ error: 'invalid family code' });
    }
    const updated = tagsLib.removeFamilyTag(db, req.params.code, req.params.tag);
    if (updated == null) return res.status(404).json({ error: 'not found' });
    audit.record(db, {
      action: 'family_remove_tag',
      actor: req.auth?.actor || 'unknown',
      entityCode: req.params.code,
      entityKind: 'family',
      metadata: { tag: req.params.tag, tags: updated },
    });
    res.json({ tags: updated });
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
