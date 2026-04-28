# Custos — Session Notes

**Working journal. Decisions made, paths abandoned, reasoning preserved.**

---

| | |
|---|---|
| **Author** | Chris Treadaway, with Claude (web chat) |
| **Purpose** | Capture the reasoning behind v6 of the spec so future sessions don't re-litigate settled decisions |
| **Companion docs** | `business_spec.md`, `PRODUCT_SPEC.md` (v6), `ARCHITECTURE_MEMO_FAMILY_MANAGEMENT.md` |

---

## The arc, briefly

This project went through six full PRD revisions before landing. The spec started as "an anonymizer agent that runs locally and sanitizes data for AI" and ended as "a family registry that serves PII or pseudonyms on request, with anonymization as one feature." The path between those two points is worth preserving because every revision encoded a real decision, and reverting any of them would be a step backwards.

This is not a record of indecision. Every revision sharpened the product. The sequence reads like incremental clarity, not floundering.

---

## v1 — The original anonymizer concept

**What was speced.** A desktop app that ingests files, detects PII via regex + NER + optional LLM, replaces names with semantic pseudonyms (FAM_001-A, Person_A), routes sanitized payloads to public AIs, and de-tokenizes responses. Ships with multi-party sharing for owners and viewers. Tauri + Rust + Python sidecar.

**What we got right.** The three-layer detection model (regex, NER, optional LLM). The pre-send review screen as a security mechanism. The folder-watch agent pattern. The audit log requirement.

**What was wrong.** Architectural ambition outran the actual problem. Tauri + Rust meant a language boundary that complicated debugging. Multi-party sharing was a v2 feature dragged into v1. Semantic pseudonyms (FAM_001-A) were vulnerable to ordering attacks (a bad actor could derive family size and chronological order from the IDs).

**What we kept.** Three-layer detection. Pre-send review. Folder-watch. Audit log.

---

## v2 — Adding family grouping and PII configurability

**What changed.** Family grouping with shared family codes plus per-member suffixes. Configurable PII handling per type (tokenize, redact, partial-reveal, pass-through). Profile system (Catholic school, parish donor, medical, HR). Splink for entity resolution. Family review screen before tokenization.

**What we got right.** Family grouping is essential. Per-PII-type handling is essential. Profiles are the market-expansion lever.

**What was wrong.** Splink is overkill for v1 and adds a Python dependency. The "family code with member suffix" idea was still leaking ordering and family size. Tauri + Python sidecar deployment was getting heavier, not lighter.

**What we kept.** Family grouping concept. Profiles. Per-PII-type handling.

---

## v3 — Discovery of MissionIQ and the Node.js pivot

**The unlock.** Reading the MissionIQ repo revealed an existing, mature, modularized identity-resolution system written in Node.js + Express + SQLite. The whole architecture pivoted: the new project should match MissionIQ's stack, vendor MissionIQ's identity module, and use compromise + winkNLP for NER (pure JavaScript, no Python).

**What changed.** Stack swapped from Tauri + Rust + Python to Node.js + Express + SQLite + React. NER moved to pure JS (Presidio became optional). Family resolver vendored from MissionIQ. The desktop app shell was replaced with a folder-watch agent + small web dashboard at localhost:3500. Multi-party sharing pushed to v2.

**What we got right.** Matching MissionIQ's stack. Vendoring rather than re-implementing identity. The folder-watch + dashboard model. Pushing sharing to v2.

**What was wrong.** Family codes were still semantic (FAM_001-A pattern). Sessions were still treated as the primary unit, which doesn't fit a long-lived registry. The product was framed as "anonymizer with a registry" rather than "registry that anonymizes."

**What we kept.** All of the stack decisions. Folder-watch. Vendored identity module.

---

## v4 — The persistent identity store

**The shift.** The user said: "I don't really want to resolve the families every time I use an app. I want to resolve them once, then be able to revisit them if needed / make edits."

That single sentence flipped the architecture. The identity store became the spine of the product. Sessions became transient events that touch the store. Families and people live forever once added.

**What changed.** Persistent SQLite identity store as the core. Hex codes (originally still semantic). Edit, merge, split, alias operations. Dashboard became the primary interface. Backup and restore added because the store is now a long-lived asset.

**What we got right.** Persistence as the spine. The alias table for handling merges. Provenance tracking. Backup/restore as a v1 requirement.

**What was wrong.** Codes were still semantic (FAM_001-A). Person codes weren't yet first-class. The relationship to MissionIQ was still ambiguous (peer? source of truth? consumer?).

**What we kept.** Everything about persistence and the store.

---

## v5 — Stable non-semantic codes, source-specific handlers

**The corrections.** Two important user clarifications:

