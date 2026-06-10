'use strict';

// Migration 0015: Staff accounts with domain-verified login
// (STAFF_ACCOUNTS_PRD.md).
//
// Four mechanisms come online:
//
// 1. Domain verification columns on `organizations`. The operator sets
//    the parish/school web domain; FG issues a token; the institution
//    proves control via DNS TXT (`familygraph-verify=<token>`) or a
//    well-known file. Verified domains are what make staff-account
//    invitations trustworthy.
//
// 2. `admin_accounts` — invited, named staff accounts. Email is
//    encrypted (`email_ct`) with an HMAC lookup hash (`email_hash`);
//    never plaintext (PII rule). Scopes reuse the api_keys vocabulary;
//    '*' is not grantable. Eligibility rule: the email's domain must
//    match a verified domain on an active organization at invite time.
//
// 3. `admin_login_tokens` — single-use magic-link tokens, 15-minute
//    expiry, stored only as SHA-256 hashes.
//
// 4. `admin_sessions` — 12-hour bearer sessions (`st_…` tokens,
//    hash-stored) issued on redeem. The auth middleware resolves them
//    exactly where it resolves `sk_` keys; disabling an account
//    revokes its sessions in the same transaction.

exports.up = function up(db) {
  const orgCols = db.prepare(`PRAGMA table_info(organizations)`).all().map(r => r.name);
  if (!orgCols.includes('domain')) {
    db.exec(`ALTER TABLE organizations ADD COLUMN domain TEXT`);
  }
  if (!orgCols.includes('domain_verification_token')) {
    db.exec(`ALTER TABLE organizations ADD COLUMN domain_verification_token TEXT`);
  }
  if (!orgCols.includes('domain_verified_at')) {
    db.exec(`ALTER TABLE organizations ADD COLUMN domain_verified_at TEXT`);
  }
  if (!orgCols.includes('domain_verification_method')) {
    db.exec(`ALTER TABLE organizations ADD COLUMN domain_verification_method TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS organizations_domain_idx ON organizations (domain)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_accounts (
      code          TEXT PRIMARY KEY,
      email_ct      BLOB NOT NULL,
      email_hash    TEXT NOT NULL,
      display_name  TEXT NOT NULL,
      org_code      TEXT NOT NULL REFERENCES organizations(code),
      scopes        TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'active',
      last_login_at TEXT,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      CHECK (status IN ('active','disabled'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS admin_accounts_email_active_uniq
      ON admin_accounts (email_hash) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS admin_accounts_org_idx    ON admin_accounts (org_code);
    CREATE INDEX IF NOT EXISTS admin_accounts_status_idx ON admin_accounts (status);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_login_tokens (
      code         TEXT PRIMARY KEY,
      account_code TEXT NOT NULL REFERENCES admin_accounts(code) ON DELETE CASCADE,
      token_hash   TEXT NOT NULL UNIQUE,
      expires_at   TEXT NOT NULL,
      used_at      TEXT,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS admin_login_tokens_account_idx
      ON admin_login_tokens (account_code, expires_at);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      code         TEXT PRIMARY KEY,
      account_code TEXT NOT NULL REFERENCES admin_accounts(code) ON DELETE CASCADE,
      token_hash   TEXT NOT NULL UNIQUE,
      expires_at   TEXT NOT NULL,
      revoked_at   TEXT,
      last_used_at TEXT,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS admin_sessions_account_idx
      ON admin_sessions (account_code, expires_at);
  `);
};
