# Family Graph — Product Specification (v1)

**The "how." Implementation contract for the Family Graph family registry.**

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
- `bin/family-graph.js`     — operator CLI (`start`, `rotate-secret`, `backup`, `restore`, `show-token`)

---

## How to run

```sh
# Every npm install in this repo must route through Socket Firewall.
# Plain `npm install` is blocked by the preinstall guard. See README.md
# section "Security requirement: Socket Firewall" for context.
SFW=1 sfw npm install               # installs server deps
SFW=1 sfw npm run client:install    # installs client deps
npm run client:build                # builds the dashboard
npm start                           # http://127.0.0.1:3500
node bin/family-graph.js show-token # paste into the dashboard the first time
```

Other CLI entry points: `status`, `rotate-secret`, `backup [passphrase]`,
`list-backups`, `prune-backups [keep=10]`, `restore <passphrase> <src> <dest>`.

Environment overrides:

| Variable | Default | Meaning |
|---|---|---|
| `FAMILY_GRAPH_HOME` | `~/.family-graph` | Root directory for keys, db, watch/out, backups |
| `FAMILY_GRAPH_DB` | `$FAMILY_GRAPH_HOME/data/family-graph.sqlite` | SQLite database path |
| `FAMILY_GRAPH_SECRET` | `$FAMILY_GRAPH_HOME/secret.key` | Master/data/HMAC key file (mode 0600) |
| `FAMILY_GRAPH_WATCH_DIR` | `$FAMILY_GRAPH_HOME/watch` | Folder-watch input |
| `FAMILY_GRAPH_OUT_DIR` | `$FAMILY_GRAPH_HOME/out` | Folder-watch output |
| `FAMILY_GRAPH_PORT` | `3500` | TCP port |
| `FAMILY_GRAPH_BIND` | `127.0.0.1` | Bind address (loopback by default) |
| `FAMILY_GRAPH_AUTO_MERGE` | `0.92` | Auto-merge threshold for the resolver |
| `FAMILY_GRAPH_REVIEW` | `0.7` | Conflict-queue threshold for the resolver |
| `FAMILY_GRAPH_DISABLE_WATCH` | unset | Set to `1` to disable the folder-watch agent |
| `FAMILY_GRAPH_WATCH_PROCESS_EXISTING` | unset | Set to `1` to drain whatever is already in the watch dir at startup |
| `FAMILY_GRAPH_DISABLE_NOTIFY` | unset | Set to `1` to disable the notification dispatcher loop |
| `FAMILY_GRAPH_POSTMARK_TOKEN` | unset | Postmark server token for outbound email; never stored in the database |
| `FAMILY_GRAPH_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` \| `silent` |
| `FAMILY_GRAPH_LOG_FILE` | `$FAMILY_GRAPH_HOME/logs/server.log` | JSON-lines log file (mirrored to stderr) |

### Logging

Structured JSON logs (one object per line). Every HTTP response is
recorded with method, path, status, latency, actor, and IP. Auth failures
include a stable `reason` code (`no_bearer`, `token_mismatch`,
`unknown_or_revoked_scoped_token`, `missing_scope`, `non_loopback_origin`)
and, for mismatched tokens, a non-reversing 8-character SHA-256
fingerprint so repeated bad-token retries are correlatable. Unhandled
errors include the stack. The same `reason` field is returned to the
client in the JSON response body so the dashboard can show the operator
exactly which check rejected their token.

The redactor scrubs values for any field whose key matches a known
sensitive name (`authorization`, `token`, PII columns, etc.) before the
line is written, so logs are safe to share with collaborators or
auditors.

### Cross-platform notes

- Paths use `path.join` everywhere; macOS/Linux and Windows behave the
  same. On Windows, `~/.family-graph` resolves to `%USERPROFILE%\.family-graph`.