1. "Family codes should be assigned once and that's it. and they shouldn't start with FAM-001-A... just use a unique hexadecimal for them that does not identify them (for example, it should not use their first initials for example as that would give a clue to a bad actor)."
2. Source handlers should support FACTS, RenWeb, Ministry Platform (not ParishSOFT — different segment), Google Sheets, Excel, plus generic CSV.
3. Closed source for v1. Ship to St. Theresa first. Decide later.

**What changed.** Codes became fully non-semantic 8-character hex with type prefixes (`f_a7b3c91d`, `p_e4d2f8a1`). Ordering and family-size leaks eliminated. Source-specific handlers became their own subsystem in `server/sources/`. Bulk seed import wizard added as a v1 feature. Closed-source posture reflected throughout (no CONTRIBUTING, no CODE_OF_CONDUCT, README marked internal).

**What we got right.** The hex code design is the privacy fix that survived. Source handlers as a clean module. Closed-source for v1.

**What was wrong, but only in retrospect.** Person codes were still framed as "tokens generated during processing" rather than first-class registry citizens. The product was still framed as "anonymizer that happens to have a registry" rather than "registry that anonymizes." MissionIQ was still positioned as an upstream source rather than a downstream consumer.

**What we kept.** Hex code design. Source handlers. Closed source.

---

## v6 — The repositioning

**The realization.** Mid-conversation, the user clarified the intended usage: "this product is simply about creating the most accurate registry of information we can on the families itself. who is related to who, family composition, where they live, etc. we will leave any donor analysis and whatnot to missioniq."

Followed by: "I want to be clear that missionIQ and parentpoint MAY expose the PII inside those apps. those should be settings in those apps specifically. this code should expose BOTH PII and fully anonymized information but the app pulls what it needs."

**What changed.** Custos was repositioned. It's now the family registry, full stop. Anonymization is one consumer of the registry. MissionIQ and ParentPoint are downstream consumers. Family management is being extracted *out* of those apps and *into* Custos.

The API got a dual surface: PII endpoints (require Bearer token from OS keychain) and pseudonym endpoints (`/safe` suffix, loopback only). Two-tier audit logging: the registry logs its own events; consuming apps log external-export consent events back to the registry.

Custody and household complexity became first-class data, not afterthought. Multiple addresses per family. Custody designations (sole, joint, other guardian, unspecified). Full relationship taxonomy including godparents (Catholic-specific). Family-to-family links for divorced parents.

Person codes became first-class permanent identifiers. Family-membership history table added so person codes can stay stable when kids emancipate, families merge, or households split.

**What we got right.** Everything. v6 is the spec.

**What still needs to be settled in the build.**
- Final repo name (Custos is the working name; user said "I don't really care")
- Ministry Platform header signatures (need a real export to design auto-detection)
- Quasi-identifier detection aggressiveness
- Conflict queue SLA
- Backup encryption mechanism
- Family membership history retention policy
- Token rotation cadence

---

## Decisions that survived every revision

A few principles were present from the first conversation and never wavered:

- **Local-first.** Never hosted, never cloud, never SaaS in v1.
- **Open-source dependencies.** All MIT, Apache 2.0, BSD. No GPL or AGPL.
- **No telemetry, no analytics, no phone-home.** Period.
- **Audit log auto-redacts PII.** Logs never contain raw values.
- **Mappings encrypted at rest.** SQLCipher with OS-account-derived key.
- **Pseudonyms never re-issued.** Merged entries become aliases.
- **Family resolver inherits MissionIQ's existing rules.** Don't re-derive what already works.

---

## Decisions we revisited and changed our minds about

| Topic | Early decision | Final decision | Why we changed |
|---|---|---|---|
| Stack | Tauri + Rust + Python | Node.js + Express + SQLite + React | Discovered MissionIQ's stack; matching it removes a language boundary and lets us vendor identity logic |
| Pseudonym format | Semantic (`FAM_001-A`) | Non-semantic hex (`f_a7b3c91d`) | Semantic codes leak ordering and family size to bad actors |
| Multi-party sharing | v1 feature | v2 feature | Too much scope for v1; not blocking the core use case |
| Sessions vs persistent store | Session-scoped tokens | Persistent registry | User said "resolve families once, revisit as needed"; sessions don't fit that mental model |
| Relationship to MissionIQ | Peer / consumer of MissionIQ | Upstream of MissionIQ | The hub model is architecturally better; identity belongs in one place |
| Person identity | "Token" | First-class registry citizen with stable code and membership history | User explicitly asked for this in v6 conversation |
| License | Apache 2.0 from day one | Closed source for v1, decide later | Avoiding the obligations of open-source while validating the product |
| NER engine | Microsoft Presidio (Python) | compromise + winkNLP (JS), Presidio optional | Pure-JS deployment is meaningfully simpler |
| Name pattern within families | Family code with semantic suffix (FAM_001-A) | Family code AND independent person code; relationships in the data model | Cleaner separation; survives family changes |

