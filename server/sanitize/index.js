'use strict';

const enc = require('../crypto/encryption');
const { newCode } = require('../crypto/identifiers');
const ner = require('./ner');
const people = require('../identity/people');
const contacts = require('../identity/contacts');
const audit = require('../audit');

// Sanitize an arbitrary text payload. Returns the sanitized string plus a
// token-set code that can be used later to desanitize. The mapping is stored
// encrypted so that even an attacker with the database cannot reverse pseudonyms
// without the data key.
function sanitizeText(db, secrets, text, opts = {}) {
  const findings = ner.detect(db, secrets, text);
  const mappings = {};
  let out = '';
  let cursor = 0;
  for (const f of findings) {
    out += text.slice(cursor, f.start);
    let token;
    if (f.kind === 'known_name' && f.person_codes && f.person_codes.length > 0) {
      // Use the existing person code as the pseudonym.
      const code = f.person_codes[0];
      token = code;
      mappings[token] = { kind: 'person', code, original: f.value };
    } else if (f.kind === 'email') {
      const code = contacts.upsertEmail(db, secrets, f.value);
      token = code || `e_unknown_${newCode('email').slice(2)}`;
      mappings[token] = { kind: 'email', code, original: f.value };
    } else if (f.kind === 'phone') {
      const code = contacts.upsertPhone(db, secrets, f.value);
      token = code || `ph_unknown_${newCode('phone').slice(3)}`;
      mappings[token] = { kind: 'phone', code, original: f.value };
    } else if (f.kind === 'address') {
      // We don't try to parse lines without structure; just tokenize as a blob.
      const code = newCode('address');
      token = code;
      mappings[token] = { kind: 'address_unknown', original: f.value };
    } else if (f.kind === 'name_candidate') {
      // Unseen name. Generate an opaque pseudonym; do not write to the registry.
      const code = newCode('person');
      token = code;
      mappings[token] = { kind: 'unseen_name', original: f.value };
    } else if (f.kind === 'ssn' || f.kind === 'dob') {
      token = `[${f.kind}]`;
      mappings[token + ':' + f.start] = { kind: f.kind, original: f.value };
    } else {
      // Pass-through; should not occur given the detector output.
      out += f.value;
      cursor = f.end;
      continue;
    }
    out += token;
    cursor = f.end;
  }
  out += text.slice(cursor);

  const tokenSetCode = newCode('token_set');
  db.prepare(
    `INSERT INTO token_sets (code, caller, mappings_ct) VALUES (?, ?, ?)`
  ).run(tokenSetCode, opts.actor || 'unknown', enc.encrypt(secrets, JSON.stringify(mappings)));

  audit.record(db, {
    action: 'sanitize',
    actor: opts.actor || 'unknown',
    metadata: { tokenSet: tokenSetCode, count: Object.keys(mappings).length },
  });

  return { sanitized: out, tokenSet: tokenSetCode, mappings };
}

function desanitizeText(db, secrets, text, tokenSetCode, opts = {}) {
  const row = db.prepare('SELECT * FROM token_sets WHERE code = ?').get(tokenSetCode);
  if (!row) throw new Error('unknown token set');
  const mappings = JSON.parse(enc.decrypt(secrets, row.mappings_ct));
  // Replace each token occurrence with its original value. Iterate over keys
  // sorted by length descending so f_a7b3c91d is processed before its prefix
  // f_a7b3.
  const keys = Object.keys(mappings).sort((a, b) => b.length - a.length);
  let out = text;
  for (const k of keys) {
    if (mappings[k] && mappings[k].original !== undefined) {
      // For SSN/DOB tokens we used "[ssn]:start" as the key; the visible token
      // is "[ssn]", which we must not blindly substitute everywhere. Only the
      // first occurrence is replaced.
      if (k.startsWith('[') && k.includes(':')) {
        const tok = k.split(':')[0];
        out = out.replace(tok, mappings[k].original);
      } else {
        // Replace all literal occurrences of the pseudonym with the original.
        const re = new RegExp(escapeRegExp(k), 'g');
        out = out.replace(re, mappings[k].original);
      }
    }
  }
  audit.record(db, {
    action: 'desanitize',
    actor: opts.actor || 'unknown',
    metadata: { tokenSet: tokenSetCode },
  });
  return out;
}

function escapeRegExp(s) {
  return String(s).replace(/[\\^$*+?.()|[\]{}]/g, '\\$&');
}

module.exports = { sanitizeText, desanitizeText };