- `fs.mkdirSync(p, { mode: 0o700 })` and `fs.writeFileSync(p, … { mode: 0o600 })`
  are honoured on POSIX and silently ignored on Windows. On Windows the
  secret key file inherits the user-profile NTFS ACL — acceptable on a
  single-operator workstation; v2 will move keys to the OS keychain
  (Keychain on macOS, Credential Manager on Windows, libsecret on
  Linux). The on-disk JSON shape is keychain-compatible so the
  migration is mechanical.
- `npm run dev` uses a `node -r ./scripts/dev-env.js …` shim instead
  of the bash-only `VAR=value cmd` form, so it works in cmd and
  PowerShell as well as bash.
- Folder-watch (`chokidar`) uses native file events on Windows; keep
  `FAMILY_GRAPH_WATCH_DIR` on a local disk for reliability.

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

- **Key file** at `$FAMILY_GRAPH_HOME/secret.key`, mode 0600, written by the server on first boot.
  - `master`  — Bearer token for the PII surface
  - `dataKey` — AES-256-GCM key for PII-column ciphertext
  - `hmacKey` — HMAC-SHA256 key for searchable hashes
- **PII at rest:** every `_ct` column is `[version:1][iv:12][tag:16][cipher: variable]`. Null inputs pass through unchanged.
- **Searchable equality:** name lookups use `HMAC-SHA256(hmacKey, normalize(input))`. Email/phone/address dedup by `norm_hash`.
- **Token rotation:** `node bin/family-graph.js rotate-secret` regenerates the master Bearer token without touching `dataKey` or `hmacKey`. Apps re-fetch on next startup.
- **Backups:** `bin/family-graph.js backup [passphrase]` produces either a hot copy of the SQLite file (mode 0600) or, if a passphrase is given, an encrypted `.family-graph-backup` (gzip + AES-256-GCM with PBKDF2-derived key, 200k iterations).
- **Threat model (v1):** trusted single-operator desktop; any process that can read the secret file can read PII. Per-app scoped keys are a known v2 evolution.

> SQLCipher was deliberately not used. Application-layer column encryption gives
> the same "plaintext never lives in the file" guarantee without forcing a
> custom SQLite native build on every consumer. Migrating to SQLCipher later is
> a one-time copy-out; the ciphertext format is independent.

---

## API contract

All routes are JSON. PII routes require `Authorization: Bearer <master>`. Safe
routes are loopback-only, no token. The `X-Family-Graph-Actor` header identifies the
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
| `POST` | `/api/conflicts/assign` | bulk-assign open conflicts. Body: `{codes?: string[], all_open?: bool, assignee, ttl_hours: 4\|12\|24\|48\|72}` |
| `POST` | `/api/conflicts/:code/assign` | per-conflict assign. Body: `{assignee, ttl_hours}` |
| `DELETE` | `/api/conflicts/:code/assignment` | clear an assignment |
| `GET` | `/api/conflicts?assigned_to=…` | filter by assignee email; also `?assigned=unassigned\|assigned` |
| `GET` | `/api/notifications` | list outbound notifications (filter `?status` / `?kind`) plus the effective config |
| `POST` | `/api/notifications/dispatch` | force a dispatcher pass (otherwise runs every 60s) |
| `POST` | `/api/notifications/test` | enqueue a test message to a given email |
| `POST` | `/api/notifications/:code/retry` | requeue a failed notification |
| `POST` | `/api/notifications/:code/cancel` | cancel a pending notification |
| `POST` | `/api/sanitize` | replace names/emails/phones with codes; returns token-set code |
| `POST` | `/api/desanitize` | restore PII from a token set |
| `GET` | `/api/audit` | tier-1 + tier-2 events |
| `POST` | `/api/audit/external-export` | tier-2 export-consent event |
| `POST` | `/api/import/preview` | parse a file, return inferred mapping + canonical preview |
| `POST` | `/api/import/run` | run a batch import. Body: `{content, source?, mapping?, source_ref?, category?: 'church'\|'school'\|'other', tags?: string\|string[]}`. Returns `{import_run, rows, totals, results}` |
| `POST` | `/api/import/fetch-sheet` | fetch a Google Sheets URL as CSV. Body: `{url}`. Returns `{content, content_type, byte_len, final_url, source_ref}`. Strict allowlist: host must be `docs.google.com`; redirects must stay on `*.google.com` / `*.googleusercontent.com`. Audited as `sheet_fetch`. |
| `GET` | `/api/imports` | list past import runs (filter `?category=...`) |
| `GET` | `/api/imports/:code` | one run + the affected family/person/address codes |
| `POST` | `/api/identity/match` | external-app peek. Body: `{record}`. Returns `{action, confidence, reasons, definitive, candidate, thresholds}`. No write. |
| `POST` | `/api/identity/resolve` | external-app commit. Body: `{record, source?, source_ref?}`. Runs the resolver, returns `{code, action, score, reasons, conflict?}`. The calling app keys its domain data by `code`. |
| `POST` | `/api/identity/feedback` | external-app same/different decision. Body: `{left_code, right_code, decision: 'same'\|'different', winner_code?, notes?}`. `'different'` becomes a sticky non-match (suppresses future re-flagging). |

