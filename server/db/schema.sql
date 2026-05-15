-- Family Graph database schema
-- Identity ledger: families, persons, contacts, addresses, relationships, history.
-- All PII columns store AES-256-GCM ciphertext. Plaintext exists only at the
-- application boundary, never in the file.
--
-- Identifier conventions:
--   f_*    family
--   p_*    person
--   e_*    email
--   ph_*   phone
--   addr_* address
--   r_*    relationship
--   m_*    membership row
--   src_*  source-record provenance
--   conf_* conflict
--   tk_*   sanitization token-set
--   au_*   audit row
-- Codes are stable across the lifetime of the system. Merges produce alias rows;
-- nothing is ever reused or reissued.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-------------------------------------------------------------------------------
-- Schema metadata
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-------------------------------------------------------------------------------
-- Families
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS families (
  code             TEXT PRIMARY KEY,
  display_name_ct  BLOB,                     -- ciphertext of display name
  notes_ct         BLOB,                     -- ciphertext of operator notes
  status           TEXT NOT NULL DEFAULT 'active',  -- active | merged | archived
  merged_into      TEXT,                     -- when merged, the surviving family code
  -- ParentPoint contract additions (migration 0012). The pointer is "soft":
  -- a merge can retire the referenced person, in which case the contract
  -- layer falls back to the first active adult member.
  primary_contact_person_code TEXT,
  communication_language      TEXT,         -- ISO-639-1 short code (default 'en')
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (status IN ('active','merged','archived'))
);

CREATE INDEX IF NOT EXISTS families_status_idx ON families (status);
CREATE INDEX IF NOT EXISTS families_merged_into_idx ON families (merged_into);
CREATE INDEX IF NOT EXISTS families_updated_at_idx ON families (updated_at);

-------------------------------------------------------------------------------
-- Persons
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS persons (
  code             TEXT PRIMARY KEY,
  given_name_ct    BLOB,
  family_name_ct   BLOB,
  middle_name_ct   BLOB,
  prefix_ct        BLOB,                     -- Mr/Mrs/Fr etc.
  suffix_ct        BLOB,
  display_name_ct  BLOB,                     -- canonical full-name string for display
  -- Searchable hash columns. Hashed with HMAC-SHA256(secret, normalized).
  -- Used for exact lookups without exposing PII.
  given_name_hash  TEXT,
  family_name_hash TEXT,
  date_of_birth_ct BLOB,
  gender_ct        BLOB,
  notes_ct         BLOB,
  -- Vendored from missionIQ contact-shape: per-person profile fields that
  -- matter for institutional workflows. employer/title for donor research,
  -- do_not_contact for compliance, not_living_together for custody-aware
  -- messaging on shared family addresses.
  employer_ct      BLOB,
  title_ct         BLOB,
  do_not_contact   INTEGER NOT NULL DEFAULT 0,
  do_not_contact_reason_ct BLOB,
  not_living_together INTEGER NOT NULL DEFAULT 0,
  -- Ethics and Integrity in Ministry (Catholic safe-environment training).
  -- Status + completion + expiration are queryable plaintext so the dashboard
  -- can surface "expiring in 30 days" without decrypting the persons table.
  -- Notes go encrypted because they may name a diocese, vendor, or waiver.
  eim_status       TEXT,                       -- pending | certified | expired | NULL
  eim_completed_on TEXT,                       -- ISO-8601 date issued
  eim_expires_on   TEXT,                       -- ISO-8601 date the cert lapses
  eim_notes_ct     BLOB,                       -- ciphertext of operator notes
  -- ParentPoint contract additions (migration 0012). kind classifies the
  -- person as an adult or child so the sibling apps can render
  -- appropriately; preferred_name_ct is the parent's chosen short name
  -- ("Mandy" instead of "Amanda") and rides on every PP person object.
  kind             TEXT,                       -- adult | child | NULL
  preferred_name_ct BLOB,
  status           TEXT NOT NULL DEFAULT 'active',
  merged_into      TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (status IN ('active','merged','archived'))
);

