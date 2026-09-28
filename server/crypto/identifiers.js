'use strict';

const crypto = require('crypto');

const PREFIXES = {
  family: 'f_',
  person: 'p_',
  email: 'e_',
  phone: 'ph_',
  address: 'addr_',
  relationship: 'r_',
  membership: 'm_',
  source: 'src_',
  conflict: 'conf_',
  token_set: 'tk_',
  audit: 'au_',
  rule: 'rule_',
  profile: 'prof_',
  ministry: 'min_',
  ministry_assignment: 'ma_',
  diocese: 'dio_',
  entity_change: 'chg_',
  organization: 'org_',
  affiliation: 'aff_',
  affiliation_verification: 'av_',
  admin_account: 'acct_',
  admin_login_token: 'mlt_',
  admin_session: 'asn_',
};

const PREFIX_TO_KIND = Object.fromEntries(
  Object.entries(PREFIXES).map(([k, v]) => [v, k])
);

function newCode(kind) {
  const prefix = PREFIXES[kind];
  if (!prefix) throw new Error(`Unknown identifier kind: ${kind}`);
  // 8 random bytes = 16 hex chars = 64 bits. Collision odds stay negligible
  // even at diocese scale (50% birthday bound is ~5 billion codes per kind).
  // Codes minted before this change carry 8 hex chars and remain valid.
  return prefix + crypto.randomBytes(8).toString('hex');
}

function kindOf(code) {
  if (typeof code !== 'string' || !code) return null;
  // Order matters: 'addr_' must be tested before 'a_'-style prefixes; using
  // longest-prefix-first sort.
  const sorted = Object.keys(PREFIX_TO_KIND).sort((a, b) => b.length - a.length);
  for (const p of sorted) {
    if (code.startsWith(p)) return PREFIX_TO_KIND[p];
  }
  return null;
}

// Kinds that existed before the suffix widening (8 → 16 hex) and may
// therefore have legacy 8-hex codes in real databases. Kinds minted
// after the widening have only ever been 16 hex; accepting 8 for them
// would turn an operator's truncated paste into a confusing 404
// instead of the 400 the validation exists to give.
const LEGACY_8HEX_KINDS = new Set([
  'family', 'person', 'email', 'phone', 'address', 'relationship',
  'membership', 'source', 'conflict', 'token_set', 'audit', 'rule',
  'profile', 'ministry', 'ministry_assignment', 'diocese', 'entity_change',
]);

function isValidCode(code, kind = null) {
  if (typeof code !== 'string') return false;
  const k = kindOf(code);
  if (!k) return false;
  if (kind && k !== kind) return false;
  const suffix = code.slice(PREFIXES[k].length);
  if (/^[0-9a-f]{16}$/.test(suffix)) return true;
  return LEGACY_8HEX_KINDS.has(k) && /^[0-9a-f]{8}$/.test(suffix);
}

// ---------------------------------------------------------------------------
// Community identifiers (owner decision 2026-09-28).
//
// Every person and every family gets ONE identifier for life, shared by every
// product that touches the community (Doc Anonymizer, the partner apps, this
// registry). Family Graph is the only minter. The community id is not a
// second code: it is the existing person/family code rendered for humans and
// spreadsheets.
//
//   p_3a4f9c2b1d0e7f21  <->  I3A4F9C2B1D0E7F21   (individual)
//   f_9b0c11d2e3f4a5b6  <->  F9B0C11D2E3F4A5B6   (family)
//
// The mapping is lossless in both directions, so nothing that already stores
// p_/f_ codes has to migrate, and a merge keeps working through the alias
// table exactly as it does for the underlying code. The leading letter keeps
// Excel from ever reading the id as a number. Input is case-insensitive;
// output is always uppercase.
// ---------------------------------------------------------------------------

const COMMUNITY_PREFIX = { person: 'I', family: 'F' };
const COMMUNITY_KIND = { I: 'person', F: 'family' };
const COMMUNITY_ID_RE = /^([FI])([0-9A-F]{16}|[0-9A-F]{8})$/i;

function toCommunityId(code) {
  if (!isValidCode(code)) return null;
  const kind = kindOf(code);
  const letter = COMMUNITY_PREFIX[kind];
  if (!letter) return null;
  return letter + code.slice(PREFIXES[kind].length).toUpperCase();
}

function fromCommunityId(id) {
  if (typeof id !== 'string') return null;
  const m = COMMUNITY_ID_RE.exec(id.trim());
  if (!m) return null;
  const kind = COMMUNITY_KIND[m[1].toUpperCase()];
  return PREFIXES[kind] + m[2].toLowerCase();
}

function isCommunityId(id, kind = null) {
  const code = fromCommunityId(id);
  if (!code) return false;
  return !kind || kindOf(code) === kind;
}

// Accept either form wherever a caller hands us a person/family reference.
function toCode(ref) {
  if (typeof ref !== 'string') return null;
  if (isValidCode(ref)) return ref;
  return fromCommunityId(ref);
}

module.exports = {
  PREFIXES,
  newCode,
  kindOf,
  isValidCode,
  COMMUNITY_ID_RE,
  toCommunityId,
  fromCommunityId,
  isCommunityId,
  toCode,
};
