'use strict';

// Staff-account management (STAFF_ACCOUNTS_PRD.md). Master-only by
// mount: provisioning trust is the operator's job, like /api/keys.
// Invited accounts only — there is deliberately no self-signup route.

const express = require('express');
const { userFacingMessage } = require('./_errors');
const accounts = require('../auth/accounts');
const audit = require('../audit');
const { isValidCode } = require('../crypto/identifiers');

function build({ db, secrets }) {
  const r = express.Router();

  const ctx = req => ({
    actor: req.auth?.actor || 'unknown',
    actorKind: req.auth?.kind || null,
    requestId: req.get('x-request-id') || null,
  });

  r.get('/', (req, res) => {
    res.json({ items: accounts.list(db, secrets, { includeEmail: true }) });
  });

  r.post('/', (req, res) => {
    try {
      const code = accounts.invite(db, secrets, req.body || {}, ctx(req));
      audit.record(db, {
        action: 'staff_account_invite',
        actor: req.auth?.actor || 'unknown',
        entityCode: code,
        entityKind: 'admin_account',
        metadata: { display_name: req.body?.display_name, scopes: req.body?.scopes },
      });
      res.status(201).json({ code });
    } catch (e) {
      res.status(400).json({ error: userFacingMessage(e) });
    }
  });

  r.patch('/:code', (req, res) => {
    if (!isValidCode(req.params.code, 'admin_account')) {
      return res.status(400).json({ error: 'invalid account code' });
    }
    try {
      const code = accounts.update(db, secrets, req.params.code, req.body || {}, ctx(req));
      if (!code) return res.status(404).json({ error: 'not found' });
      audit.record(db, {
        action: 'staff_account_update',
        actor: req.auth?.actor || 'unknown',
        entityCode: code,
        entityKind: 'admin_account',
      });
      res.json({ code });
    } catch (e) {
      res.status(400).json({ error: userFacingMessage(e) });
    }
  });

  // DELETE disables (and revokes sessions immediately); rows are never
  // dropped, so the audit trail keeps pointing at a real account.
  r.delete('/:code', (req, res) => {
    if (!isValidCode(req.params.code, 'admin_account')) {
      return res.status(400).json({ error: 'invalid account code' });
    }
    const code = accounts.update(db, secrets, req.params.code, { status: 'disabled' }, ctx(req));
    if (!code) return res.status(404).json({ error: 'not found' });
    audit.record(db, {
      action: 'staff_account_disable',
      actor: req.auth?.actor || 'unknown',
      entityCode: code,
      entityKind: 'admin_account',
    });
    res.status(204).end();
  });

  return r;
}

module.exports = build;