CREATE INDEX IF NOT EXISTS persons_family_name_hash_idx ON persons (family_name_hash);
CREATE INDEX IF NOT EXISTS persons_given_name_hash_idx  ON persons (given_name_hash);
CREATE INDEX IF NOT EXISTS persons_status_idx           ON persons (status);
CREATE INDEX IF NOT EXISTS persons_merged_into_idx      ON persons (merged_into);
CREATE INDEX IF NOT EXISTS persons_eim_expires_idx      ON persons (eim_expires_on);
CREATE INDEX IF NOT EXISTS persons_eim_status_idx       ON persons (eim_status);
CREATE INDEX IF NOT EXISTS persons_kind_idx             ON persons (kind);
CREATE INDEX IF NOT EXISTS persons_updated_at_idx       ON persons (updated_at);

-------------------------------------------------------------------------------
-- Family memberships (history-tracking)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS memberships (
  code           TEXT PRIMARY KEY,
  family_code    TEXT NOT NULL REFERENCES families(code) ON DELETE CASCADE,
  person_code    TEXT NOT NULL REFERENCES persons(code)  ON DELETE CASCADE,
  role           TEXT NOT NULL,            -- parent | child | guardian | grandparent | other_adult
  -- ParentPoint's household members[] carry a finer-grained label than the
  -- internal role bucket — mother vs. father vs. step_parent, etc. We keep
  -- the legacy role for compatibility with the resolver and the family-list
  -- views, and round-trip the finer label here.
  relation_label TEXT,                     -- mother | father | step_parent | guardian | grandparent | other | child | NULL
  custody        TEXT,                     -- sole | joint | other_guardian | unspecified
  started_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at       TEXT,                     -- null while active
  reason         TEXT,                     -- why ended (emancipation, merge, split, edit)
  CHECK (role IN ('parent','child','guardian','grandparent','spouse','other_adult','head','member')),
  CHECK (custody IS NULL OR custody IN ('sole','joint','other_guardian','unspecified'))
);

CREATE INDEX IF NOT EXISTS memberships_family_idx     ON memberships (family_code);
CREATE INDEX IF NOT EXISTS memberships_person_idx     ON memberships (person_code);
CREATE INDEX IF NOT EXISTS memberships_active_idx     ON memberships (family_code, ended_at);
CREATE UNIQUE INDEX IF NOT EXISTS memberships_active_uniq
  ON memberships (family_code, person_code) WHERE ended_at IS NULL;