---

## Decisions we walked back from completely

| Topic | Considered | Rejected because |
|---|---|---|
| Building a generic person registry as the headline | Spent meaningful conversation on this | User clarified the registration data comes from existing systems; Custos consumes, doesn't create |
| Time-aware logic (grade rollover, age computation, alumni transitions) | Almost speced into v5 | The systems Custos consumes from already do this; Custos shouldn't duplicate |
| Sacrament eligibility windows | Considered as a registry feature | Same reason; sacramental register is the system of record |
| Bitemporal event sourcing | Almost adopted in v5 | Overkill for the actual use case; family-membership history is enough |
| Point-in-time queries ("who was in grade 5 in 2024") | Considered as v1 feature | Same; out of scope |
| Custos as MissionIQ's database backend | Briefly considered | Tight coupling; failures cascade; chose API contract instead |
| Per-app scoped API keys | Discussed | Overkill for single-operator desktop; v2 evolution if threat model expands |

---

## What v6 is

A local-first family registry. Source of truth for who lives in what household, who is related to whom, and where they live. Serves PII to authenticated local apps. Serves pseudonyms to AI workflows and external recipients. Built on Node.js + Express + SQLite (encrypted via SQLCipher) + React. Vendors MissionIQ's identity module. Reuses MissionIQ's resolution rules. Closed source for v1, shipping to St. Theresa first.

The product is small enough to build well and ambitious enough to be foundational infrastructure for Chris's portfolio of Catholic institutional software.

---

## What's next, in order

1. **Build v6.** Use Claude Code. Build order is documented in v6 PRD (logging first, then store schema, then folder watch, then de-tokenization round-trip, then identity module, then conflict queue, then edits, then source handlers, then NER, then backup/restore, then bulk import wizard, then profiles).

2. **Deploy to St. Theresa.** One operator, real data, real workflow. Run for at least 30 days without data-integrity issues.

3. **Open-source decision.** Based on field experience. Default deferred until experience justifies a decision either way.

4. **MissionIQ migration PRD.** Per the architectural memo. Phased rollout starting with read-through cache, then new data authoritative, then backfill, then drop legacy tables.

5. **ParentPoint migration PRD.** Same phased pattern. Less work because ParentPoint's family management is less mature.

6. **Future apps.** Build on Custos from day one. No new app should re-implement family resolution.

---

## Things to remember when this comes back up

- Custos is the registry. Anonymization is a feature, not the headline.
- PII vs pseudonym is a posture, not just a technical surface. Every consuming app must respect it.
- Person codes are stable across family changes. Family-membership history is queryable, not just an audit-log entry.
- Pseudonyms are non-semantic hex. They leak nothing.
- The dual API surface (`/api/families/:id` vs `/api/families/:id/safe`) is implemented as separate route files in code, not a query parameter. Make the security boundary visible.
- The audit log captures both internal events (Tier 1) and external-export consent events from consuming apps (Tier 2).
- Bearer token auth is shared local secret in v1. Per-app scoped keys are a known v2 evolution.
- Ministry Platform is the parish system to support, not ParishSOFT. Different segment.
- Custos is closed source for v1. The decision to open-source comes after field experience.
- Claude Code, not me, builds this. The PRD is detailed enough that Claude Code can execute against it.

---

## v6 → v1 build session (Claude Code, 2026-04-27)

The first end-to-end implementation pass against the v6 spec. Goal: produce a
shippable v1 with no shortcuts and no deferred subsystems. The output of this
session is the code currently in this repo plus the new `product_spec.md`.

### What got built, in order

1. **Database schema.** `server/db/schema.sql` lays out families, persons,
   memberships (with started_at/ended_at history), addresses (multi),
   emails/phones, relationships (with valid kinds + symmetric back-refs),
   aliases, source_records + provenance, conflicts, resolution_rules,
   token_sets, audit_events (tier-1 + tier-2), profiles, settings.
   Foreign keys + WAL on. Schema is idempotent; `schema_version` table is
   the migration record.
2. **Identifiers.** `server/crypto/identifiers.js` produces non-semantic
   8-hex-char codes per kind. Disambiguation tested for `addr_` vs `a_`-style
   prefixes (the longest-prefix-first sort matters).
3. **Crypto layer.** AES-256-GCM column ciphertext + HMAC-SHA256 search hashes
   in `server/crypto/encryption.js`; key file in
   `server/crypto/secret.js` (mode 0600, three keys: `master`, `dataKey`,
   `hmacKey`). Tamper detection covered by tests.
4. **Auth.** Bearer + loopback-only middlewares in
   `server/auth/middleware.js`. Constant-time token comparison; loopback
   accepts `127.0.0.1`, `::1`, `::ffff:127.0.0.1`.