Aliases are followed transparently: `GET /api/families/:loser` returns the
surviving family's data with the surviving code in `family.code`.

---

## Identity resolver

The resolver lives in `server/identity/resolver.js` and uses the pure
matching primitives in `server/identity/matching.js` (vendored from
the upstream identity engine; see `session_notes.md` v9). The decision flow:

**1. Candidate gathering (`findCandidates`).** Block on every
deterministic signal we can hash:
- Family-name HMAC (suffix-aware: also tries the suffix-stripped base
  so `Smith Jr.` finds `Smith`).
- Each email's HMAC (joined through `person_emails`).
- Each phone's HMAC (each 10-digit number from `splitPhones` —
  concatenated `+13143...+13145...` becomes two hashes).
- Address HMAC (joined through `family_addresses`).
- Last-resort: given-name HMAC, only when nothing above hit.

Each candidate is enriched with its full email/phone/address history
so the scorer compares multi-value fields against multi-value
candidates.

**2. Scoring (`matching.scoreMatch`).** For each candidate:
- **Definitive signals (auto-merge at 0.95):**
  - Exact email
  - Exact phone
  - Exact name + exact DOB (promoted to definitive because child
    rosters frequently lack email/phone)
  - Address line1 ≥ 0.85 similarity AND a name overlap
- **Definitive vetoes** (cap below auto-merge):
  - Different states
  - Address similarity < 0.5
  - Different zips AND address-similarity < 0.7
- **Soft additive** (capped at 1.0):
  - Last name suffix-aware: exact +0.30, similar +0.20
  - First name compound/nickname/prefix-aware: exact +0.20, nickname
    +0.18, similar +0.10, phonetic +0.05
  - DOB exact +0.20 (bonus on top of definitive promotion)
  - Address similar (>0.65) +0.15
  - Zip match +0.05/+0.10
  - City match +0.05

**3. Decision gate (`decideMatch`).** Default thresholds:
- definitive OR confidence ≥ `autoMerge` (default 0.85) → attach (auto-merge)
- ≥ `review` (default 0.30) → enqueue conflict
- otherwise → create new person

Thresholds are tunable per institution via the `profiles` table.
`resolution_rules` (operator-curated) are applied as a final adjustment
to each candidate's score before the gate fires.

**4. Sticky decisions.** Before opening a new conflict, the resolver
checks `conflicts.hasStickyNonMatch(left, right)`. If the operator (or
an external app via `/api/identity/feedback`) previously decided the
pair is "different" (status `rejected` or `dismissed`), no new
conflict is opened. The decision survives forever unless explicitly
cleared. The `resolution_notes` column captures the operator's
free-form reason.

**5. Family attachment (`resolveOrCreateFamily`).** Two paths:
- Person-overlap: if ≥50% of incoming persons already belong to one
  existing family, attach there.
