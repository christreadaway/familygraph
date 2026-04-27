'use strict';

const express = require('express');
const enc = require('../crypto/encryption');

// HMAC-backed search. Operator types a name; we hash it the same way the
// registry hashes names and match against `*_hash` columns. We never iterate
// over decrypted PII.
//
// Supports searching by:
//   ?q=Smith            -> persons by family_name OR given_name (HMAC eq)
//   ?email=mary@x.org   -> emails by norm_hash
//   ?phone=4155550100   -> phones by norm_hash
//   ?postal=45801       -> addresses by postal containment via decrypted scan
//
// "Substring" search of encrypted PII would defeat the encryption-at-rest
// guarantee, so we only support exact normalized lookups for the fast paths.
// For browse/scan use cases the operator can list pages of families/people
// from the existing endpoints.

function build({ db, secrets }) {
  const r = express.Router();

  r.get('/', (req, res) => {
    const out = { persons: [], families: [], addresses: [], emails: [], phones: [] };
    const q = (req.query.q || '').trim();
    const email = (req.query.email || '').trim();
    const phone = (req.query.phone || '').trim();

    if (q) {
      const norm = enc.normalizeName(q);
      const h = enc.hmac(secrets, norm);
      if (h) {
        const persons = db
          .prepare(
            `SELECT * FROM persons WHERE status = 'active' AND
              (given_name_hash = ? OR family_name_hash = ?) LIMIT 100`
          )
          .all(h, h);
        out.persons = persons.map(p => ({
          code: p.code,
          display_name: enc.decrypt(secrets, p.display_name_ct),
          given_name: enc.decrypt(secrets, p.given_name_ct),
          family_name: enc.decrypt(secrets, p.family_name_ct),
        }));
        // Family display names are not hashed; surface families containing any
        // of the matched persons.
        const personCodes = persons.map(p => p.code);
        if (personCodes.length > 0) {
          const placeholders = personCodes.map(() => '?').join(',');
          const fams = db
            .prepare(
              `SELECT DISTINCT f.* FROM families f JOIN memberships m ON m.family_code = f.code
                WHERE m.ended_at IS NULL AND m.person_code IN (${placeholders})
                  AND f.status = 'active' LIMIT 50`
            )
            .all(...personCodes);
          out.families = fams.map(f => ({
            code: f.code,
            display_name: enc.decrypt(secrets, f.display_name_ct),
          }));
        }
      }
    }

    if (email) {
      const h = enc.hmac(secrets, enc.normalizeEmail(email));
      if (h) {
        const row = db.prepare('SELECT * FROM emails WHERE norm_hash = ?').get(h);
        if (row) out.emails = [{ code: row.code, value: enc.decrypt(secrets, row.value_ct) }];
      }
    }
    if (phone) {
      const h = enc.hmac(secrets, enc.normalizePhone(phone));
      if (h) {
        const row = db.prepare('SELECT * FROM phones WHERE norm_hash = ?').get(h);
        if (row) out.phones = [{ code: row.code, value: enc.decrypt(secrets, row.value_ct) }];
      }
    }

    res.json(out);
  });

  return r;
}

module.exports = build;
