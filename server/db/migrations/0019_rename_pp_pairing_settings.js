'use strict';

// Migration 0019: rename the outbound partner-pairing settings keys from the
// previous app-specific `pp_*` naming to the generic `partner_*` naming.
//
// Partner pairings are stored in the `settings` table under keys shaped like
// `pp_pairing.<schoolId>.<field>` (see server/integration/pairing.js). The
// pairing subsystem is generic infrastructure — FamilyGraph dials OUT to any
// paired consuming app per tenant — so the naming is being generalized for the
// open-source release. This migration renames any EXISTING stored keys so a
// pairing configured before the rename keeps working without re-entry.
//
// Data-preserving and idempotent: it only touches keys that still carry the old
// prefix, and re-running finds nothing to change. The wire contract to the
// paired app (outbound headers, paths, envelope) is unaffected — only these
// internal storage keys change.
module.exports.up = function up(db) {
  // Field-name parts first (while the old prefix still identifies the rows),
  // then the namespace prefix. `\` escapes the LIKE underscore wildcard so we
  // match the literal `pp_pairing.` prefix and nothing else.
  db.prepare(
    "UPDATE settings SET key = REPLACE(key, 'pp_bearer_credential', 'partner_bearer_credential') " +
    "WHERE key LIKE 'pp\\_pairing.%' ESCAPE '\\'"
  ).run();
  db.prepare(
    "UPDATE settings SET key = REPLACE(key, 'pp_base_url', 'partner_base_url') " +
    "WHERE key LIKE 'pp\\_pairing.%' ESCAPE '\\'"
  ).run();
  db.prepare(
    "UPDATE settings SET key = REPLACE(key, 'pp_pairing.', 'partner_pairing.') " +
    "WHERE key LIKE 'pp\\_pairing.%' ESCAPE '\\'"
  ).run();
};
