'use strict';

const crypto = require('crypto');

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

function bearerAuth(secrets) {
  return function bearerAuthMw(req, res, next) {
    const token = extractBearer(req);
    if (!token || !tokensEqual(token, secrets.master)) {
      return res
        .status(401)
        .json({ error: 'unauthorized', detail: 'PII surface requires Bearer token' });
    }
    req.auth = { kind: 'bearer', actor: req.get('x-sanctus-actor') || 'unknown_app' };
    next();
  };
}

function loopbackOnly() {
  return function loopbackOnlyMw(req, res, next) {
    if (!isLoopback(req)) {
      return res
        .status(403)
        .json({ error: 'forbidden', detail: 'safe surface is loopback-only' });
    }
    req.auth = req.auth || { kind: 'loopback', actor: req.get('x-sanctus-actor') || 'local' };
    next();
  };
}

module.exports = {
  bearerAuth,
  loopbackOnly,
  isLoopback,
  tokensEqual,
};