-------------------------------------------------------------------------------
-- Addresses
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS addresses (
  code         TEXT PRIMARY KEY,
  line1_ct     BLOB,
  line2_ct     BLOB,
  city_ct      BLOB,
  region_ct    BLOB,                       -- state/province
  postal_ct    BLOB,
  country_ct   BLOB,
  -- Hash of normalized address used for de-dup.
  norm_hash    TEXT UNIQUE,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS family_addresses (
  family_code  TEXT NOT NULL REFERENCES families(code) ON DELETE CASCADE,
  address_code TEXT NOT NULL REFERENCES addresses(code) ON DELETE CASCADE,
  label        TEXT,                       -- home | mailing | summer | other
  is_primary   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (family_code, address_code)
);

CREATE TABLE IF NOT EXISTS person_addresses (
  person_code  TEXT NOT NULL REFERENCES persons(code) ON DELETE CASCADE,
  address_code TEXT NOT NULL REFERENCES addresses(code) ON DELETE CASCADE,
  label        TEXT,
  is_primary   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (person_code, address_code)
);

-------------------------------------------------------------------------------
-- Emails / Phones
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS emails (
  code         TEXT PRIMARY KEY,
  value_ct     BLOB NOT NULL,
  norm_hash    TEXT UNIQUE,
  is_verified  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS phones (
  code         TEXT PRIMARY KEY,
  value_ct     BLOB NOT NULL,
  norm_hash    TEXT UNIQUE,
  kind         TEXT,                       -- mobile | home | work | other
  -- ParentPoint contract additions (migration 0012). The e164 column carries
  -- the canonical "+15125550101" representation so PP messaging can dial it
  -- directly; sms_consent is the per-phone SMS opt-in.
  e164         TEXT,
  sms_consent  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS phones_e164_idx ON phones (e164);

CREATE TABLE IF NOT EXISTS person_emails (
  person_code  TEXT NOT NULL REFERENCES persons(code) ON DELETE CASCADE,
  email_code   TEXT NOT NULL REFERENCES emails(code)  ON DELETE CASCADE,
  is_primary   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (person_code, email_code)
);

CREATE TABLE IF NOT EXISTS person_phones (
  person_code  TEXT NOT NULL REFERENCES persons(code) ON DELETE CASCADE,
  phone_code   TEXT NOT NULL REFERENCES phones(code)  ON DELETE CASCADE,
  is_primary   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (person_code, phone_code)
);

-------------------------------------------------------------------------------
-- Relationships (person <-> person, person <-> family, family <-> family)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS relationships (
  code         TEXT PRIMARY KEY,
  from_code    TEXT NOT NULL,             -- p_ or f_
  to_code      TEXT NOT NULL,
  kind         TEXT NOT NULL,             -- parent_of, child_of, spouse_of, godparent_of,
                                          -- sibling_of, related_household, custody_of, other
  detail       TEXT,                      -- free-form qualifier
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (kind IN (
    'parent_of','child_of','spouse_of','godparent_of','sibling_of',
    'related_household','custody_of','guardian_of','other'
  ))
);

CREATE INDEX IF NOT EXISTS relationships_from_idx ON relationships (from_code);
CREATE INDEX IF NOT EXISTS relationships_to_idx   ON relationships (to_code);
CREATE INDEX IF NOT EXISTS relationships_kind_idx ON relationships (kind);

-------------------------------------------------------------------------------
-- Aliases (merged-loser codes resolve to the surviving code)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS aliases (
  alias_code   TEXT PRIMARY KEY,           -- old code that should redirect
  target_code  TEXT NOT NULL,              -- code of the survivor
  kind         TEXT NOT NULL,              -- family | person | address | email | phone
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (kind IN ('family','person','address','email','phone'))
);

CREATE INDEX IF NOT EXISTS aliases_target_idx ON aliases (target_code);

-------------------------------------------------------------------------------
-- Source provenance
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS source_records (
  code         TEXT PRIMARY KEY,
  source       TEXT NOT NULL,             -- facts | renweb | ministry_platform | csv | excel | sheets | manual | api
  source_ref   TEXT,                      -- file path, sheet+row, vendor record id
  -- Operator classification of the *file* this row came from. The dashboard
  -- offers 'church' / 'school' / 'other' but this column accepts any short
  -- string. Family Graph never aggregates by category; it's a label so the
  -- operator can later see "this directory entry first appeared in our
  -- church donor list" vs. "in our school enrollment list".
  category     TEXT,
  -- Free-form operator tags (JSON array). Same purpose as `category`, just
  -- finer-grained: e.g., ['q1-2026', 'donor-list', 'fr-mike-onboarded'].
  tags         TEXT,
  -- Link to the batch (import_runs row) that produced this source record.
  import_run_code TEXT,
  imported_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  raw_payload_ct BLOB                     -- ciphertext of the original row (PII)
);

CREATE INDEX IF NOT EXISTS source_records_category_idx ON source_records (category);
CREATE INDEX IF NOT EXISTS source_records_import_run_idx ON source_records (import_run_code);

-------------------------------------------------------------------------------
-- Import runs (per-batch summary stats)
-------------------------------------------------------------------------------
-- One row per /api/import/run call (or per folder-watch file). Holds the
-- aggregate effects so the operator can review what a freshly-introduced
-- file did to the directory: how many families/persons appeared, how many
-- conflicts the resolver opened, what got attached vs. created.

CREATE TABLE IF NOT EXISTS import_runs (
  code                 TEXT PRIMARY KEY,
  source               TEXT NOT NULL,            -- csv | facts | renweb | ministry_platform | sheets | excel | manual
  source_ref           TEXT,
  category             TEXT,
  tags                 TEXT,                     -- JSON array
  rows                 INTEGER NOT NULL DEFAULT 0,
  families_created     INTEGER NOT NULL DEFAULT 0,
  families_attached    INTEGER NOT NULL DEFAULT 0,
  persons_created      INTEGER NOT NULL DEFAULT 0,
  persons_attached     INTEGER NOT NULL DEFAULT 0,
  persons_enqueued     INTEGER NOT NULL DEFAULT 0,
  conflicts_opened     INTEGER NOT NULL DEFAULT 0,
  addresses_attached   INTEGER NOT NULL DEFAULT 0,
  emails_attached      INTEGER NOT NULL DEFAULT 0,
  phones_attached      INTEGER NOT NULL DEFAULT 0,
  memberships_opened   INTEGER NOT NULL DEFAULT 0,
  memberships_ended    INTEGER NOT NULL DEFAULT 0,
  rows_skipped_blank   INTEGER NOT NULL DEFAULT 0,
  actor                TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS import_runs_created_at_idx ON import_runs (created_at);
CREATE INDEX IF NOT EXISTS import_runs_category_idx ON import_runs (category);

CREATE TABLE IF NOT EXISTS provenance (
  source_code  TEXT NOT NULL REFERENCES source_records(code) ON DELETE CASCADE,
  entity_code  TEXT NOT NULL,
  field        TEXT,                      -- which field this source contributed
  PRIMARY KEY (source_code, entity_code, field)
);

CREATE INDEX IF NOT EXISTS provenance_entity_idx ON provenance (entity_code);

-------------------------------------------------------------------------------
-- Conflict queue (ambiguous match pairs awaiting operator decision)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS conflicts (
  code                   TEXT PRIMARY KEY,
  kind                   TEXT NOT NULL,             -- family | person
  left_code              TEXT NOT NULL,
  right_code             TEXT NOT NULL,
  score                  REAL NOT NULL,
  reasons                TEXT NOT NULL,             -- JSON array of match-reason strings
  status                 TEXT NOT NULL DEFAULT 'open',  -- open | merged | rejected | dismissed
  resolved_by            TEXT,
  resolved_at            TEXT,
  -- Free-form operator note recorded with the resolution. The status field
  -- captures WHAT was decided; this captures WHY ("same name, different DOB,
  -- confirmed via parish records"). Surfaced on family/person history.
  resolution_notes       TEXT,
  -- If a saved resolution_rules row triggered the auto-decision, its rule
  -- code is stored here so the audit trail can replay the exact rule.
  decided_by_rule        TEXT,
  -- Operator may park an open conflict on a colleague's email. The
  -- assignment auto-expires per the operator-chosen TTL; the sweeper clears
  -- expired rows back to unassigned. None of these columns are PII; the email
  -- is the colleague's address.
  assigned_to            TEXT,
  assigned_at            TEXT,
  assignment_expires_at  TEXT,
  reminder_sent_at       TEXT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (kind IN ('family','person')),
  CHECK (status IN ('open','merged','rejected','dismissed'))
);

CREATE INDEX IF NOT EXISTS conflicts_status_idx        ON conflicts (status);
CREATE INDEX IF NOT EXISTS conflicts_kind_idx          ON conflicts (kind);
CREATE INDEX IF NOT EXISTS conflicts_assigned_to_idx   ON conflicts (assigned_to);
CREATE INDEX IF NOT EXISTS conflicts_assignment_exp_idx ON conflicts (assignment_expires_at);

-------------------------------------------------------------------------------
-- Resolution rules (operator-curated matching rules vendored from MissionIQ)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS resolution_rules (
  code         TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,             -- family | person
  -- rule_json shape: { match: { field: pattern }, action: 'auto_merge'|'never_merge', weight }
  rule_json    TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-------------------------------------------------------------------------------
-- Sanitization token sets (for desanitize round-trip)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS token_sets (
  code         TEXT PRIMARY KEY,
  caller       TEXT,                      -- which app or context requested it
  -- mappings_json shape: { token: { kind, code, value_ct } } encrypted
  mappings_ct  BLOB NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at   TEXT
);

-------------------------------------------------------------------------------
-- Audit log (Tier 1 internal events + Tier 2 external-export consent events)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_events (
  code         TEXT PRIMARY KEY,
  tier         INTEGER NOT NULL,          -- 1 = internal, 2 = external export consent
  action       TEXT NOT NULL,             -- read_pii, write, merge, split, sanitize, desanitize, export_consent, etc.
  actor        TEXT NOT NULL,             -- the calling app or 'operator'
  entity_code  TEXT,
  entity_kind  TEXT,
  destination  TEXT,                      -- only for tier 2
  metadata     TEXT,                      -- JSON; PII redacted before write
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (tier IN (1,2))
);

CREATE INDEX IF NOT EXISTS audit_action_idx     ON audit_events (action);
CREATE INDEX IF NOT EXISTS audit_actor_idx      ON audit_events (actor);
CREATE INDEX IF NOT EXISTS audit_entity_idx     ON audit_events (entity_code);
CREATE INDEX IF NOT EXISTS audit_created_at_idx ON audit_events (created_at);

-------------------------------------------------------------------------------
-- Profiles (Catholic school, parish donor, etc.)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS profiles (
  code         TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  config_json  TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-------------------------------------------------------------------------------
-- Settings (key/value)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS settings (
  key          TEXT PRIMARY KEY,
  value_json   TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-------------------------------------------------------------------------------
-- Per-app scoped API keys (v1.x)
-------------------------------------------------------------------------------
-- A scoped key has a name (the consuming app), a SHA-256 hash of the secret
-- (we never store the secret), a JSON `scopes` array describing which surfaces
-- the holder may call, and an optional revoked_at timestamp. The shared master
-- token continues to work for backwards compatibility; scoped keys are added
-- on top.

CREATE TABLE IF NOT EXISTS api_keys (
  code         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  hash         TEXT NOT NULL UNIQUE,        -- SHA-256 hex of the issued token
  scopes       TEXT NOT NULL,               -- JSON array of scope strings
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at TEXT,
  revoked_at   TEXT
);

CREATE INDEX IF NOT EXISTS api_keys_name_idx ON api_keys (name);

-------------------------------------------------------------------------------
-- Notifications queue (v1.x)
-------------------------------------------------------------------------------
-- Outbound messages to operators / colleagues. Persisted so a transient
-- transport failure (Postmark 5xx, network blip) doesn't lose the message;
-- a periodic dispatcher picks `pending` rows up and sends. After 5 attempts
-- the row goes to `failed` and the operator can retry from the dashboard.

CREATE TABLE IF NOT EXISTS notifications (
  code              TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,           -- assign | reminder | expired | test
  to_email          TEXT NOT NULL,
  subject           TEXT NOT NULL,
  body_text         TEXT NOT NULL,
  body_html         TEXT,
  related_codes     TEXT,                    -- JSON array of conflict codes (or other)
  status            TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed | cancelled
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   TEXT,                    -- exponential backoff target
  last_error        TEXT,
  transport         TEXT,                    -- postmark | log
  provider_message_id TEXT,                  -- e.g., Postmark MessageID
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at           TEXT,
  CHECK (status IN ('pending','sent','failed','cancelled'))
);

CREATE INDEX IF NOT EXISTS notifications_status_idx          ON notifications (status);
CREATE INDEX IF NOT EXISTS notifications_kind_idx            ON notifications (kind);
CREATE INDEX IF NOT EXISTS notifications_next_attempt_idx    ON notifications (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS notifications_to_email_idx        ON notifications (to_email);

-------------------------------------------------------------------------------
-- Ministries / volunteer rosters (v1.x)
-------------------------------------------------------------------------------
-- A ministry is any volunteer or staff list the parish maintains: Lectors,
-- Eucharistic Ministers, Ushers, Faith Formation aides, Coffee & Donuts. The
-- catalog row carries a `requires_eim` flag so the dashboard can flag
-- assignments to expired EIM certs. Assignments may target a person OR a
-- whole family (e.g., the Smith family signs up for monthly Coffee &
-- Donuts) but never both at the same time.

CREATE TABLE IF NOT EXISTS ministries (
  code           TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT,
  requires_eim   INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (status IN ('active','archived'))
);

-- Unique name only among active ministries — archived rows can keep the
-- same name as their replacement so historical data isn't corrupted by a
-- rename, and the operator can re-introduce a roster they previously
-- archived without picking a synonym.
CREATE UNIQUE INDEX IF NOT EXISTS ministries_name_active_uniq
  ON ministries (name) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS ministries_status_idx ON ministries (status);

CREATE TABLE IF NOT EXISTS ministry_assignments (
  code           TEXT PRIMARY KEY,
  ministry_code  TEXT NOT NULL REFERENCES ministries(code) ON DELETE CASCADE,
  person_code    TEXT REFERENCES persons(code)  ON DELETE CASCADE,
  family_code    TEXT REFERENCES families(code) ON DELETE CASCADE,
  role           TEXT NOT NULL DEFAULT 'member',
  started_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at       TEXT,
  notes_ct       BLOB,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (role IN ('member','coordinator','lead')),
  CHECK (
    (person_code IS NOT NULL AND family_code IS NULL)
    OR (person_code IS NULL AND family_code IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS ministry_assignments_ministry_idx ON ministry_assignments (ministry_code);
CREATE INDEX IF NOT EXISTS ministry_assignments_person_idx   ON ministry_assignments (person_code);
CREATE INDEX IF NOT EXISTS ministry_assignments_family_idx   ON ministry_assignments (family_code);
CREATE INDEX IF NOT EXISTS ministry_assignments_active_idx   ON ministry_assignments (ministry_code, ended_at);
CREATE UNIQUE INDEX IF NOT EXISTS ministry_assignments_active_person_uniq
  ON ministry_assignments (ministry_code, person_code) WHERE ended_at IS NULL AND person_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ministry_assignments_active_family_uniq
  ON ministry_assignments (ministry_code, family_code) WHERE ended_at IS NULL AND family_code IS NOT NULL;

-------------------------------------------------------------------------------
-- ParentPoint integration contract (migration 0012)
-------------------------------------------------------------------------------
-- The ParentPoint × FamilyGraph contract (FAMILYGRAPH_INTEGRATION.md v0.1)
-- defines a separate read / write API surface that sibling apps consume.
-- Most of the underlying data continues to live in `persons`, `families`,
-- and friends; the tables below cover things the existing identity model
-- did not yet capture.

-- Per-person consent flags. Lazy-created on first set; the contract layer
-- treats a missing row as the default ('allow' for both fields). One row per
-- person; updated_at supports the changed-since feed.
CREATE TABLE IF NOT EXISTS person_consents (
  person_code        TEXT PRIMARY KEY REFERENCES persons(code) ON DELETE CASCADE,
  photo_consent      TEXT NOT NULL DEFAULT 'allow',
  directory_listing  TEXT NOT NULL DEFAULT 'allow',
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (photo_consent IN ('allow','group_only','deny')),
  CHECK (directory_listing IN ('allow','deny'))
);
CREATE INDEX IF NOT EXISTS person_consents_updated_at_idx ON person_consents (updated_at);

-- History of EIM certifications. The existing persons.eim_* columns continue
-- to hold the "current" cert pointer for the expiring-soon dashboard view;
-- this table preserves the audit trail of every renewal.
CREATE TABLE IF NOT EXISTS eim_certifications (
  code              TEXT PRIMARY KEY,
  person_code       TEXT NOT NULL REFERENCES persons(code) ON DELETE CASCADE,
  status            TEXT NOT NULL,
  completed_on      TEXT,
  expires_on        TEXT,
  source            TEXT,
  notes_ct          BLOB,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (status IN ('pending','certified','expired'))
);
CREATE INDEX IF NOT EXISTS eim_certifications_person_idx     ON eim_certifications (person_code);
CREATE INDEX IF NOT EXISTS eim_certifications_expires_on_idx ON eim_certifications (expires_on);

-- PP-pushed enrichment snapshots. One row per (person, school) pair; PP
-- overwrites on every POST (§7.3 says the activities array is "current
-- state, not a log"). FG never edits this table itself; it just stores and
-- serves what PP sent.
CREATE TABLE IF NOT EXISTS school_contexts (
  code                              TEXT PRIMARY KEY,
  person_code                       TEXT NOT NULL REFERENCES persons(code) ON DELETE CASCADE,
  school_id                         TEXT NOT NULL,
  school_year                       TEXT,
  grade                             TEXT,
  classroom_id                      TEXT,
  classroom_name                    TEXT,
  homeroom_teacher_person_code      TEXT,
  activities                        TEXT,
  allergies                         TEXT,
  snapshot_at                       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  source_app                        TEXT,
  created_at                        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS school_contexts_person_school_uniq
  ON school_contexts (person_code, school_id);
CREATE INDEX IF NOT EXISTS school_contexts_school_idx     ON school_contexts (school_id);
CREATE INDEX IF NOT EXISTS school_contexts_updated_at_idx ON school_contexts (updated_at);

-- Subscribed PP webhook endpoints. The secret is encrypted at rest; we hold
-- it because we must compute the HMAC-SHA256 signature on outbound deliveries.
CREATE TABLE IF NOT EXISTS pp_webhook_subscriptions (
  code               TEXT PRIMARY KEY,
  url                TEXT NOT NULL,
  secret_ct          BLOB,
  events             TEXT NOT NULL DEFAULT '*',
  school_hint        TEXT,
  enabled            INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_delivered_at  TEXT,
  last_status        TEXT,
  last_error         TEXT
);
CREATE INDEX IF NOT EXISTS pp_webhook_subs_enabled_idx ON pp_webhook_subscriptions (enabled);

-- Per-attempt delivery rows. Same lifecycle as `notifications`: pending rows
-- get picked up by the dispatcher, success flips to 'sent', failure backs off
-- exponentially until MAX_ATTEMPTS, then 'failed'.
CREATE TABLE IF NOT EXISTS pp_webhook_deliveries (
  code               TEXT PRIMARY KEY,
  subscription_code  TEXT NOT NULL REFERENCES pp_webhook_subscriptions(code) ON DELETE CASCADE,
  event              TEXT NOT NULL,
  person_code        TEXT,
  family_code        TEXT,
  payload            TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  attempts           INTEGER NOT NULL DEFAULT 0,
  next_attempt_at    TEXT,
  last_error         TEXT,
  provider_status    INTEGER,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at            TEXT,
  CHECK (status IN ('pending','sent','failed','cancelled'))
);
CREATE INDEX IF NOT EXISTS pp_deliveries_sub_idx           ON pp_webhook_deliveries (subscription_code);
CREATE INDEX IF NOT EXISTS pp_deliveries_status_idx        ON pp_webhook_deliveries (status);
CREATE INDEX IF NOT EXISTS pp_deliveries_next_attempt_idx  ON pp_webhook_deliveries (status, next_attempt_at);

-- X-Request-Id idempotency cache. Per §7.2 of the contract, FG dedupes
-- inbound writes within 24h so retries on flaky networks don't double-create.
-- The response body is cached so a retry returns the exact same response the
-- caller saw the first time.
CREATE TABLE IF NOT EXISTS pp_idempotency_keys (
  request_id    TEXT NOT NULL,
  method        TEXT NOT NULL,
  path          TEXT NOT NULL,
  response_code INTEGER NOT NULL,
  response_body TEXT,
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (request_id, method, path)
);
CREATE INDEX IF NOT EXISTS pp_idempotency_expires_idx ON pp_idempotency_keys (expires_at);
