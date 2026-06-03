# Test suite

Two suites, both required green before merging:

1. **Server tests** — `npm test`. Built on Node's `node:test` runner; one
   subtest tree per `tests/*.test.js` file. **206 tests, all passing.**
2. **End-to-end browser tests** — `npm run test:e2e`. Playwright-driven.
   Boots an isolated Family Graph at `127.0.0.1:13500` against a temp
   `$FAMILY_GRAPH_HOME` and drives the React dashboard with the headless
   Chromium shell. **12 tests, all passing.**

Total: **218 tests, all green.** First-time setup for Playwright:
`npm run test:e2e:install` (downloads the headless-shell chromium build to
`/opt/pw-browsers/`).

This document is the canonical map of what's covered, where, and what each
test is asserting. New tests should land alongside the closest sibling and
get a one-line entry here so reviewers can see the coverage shape at a
glance.

## How to run

```sh
npm test                    # run everything
node --test tests/<file>    # run one test file
node --test --test-name-pattern="resolver >" tests/   # filter by name
```

The `tests/_helpers.js` module gives every suite a clean SQLite scratch DB
(`newDb`), fresh secrets (`newSecrets`), and the calibrated default thresholds
(`defaultThresholds()` → `{ autoMerge: 0.85, review: 0.30 }`). Every test
must clean up its temp directory in the `t.after` hook — running the suite
should leave no files behind.

---

## Suite-by-suite map

### `tests/sources.test.js` — CSV / Excel / Sheets ingest + matching primitives

Covers `server/sources/csv.js`, `server/sources/normalize.js`, the
vendor-specific handlers (FACTS, RenWeb, Ministry Platform), and the
matching primitives in `server/identity/matching.js`.

| Test | Asserts |
| --- | --- |
| `generic CSV inferred mapping` | `first_name`, `last_name`, `email`, `phone`, address fields auto-map; canonical persons + address materialize. |
| `FACTS shape` | School-roster rows produce 1 child + 2 parent persons under the same family display name. |
| `RenWeb shape` | StudentFirst/FatherFirst/MotherFirst columns produce the 3-person household. |
| `Ministry Platform shape` | Household_ID groups two contacts into one family. |
| `detection picks the right handler from headers` | `sources.detectSource` distinguishes FACTS / RenWeb / Ministry Platform / generic CSV. |
| `BOM-prefixed CSV is parsed` | UTF-8 BOM is stripped before column inference. |
| `empty rows are skipped` | csv-parse drops blank lines and our applyMapping drops rows with no person. |
| `full-name column splits when no first/last present` | "Mary Smith" / "John Q. Smith" split correctly into given/middle/family. |
| `"Last, First" full-name column splits correctly` | Quoted comma-separated names split family-first. |
| `spouse / husband / wife slots produce parent templates` | Spouse columns generate a second adult person template. |
| `headers, when nothing matches, produce zero persons (caller can detect)` | Unmapped headers return `headers` array so the UI can prompt for column mapping. |
| `scored auto-mapper picks specific over generic (Child First Name)` | "Child First Name" wins over "First Name" via global best-match. |
| `Excel serial DOB normalizes to ISO via applyMapping` | Excel serial 40179 → "2010-01-01" — critical for Sheets exports. |
| `concatenated phone splits into multiple values per person` | "+13143783612+13145607897" → `['3143783612', '3145607897']`. |
| `"Total" / "Grand Total" rows are dropped` | `summary_rows_dropped` counts and rows are excluded from canonical. |
| `mapping warning fires when no identity columns detected` | `mapping_warning` is set so the dashboard can refuse to import. |
| `matching > exact email match is definitive even with different last names` | scoreMatch returns `definitive=true`, confidence ≥ 0.95. |
| `matching > different states veto a definitive email match` | Cross-state email match caps confidence below auto-merge so the operator decides. |
| `matching > Tim/Timothy nickname match` | NICKNAME_GROUPS produces `nickname_or_short_form` reason. |
| `matching > Smith Jr. matches Smith (suffix-aware)` | NAME_SUFFIXES strips "Jr." before name comparison. |
| `matching > address match without name overlap stays soft (NOT a person-merge)` | Same-address different-name stays below auto-merge — the family resolver handles attachment. |
| `matching > address + matching last name = definitive person merge` | Address+name together promote to definitive. |
| `matching > "Timothy & Mary" matches Timothy` | Compound names split on `&`/`and`/`/` and match each part. |

