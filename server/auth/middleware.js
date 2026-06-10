'use strict';

const crypto = require('crypto');
const apiKeys = require('./api-keys');
const accounts = require('./accounts');
const log = require('../log');

// Compact fingerprint we can log to identify a token without revealing it.
// First 8 chars of sha256(token). Even if the log file leaks, you cannot
// reverse this back to the token, but you can see "this same fingerprint
// appeared at line A and line B".
function tokenFingerprint(t) {
  if (!t) return null;
  return crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 8);
}

// Loopback addresses we accept. IPv6 mapping of IPv4 must be normalized.
const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function clientIp(req) {
  // Express's req.ip respects trust-proxy. We never trust proxy headers.
  return (req.socket && (req.socket.remoteAddress || '')) || '';
}

function isLoopback(req) {
  const ip = clientIp(req);
  if (!ip) return false;
  return LOOPBACK_ADDRS.has(ip);
}

// Constant-time bearer-token comparison.
function tokensEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function extractBearer(req) {
  const auth = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : null;
}

// bearerAuth(secrets, { db, scope })
//   Accepts either:
//     - the shared master token (full access)
//     - a per-app scoped key (sk_…) provisioned in api_keys
//   When `scope` is provided, scoped keys must include the required scope or
//   '*'. Master always passes.
function bearerAuth(secrets, opts = {}) {
  const required = opts.scope || null;
  const db = opts.db || null;
  return function bearerAuthMw(req, res, next) {
    const token = extractBearer(req);
    const ctx = { path: req.path, method: req.method, scope: required };
    if (!token) {
      log.warn('auth.reject', { ...ctx, reason: 'no_bearer' });
      return res.status(401).json({
        error: 'unauthorized',
        detail: 'PII surface requires Bearer token',
        reason: 'no_bearer',
      });
    }
    if (tokensEqual(token, secrets.master)) {
      req.auth = {
        kind: 'master',
        scopes: ['*'],
        actor: req.get('x-family-graph-actor') || 'master_app',
      };
      log.debug('auth.ok', { ...ctx, kind: 'master', actor: req.auth.actor });
      return next();
    }
    if (db && token.startsWith('sk_')) {
      const key = apiKeys.lookupByToken(db, token);
      if (key) {
        if (required && !apiKeys.authorizes(key.scopes, required)) {
          log.warn('auth.reject', {
            ...ctx,
            reason: 'missing_scope',
            actor: key.name,
            key_code: key.code,
            scopes: key.scopes,
          });
          return res
            .status(403)
            .json({
              error: 'forbidden',
              detail: `missing scope: ${Array.isArray(required) ? required.join(',') : required}`,
              reason: 'missing_scope',
            });
        }
        apiKeys.recordUse(db, key.code);
        req.auth = {
          kind: 'scoped',
          scopes: key.scopes,
          actor: key.name,
          key_code: key.code,
        };
        log.debug('auth.ok', { ...ctx, kind: 'scoped', actor: key.name, key_code: key.code });
        return next();
      }
      // sk_-prefixed but unknown to the api_keys table: revoked or never issued.
      log.warn('auth.reject', {
        ...ctx,
        reason: 'unknown_or_revoked_scoped_token',
        token_fp: tokenFingerprint(token),
      });
      return res.status(401).json({
        error: 'unauthorized',
        detail: 'invalid or revoked token',
        reason: 'unknown_or_revoked_scoped_token',
      });
    }
    // Staff session tokens (st_…) resolve through admin_sessions exactly
    // where sk_ keys resolve through api_keys. The actor is the named
    // staff member, so audit rows attribute changes to a person.
    if (db && token.startsWith('st_')) {
      const sess = accounts.lookupSession(db, token);
      if (sess) {
        if (required && !apiKeys.authorizes(sess.scopes, required)) {
          log.warn('auth.reject', {
            ...ctx,
            reason: 'missing_scope',
            actor: sess.display_name,
            account_code: sess.account_code,
            scopes: sess.scopes,
          });
          return res.status(403).json({
            error: 'forbidden',
            detail: `missing scope: ${Array.isArray(required) ? required.join(',') : required}`,
            reason: 'missing_scope',
          });
        }
        req.auth = {
          kind: 'staff',
          scopes: sess.scopes,
          actor: sess.display_name,
          account_code: sess.account_code,
          session_code: sess.session_code,
          org_code: sess.org_code,
        };
        log.debug('auth.ok', { ...ctx, kind: 'staff', actor: sess.display_name, account_code: sess.account_code });
        return next();
      }
      log.warn('auth.reject', {
        ...ctx,
        reason: 'unknown_or_expired_session',
        token_fp: tokenFingerprint(token),
      });
      return res.status(401).json({
        error: 'unauthorized',
        detail: 'invalid or expired session',
        reason: 'unknown_or_expired_session',
      });
    }
    // Some other bearer string that didn't match the master token.
    log.warn('auth.reject', {
      ...ctx,
      reason: 'token_mismatch',
      token_fp: tokenFingerprint(token),
      token_len: token.length,
    });
    return res.status(401).json({
      error: 'unauthorized',
      detail: 'invalid or revoked token',
      reason: 'token_mismatch',
    });
  };
}

function loopbackOnly() {
  return function loopbackOnlyMw(req, res, next) {
    if (!isLoopback(req)) {
      log.warn('auth.reject', {
        path: req.path,
        method: req.method,
        reason: 'non_loopback_origin',
        ip: req.socket && req.socket.remoteAddress,
      });
      return res
        .status(403)
        .json({
          error: 'forbidden',
          detail: 'safe surface is loopback-only',
          reason: 'non_loopback_origin',
        });
    }
    req.auth = req.auth || { kind: 'loopback', actor: req.get('x-family-graph-actor') || 'local' };
    next();
  };
}

module.exports = {
  bearerAuth,
  loopbackOnly,
  isLoopback,
  tokensEqual,
  tokenFingerprint,
};