5. **Identity.** Families, persons, contacts, relationships, aliases, plus a
   merge that re-points memberships, contacts, relationships, and provenance
   in a single transaction. Split creates a new family and ends source
   memberships with `reason='split'`.
6. **Resolver.** Levenshtein-based per-field similarity with weighted scoring
   (family 0.45, given 0.35, DOB 0.20). Auto-merge ≥ 0.92, conflict-queue
   ≥ 0.7. Family attachment by membership majority. `rescorePerson` exists
   for manual edits.
7. **Source handlers.** FACTS, RenWeb, Ministry Platform, Google Sheets
   (CSV), Excel, generic CSV. Header inference covers ~30 aliases per field.
   Auto-detection by headers; operator can pin `source` explicitly.
8. **Sanitize/desanitize.** Three-layer NER: regex (email/phone/SSN/DOB/
   address), registry-driven HMAC matches against active-person hashes, and
   capitalized-token heuristic. Token-set mappings are AES-256-GCM
   ciphertext at rest. Tested that the raw blob does not contain plaintext.
9. **Folder-watch agent.** chokidar with awaitWriteFinish, non-recursive,
   moves processed files to `out/processed/`, errors to `out/errors/`,
   never overwrites.
10. **Two-tier audit.** PII-redacting metadata serializer; tier-2 events
    record `destination + entity_codes + reason`.
11. **Backup.** Hot snapshot via better-sqlite3's `.backup()` API; optional
    AES-256-GCM + gzip wrapper with PBKDF2(200k iterations) from a
    passphrase. Wrong-passphrase rejection is verified.
12. **API.** Express, JSON-only, separate routers for safe vs PII surface.
    `X-Custos-Actor` header carries the consuming-app name into the audit
    log. Aliases are followed transparently — `GET /api/families/:loser`
    returns the survivor.
13. **Operator dashboard.** Vite + React 18. Routes for families, people,
    conflicts, import (preview + run), sanitize/desanitize round-trip,
    audit log. Bearer token kept in `localStorage`. Safe + PII surfaces are
    distinct in the UI as well as the API.
14. **CLI.** `bin/custos.js` wraps `start`, `rotate-secret`, `backup`,
    `restore`, `show-token`.

### Bugs found and fixed during the test pass

70 `node:test` cases were authored alongside the implementation. The first
full run had five failures, all real:

1. **Diacritic regex was a literal NUL-class, not a Unicode property class.**
   `[̀-ͯ]` was a copy-paste of the visible characters, not the U+0300–U+036F
   range. Replaced with `\p{M}+/gu`. Without this, `María` normalized to
   garbage and the resolver's HMAC blocking missed it.
2. **Phone regex didn't match `(415) 555-0100` after a space.** The leading
   `\b` requires a word/non-word transition, but `(` is non-word and a
   preceding space is also non-word. Replaced with a `(?<![\w-])` lookbehind
   and a tightened tail.
3. **The `/api/*` 404 handler was unreachable for unauthenticated callers.**
   `app.use('/api', bearer, sanitizeRouter)` meant the bearer middleware
   intercepted every unknown `/api/*` path and returned 401 before the 404
   handler could run. Split the sanitize router into two endpoints
   (`buildSanitize` and `buildDesanitize`) and mounted each at its specific
   path.
4. **Tests used `assert.notMatch`, which doesn't exist in `node:assert`.**
   The correct name is `assert.doesNotMatch`. Three tests fixed.
5. **Test expectation for `normalizeName('María-José')` was wrong.** After
   stripping diacritics the correct output is `'maria jose'`. Test corrected.

After fixes, all 70 cases pass. End-to-end smoke testing through curl
exercised: bearer rejection, bulk import (auto-detected resolver decisions,
including a deliberate near-duplicate that landed in the conflict queue),
PII vs safe surface differences, sanitize → desanitize round-trip,
tier-2 export consent, folder-watch CSV import (with file moved to
`processed/` and a sidecar summary written), and SPA fallback for the React
client.

### Settled in this build that the spec had left open

- Closed-source for v1 reaffirmed. No `LICENSE`, `CONTRIBUTING.md`, or
  `CODE_OF_CONDUCT.md` checked in. The `package.json` `license` field is
  `UNLICENSED`.
- Application-layer column encryption was chosen over SQLCipher to avoid
  forcing custom-build SQLite on every consumer. The format is forward-
  compatible with a SQLCipher migration if the threat model later requires
  it.
- The folder-watch sidecar format is `<stem>.import-summary.json` for
  imports and `<stem>.token-set.json` for sanitization output.
- The Bearer token is regenerated by `custos rotate-secret` without
  touching the data key, so existing ciphertext keeps decrypting after a
  rotation.