### `tests/resolver.test.js` — auto-merge / conflict / create gate

Covers `server/identity/resolver.js`'s decision gate and how it interacts
with `matching.scoreMatch`.

| Test | Asserts |
| --- | --- |
| `exact name + DOB auto-merges` | Same first+last+DOB is treated as a person-level definitive signal. |
| `similar names without DOB go to conflict queue` | Mary/Marie (cross-language nickname) → review threshold. |
| `exact same name without DOB also goes to conflict queue` | Two Pio Pietrelcinas → enqueued (could be father+son). |
| `unrelated person is created` | No name/email/phone overlap → action='created'. |
| `family resolution attaches existing family when persons overlap` | Mary auto-merges via DOB; family resolver attaches Lucy to existing Smith family. |
| `rescore creates conflicts for new dupes` | Manually-created duplicate fires `rescorePerson` and opens a conflict. |
| `similarity edge cases` | empty, null, exact, fuzzy. |
| `exact email auto-merges across different last names (definitive)` | Email is a definitive signal; surname change does not block. |
| `address-only match auto-merges (same household, different last names)` | Different-name persons at same address attach to the SAME family (but stay separate persons). |

### `tests/identity-api.test.js` — external matching API

Covers `server/api/identity.js` — the surface sibling apps will
call into.

| Test | Asserts |
| --- | --- |
| `/match returns no candidate when registry is empty` | action='create', candidate=null. |
| `/match peeks an existing person via email (definitive)` | action='auto_merge', `definitive=true`, candidate.code returned. |
| `/resolve commits the match and returns the code` | action='attached', existing code returned. |
| `/resolve creates a new person when no candidate hits` | 201 + new `p_*` code. |
| `/feedback "different" makes a sticky non-match` | rescorePerson does NOT re-flag the pair after the operator marks them different. |
| `/feedback "same" merges the pair` | Pair merges with the supplied winner_code. |
| `/resolve persists profile fields on creation` | After resolve→PATCH the new profile fields (employer/title/do_not_contact/reason/not_living_together) round-trip through GET. |
| `conflicts api > resolve with notes persists resolution_notes` | A POST to /api/conflicts/:code/resolve with `notes` writes resolution_notes + resolved_by, and the closed conflict surfaces them on subsequent list calls. |

### `tests/api.test.js` — bulk do-not-call + family-list filter (added in v9.1)

| Test | Asserts |
| --- | --- |
| `family bulk do-not-contact flags every active member` | POST /api/families/:code/do-not-contact with `value:true, reason` flips do_not_contact + reason on every active member; `value:false` clears both. Counts updated members. |
| `/api/families?q= filters by member surname (HMAC equality)` | `?q=Smith` returns only families containing a member with family_name_hash matching the HMAC of "smith". Powers the Families list "search by last name" affordance. |

### `tests/identity.test.js` — core entity CRUD

Covers `people.js`, `families.js`, `contacts.js`, `aliases.js` for direct
construction, hashing, encryption, and merge behavior.

### `tests/import-runs.test.js` — bulk import accounting

Covers `server/identity/import.js` (`importBatch`) and the `import_runs`
table:
- `batch writes a run row with totals and code`
- `source_records inherit category/tags + import_run_code`
- `affectedEntities lists distinct family + person codes`
- `donation-shaped CSV with extra columns yields zero financial fact storage`
  (sanity that we ignore unknown amount/date/method columns)

### `tests/conflict-assignment.test.js` — TTL whitelist + assignment lifecycle

Covers `server/identity/conflicts.js`'s assign / unassign / sweep helpers:
- TTL whitelist enforcement (4/12/24/48/72h)
- `all_open` mode assigns every open conflict
- codes-mode skips already-resolved conflicts
- reassignment overwrites assignee + bumps expiry
- unassign clears + audits
- `sweepExpiredAssignments` clears past expiries and audits once
- list filter `?assigned=unassigned` excludes assigned rows

