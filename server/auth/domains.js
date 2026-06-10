'use strict';

// Organization web-domain verification (STAFF_ACCOUNTS_PRD.md).
//
// Staff accounts are only as trustworthy as the email domain behind
// them, so before any invite the organization must PROVE it controls
// its web domain. The operator sets the domain, FamilyGraph issues a
// random token, and the parish/school publishes it either as a DNS TXT
// record (`familygraph-verify=<token>`) or a well-known file
// (`https://<domain>/.well-known/familygraph-verify.txt`). Changing
// the domain always voids prior verification — re-prove or no invites.
// The token never appears in logs; only org code, method, and outcome.

const crypto = require('crypto');
const { isValidCode } = require('../crypto/identifiers');
const history = require('../identity/history');
const log = require('../log');

// Conservative hostname shape: dot-separated labels of [a-z0-9-] that
// neither start nor end with a hyphen, at least two labels deep.
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const HTTP_TIMEOUT_MS = 10 * 1000;

function _instructions(domain, token) {
  return {
    dns: `Create a TXT record on ${domain} with value: familygraph-verify=${token}`,
    http: `Serve https://${domain}/.well-known/familygraph-verify.txt containing: ${token}`,
  };
}

// Set (or clear, with a null/empty domain) the organization's web
// domain. Setting always mints a fresh verification token and NULLs
// out any previous verification — control must be re-proven.
function setDomain(db, orgCode, domain, audit = {}) {
  if (!isValidCode(orgCode, 'organization')) return null;
  const existing = db.prepare(`SELECT * FROM organizations WHERE code = ?`).get(orgCode);
  if (!existing) return null;

  const normalized = domain == null ? '' : String(domain).trim().toLowerCase();
  if (!normalized) {
    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE organizations
            SET domain = NULL, domain_verification_token = NULL,
                domain_verified_at = NULL, domain_verification_method = NULL,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE code = ?`
      ).run(orgCode);
      const after = db.prepare(`SELECT * FROM organizations WHERE code = ?`).get(orgCode);
      history.record(db, {
        entityKind: 'organization', entityCode: orgCode, operation: 'update',
        before: existing, after,
        actor: audit.actor || 'system', actorKind: audit.actorKind, requestId: audit.requestId,
      });
    });
    tx();
    return { code: orgCode, domain: null, verification_token: null, instructions: null };
  }

  if (!DOMAIN_RE.test(normalized)) throw new Error('invalid domain');

  const token = crypto.randomBytes(16).toString('hex');
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE organizations
          SET domain = ?, domain_verification_token = ?,
              domain_verified_at = NULL, domain_verification_method = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE code = ?`
    ).run(normalized, token, orgCode);
    const after = db.prepare(`SELECT * FROM organizations WHERE code = ?`).get(orgCode);
    history.record(db, {
      entityKind: 'organization', entityCode: orgCode, operation: 'update',
      before: existing, after,
      actor: audit.actor || 'system', actorKind: audit.actorKind, requestId: audit.requestId,
    });
  });
  tx();
  return {
    code: orgCode,
    domain: normalized,
    verification_token: token,
    instructions: _instructions(normalized, token),
  };
}

async function _defaultFetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`http_status_${res.status}`);
  return await res.text();
}

// Check the published proof for the org's domain. `resolveTxt` and
// `fetchText` are injectable so tests never hit the network. Lookup
// failures and mismatches both come back as { verified: false } — the
// caller decides what to tell the operator; nothing throws for a
// network problem, and the token value never reaches the logs.
async function verifyDomain(db, orgCode, { method, resolveTxt, fetchText } = {}, audit = {}) {
  if (method !== 'dns' && method !== 'http') {
    throw new Error(`verification method must be 'dns' or 'http'`);
  }
  if (!isValidCode(orgCode, 'organization')) return null;
  const org = db.prepare(`SELECT * FROM organizations WHERE code = ?`).get(orgCode);
  if (!org) return null;
  if (!org.domain || !org.domain_verification_token) throw new Error('no domain set');

  const token = org.domain_verification_token;
  let matched = false;
  let reason = null;
  try {
    if (method === 'dns') {
      const lookup = resolveTxt || require('node:dns').promises.resolveTxt;
      const records = await lookup(org.domain);
      const expected = `familygraph-verify=${token}`;
      matched = (records || []).some(parts => Array.isArray(parts) && parts.join('') === expected);
    } else {
      const get = fetchText || _defaultFetchText;
      const body = await get(`https://${org.domain}/.well-known/familygraph-verify.txt`);
      matched = String(body).trim() === token;
    }
    if (!matched) reason = 'token_not_found';
  } catch (e) {
    // Lookup errors are an unverified outcome, not a crash. Log the
    // error class only — never the token, never a response body.
    matched = false;
    reason = (e && (e.code || e.name)) || 'lookup_error';
  }

  if (!matched) {
    log.warn('domain.verify_attempt', { org_code: orgCode, method, outcome: 'failed', reason });
    return { verified: false, domain: org.domain, method, reason };
  }

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE organizations
          SET domain_verified_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              domain_verification_method = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE code = ?`
    ).run(method, orgCode);
    const after = db.prepare(`SELECT * FROM organizations WHERE code = ?`).get(orgCode);
    history.record(db, {
      entityKind: 'organization', entityCode: orgCode, operation: 'update',
      before: org, after,
      actor: audit.actor || 'system', actorKind: audit.actorKind, requestId: audit.requestId,
    });
  });
  tx();
  log.info('domain.verify_attempt', { org_code: orgCode, method, outcome: 'verified' });
  return { verified: true, domain: org.domain, method };
}

module.exports = { setDomain, verifyDomain };
