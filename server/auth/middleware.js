'use strict';

const crypto = require('crypto');
const apiKeys = require('./api-keys');

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
    if (!token) {
      return res.status(401).json({ error: 'unauthorized', detail: 'PII surface requires Bearer token' });
    }
    if (tokensEqual(token, secrets.master)) {
      req.auth = {
        kind: 'master',
        scopes: ['*'],
        actor: req.get('x-custos-actor') || 'master_app',
      };
      return next();
    }
    if (db && token.startsWith('sk_')) {
      const key = apiKeys.lookupByToken(db, token);
      if (key) {
        if (required && !apiKeys.authorizes(key.scopes, required)) {
          return res
            .status(403)
            .json({ error: 'forbidden', detail: `missing scope: ${Array.isArray(required) ? required.join(',') : required}` });
        }
        apiKeys.recordUse(db, key.code);
        req.auth = {
          kind: 'scoped',
          scopes: key.scopes,
          actor: key.name,
          key_code: key.code,
        };
        return next();
      }
    }
    return res
      .status(401)
      .json({ error: 'unauthorized', detail: 'invalid or revoked token' });
  };
}

function loopbackOnly() {
  return function loopbackOnlyMw(req, res, next) {
    if (!isLoopback(req)) {
      return res
        .status(403)
        .json({ error: 'forbidden', detail: 'safe surface is loopback-only' });
    }
    req.auth = req.auth || { kind: 'loopback', actor: req.get('x-custos-actor') || 'local' };
    next();
  };
}

module.exports = {
  bearerAuth,
  loopbackOnly,
  isLoopback,
  tokensEqual,
};
