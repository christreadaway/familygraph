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
};

const PREFIX_TO_KIND = Object.fromEntries(
  Object.entries(PREFIXES).map(([k, v]) => [v, k])
);

function newCode(kind) {
  const prefix = PREFIXES[kind];
  if (!prefix) throw new Error(`Unknown identifier kind: ${kind}`);
  return prefix + crypto.randomBytes(4).toString('hex');
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

function isValidCode(code, kind = null) {
  if (typeof code !== 'string') return false;
  const k = kindOf(code);
  if (!k) return false;
  if (kind && k !== kind) return false;
  // Hex suffix length is fixed at 8 chars after the prefix.
  const suffix = code.slice(PREFIXES[k].length);
  return /^[0-9a-f]{8}$/.test(suffix);
}

module.exports = {
  PREFIXES,
  newCode,
  kindOf,
  isValidCode,
};