- Conflict-queue actions are: `merge` (with `winner_code`), `reject` (the
  pair is genuinely two distinct entities), `dismiss` (defer without a
  semantic claim).

### Open items (not blockers for v1)

- **OS-keychain integration.** File-based secret storage is the v1 path;
  the file format is keychain-compatible, so the migration is mechanical.

---

## v1.x extensions session (Claude Code, 2026-04-27, continued)

A second pass that promoted every v1.x deferral that wasn't explicitly v2
into v1 proper. The shape and posture of v1 didn't change; the surface
expanded.

### What was added

1. **Resolution-rule engine.** `server/identity/rules.js` validates and
   persists rules against the existing `resolution_rules` table; the
   resolver consults active rules and applies `auto_merge`, `never_merge`,
   `boost`, or `penalize` decisions before the threshold check. CRUD
   surface at `/api/rules`. Dashboard editor at `/rules`.
2. **compromise NER.** Added as the third layer of the sanitize detector,
   between the registry HMAC layer and the capitalized-token heuristic.
   Loaded lazily so removing the dependency leaves the rest of the system
   working.
3. **Per-app scoped API keys.** New `api_keys` table (sha256-hashed
   tokens, scope arrays). `auth/middleware.js` accepts both the master
   token and `sk_…` scoped tokens; scope is enforced per route. New scopes:
   `pii.read`, `pii.write`, `sanitize`, `audit.read`, `audit.write`,
   `import`, `rules.write`, `*`.
4. **HMAC-backed search.** `/api/search` answers exact normalized lookups
   for names (via `_hash` columns), emails, and phones. Substring scan
   over encrypted PII is deliberately unsupported because it would
   defeat the encryption-at-rest guarantee.
5. **Membership history.** `/api/membership-history/{person|family}/:code`
   returns every row including ended memberships with reason. Surfaced
   in the FamilyDetail dashboard view.
6. **Profiles activated.** Built-ins (`catholic_school`, `parish_donor`,
   `diocese`) seed on first boot. The active profile's thresholds
   override the resolver defaults at import time. `/api/profiles` +
   `/api/profiles/activate`. Dashboard at `/profiles`.
7. **Settings persistence.** Allow-listed keys (`institution_name`,
   `operator_name`, `audit_retention_days`, plus `custom.*` namespace).
   `/api/settings` and dashboard at `/settings`.
8. **Audit retention sweeper.** Daily `setInterval` triggers a sweep of
   tier-1 events older than `audit_retention_days`. Tier-2 events are
   never swept — they are the operator's PII-export ledger and must
   persist.
9. **Numbered migrations runner.** `server/db/migrations/` with a runner
   that picks up `NNNN_*.sql` and `NNNN_*.js` files and applies them in
   order, updating `schema_version`. Schema version bumped to 2 to
   reflect the `api_keys` addition.
10. **Family-to-family relationships UI.** Add / list / remove via
    `/api/relationships`. Dashboard exposes the operations in the
    family detail page.
11. **Bulk export with consent gate.** `/api/export` with `mode=safe`
    (codes only) and `mode=pii` (requires `consent: true` + `destination`,
    records a tier-2 audit event). CSV/JSON.

### Bugs found and fixed during this pass

- **Audit `external-export` route shadow.** Mounting `buildAudit` at both
  `/api/audit` and `/api/audit/external-export` (with different scopes)
  caused the POST endpoint to be reachable at
  `/api/audit/external-export/external-export`. Split into `buildList`
  (GET) and `buildExternalExport` (POST `/`) and mounted each at the
  correct base path.
- **Search test expectation.** I expected hashing `'Mary'` would match
  both Mary Smith and Maria Smith via shared family-name hash. Mary's
  given-name hash matches one row, Smith's family-name hash matches both.
  Test corrected.

After fixes: 103 / 103 `node:test` cases pass. End-to-end smoke run
confirmed scoped tokens reject writes (403), wrong-scope tokens reject
audit-export attempts (403), built-in profiles seed on boot, the schema
migrates cleanly to version 2.

---

## Operational polish pass (Claude Code, 2026-04-28)

A third pass focused on operational hygiene rather than new features. The
goal was to make the system shippable in a way an operator can actually
manage day to day.

### What was added

1. **README.** Top-level operational doc covering install, CLI commands,
   folder-watch behaviour, env vars, and the security posture.
2. **Enriched health endpoint.** `GET /api/health` now reports active
   counts (families, persons, audit events, active api keys), the
   number of pending conflicts, the active profile, and the folder-watch
   state (enabled, dirs, files processed since boot). Both the dashboard
   sidebar and external monitors can rely on it.
