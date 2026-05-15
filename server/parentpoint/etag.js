'use strict';

// Weak ETag computation for the ParentPoint contract. PP's PATCH requests
// MUST carry `If-Match: <etag>` (§7.2) so a stale cache cannot blindly
// overwrite FamilyGraph. We compute a deterministic hash over the JSON
// representation of the response body — different fields → different
// ETag, same fields in the same order → same ETag.
//
// Format: W/"<8-hex>" so HTTP intermediaries treat the value as a weak
// validator (no byte-for-byte equivalence guarantee).

const crypto = require('crypto');

// Stable stringifier — keys sorted, no whitespace — so equivalent objects
// always produce the same hash regardless of insertion order.
function stableStringify(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

function compute(value) {
  const s = stableStringify(value);
  const h = crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
  return `W/"${h}"`;
}

// Compare two ETag strings. Both forms (W/"abc" and "abc") match — we
// normalise by stripping the optional weak prefix and surrounding quotes.
function _normalize(tag) {
  if (!tag) return '';
  let t = String(tag).trim();
  if (t.startsWith('W/')) t = t.slice(2);
  if (t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
  return t;
}

function matches(provided, current) {
  if (!provided || !current) return false;
  if (provided === '*') return true;
  return _normalize(provided) === _normalize(current);
}

module.exports = { compute, matches, stableStringify };
