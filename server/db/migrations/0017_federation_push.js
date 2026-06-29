'use strict';

// Migration 0017: Federation push mode for webhook subscriptions.
//
// The existing webhook is a THIN notification: it sends only the changed
// entity's hex id (`personId` / `householdId`) and expects the consumer to
// GET /v1/persons/:id to fetch the record. That works when the consuming app
// can reach FamilyGraph's inbound API.
//
// A consuming app that runs OUTSIDE FamilyGraph's network — e.g. a cloud
// service while FamilyGraph sits on-prem behind a firewall — can receive our
// outbound POSTs but cannot reach back in to pull. For those apps a thin
// notification is useless: they have the id but can never fetch the record.
//
// Federation push solves that. A subscription flagged `federation_push = 1`
// receives FAT batches instead of thin notifications: FamilyGraph POSTs the
// full hex-keyed person / household objects (the same shapes the
// changed-since feed serves), so the consumer can federate identity on the
// canonical hex without ever pulling. Two per-subscription cursors track how
// far each entity stream has been pushed; a null cursor means "never pushed"
// and the first tick hydrates the whole active graph.
//
// All additive. Existing subscriptions default to federation_push = 0 and keep
// receiving thin webhooks exactly as before.

exports.up = function up(db) {
  const cols = db.prepare(`PRAGMA table_info(webhook_subscriptions)`).all().map(r => r.name);
  if (!cols.includes('federation_push')) {
    db.exec(`ALTER TABLE webhook_subscriptions ADD COLUMN federation_push INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.includes('reconcile_persons_cursor')) {
    db.exec(`ALTER TABLE webhook_subscriptions ADD COLUMN reconcile_persons_cursor TEXT`);
  }
  if (!cols.includes('reconcile_households_cursor')) {
    db.exec(`ALTER TABLE webhook_subscriptions ADD COLUMN reconcile_households_cursor TEXT`);
  }
  if (!cols.includes('hydrated_at')) {
    db.exec(`ALTER TABLE webhook_subscriptions ADD COLUMN hydrated_at TEXT`);
  }
  // Federation push selects subscriptions by the flag on every tick; index it.
  db.exec(`CREATE INDEX IF NOT EXISTS webhook_subs_federation_idx ON webhook_subscriptions (federation_push, enabled)`);
};