### `tests/notifications.test.js` — email queue + templating

Covers `server/notify/`:
- `assignTemplate` produces subject/text/html with TTL and link
- reminder/expired templates carry the link and counts
- enqueue inserts a pending row + audits
- assign enqueues an "assign" notification with TTL in subject
- `sweepExpiredAssignments` enqueues an "expired" notification per assignee
- `sendDueReminders` skips already-reminded conflicts

### `tests/api.test.js` — HTTP surface integration

Round-trips every protected endpoint through Express:
- health is open
- bearer enforcement (401/403 with reason codes)
- families/people CRUD via PII and `/api/safe/*` (pseudonyms)
- relationships
- conflicts list/get/resolve (`merge`/`reject`/`dismiss`)
- imports preview/run/get with category + tags
- audit log read + external-export consent
- search, sanitize/desanitize round-trip

### `tests/api-extensions.test.js` + `tests/extensions.test.js` — v1.x feature surfaces

- `/api/search` text/email/phone/code lookups with ACL safety
- `/api/membership-history/person/:code` and `family/:code`
- `/api/profiles` activate / list — threshold profiles
- `/api/keys` provision/revoke + scoped Bearer enforcement
- `/api/settings` master-only K/V store
- `/api/export` PII-vs-pseudonym + audit consent

### `tests/api-keys.test.js` — scoped Bearer tokens

- master token grants every scope
- scoped token rejects out-of-scope calls with `missing_scope`
- revoked token returns `unknown_or_revoked_scoped_token`
- scope validation on provision (only the documented scope names accepted)

### `tests/auth.test.js` + `tests/auth-reasons.test.js`

- localhost / loopback open routes
- non-loopback IP requires Bearer
- 401 reasons (`no_bearer`, `token_mismatch`, `unknown_or_revoked_scoped_token`,
  `missing_scope`, `expired_token`)

### `tests/audit.test.js`

- every mutating op writes an `audit_events` row
- consent rows for external exports include the consent banner

### `tests/encryption.test.js` — crypto

- AES-256-GCM round-trip
- ciphertext rejects on wrong version byte
- HMAC stable across runs (deterministic)
- normalizeName / normalizeEmail / normalizePhone / normalizeAddress all
  collapse expected variants to the same hash
- normalizeAddress expands "St"→"Street" before hashing (cross-import dedup)

### `tests/identifiers.test.js`

- `newCode` produces well-formed prefixed codes
- `isValidCode` enforces prefix + length + charset
- collision-resistance smoke test (10k codes, no duplicates)

### `tests/secret.test.js` — keystore

- master key file is created with mode 0600 on first start
- subsequent starts read the existing key
- corrupted key file refuses to load (no silent regeneration)

### `tests/log.test.js` — structured logging middleware

- request/error logger writes ndjson with reqId, status, duration
- audit-friendly paths redact PII fields by default
- error responses don't leak stack traces in production mode

### `tests/folder-watch.test.js`

- new file in the watch directory triggers `importBatch`
- file move / rename is treated as one event, not two
- malformed CSV is moved to `quarantined/` with audit
- watch state surface (`state.lastEventAt`, error counters)

### `tests/sheets-url.test.js`

- `parseSheetUrl` accepts only `docs.google.com`; rejects www., subdomain
  tricks, IP literals, non-https
- gid parsed from query AND fragment
- redirect chain capped at 5 hops; non-google hosts rejected
- 10MB body cap enforced
- HTML-instead-of-CSV (private sheet) surfaces a clear error
- 30s request timeout

### `tests/sanitize.test.js`

- `/api/sanitize` swaps PII for stable tokens, keyed by token-set code
- `/api/desanitize` reverses with the same token-set
- mismatched token-set returns 400 (never silently lossy)

### `tests/rules.test.js` — saved resolution rules

- `applyToScore` uses operator-curated rules to bump or veto a base score
- email-domain rule, postal-prefix rule, surname-allowlist rule
- inactive rules are skipped

