'use strict';

// Staff accounts with domain-verified login (STAFF_ACCOUNTS_PRD.md).
//
// Accounts are invited, never self-created, and only for emails whose
// domain matches a verified domain on an active organization. Login is
// passwordless: a single-use magic link (15 min) redeems into a
// 12-hour `st_…` bearer session that the standard middleware resolves
// alongside master and `sk_` keys. Raw tokens are never stored or
// logged — SHA-256 hashes in the tables, 8-char fingerprints in logs.
// Emails are encrypted with an HMAC lookup hash; never plaintext.

const crypto = require('crypto');
const enc = require('../crypto/encryption');
const { newCode } = require('../crypto/identifiers');
const apiKeys = require('./api-keys');
const history = require('../identity/history');
const notify = require('../notify');
const log = require('../log');

const LINK_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
// At most this many outstanding (unredeemed, unexpired) links per
// account; further requests are silently throttled.
const MAX_OUTSTANDING_LINKS = 3;

// Staff accounts use the api_keys scope vocabulary, minus '*': master
// stays with the operator.
const GRANTABLE_SCOPES = new Set([...apiKeys.VALID_SCOPES].filter(s => s !== '*'));

// Token hashing shares api-keys' scheme: one place to change if token
// storage ever moves to keyed hashes.
const _hash = apiKeys.hash;

function _emailDomain(email) {
  const at = String(email).lastIndexOf('@');
  if (at < 1 || at === String(email).length - 1) return null;
  return String(email).slice(at + 1).toLowerCase();
}

function _hashPrefix(h) {
  return String(h || '').slice(0, 8);
}

function _row2account(row, secrets, { includeEmail = false } = {}) {
  if (!row) return null;
  const base = {
    code: row.code,
    display_name: row.display_name,
    org_code: row.org_code,
    scopes: JSON.parse(row.scopes),
    status: row.status,
    last_login_at: row.last_login_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (!includeEmail) return base;
  return { ...base, email: enc.decrypt(secrets, row.email_ct) };
}

// The eligibility rule at INVITE time: the email's domain must match a
// verified domain on an active org. A parish and its school can
// legitimately share one domain (shared campus and staff), so multiple
// matches are possible — the caller disambiguates with org_code.
function _verifiedOrgsForDomain(db, domain) {
  if (!domain) return [];
  return db.prepare(
    `SELECT * FROM organizations
      WHERE domain = ? AND domain_verified_at IS NOT NULL AND status = 'active'
      ORDER BY created_at ASC`
  ).all(domain);
}

// The trust rule at every LOGIN (link request and redeem): the
// account's OWN organization must still be active with this email's
// domain verified. Checking by the account's org — not by a global
// domain lookup — means a parish and school sharing a domain can't
// lock each other's staff out.
function _accountOrgTrusted(db, account, emailDomain) {
  if (!emailDomain) return false;
  const org = db.prepare(`SELECT * FROM organizations WHERE code = ?`).get(account.org_code);
  return !!(org && org.status === 'active' && org.domain === emailDomain && org.domain_verified_at);
}

function invite(db, secrets, input = {}, audit = {}) {
  const email = enc.normalizeEmail(input.email);
  if (!email || !_emailDomain(email)) throw new Error('a valid email is required');
  const displayName = input.display_name ? String(input.display_name).trim() : null;
  if (!displayName) throw new Error('display_name is required');
  const scopes = Array.isArray(input.scopes) && input.scopes.length
    ? input.scopes
    : ['pii.read'];
  for (const s of scopes) {
    if (!GRANTABLE_SCOPES.has(s)) {
      throw new Error(`scope not grantable to a staff account: ${s}`);
    }
  }
  const candidates = _verifiedOrgsForDomain(db, _emailDomain(email));
  if (!candidates.length) {
    throw new Error('email domain does not match any verified organization domain');
  }
  let org;
  if (input.org_code) {
    org = candidates.find(o => o.code === input.org_code);
    if (!org) throw new Error('org_code does not match a verified organization for this email domain');
  } else if (candidates.length === 1) {
    org = candidates[0];
  } else {
    // A parish and its school sharing one domain is a real case; the
    // invite must say which community the account belongs to.
    throw new Error(
      `multiple organizations share this domain; pass org_code (one of: ${candidates.map(o => o.code).join(', ')})`
    );
  }
  const emailHash = enc.hmac(secrets, email);
  const existingActive = db.prepare(
    `SELECT code FROM admin_accounts WHERE email_hash = ? AND status = 'active'`
  ).get(emailHash);
  if (existingActive) {
    throw new Error('an active account already exists for this email');
  }
  const code = newCode('admin_account');
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO admin_accounts (code, email_ct, email_hash, display_name, org_code, scopes)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(code, enc.encrypt(secrets, email), emailHash, displayName, org.code, JSON.stringify(scopes));
    const row = db.prepare(`SELECT * FROM admin_accounts WHERE code = ?`).get(code);
    history.record(db, {
      entityKind: 'admin_account', entityCode: code, operation: 'create',
      before: null, after: row,
      actor: audit.actor || 'system', actorKind: audit.actorKind, requestId: audit.requestId,
    });
    return code;
  });
  const out = tx();
  log.info('auth.account_invited', {
    account_code: code, org_code: org.code, email_hash: _hashPrefix(emailHash), scopes,
  });
  return out;
}

