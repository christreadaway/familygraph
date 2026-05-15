'use strict';

// OAuth 2.0 client_credentials helper for connectors. Cache tokens per
// (connector, token_url) tuple in memory, with a 60s safety window before
// the published expiry. On 401 from a downstream call, drop the cached
// token and let the caller retry once — the caller decides when to give up.
//
// Why we own this: the published Node ecosystem packages either pull in 30+
// dependencies (`simple-oauth2`) or assume a browser-shaped fetch shim. We
// only need ~50 lines for what we do, and structured logging of every HTTP
// hop is part of the operator-debugging contract anyway.

const log = require('../log');

// Token cache key isolates by both connector name and token endpoint, so
// rotating credentials or repointing the access_token_url doesn't leak a
// stale token.
const _tokenCache = new Map();

function _cacheKey(connector, tokenUrl, clientId) {
  return `${connector}|${tokenUrl}|${clientId || ''}`;
}

function _now() { return Date.now(); }

function clearTokenCache(connector = null) {
  if (!connector) { _tokenCache.clear(); return; }
  for (const k of [..._tokenCache.keys()]) {
    if (k.startsWith(`${connector}|`)) _tokenCache.delete(k);
  }
}

// Helper: redact-friendly logging. Never include secrets in fields.
function _logHttp(connector, method, url, status, durationMs) {
  let path = url;
  try { path = new URL(url).pathname; } catch (_) { /* keep as-is */ }
  log.debug('connector.http.request', {
    connector,
    method,
    path,
    status,
    duration_ms: durationMs,
  });
}

// fetchToken: POST client_credentials to the token endpoint. Returns
// { access_token, expires_at_ms } on success. Throws on network or
// auth failure. Errors include a `reason` string from the existing
// vocabulary so the operator can paste a log line and we can tell
// `auth_failed` apart from `network_error`.
// Outbound fetches must time out — a vendor whose token endpoint hangs
// shouldn't trap a worker in an indefinite await. 30s is generous (some
// FACTS endpoints take 20+ seconds under load); shorter is safer if you
// know your vendor.
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

// Validate an outbound URL before any fetch fires.
//   - https:// only — credentials over http are unacceptable even on a LAN
//   - hostname must not resolve obviously private (loopback / RFC1918 /
//     link-local / metadata endpoint). The check is by literal IP form
//     in the URL; a hostname pointing at a private IP slips through but
//     getting that wrong is the operator's misconfiguration, not an
//     external attacker.
function _assertOutboundUrlSafe(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch (_) {
    throw _httpError('bad_url', 'invalid URL');
  }
  if (u.protocol !== 'https:') {
    throw _httpError('bad_url', `outbound URL must be https://; got ${u.protocol}`);
  }
  const host = u.hostname.toLowerCase();
  const private_ish = [
    h => h === 'localhost' || h === '0.0.0.0',
    h => /^127\./.test(h),
    h => h === '::1' || h === '[::1]',
    h => /^169\.254\./.test(h),
    h => /^fe80:/i.test(h),
    h => /^10\./.test(h),
    h => /^192\.168\./.test(h),
    h => /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h),
  ];
  if (private_ish.some(f => f(host))) {
    throw _httpError('bad_url', `outbound URL targets a private / loopback host: ${host}`);
  }
}

async function fetchToken({ connector, tokenUrl, clientId, clientSecret, scope = null, fetchImpl = null }) {
  const _fetch = fetchImpl || globalThis.fetch;
  if (!_fetch) throw _httpError('fetch_unavailable', 'no fetch implementation');
  _assertOutboundUrlSafe(tokenUrl);
  const body = new URLSearchParams();
  body.set('grant_type', 'client_credentials');
  body.set('client_id', clientId);
  body.set('client_secret', clientSecret);
  if (scope) body.set('scope', scope);

  const start = _now();
  let resp;
  try {
    resp = await _fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    const dur = _now() - start;
    log.error('connector.http.auth_failed', { connector, reason: 'network_error', message: String(e.message || e), duration_ms: dur });
    // The vendor's error text might echo back the request body (and
    // therefore the client_secret). We discard it; the operator sees a
    // structured reason instead.
    throw _httpError('network_error', 'token endpoint unreachable or timed out');
  }
  const dur = _now() - start;
  _logHttp(connector, 'POST', tokenUrl, resp.status, dur);
  let payload = null;
  try { payload = await resp.json(); } catch (_) { /* leave null */ }
  if (!resp.ok) {
    let reason;
    if (resp.status === 429) reason = 'rate_limited';
    else if (resp.status === 401 || resp.status === 403) reason = 'auth_failed';
    else reason = 'token_endpoint_error';
    log.error('connector.http.auth_failed', { connector, reason, status: resp.status });
    throw _httpError(reason, `token endpoint ${resp.status}: ${(payload && payload.error) || resp.statusText}`);
  }
  if (!payload || !payload.access_token) {
    throw _httpError('token_endpoint_error', 'token endpoint returned no access_token');
  }
  const expiresIn = Number(payload.expires_in) || 3600;
  log.debug('connector.http.auth_refreshed', { connector, expires_in: expiresIn });
  return {
    access_token: String(payload.access_token),
    token_type: payload.token_type || 'Bearer',
    expires_at_ms: _now() + Math.max(0, (expiresIn - 60)) * 1000,
  };
}