### `tests/backup.test.js`

- `backup snapshot` produces a complete SQLite copy with audit row
- restore from snapshot replays migrations + verifies row counts
- backup encryption uses the same data key (no plaintext on disk)

### `tests/final-pass.test.js`

End-to-end "happy path" smoke: spin a full server, import a CSV, scan for
duplicates, resolve a conflict, verify the family detail surface, export
pseudonyms with consent. Catches integration regressions the unit suites
miss.

---

## End-to-end browser tests (`e2e/*.e2e.js`)

Driven by Playwright. The Playwright `webServer` boots a fresh Family Graph
under `/tmp/fg-pw-<pid>/` so the browser flows never collide with a
developer's running instance. `e2e/_setup.js` reads the master token out of
that home's `secret.key`, seeds it into localStorage, and flips the view to
`pii` so member rows render their human details (the product default is
pseudonym).

### `e2e/import.e2e.js`

| Test | Asserts |
| --- | --- |
| Preview panel surfaces diagnostic + disables Import on bad mapping | The /import page renders the diagnostic banner and the column mapper auto-opens when nothing matches. |
| Preview API: empty mapping triggers `mapping_warning` and `rows_with_persons=0` | Pure API contract: `mapping_warning` matches /No identity columns/, diagnostic counts are accurate. |
| Preview API: summary rows are dropped + `mapping_warning` stays null on a clean CSV | "Grand Total" line is filtered, real rows count, mapping_warning stays null. |
| Running an import lands rows + reports stats in the result panel | POST /api/import/run for two unique persons creates 2 persons; the new run shows up in the /imports list. |

### `e2e/conflicts.e2e.js`

| Test | Asserts |
| --- | --- |
| Resolution-notes textarea persists notes through reject | Operator types a note → clicks reject → switches to status=rejected → the saved note is rendered verbatim under the row. |
| Merging records the note alongside the merge | Same flow with merge: the note threads through to `conflicts.resolution_notes` and shows on the closed-conflict view. |

### `e2e/person-profile.e2e.js`

| Test | Asserts |
| --- | --- |
| Profile fields edit + persist | employer / title / do_not_contact / reason / not_living_together round-trip through the React form to the GET surface. |
| `do_not_contact` reason input only appears while checked | Reason field renders only when the DNC checkbox is checked; unchecking re-hides it. |

### `e2e/family-detail.e2e.js`

| Test | Asserts |
| --- | --- |
| Member rows surface DOB, age, profile flags; channels roll up | School-roster import → family detail → adult/kid roll-up in the panel header, "grade N" or "completed N · rising N+1" depending on date, both parents' emails listed under Contact channels. |
| "do not contact" flag shows as a pill on the member row | After a PATCH on one member, the row pill renders + employer chip renders. |
| Bulk do-not-call flags every active member | The do-not-call panel button bulk-flags every member with the supplied reason. |
| Families list > search by last name + quick "Add to do-not-call" | `?q=<surname>` filters the list server-side; the row's quick-action button + dialog reason apply do-not-call across the household. |

## What's NOT covered (known gaps)

- The Tauri/Electron desktop shell (CLAUDE_CODE_HANDOFF §5) hasn't been
  built yet — the dashboard runs only as the Vite-built SPA served by the
  Express process.
- The folder-watch tests use a hand-rolled FS event simulator rather than
  real `chokidar` events; on macOS specifically there's a watch-collapse
  edge case that's not exercised.
- `tests/identity-api.test.js` uses the master Bearer token and doesn't
  cross-test scoped tokens. We should add an `external_app` scope test
  asserting that `/api/identity/*` enforces the right scope split.

## Adding a test

1. Pick the closest sibling file. If you can't find one, create a new
   `tests/<feature>.test.js`.
2. Use `_helpers.js` for the DB / secrets / thresholds. Don't copy/paste
   bootstrap code.
3. Every test that creates a DB MUST register a `t.after(() => { db.close();
   cleanup(dir); })` cleanup. The runner catches leftover handles.
4. Add a one-line entry to this file in the right section.
5. Run `npm test`. The whole suite should stay green.
