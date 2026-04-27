# Sanctus — Product Specification (v1)

**The "how." Implementation contract for the Sanctus family registry.**

---

| | |
|---|---|
| **Status** | v1 implementation reference, in lock-step with the code in this repo |
| **Companion docs** | `business_spec.md` (the "why"), `ARCHITECTURE_MEMO_FAMILY_MANAGEMENT.md` (consumer integration), `session_notes.md` (decision log) |
| **Stack** | Node.js 20+ · Express · better-sqlite3 · React 18 · Vite |
| **Posture** | Local-first. Default loopback. PII at rest is AES-256-GCM ciphertext. |

---

## What is in the box

- `server/`            — Express HTTP API, identity store, sanitize/desanitize, folder-watch agent, audit log, backup/restore
- `client/`            — React 18 dashboard (Vite-built). Served from the same Express process.
- `tests/`             — `node:test` suites covering crypto, identity, resolver, sources, sanitize, audit, auth, API, folder watch, backup
- `bin/sanctus.js`     — operator CLI (`start`, `rotate-secret`, `backup`, `restore`, `show-token`)

---

## How to run

```sh
npm install                # installs server deps
cd client && npm install   # installs client deps
cd .. && npm run client:build
npm start                  # http://127.0.0.1:3500
node bin/sanctus.js show-token   # paste into the dashboard the first time
```

Environment overrides:

| Variable | Default | Meaning |
|---|---|---|
| `SANCTUS_HOME` | `~/.sanctus` | Root directory for keys, db, watch/out, backups |
| `SANCTUS_DB` | `$SANCTUS_HOME/data/sanctus.sqlite` | SQLite database path |
| `SANCTUS_SECRET` | `$SANCTUS_HOME/secret.key` | Master/data/HMAC key file (mode 0600) |
| `SANCTUS_WATCH_DIR` | `$SANCTUS_HOME/watch` | Folder-watch input |
| `SANCTUS_OUT_DIR` | `$SANCTUS_HOME/out` | Folder-watch output |
| `SANCTUS_PORT` | `3500` | TCP port |
| `SANCTUS_BIND` | `127.0.0.1` | Bind address (loopback by default) |
| `SANCTUS_AUTO_MERGE` | `0.92` | Auto-merge threshold for the resolver |
| `SANCTUS_REVIEW` | `0.7` | Conflict-queue threshold for the resolver |
| `SANCTUS_DISABLE_WATCH` | unset | Set to `1` to disable the folder-watch agent |

---

## Identifier system

| Entity | Prefix | Example | Validator |
|---|---|---|---|
| Family | `f_` | `f_a7b3c91d` | `^f_[0-9a-f]{8}$` |
| Person | `p_` | `p_e4d2f8a1` | `^p_[0-9a-f]{8}$` |
| Email | `e_` | `e_b91c4f23` | `^e_[0-9a-f]{8}$` |
| Phone | `ph_` | `ph_2d8a5e91` | `^ph_[0-9a-f]{8}$` |
| Address | `addr_` | `addr_4c7f2a91` | `^addr_[0-9a-f]{8}$` |
| Relationship | `r_` | `r_7d2f12a3` | `^r_[0-9a-f]{8}$` |
| Membership | `m_` | `m_5e8a13b4` | `^m_[0-9a-f]{8}$` |
| Source record | `src_` | `src_3a1f8d2b` | |
| Conflict | `conf_` | `conf_b1c2d3e4` | |
| Token set | `tk_` | `tk_a1b2c3d4` | |
| Audit row | `au_` | `au_aabbccdd` | |

All codes are non-semantic 8-char hex with a 4-byte CSPRNG entropy. Codes are
permanent; merges produce alias rows; nothing is reused or reissued. The
alias chain is followed transitively at read time.

---

## Database schema

Defined in `server/db/schema.sql`. PII columns end with `_ct` and store
AES-256-GCM ciphertext (12-byte IV, 16-byte tag, version byte). Search is
done via `_hash` columns containing HMAC-SHA256 of the normalized form.

Top-level tables:

- `families` (status, merged_into, display_name_ct, notes_ct)
- `persons` (given/family/middle/prefix/suffix/dob/gender/notes ciphertext + name hashes)
- `memberships` (family↔person with role, custody, started_at/ended_at)
- `addresses`, `family_addresses`, `person_addresses`
- `emails`, `phones`, `person_emails`, `person_phones`
- `relationships` (parent_of, child_of, spouse_of, godparent_of, sibling_of, related_household, custody_of, guardian_of, other; symmetric back-references where applicable)
- `aliases` (loser code → winner code)
- `source_records`, `provenance` (which source contributed which field to which entity)
- `conflicts` (resolution-queue rows with status: open | merged | rejected | dismissed)
- `resolution_rules` (operator-curated overrides — schema only in v1; full UI in v2)
- `token_sets` (encrypted sanitize round-trip mappings)
- `audit_events` (tier 1 internal + tier 2 external-export consent)
- `profiles`, `settings`

The schema is versioned (`schema_version` table) and applied idempotently on
startup.

---

## Cryptographic posture

- **Key file** at `$SANCTUS_HOME/secret.key`, mode 0600, written by the server on first boot.
  - `master`  — Bearer token for the PII surface
  - `dataKey` — AES-256-GCM key for PII-column ciphertext
  - `hmacKey` — HMAC-SHA256 key for searchable hashes
- **PII at rest:** every `_ct` column is `[version:1][iv:12][tag:16][cipher: variable]`. Null inputs pass through unchanged.
- **Searchable equality:** name lookups use `HMAC-SHA256(hmacKey, normalize(input))`. Email/phone/address dedup by `norm_hash`.
- **Token rotation:** `node bin/sanctus.js rotate-secret` regenerates the master Bearer token without touching `dataKey` or `hmacKey`. Apps re-fetch on next startup.
- **Backups:** `bin/sanctus.js backup [passphrase]` produces either a hot copy of the SQLite file (mode 0600) or, if a passphrase is given, an encrypted `.sanctus-backup` (gzip + AES-256-GCM with PBKDF2-derived key, 200k iterations).
- **Threat model (v1):** trusted single-operator desktop; any process that can read the secret file can read PII. Per-app scoped keys are a known v2 evolution.

> SQLCipher was deliberately not used. Application-layer column encryption gives
> the same "plaintext never lives in the file" guarantee without forcing a
> custom SQLite native build on every consumer. Migrating to SQLCipher later is
> a one-time copy-out; the ciphertext format is independent.

---

## API contract

All routes are JSON. PII routes require `Authorization: Bearer <master>`. Safe
routes are loopback-only, no token. The `X-Sanctus-Actor` header identifies the
calling app for audit purposes (defaults to `unknown_app`).

### Open

- `GET /api/health` → `{ status, schema, time }`

### Safe surface (loopback only, no PII ever)

- `GET /api/safe/families` — list family codes + status only
- `GET /api/safe/families/:code` — family + members + addresses (codes only)
- `GET /api/safe/people` — list person codes
- `GET /api/safe/people/:code` — person code + status only

### PII surface (Bearer required)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/families` | list active families with PII |
| `POST` | `/api/families` | create family (`{display_name?, notes?}`) |
| `GET` | `/api/families/:code` | family + members + addresses + emails + phones (PII) |
| `PATCH` | `/api/families/:code` | update display_name / notes |
| `POST` | `/api/families/:code/members` | add a member (`{person_code, role?, custody?}`) |
| `DELETE` | `/api/families/:code/members/:m` | end a membership row |
| `POST` | `/api/families/:code/merge` | merge into `{winner_code}`; loser becomes alias |
| `POST` | `/api/families/:code/split` | split into a new family by `{person_codes[]}` |
| `POST` | `/api/families/:code/addresses` | attach an address |
| `GET` | `/api/people` | list active people |
| `POST` | `/api/people` | create person |
| `GET` | `/api/people/:code` | person with PII |
| `PATCH` | `/api/people/:code` | update person fields |
| `POST` | `/api/people/:code/merge` | merge into `{winner_code}` |
| `POST` | `/api/people/:code/emails` | attach email |
| `POST` | `/api/people/:code/phones` | attach phone |
| `GET` | `/api/conflicts` | list resolver conflicts |
| `GET` | `/api/conflicts/:code` | one conflict |
| `POST` | `/api/conflicts/:code/resolve` | `{decision: merge \| reject \| dismiss, winner_code?}` |
| `POST` | `/api/sanitize` | replace names/emails/phones with codes; returns token-set code |
| `POST` | `/api/desanitize` | restore PII from a token set |
| `GET` | `/api/audit` | tier-1 + tier-2 events |
| `POST` | `/api/audit/external-export` | tier-2 export-consent event |
| `POST` | `/api/import/preview` | parse a file, return inferred mapping + canonical preview |
| `POST` | `/api/import/run` | run a batch import; returns per-row outcomes |