function list(db, secrets, { includeEmail = false } = {}) {
  return db.prepare(`SELECT * FROM admin_accounts ORDER BY created_at DESC`)
    .all().map(r => _row2account(r, secrets, { includeEmail }));
}

function get(db, secrets, code, opts = {}) {
  const row = db.prepare(`SELECT * FROM admin_accounts WHERE code = ?`).get(code);
  return _row2account(row, secrets, opts);
}

function update(db, secrets, code, patch = {}, audit = {}) {
  const existing = db.prepare(`SELECT * FROM admin_accounts WHERE code = ?`).get(code);
  if (!existing) return null;
  let scopes = existing.scopes;
  if ('scopes' in patch) {
    if (!Array.isArray(patch.scopes) || !patch.scopes.length) {
      throw new Error('scopes must be a non-empty array');
    }
    for (const s of patch.scopes) {
      if (!GRANTABLE_SCOPES.has(s)) {
        throw new Error(`scope not grantable to a staff account: ${s}`);
      }
    }
    scopes = JSON.stringify(patch.scopes);
  }
  const displayName = 'display_name' in patch && patch.display_name
    ? String(patch.display_name).trim()
    : existing.display_name;
  let status = existing.status;
  if ('status' in patch) {
    if (patch.status !== 'active' && patch.status !== 'disabled') {
      throw new Error(`invalid account status: ${patch.status}`);
    }
    status = patch.status;
  }
  // Re-enabling must not collide with a newer active account for the
  // same email (the unique index only covers active rows, so disable +
  // re-invite is legal — and makes the old row un-re-enableable).
  if (status === 'active' && existing.status === 'disabled') {
    const dupe = db.prepare(
      `SELECT code FROM admin_accounts WHERE email_hash = ? AND status = 'active' AND code != ?`
    ).get(existing.email_hash, code);
    if (dupe) throw new Error('an active account already exists for this email; disable it first');
  }
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE admin_accounts SET display_name = ?, scopes = ?, status = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE code = ?`
    ).run(displayName, scopes, status, code);
    // Disabling an account kills its sessions and outstanding links in
    // the same transaction — revocation is immediate, not eventual.
    if (status === 'disabled' && existing.status !== 'disabled') {
      db.prepare(
        `UPDATE admin_sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE account_code = ? AND revoked_at IS NULL`
      ).run(code);
      db.prepare(
        `UPDATE admin_login_tokens SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE account_code = ? AND used_at IS NULL`
      ).run(code);
      log.info('auth.account_disabled', { account_code: code });
    }
    const after = db.prepare(`SELECT * FROM admin_accounts WHERE code = ?`).get(code);
    history.record(db, {
      entityKind: 'admin_account', entityCode: code,
      operation: status === 'disabled' && existing.status !== 'disabled' ? 'archive' : 'update',
      before: existing, after,
      actor: audit.actor || 'system', actorKind: audit.actorKind, requestId: audit.requestId,
    });
    return code;
  });
  return tx();
}

// Request a magic link. ALWAYS returns { ok: true } so the endpoint
// never reveals whether an account exists (no enumeration). When the
// account is real, active, and its org still domain-verified, a
// single-use link is enqueued through the notifications queue.
function requestLink(db, secrets, email) {
  const normalized = enc.normalizeEmail(email);
  if (!normalized) return { ok: true };
  const emailHash = enc.hmac(secrets, normalized);
  const account = db.prepare(
    `SELECT * FROM admin_accounts WHERE email_hash = ? AND status = 'active'`
  ).get(emailHash);
  if (!account) {
    log.warn('auth.link_requested', { account_code: 'unknown_email', email_hash: _hashPrefix(emailHash) });
    return { ok: true };
  }
  if (!_accountOrgTrusted(db, account, _emailDomain(normalized))) {
    // Domain un-verified, changed, or organization archived since the
    // invite: the trust chain is broken, so logins stop.
    log.warn('auth.link_requested', {
      account_code: account.code, email_hash: _hashPrefix(emailHash), reason: 'domain_no_longer_verified',
    });
    return { ok: true };
  }
  const now = new Date().toISOString();
  const outstanding = db.prepare(
    `SELECT COUNT(*) AS n FROM admin_login_tokens
      WHERE account_code = ? AND used_at IS NULL AND expires_at > ?`
  ).get(account.code, now).n;
  if (outstanding >= MAX_OUTSTANDING_LINKS) {
    log.warn('auth.link_throttled', { account_code: account.code });
    return { ok: true };
  }
  const raw = `ml_${crypto.randomBytes(32).toString('base64url')}`;
  const code = newCode('admin_login_token');
  const expiresAt = new Date(Date.now() + LINK_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO admin_login_tokens (code, account_code, token_hash, expires_at)
     VALUES (?, ?, ?, ?)`
  ).run(code, account.code, _hash(raw), expiresAt);
  const cfg = notify.effectiveConfig(db);
  const link = `${cfg.dashboardUrl}/login?token=${raw}`;
  notify.enqueue(db, {
    kind: 'magic_link',
    to: normalized,
    subject: 'Your FamilyGraph sign-in link',
    text: [
      `Hello ${account.display_name},`,
      '',
      'Use this link to sign in to FamilyGraph. It works once and',
      'expires in 15 minutes:',
      '',
      link,
      '',
      'If you did not request this, you can ignore this message.',
    ].join('\n'),
    related: [account.code],
  });
  log.info('auth.link_requested', { account_code: account.code, email_hash: _hashPrefix(emailHash) });
  return { ok: true };
}

