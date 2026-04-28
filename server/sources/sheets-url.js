'use strict';

// Google Sheets URL ingestion. The operator pastes a Sheets link; we convert
// it to the published-CSV export URL and fetch the body.
//
// SSRF posture:
//   - The accepted URL host must be EXACTLY `docs.google.com`. No `www.`,
//     no subdomain tricks, no IP literals. The pasted URL is *parsed* —
//     we do not blindly fetch it. We construct the export URL ourselves
//     from the parsed sheet ID + optional gid.
//   - Redirects from Google's export endpoint are followed up to 5 hops,
//     and every redirect target must end with `.google.com` or
//     `.googleusercontent.com`. Anything else aborts with an error.
//   - Body is capped at 10 MB. Larger responses are rejected.
//   - Total request timeout is 30 s.
//   - The response content-type must be a CSV variant. If Google's auth
//     wall returns HTML (private sheet → login page), we surface a clear
//     error rather than silently parsing HTML as CSV.
//
// The sheet must be share-set to "anyone with the link can view" for the
// export to succeed. Private sheets cannot be ingested through this path
// in v1; OAuth-backed access is a v2 evolution.

const https = require('https');
const { URL } = require('url');

const ALLOWED_HOST = 'docs.google.com';
const ALLOWED_REDIRECT_SUFFIXES = ['.google.com', '.googleusercontent.com'];
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

function _hostAllowedForRedirect(host) {
  if (!host) return false;
  // Reject IP literals defensively.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  if (host.includes(':') && !host.includes(']')) return false; // IPv6 raw
  const h = host.toLowerCase();
  if (h === ALLOWED_HOST) return true;
  return ALLOWED_REDIRECT_SUFFIXES.some(suffix => h === suffix.slice(1) || h.endsWith(suffix));
}

// Parse a Google Sheets URL into { id, gid, exportUrl }. Throws on anything
// that isn't a docs.google.com sheet URL.
function parseSheetUrl(input) {
  let u;
  try { u = new URL(String(input || '').trim()); }
  catch (_) { throw new Error('not a valid URL'); }
  if (u.protocol !== 'https:') throw new Error('only https URLs are accepted');
  if (u.hostname.toLowerCase() !== ALLOWED_HOST) {
    throw new Error(`only ${ALLOWED_HOST} URLs are accepted`);
  }
  // Path patterns we accept:
  //   /spreadsheets/d/<id>/edit
  //   /spreadsheets/d/<id>/export
  //   /spreadsheets/d/<id>/htmlview
  //   /spreadsheets/d/<id>/   (trailing slash)
  //   /spreadsheets/d/<id>    (no trailing path)
  const m = /^\/spreadsheets\/d\/([a-zA-Z0-9_-]+)(?:\/[a-zA-Z0-9_]*)?\/?$/.exec(u.pathname);
  if (!m) throw new Error('URL must point to a Google Sheets spreadsheet');
  const id = m[1];

  // gid can live in the search params or in the fragment (`#gid=…`).
  let gid = u.searchParams.get('gid');
  if (!gid && u.hash) {
    const fm = /(?:^|[#&])gid=(\d+)/.exec(u.hash);
    if (fm) gid = fm[1];
  }
  // `format` param: if present and != 'csv', error.
  const fmt = u.searchParams.get('format');
  if (fmt && fmt.toLowerCase() !== 'csv') {
    throw new Error(`only format=csv is supported (got '${fmt}')`);
  }

  const exportUrl = `https://${ALLOWED_HOST}/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ''}`;
  return { id, gid: gid || null, exportUrl };
}

function _isCsvContentType(ct) {
  if (!ct) return false;
  const lower = ct.toLowerCase();
  return lower.startsWith('text/csv')
      || lower.startsWith('application/csv')
      || lower.startsWith('text/comma-separated-values');
}

// Internal: a single HTTP GET with timeout + body cap. Returns the response
// (with `body` already buffered if 2xx, or null body and the redirect target
// if 3xx). Caller handles the redirect chain.
function _getOnce(target, { httpsAgent } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(target);
    if (u.protocol !== 'https:') return reject(new Error(`refusing non-https redirect to ${target}`));
    if (!_hostAllowedForRedirect(u.hostname)) {
      return reject(new Error(`refusing redirect to disallowed host ${u.hostname}`));
    }
    const req = https.request({
      method: 'GET',
      host: u.hostname,
      path: u.pathname + (u.search || ''),
      headers: { accept: 'text/csv,*/*;q=0.1', 'user-agent': 'family-graph/1.0' },
      timeout: TIMEOUT_MS,
      agent: httpsAgent || undefined,
    }, res => {
      const status = res.statusCode || 0;
      const headers = res.headers || {};
      // Redirect handling: don't read body; just return the location.
      if (status >= 300 && status < 400 && headers.location) {
        res.resume();
        const next = new URL(headers.location, target).toString();
        resolve({ status, headers, redirect: next, body: null });
        return;
      }
      let bytes = 0;
      const chunks = [];
      res.on('data', c => {
        bytes += c.length;
        if (bytes > MAX_BODY_BYTES) {
          res.destroy(new Error(`response exceeds ${MAX_BODY_BYTES} bytes`));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        resolve({ status, headers, redirect: null, body: Buffer.concat(chunks) });
      });
      res.on('error', e => reject(e));
    });
    req.on('timeout', () => { req.destroy(new Error(`request timed out after ${TIMEOUT_MS}ms`)); });
    req.on('error', e => reject(e));
    req.end();
  });
}

// Public: fetch a Google Sheets CSV export. Returns
//   { content: string, contentType: string, finalUrl: string, byteLen: number }
// Throws on any auth/redirect/format violation.
async function fetchSheetCsv(input, opts = {}) {
  const { exportUrl } = parseSheetUrl(input);
  let target = exportUrl;
  let hops = 0;
  while (true) {
    const r = await _getOnce(target, opts);
    if (r.redirect) {
      hops += 1;
      if (hops > MAX_REDIRECTS) throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
      target = r.redirect;
      continue;
    }
    if (r.status === 401 || r.status === 403) {
      throw new Error('sheet is not publicly readable. Set sharing to "Anyone with the link" or use OAuth (v2).');
    }
    if (r.status === 404) {
      throw new Error('sheet not found (check the URL or share access)');
    }
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`unexpected HTTP status ${r.status}`);
    }
    const ct = String(r.headers['content-type'] || '');
    if (!_isCsvContentType(ct)) {
      // The most common cause: the sheet isn't shared and Google returned
      // an HTML login page. Surface a clear, actionable message.
      throw new Error(`sheet did not return CSV (content-type: ${ct || 'unknown'}). Make sure the sheet is shared as "Anyone with the link can view".`);
    }
    return {
      content: r.body.toString('utf8'),
      contentType: ct,
      finalUrl: target,
      byteLen: r.body.length,
    };
  }
}

module.exports = {
  parseSheetUrl,
  fetchSheetCsv,
  // Exposed for tests:
  _hostAllowedForRedirect,
  _getOnce,
  ALLOWED_HOST,
  ALLOWED_REDIRECT_SUFFIXES,
  MAX_REDIRECTS,
  MAX_BODY_BYTES,
};
