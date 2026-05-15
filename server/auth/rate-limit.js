'use strict';

// In-memory token-bucket rate limiter scoped per bearer-token or per IP.
//
// We want the integration surface to feel friendly — sibling apps can be
// chatty during a reconcile sweep, and the operator dashboard fires
// off bursts of GETs while the user clicks around. Limits are generous
// by default; the operator can tune them via settings or env vars when a
// specific consumer misbehaves.
//
// Why not express-rate-limit? Two reasons. (1) Our bucket key is the
// bearer-token fingerprint when one is present, falling back to the IP —
// that's a one-line change in this module but a configuration headache
// with the off-the-shelf lib. (2) The express-rate-limit package adds a
// transitive dep tree we'd rather avoid in a single-binary install.
//
// Disable globally with FAMILY_GRAPH_DISABLE_RATE_LIMIT=1. Disable
// per-test by setting the same env var before booting the app.

const crypto = require('crypto');

function _now() { return Date.now(); }

function _fingerprintFor(req) {
  const auth = req.get && req.get('authorization');
  if (auth) {
    // Hash so we don't keep the token in memory longer than necessary.
    return 'tok:' + crypto.createHash('sha256').update(auth).digest('hex').slice(0, 16);
  }
  const ip = (req.ip || (req.socket && req.socket.remoteAddress) || 'unknown').toString();
  return 'ip:' + ip;
}

// Build a token-bucket middleware. Each key gets `capacity` tokens that
// refill at `refillPerSec`. Each request consumes one token; if the
// bucket is empty the response is 429 with Retry-After.
function build({ capacity, refillPerSec, name = 'default', disabled = false } = {}) {
  if (disabled || process.env.FAMILY_GRAPH_DISABLE_RATE_LIMIT === '1') {
    return function disabledRateLimit(_req, _res, next) { next(); };
  }
  if (!capacity || !refillPerSec) {
    throw new Error('rate-limit: capacity and refillPerSec required');
  }
  const buckets = new Map();
  // Periodic GC so a long-running process doesn't accumulate stale
  // entries for one-off callers. Entries idle longer than 10× the
  // bucket refill time are dropped.
  const idleMs = Math.max(60_000, (capacity / refillPerSec) * 10_000);
  const gc = setInterval(() => {
    const cutoff = _now() - idleMs;
    for (const [k, v] of buckets) {
      if (v.lastSeen < cutoff) buckets.delete(k);
    }
  }, 60_000);
  if (typeof gc.unref === 'function') gc.unref();

  return function rateLimitMw(req, res, next) {
    const key = _fingerprintFor(req);
    const now = _now();
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: capacity, lastRefillMs: now, lastSeen: now };
      buckets.set(key, b);
    } else {
      const elapsed = (now - b.lastRefillMs) / 1000;
      b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerSec);
      b.lastRefillMs = now;
      b.lastSeen = now;
    }
    if (b.tokens < 1) {
      const retryAfter = Math.ceil((1 - b.tokens) / refillPerSec);
      res.set('Retry-After', String(retryAfter));
      res.set('X-RateLimit-Bucket', name);
      return res.status(429).json({
        error: 'rate_limited',
        detail: `bucket "${name}" exhausted; retry after ${retryAfter}s`,
      });
    }
    b.tokens -= 1;
    res.set('X-RateLimit-Bucket', name);
    res.set('X-RateLimit-Remaining', String(Math.floor(b.tokens)));
    next();
  };
}

module.exports = { build, _fingerprintFor };