// Redeem a magic link for a session. Returns { token, account } or null.
function redeem(db, secrets, rawToken) {
  if (typeof rawToken !== 'string' || !rawToken.startsWith('ml_')) {
    log.warn('auth.login_failed', { reason: 'unknown' });
    return null;
  }
  const row = db.prepare(`SELECT * FROM admin_login_tokens WHERE token_hash = ?`).get(_hash(rawToken));
  if (!row) {
    log.warn('auth.login_failed', { reason: 'unknown' });
    return null;
  }
  if (row.used_at) {
    log.warn('auth.login_failed', { reason: 'used', account_code: row.account_code });
    return null;
  }
  if (row.expires_at <= new Date().toISOString()) {
    log.warn('auth.login_failed', { reason: 'expired', account_code: row.account_code });
    return null;
  }
  const account = db.prepare(
    `SELECT * FROM admin_accounts WHERE code = ? AND status = 'active'`
  ).get(row.account_code);
  if (!account) {
    log.warn('auth.login_failed', { reason: 'unknown', account_code: row.account_code });
    return null;
  }
  const email = enc.normalizeEmail(enc.decrypt(secrets, account.email_ct));
  if (!_accountOrgTrusted(db, account, _emailDomain(email))) {
    log.warn('auth.login_failed', { reason: 'domain_no_longer_verified', account_code: account.code });
    return null;
  }
  const sessionToken = `st_${crypto.randomBytes(32).toString('base64url')}`;
  const sessionCode = newCode('admin_session');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE admin_login_tokens SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ?`
    ).run(row.code);
    db.prepare(
      `INSERT INTO admin_sessions (code, account_code, token_hash, expires_at)
       VALUES (?, ?, ?, ?)`
    ).run(sessionCode, account.code, _hash(sessionToken), expiresAt);
    db.prepare(
      `UPDATE admin_accounts SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ?`
    ).run(account.code);
  });
  tx();
  log.info('auth.login_success', { account_code: account.code, session_code: sessionCode });
  return {
    token: sessionToken,
    expires_at: expiresAt,
    account: _row2account(db.prepare(`SELECT * FROM admin_accounts WHERE code = ?`).get(account.code), secrets),
  };
}

// Resolve a `st_…` bearer into an account context, or null. Called by
// the auth middleware on every staff request.
function lookupSession(db, token) {
  if (typeof token !== 'string' || !token.startsWith('st_')) return null;
  const row = db.prepare(
    `SELECT s.code AS session_code, s.expires_at, s.revoked_at, s.last_used_at,
            a.code AS account_code, a.display_name, a.scopes, a.org_code, a.status
       FROM admin_sessions s JOIN admin_accounts a ON a.code = s.account_code
      WHERE s.token_hash = ?`
  ).get(_hash(token));
  if (!row) return null;
  if (row.revoked_at || row.status !== 'active') return null;
  if (row.expires_at <= new Date().toISOString()) return null;
  // last_used_at is an operator-facing freshness signal, not a ledger:
  // refreshing it at most once a minute keeps staff reads from turning
  // into a WAL write per request.
  const staleCutoff = new Date(Date.now() - 60_000).toISOString();
  if (!row.last_used_at || row.last_used_at < staleCutoff) {
    db.prepare(
      `UPDATE admin_sessions SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ?`
    ).run(row.session_code);
  }
  return {
    session_code: row.session_code,
    account_code: row.account_code,
    display_name: row.display_name,
    org_code: row.org_code,
    scopes: JSON.parse(row.scopes),
  };
}

// Kill every live session and outstanding link for an organization's
// accounts. The trust break that motivates un-verifying a domain or
// archiving an org (compromised mail, offboarded institution) is at
// least as severe as disabling one account, so it gets the same
// immediate revocation, not a wait-for-expiry.
function revokeSessionsForOrg(db, orgCode, { reason = 'org_trust_change' } = {}) {
  const sessions = db.prepare(
    `UPDATE admin_sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE revoked_at IS NULL
        AND account_code IN (SELECT code FROM admin_accounts WHERE org_code = ?)`
  ).run(orgCode).changes;
  const links = db.prepare(
    `UPDATE admin_login_tokens SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE used_at IS NULL
        AND account_code IN (SELECT code FROM admin_accounts WHERE org_code = ?)`
  ).run(orgCode).changes;
  if (sessions || links) {
    log.info('auth.session_revoked', { by: reason, org_code: orgCode, sessions, links });
  }
  return { sessions, links };
}

function logout(db, token) {
  if (typeof token !== 'string' || !token.startsWith('st_')) return false;
  const r = db.prepare(
    `UPDATE admin_sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE token_hash = ? AND revoked_at IS NULL`
  ).run(_hash(token));
  if (r.changes) log.info('auth.session_revoked', { by: 'logout' });
  return r.changes > 0;
}

module.exports = {
  invite,
  list,
  get,
  update,
  requestLink,
  redeem,
  lookupSession,
  logout,
  revokeSessionsForOrg,
  GRANTABLE_SCOPES,
  LINK_TTL_MS,
  SESSION_TTL_MS,
};