3. **Sidebar conflict-count badge.** The dashboard polls `/api/health`
   every 15s. Open conflicts surface as a numeric badge next to the
   "Conflict queue" navigation item, and the sidebar footer shows
   active counts and folder-watch status.
4. **Backup CLI improvements.** `custos list-backups` lists files in
   `~/.custos/backups/` newest first; `custos prune-backups [keep=10]`
   keeps the most recent N and deletes older. `custos status` prints
   schema version, paths, counts, and backup-file count in one place.
5. **Audit log CSV export.** `GET /api/audit/export` produces a CSV
   suitable for compliance review or board reporting. Filterable by
   `action`, `actor`, `entity_code`.
6. **Import wizard mapping override.** The dashboard's preview step now
   exposes the inferred mapping in an editable JSON textarea; the
   subsequent `Run import` call sends that mapping verbatim, so an
   operator with non-standard column names can fix them in place
   without leaving the dashboard.
7. **Folder-watch process-existing flag.** `CUSTOS_WATCH_PROCESS_EXISTING=1`
   processes whatever is already in the watch dir at startup. Useful
   when files were dropped while Custos was down. Off by default so a
   fresh boot doesn't accidentally re-import older files.
8. **Audit recorder robustness.** The redactor now detects circular
   structures and replaces them with `[circular]`. The serializer
   clamps overlong metadata to 32 KB with a `truncated: true` sentinel.
   A misbehaving caller can no longer crash the recorder or fill the
   database with a single multi-MB blob.

### Tests

110 / 110 `node:test` cases pass. Seven new cases added covering:
- Circular metadata is recorded as `[circular]`, not crashing.
- Oversized metadata is truncated with a sentinel.
- The audit CSV export endpoint returns CSV with the expected header.
- Health reports active profile + counts + folder-watch state.
- `processExisting=true` consumes both CSV and text files left in the
  watch dir at startup.
- Default folder-watch start does NOT touch existing files.
- The `status` CLI shape compiles end to end.

### What still belongs to v2 explicitly

- OS-keychain-backed secret storage. (File-based with a keychain-compatible
  format ships in v1.)
- Multi-party sharing.
- Bitemporal point-in-time queries.

Everything else the v6 spec described is now in v1 and tested.

---

## Conflict assignment workflow (Claude Code, 2026-04-28, continued)

Field-driven addition: the operator wants to park open conflicts on a
colleague's email for review, and assignments must auto-expire after a
chosen TTL of 4, 12, 24, 48, or 72 hours so a stale parking spot doesn't
silently hide a conflict forever.

### What was added

- **Schema v3.** `conflicts` gains `assigned_to`, `assigned_at`, and
  `assignment_expires_at`. Migration `0003_conflicts_assignee.js` is a
  PRAGMA-checked `ALTER TABLE` that's idempotent for fresh and existing
  installs. Two indexes (`assigned_to`, `assignment_expires_at`).
