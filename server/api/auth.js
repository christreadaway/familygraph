'use strict';

// Staff login surface (STAFF_ACCOUNTS_PRD.md). Request-link and redeem
// are unauthenticated by design — they're how a session comes to exist —
// and are mounted behind a tight rate limit. me/logout require a live
// session bearer.

const express = require('express');
const { userFacingMessage } = require('./_errors');
const accounts = require('../auth/accounts');
const { tokenFingerprint } = require('../auth/middleware');
const audit = require('../audit');

function _bearer(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  return m ? m[1].trim() : null;
}

function build({ db, secrets }) {
  const r = express.Router();

  r.post('/request-link', (req, res) => {
    try {
      // Always { ok: true } — the endpoint never reveals whether an
      // account exists for the address.
      res.json(accounts.requestLink(db, secrets, req.body?.email));
    } catch (e) {
      res.status(400).json({ error: userFacingMessage(e) });
    }
  });

  r.post('/redeem', (req, res) => {
    const out = accounts.redeem(db, secrets, req.body?.token);
    if (!out) {
      return res.status(401).json({ error: 'unauthorized', detail: 'invalid, used, or expired link' });
    }
    audit.record(db, {
      action: 'staff_login',
      actor: out.account.display_name,
      entityCode: out.account.code,
      entityKind: 'admin_account',
    });
    res.json(out);
  });

  r.get('/me', (req, res) => {
    const sess = accounts.lookupSession(db, _bearer(req));
    if (!sess) return res.status(401).json({ error: 'unauthorized', reason: 'unknown_or_expired_session' });
    res.json({ account: accounts.get(db, secrets, sess.account_code), session_code: sess.session_code });
  });

  r.post('/logout', (req, res) => {
    const token = _bearer(req);
    const out = accounts.logout(db, token);
    if (out) {
      audit.record(db, {
        action: 'staff_logout',
        actor: 'staff',
        metadata: { token_fp: tokenFingerprint(token) },
      });
    }
    res.json({ ok: true });
  });

  return r;
}

module.exports = build;