- Address-overlap: if no person overlap but the incoming address
  matches an existing family's primary address (line1 required to
  avoid false positives on shared cities), attach there. This is the
  "blended household / spouse keeping maiden name" case — same home,
  different first name, same family.

`rescorePerson(code)` re-runs the scorer for a single person — used
after manual edits.

**Critical correctness note.** The upstream identity engine collapses two persons with
unrelated first names at the same address into one person. Family
Graph does NOT - Mary Escamilla and John Torre at 123 Main St are a
couple, not duplicates. Address only becomes a person-merge signal
when paired with a name overlap; otherwise it's a family signal.

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

`server/folder-watch/index.js` watches `$FAMILY_GRAPH_WATCH_DIR` (chokidar,
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

Built with Vite + React 18, themed against the Institutional design
system (`CLAUDE_CODE_HANDOFF.md`). Routes:

- `/families` — list, create
- `/families/:code` — detail, edit, members (add/end), addresses, merge, split
- `/people` — list, create
- `/people/:code` — detail, edit, emails, phones, merge
- `/conflicts` — review queue (open/merged/rejected/dismissed) with merge-→-left, merge-→-right, reject, dismiss buttons
- `/import` — bulk import wizard (paste CSV or upload file → preview → run)
- `/imports`, `/imports/:code` — imports log + per-run detail
- `/export` — safe / PII export with consent + tier-2 audit
- `/sanitize` — interactive sanitize → AI → desanitize round trip
- `/audit` — filterable audit log
- `/notifications`, `/profiles`, `/keys`, `/settings`, `/rules`, `/search`

The Bearer token is stored in `localStorage` and prompted for on first
load. Vite's dev server proxies `/api/*` to `http://127.0.0.1:3500`.

### Shell anatomy

Every route renders inside the same shell:

1. **Status rail** (`<StatusRail/>`) — pinned to top, posture
   indicators (loopback / encrypted / audit-live), schema version,
   live counts. Polls `/api/health` every 5s. Goes red on loopback
   loss.
2. **Header** (`<Header/>`) — institution display name + meta +
   **PII ↔ Pseudonym** segmented toggle. Default = pseudonym;
   persisted to `localStorage`.
3. Sidebar (grouped: Operator / Ingest·Egress / Posture).
4. Main column — view content + footer.

### Pseudonym posture in the dashboard

When the toggle is set to *pseudonym*, list views (Families, People,
Search) fetch from the `/api/safe/...` surfaces; detail views redact
display names + addresses with `[pseudonym surface]` markers. The
dashboard never tries to pseudonymize on the client.

### Component vocabulary

- `<IdCode type="family|person|address|email|phone" code="…">` —
  type-coloured identifier, JetBrains Mono, prefix-inferred when
  `type` is omitted.
- `<Pill state="loopback|encrypted|pseudonym|pii|consented|muted">` —
  semantic posture pills only. Audit actions map to states:
  `external_export → consented`, `read_pii → pii`, `sanitize →
  pseudonym`, `boot/health → loopback`.
- `<ProvDot source="…">` — provenance dot using a separate palette
  from posture (FACTS, RenWeb, Ministry Platform, Sheets, CSV, Excel,
  other).
- `<StatusRail/>`, `<Header/>`, `<ViewToggle/>` — shell.

### File layout

```
client/src/
├── components/   # StatusRail, Header, ViewToggle, Pill, IdCode, ProvDot
├── styles/       # tokens.css, shared.css, app.css
├── store.js      # tiny pub/sub for the view toggle
├── api.js        # fetch wrapper; { safe } flag routes to /api/safe/...
└── views/        # Families, People, Conflicts, Imports, Audit, …
```

---

## Test surface

`npm test` runs **202 cases** (see `test_suite.md` for the full map)
across:

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

All 177 pass against `node:test` (Node 20+).

The dashboard does not ship with a separate unit-test suite in v1; the
`vite build` (`npm run client:build`) is treated as a structural test
that every component compiles, every import resolves, and every design
token is reachable. CI runs both `npm test` and `npm run client:build`.

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