// getAccessToken: returns a cached token if it's still fresh, otherwise
// fetches a new one. forceRefresh skips the cache (used after a 401).
async function getAccessToken({ connector, tokenUrl, clientId, clientSecret, scope = null, forceRefresh = false, fetchImpl = null }) {
  const key = _cacheKey(connector, tokenUrl, clientId);
  if (!forceRefresh) {
    const cached = _tokenCache.get(key);
    if (cached && cached.expires_at_ms > _now()) return cached;
  }
  const tok = await fetchToken({ connector, tokenUrl, clientId, clientSecret, scope, fetchImpl });
  _tokenCache.set(key, tok);
  return tok;
}

// Parse a Retry-After header value. Per RFC 7231 it's either an integer
// number of seconds or an HTTP-date. We accept either; bad values fall
// back to a 60-second pause per PRD §5.9.1.
function _parseRetryAfter(headerValue) {
  if (!headerValue) return 60;
  const n = Number(headerValue);
  if (Number.isFinite(n) && n >= 0) return Math.min(Math.floor(n), 600);
  const ts = Date.parse(String(headerValue));
  if (!Number.isFinite(ts)) return 60;
  const seconds = Math.ceil((ts - Date.now()) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return 60;
  return Math.min(seconds, 600);
}

// authedFetch: GET (or any verb) the given URL with a Bearer token.
//   - 401 → refresh the token once and retry the same request once.
//   - 429 → respect the Retry-After header (or 60s default), wait, retry
//     once. A second 429 in a row fails the call with reason
//     `rate_limited`. PRD §5.9.1.
//   - 4xx/5xx → throw with a structured reason.
// Returns the parsed JSON body on 2xx.
async function authedFetch({
  connector, url, method = 'GET', body = null,
  tokenUrl, clientId, clientSecret, scope = null,
  extraHeaders = {}, fetchImpl = null,
  // Test hook: replaces the real setTimeout-based wait so the
  // rate-limit retry path doesn't add real wall-clock seconds to
  // tests. Production uses sleep() unconditionally.
  _sleep = null,
}) {
  const _fetch = fetchImpl || globalThis.fetch;
  if (!_fetch) throw _httpError('fetch_unavailable', 'no fetch implementation');
  _assertOutboundUrlSafe(url);
  const _waitFor = _sleep || sleep;
  let tok = await getAccessToken({ connector, tokenUrl, clientId, clientSecret, scope, fetchImpl });

  let authRefreshed = false;
  let rateLimitRetried = false;
  // Cap the number of retry hops so a misbehaving server can't trap us
  // here. Worst case: 401 → refresh → 429 → wait → retry. 4 hops.
  for (let hop = 0; hop < 4; hop++) {
    const start = _now();
    let resp;
    try {
      const headers = {
        accept: 'application/json',
        authorization: `${tok.token_type || 'Bearer'} ${tok.access_token}`,
        ...extraHeaders,
      };
      if (body && !headers['content-type']) headers['content-type'] = 'application/json';
      resp = await _fetch(url, {
        method,
        headers,
        body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
        signal: AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      _logHttp(connector, method, url, 'ERR', _now() - start);
      // Generic wire message; the full detail (with URL, status) lives
      // in the structured log line above for operator debugging.
      throw _httpError('network_error', 'upstream unreachable or timed out');
    }
    const dur = _now() - start;
    _logHttp(connector, method, url, resp.status, dur);

    if (resp.status === 401 && !authRefreshed) {
      authRefreshed = true;
      tok = await getAccessToken({ connector, tokenUrl, clientId, clientSecret, scope, forceRefresh: true, fetchImpl });
      continue;
    }
    if (resp.status === 401 || resp.status === 403) {
      throw _httpError('auth_failed', `${url} returned ${resp.status}`);
    }
    if (resp.status === 429) {
      if (rateLimitRetried) {
        // PRD §5.9.1: a second 429 in a row fails the entire sync with
        // reason rate_limited.
        log.error('connector.http.rate_limited', { connector, status: 429, retried: true });
        throw _httpError('rate_limited', `${url} returned 429 twice in a row`);
      }
      rateLimitRetried = true;
      const retryAfterSec = _parseRetryAfter(resp.headers && (resp.headers.get ? resp.headers.get('retry-after') : resp.headers['retry-after']));
      log.warn('connector.http.rate_limited', { connector, status: 429, retry_after_s: retryAfterSec });
      await _waitFor(retryAfterSec * 1000);
      continue;
    }
    if (!resp.ok) {
      // Discard the response body before throwing. Vendor error bodies
      // sometimes echo back the request (which contains PII) or the
      // bearer token in a `WWW-Authenticate`-style detail. The status
      // code + connector name is enough for operator triage; the
      // structured log line above already recorded the full status.
      try { await resp.text(); } catch (_) { /* drain */ }
      throw _httpError('http_error', `upstream returned ${resp.status}`);
    }
    let payload = null;
    try { payload = await resp.json(); }
    catch (e) { throw _httpError('parse_error', `parse failed: ${String(e.message || e)}`); }
    return payload;
  }
  throw _httpError('http_error', 'authedFetch exhausted retry budget');
}

function _httpError(reason, message) {
  const e = new Error(message || reason);
  e.reason = reason;
  return e;
}

// Politeness: respects PRD §5.9 — small delay between paginated requests so
// we don't hammer the vendor.
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  fetchToken,
  getAccessToken,
  authedFetch,
  clearTokenCache,
  sleep,
  _httpError,
};
