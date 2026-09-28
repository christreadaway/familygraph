'use strict';

// Migration 0020: external_refs - the crosswalk from another app's own record
// ids to Family Graph codes (2026-09-28).
//
// A consuming app that already holds people (MissionIQ's contacts, children,
// and families) imports them once; from then on "MissionIQ contact X" IS a
// specific Family Graph person, looked up exactly and never re-matched by
// name. That is what keeps one human on one identifier across products.
//
// Refs are the other app's opaque record ids (uuids, integers) - never names
// or contact details. Codes are stored as written; readers follow the alias
// table, so a later merge keeps every ref pointing at the survivor.
module.exports.up = function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_refs (
      source      TEXT NOT NULL,
      ref         TEXT NOT NULL,
      kind        TEXT NOT NULL,
      code        TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (source, ref),
      CHECK (kind IN ('person','family'))
    );
    CREATE INDEX IF NOT EXISTS external_refs_code_idx ON external_refs (code);
  `);
};
