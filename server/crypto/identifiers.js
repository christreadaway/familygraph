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

module.exports = {
  PREFIXES,
  newCode,
  kindOf,
  isValidCode,
};