- **Helpers in `identity/conflicts.js`.** `assign()` accepts either a
  list of codes or `allOpen: true`. The TTL is whitelisted to
  `{4, 12, 24, 48, 72}` hours; anything else is rejected at the helper
  boundary. The assignee must look like an email
  (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`); used as a label, not for delivery.
  Reassignment overwrites the assignee and bumps the expiry. Both events
  are auditable.
- **`sweepExpiredAssignments()`.** Clears `assigned_*` for any row whose
  `assignment_expires_at` has passed. Records a single
  `conflict_assignment_expired` event with the count and codes. Wired to
  fire every 15 minutes via `setInterval`, plus a one-shot run at boot
  so a process restart doesn't show stale assignments.
- **API.**
  - `POST /api/conflicts/assign` — body
    `{codes?, all_open?, assignee, ttl_hours}`. Translates snake-case
    `ttl_hours` to camel-case at the boundary.
  - `POST /api/conflicts/:code/assign` — per-conflict.
  - `DELETE /api/conflicts/:code/assignment` — clear.
  - `GET /api/conflicts?assigned_to=…&assigned=unassigned|assigned` —
    filter by assignee email or assignment state.
  - `GET /api/conflicts` now also returns `ttl_options` so the dashboard
    can render the dropdown without hardcoding the whitelist.
- **Dashboard.** Conflicts page gets a TTL dropdown
  (`4 | 12 | 24 | 48 | 72 hours`), an assignee email input, "Assign N
  selected" and "Assign ALL open" buttons, per-row checkboxes with
  "select all", and Assigned + Expires columns. The expires column
  shows minutes/hours and goes amber when within 4 hours.
- **Audit trail.** New events: `conflict_assign`, `conflict_unassign`,
  `conflict_assignment_expired`. Tier 1, redacted, swept by retention
  like the rest. The assignee is not PII as we use it (it's the
  colleague's organizational email), but if the operator is paranoid
  they can add `email` and `assignee` to the redactor's PII key list.

### Tests

124 / 124 pass. Fourteen new cases cover:
- TTL whitelist (rejects 1, 2, 3, 5, 6, 36, 100, 'four', null, NaN; accepts 4/12/24/48/72).
- Email-shape validator rejects every empty / malformed input.
- `all_open` assigns every open conflict; `expires_at` is within 5s of
  `now + ttlHours`.
- `codes` mode skips already-resolved (dismissed) conflicts.
- Reassignment overwrites assignee and bumps expiry.
- `unassign` clears columns and records a `conflict_unassign` event.
- `sweepExpiredAssignments` clears past-due rows and emits ONE audit row
  for the batch (not one per row).
- Sweeper with nothing expired is a no-op.
- `?assigned=unassigned` filter excludes assigned rows; `=assigned`
  excludes unassigned rows.
- API: `/assign` with `all_open`, `/assign` with bad `ttl_hours=10` → 400,
  `?assigned_to=…` filter, `DELETE /assignment` returns 204.
- Migration 0003 is idempotent on a fresh schema (running it twice
  doesn't throw "duplicate column").

### Bugs found and fixed

- **API key-name mismatch.** Helper expects `ttlHours`, the JSON body
  carries `ttl_hours`. The first version of the route spread `req.body`
  into the helper without translating, so the helper saw
  `ttlHours=undefined` and returned 400. Fixed at the route boundary
  by mapping each key explicitly.

---

## Postmark email notifications (Claude Code, 2026-04-28, continued)

Field-driven addition: when an operator assigns conflicts to a
colleague, the colleague should receive an email telling them to log in
and resolve, with the time-remaining and deadline. Operator picked
Postmark.

### What was added

- **Schema v4.** `notifications` queue table (code, kind, to_email,
  subject, body_text, body_html, related_codes, status, attempts,
  next_attempt_at, last_error, transport, provider_message_id,
  created_at, sent_at). `conflicts.reminder_sent_at` for de-duped
  reminder emails. Migration `0004_notifications.js` is idempotent for
  fresh and existing installs.
- **Postmark transport.** `server/notify/transports/postmark.js` posts
  directly to `https://api.postmarkapp.com/email` via Node's built-in
  HTTPS — no SDK dependency. Token comes from
  `CUSTOS_POSTMARK_TOKEN` (env var; never stored in the database). The
  `From:` address and message stream live in settings. 4xx (except 429)
  is treated as non-retryable; 429 and 5xx are retryable with
  exponential backoff (30s → 2m → 10m → 1h → 6h, capped at 5 attempts).
- **Log transport.** Default until Postmark is configured. Appends a
  JSONL line per message to `~/.custos/notifications.jsonl` so the
  operator can preview what *would* go out before flipping the
  transport to `postmark`.
- **Templates.** Plaintext + HTML for `assign`, `reminder`, `expired`.
  Subject + body include the count, the TTL, the human-readable time
  remaining, the hard deadline (UTC string), and a deep link to the
  recipient's filtered queue
  (`<dashboard>/conflicts?assigned_to=<email>`). **No PII**: family
  display names and person names never appear in the email — those
  remain behind the Bearer-protected dashboard.
- **Lifecycle hooks.** `assign()` enqueues an `assign` notification on
  every successful assignment. `sweepExpiredAssignments()` enqueues
  one `expired` notification per affected assignee (batched, not one
  per conflict). `sendDueReminders()` enqueues a single `reminder`
  notification per assignee whose batch has < `notifications.reminder_hours`
  remaining and stamps `reminder_sent_at` so the same assignment is
  never reminded twice.
- **Dispatcher.** A 60-second `setInterval` plus a one-shot at boot
  picks up `pending` rows whose `next_attempt_at` has elapsed and
  delivers them. Disabled with `CUSTOS_DISABLE_NOTIFY=1`. When
  `notifications.enabled=false` in settings the dispatcher returns
  `{ skipped: true }` so the queue continues to accumulate harmlessly.
- **API.** `GET /api/notifications` (filterable by status/kind, returns
  the effective config minus the token), `POST /dispatch`, `POST /test`,
  `POST /:code/retry`, `POST /:code/cancel`.
- **Dashboard.** New `/notifications` page shows the configuration
  banner ("Postmark token: configured / missing — set
  CUSTOS_POSTMARK_TOKEN"), a test-send form, status filters, and the
  full audit trail with per-row retry/cancel.
- **Settings.** Added six allow-listed keys: `notifications.enabled`,
  `notifications.transport`, `notifications.reminder_hours`,
  `dashboard_url`, `postmark.from`, `postmark.message_stream`.

### Tests

139 / 139 pass. Fifteen new cases covering:
- Subject, body, and link in `assign` template (TTL, time-remaining,
  encoded `assigned_to`).
- Reminder + expired template shapes.
- Enqueue inserts a pending row + audit event.
- Calling `assign()` enqueues a notification with the correct count
  and TTL in the subject.
- `sweepExpiredAssignments()` enqueues one `expired` per assignee
  (batched).
- `sendDueReminders()` is idempotent: re-running doesn't re-remind a
  conflict that's already had `reminder_sent_at` stamped.
- Log transport writes a JSONL line and stamps `sent_at`.
- Dispatch is a no-op when `notifications.enabled=false`.
- A retryable failure increments `attempts` and sets `next_attempt_at`;
  retry resets the row to pending; cancel only works on pending.
- Postmark transport: outbound HTTPS request shape verified by
  hot-patching `https.request` (host, path, headers, payload). 5xx
  marks the error retryable; 4xx (non-429) does not; 429 does.
- Settings round trip for `notifications.*` keys.
- Privacy: assert that no `f_…` or `p_…` codes appear in the rendered
  email body.

### Configuration

Operator workflow on first boot:
1. Settings → set `dashboard_url`, `postmark.from`, `postmark.message_stream`.
2. Set `CUSTOS_POSTMARK_TOKEN=...` in the environment / launchd plist
   / systemd unit and restart Custos.
3. Settings → flip `notifications.enabled` to `true` and
   `notifications.transport` to `postmark`.
4. Notifications page → "Send a test" to verify Postmark accepts the
   request.
5. Conflicts page → assign workflow now triggers email automatically.

---

## Rename: Sanctus → Custos (Claude Code, 2026-04-28, continued)

The product is no longer called Sanctus. It is **Custos**. Clean break,
no backward-compat aliases — the product is pre-production and has no
external integrations yet, so a hard rename is cheaper than a
deprecation period.

### Surface area touched

- **CLI:** `bin/sanctus.js` → `bin/custos.js`. `package.json#bin` now
  publishes `custos`. The catch-all `npm` aliases in `package.json`
  (`rotate-secret`, `backup`, `restore`) were repointed at
  `bin/custos.js` since the original separate `bin/rotate-secret.js`
  / `bin/backup.js` / `bin/restore.js` files never existed; a `status`
  alias was added.
- **Environment variables:** `SANCTUS_*` → `CUSTOS_*` across the
  server, the CLI, the README, and tests:
    `CUSTOS_HOME`, `CUSTOS_DB`, `CUSTOS_SECRET`, `CUSTOS_PORT`,
    `CUSTOS_BIND`, `CUSTOS_WATCH_DIR`, `CUSTOS_OUT_DIR`,
    `CUSTOS_AUTO_MERGE`, `CUSTOS_REVIEW`, `CUSTOS_DISABLE_WATCH`,
    `CUSTOS_WATCH_PROCESS_EXISTING`, `CUSTOS_DISABLE_NOTIFY`,
    `CUSTOS_POSTMARK_TOKEN`, `CUSTOS_ENV`.
- **Default filesystem paths:** `~/.sanctus/` → `~/.custos/`. The
  default DB filename is now `custos.sqlite`. The encrypted backup
  extension is now `.custos-backup` (magic header bytes
  `CUSTOS1`). Existing `.sanctus-backup` files would no longer
  decrypt — fine, since none have been issued in production.
- **HTTP header:** `X-Sanctus-Actor` → `X-Custos-Actor`. Apps that
  identify themselves to the audit log set the new header.
- **Email subjects:** `[Sanctus]` → `[Custos]`. Body signature line
  updated. The deep link in templates points to `dashboard_url` as
  before; only the brand text changes.
- **Dashboard:** sidebar `<h1>Custos</h1>`, `<title>Custos</title>`,
  token-banner copy, and the "X is running" splash all updated.
- **Documentation:** README, `business_spec.md`, `product_spec.md`,
  `session_notes.md`, and `ARCHITECTURE_MEMO_FAMILY_MANAGEMENT.md`
  now read "Custos" throughout.
- **Source comments:** every `// Custos …` and SQL header comment
  swapped. Audit-log header comment swapped.
- **Lock files:** both `package-lock.json` and
  `client/package-lock.json` regenerated so the package name in
  the lock matches the new `name` field.

### Verification

- 139 / 139 `node:test` cases still pass after the rename.
- End-to-end smoke: `npm start`, `node bin/custos.js status`, `health`
  endpoint, scoped-token issuance, queued notification (subject
  `[Custos] Test notification`), and the `X-Custos-Actor` header all
  exercise cleanly.
- `grep -rIl --exclude-dir=node_modules --exclude-dir=.git
  --exclude-dir=dist 'sanctus\|Sanctus\|SANCTUS' .` returns zero
  matches.

---

*End of session notes*