Aliases are followed transparently: `GET /api/families/:loser` returns the
surviving family's data with the surviving code in `family.code`.

---

## Identity resolver

- **Blocking:** family-name HMAC. Falls back to given-name HMAC if no surname match.
- **Score (per-person):** weighted sum of name + DOB similarity. Levenshtein-normalized similarity per field.
- **Decisions:**
  - score ≥ `autoMerge` (default 0.92) → attach to existing person; fill missing fields if any.
  - score ≥ `review` (default 0.7) → create new person + open conflict-queue row.
  - otherwise → create new person.
- **Family attachment:** if 50%+ of incoming persons already belong to a single existing family, attach there; otherwise create a new family.
- `rescorePerson(code)` re-runs the scorer for a single person — used for rescoring after manual edits.

The thresholds are tunable per env var or per call. Resolution rules
(`resolution_rules` table) are wired into the schema for operator overrides;
the rule UI is v1.x.

---

## Sanitize / desanitize

`sanitize` is a three-layer NER over arbitrary text:

1. Regex: emails, phones, US-style SSNs, US-style DOBs, US street-address hints.
2. Registry: HMAC-matched lookups against every active person's `given_name_hash` and `family_name_hash`. Any token whose hash matches an active person becomes that person's code.
3. Heuristic: capitalized-token sequences not corroborated by 1 or 2 are tokenized with fresh, non-registry person codes.

The output stores its mapping as an encrypted `mappings_ct` blob in
`token_sets`. `desanitize(text, token_set)` restores the original strings.
Token-set ciphertext is unreadable without `dataKey`.

---

## Source handlers

| Source | Detection key | Module |
|---|---|---|
| FACTS | `Student First Name`, `Parent 1 First Name`, `Family Name` | `server/sources/facts.js` |
| RenWeb | `StudentFirst`/`StudentFirstName`, `FatherFirst`, `MotherFirst` | `server/sources/renweb.js` |
| Ministry Platform | `Household_ID`, `Contact_ID`, `Email_Address` | `server/sources/ministry-platform.js` |
| Google Sheets (CSV) | passthrough | `server/sources/google-sheets.js` |
| Excel | `.xlsx`/`.xls`/`.xlsm` extension | `server/sources/excel.js` |
| Generic CSV | inferred from headers | `server/sources/csv.js` |

Each handler returns `{ rows, mapping, canonical }` where `canonical` is an
array of `{ family, persons[], address }` objects suitable for
`identity/import.importRow`. Header inference recognizes 30+ aliases per
field (e.g., `first_name`, `firstname`, `given_name`, `fname`, …).

Auto-detection is by header heuristic; the user can pin a source via
`source` parameter on `/api/import/preview` and `/api/import/run`.

---

## Folder-watch agent

`server/folder-watch/index.js` watches `$SANCTUS_WATCH_DIR` (chokidar,
non-recursive, with `awaitWriteFinish`). On a settled file:

- `*.csv | *.tsv` → parsed via `sources.load`, run through the import
  pipeline, source moved to `out/processed/`, summary JSON written to `out/`.
- `*.xlsx | *.xls | *.xlsm` → same.
- `*.txt | *.md | *.eml | *.json` → sanitized; `<stem>.sanitized.<ext>` and
  `<stem>.token-set.json` written to `out/`.
- Anything else → moved to `out/errors/` with a `.error.txt` sidecar.

The agent never overwrites: collisions are renamed `<stem>.1.<ext>` etc.

---

## Two-tier audit log

- **Tier 1 (internal):** `read_pii`, `family_create`, `person_merge`,
  `family_split`, `import_row`, `bulk_import`, `sanitize`, `desanitize`,
  `resolver_attach`, `resolver_enqueued`, `resolver_created`,
  `conflict_merged`, `conflict_rejected`, `conflict_dismissed`,
  `folder_watch_import`, `folder_watch_error`.
- **Tier 2 (external-export consent):** `export_consent`, recorded by
  consuming apps via `POST /api/audit/external-export`. Required fields:
  `destination`, `entity_codes[]`, `reason`.

Metadata is JSON. The audit recorder runs a PII redactor over every
`metadata` object before writing — keys like `name`, `email`, `phone`,
`first_name`, etc., become `[redacted]`. Audit rows themselves are safe to
share.

---

## Operator dashboard

Built with Vite + React 18. Routes:

- `/families` — list, create
- `/families/:code` — detail, edit, members (add/end), addresses, merge, split
- `/people` — list, create
- `/people/:code` — detail, edit, emails, phones, merge
- `/conflicts` — review queue (open/merged/rejected/dismissed) with merge-→-left, merge-→-right, reject, dismiss buttons
- `/import` — bulk import wizard (paste CSV or upload file → preview → run)
- `/sanitize` — interactive sanitize → AI → desanitize round trip
- `/audit` — filterable audit log

The Bearer token is stored in `localStorage` and prompted for on first load.
Vite's dev server proxies `/api/*` to `http://127.0.0.1:3500`.

---

## Test surface

`npm test` runs ~70 cases across:

- `tests/identifiers.test.js` — code generation, validation, prefix disambiguation
- `tests/encryption.test.js` — round-trip, tamper detection, IV randomness, normalize, HMAC determinism + key-binding
- `tests/secret.test.js` — key file creation, mode bits, rotation, malformed-file rejection
- `tests/auth.test.js` — bearer constant-time match, loopback IPv4/IPv6 acceptance, external-IP rejection
- `tests/identity.test.js` — person/family CRUD, members, contacts, merge (chains), split, relationships, alias transitivity, contact dedup, active-membership uniqueness
- `tests/resolver.test.js` — auto-merge, conflict enqueue, new-person creation, family attachment, rescoring, similarity edges
- `tests/sources.test.js` — CSV/FACTS/RenWeb/Ministry Platform parsing, header detection, BOM handling
- `tests/sanitize.test.js` — round-trip, registry matches, NER detection, encrypted mappings at rest
- `tests/audit.test.js` — redaction, list filters, tier-2 events
- `tests/folder-watch.test.js` — CSV import, text sanitization, unknown-kind error path
- `tests/backup.test.js` — hot copy, encrypted-backup round trip, wrong-passphrase rejection
- `tests/api.test.js` — open health, 401 without token, PII surface, safe surface excludes PII, sanitize round-trip, import preview/run, tier-2 audit, 404 JSON, 400 on invalid code, family merge, conflict resolve

All 70 pass against `node:test` (Node 20+).

---

## What v1 ships and what v1 does not

**Ships:**
- Full identity ledger with merge/split/alias semantics
- Resolver with conflict queue
- Import wizard + folder-watch agent
- Sanitize/desanitize with registry-aware NER
- Two-tier audit
- Encrypted backups
- React dashboard for the operator
- Bearer + loopback dual-surface API

**Does not ship in v1 (deferred to v2):**
- OS-keychain-backed secret storage (file-based in v1, file format is keychain-compatible)
- Multi-party sharing (explicitly v2 per session_notes)
- Bitemporal point-in-time queries (explicitly out of scope per session_notes)

**v1.x extensions added in this build (all included in `npm test`):**
- Per-app scoped API keys: `api_keys` table, `POST /api/keys` provisioning, `DELETE /api/keys/:code` revoke, scope-aware `bearerAuth`. Scopes: `pii.read`, `pii.write`, `sanitize`, `audit.read`, `audit.write`, `import`, `rules.write`, `*`. Master token always satisfies any scope.
- Resolution-rule engine: `resolution_rules` consulted by the resolver. Actions are `auto_merge`, `never_merge`, `boost`, `penalize`. CRUD via `/api/rules`. Dashboard editor at `/rules`.
- compromise NER as the third sanitize layer (loaded lazily so the system still works if removed).
- Numbered migrations runner (`server/db/migrations/`) layered on top of the bootstrap schema. Each migration runs in a transaction; `schema_version` is updated after success.
- Built-in profiles (catholic_school, parish_donor, diocese) seeded on first boot. The active profile's thresholds override the defaults at import time. Endpoints `/api/profiles` + `/api/profiles/activate`.
- Settings persistence (`/api/settings`) with allow-list of known keys (`institution_name`, `operator_name`, `audit_retention_days`).
- Audit retention sweeper: tier-1 events older than `audit_retention_days` are deleted on a daily timer; tier-2 events are never deleted. Sweep is also exposed as a function for tests.
- HMAC-backed search at `/api/search` (name → persons + their families; email → emails; phone → phones). Substring scan over encrypted columns is intentionally not supported.
- Membership history at `/api/membership-history/person/:code` and `/family/:code` — every row including ended ones, with `reason`.
- Family-to-family relationships endpoint `/api/relationships` (add / list / remove). UI exposed in `FamilyDetail`.
- Bulk export at `/api/export` with safe (codes only) and PII (consent + destination + reason → tier-2 audit event) modes.

---

*End of product specification*
