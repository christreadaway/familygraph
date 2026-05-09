# Family Graph — Session Notes

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

**What changed.** Family Graph was repositioned. It's now the family registry, full stop. Anonymization is one consumer of the registry. MissionIQ and ParentPoint are downstream consumers. Family management is being extracted *out* of those apps and *into* Family Graph.

The API got a dual surface: PII endpoints (require Bearer token from OS keychain) and pseudonym endpoints (`/safe` suffix, loopback only). Two-tier audit logging: the registry logs its own events; consuming apps log external-export consent events back to the registry.

Custody and household complexity became first-class data, not afterthought. Multiple addresses per family. Custody designations (sole, joint, other guardian, unspecified). Full relationship taxonomy including godparents (Catholic-specific). Family-to-family links for divorced parents.

Person codes became first-class permanent identifiers. Family-membership history table added so person codes can stay stable when kids emancipate, families merge, or households split.

**What we got right.** Everything. v6 is the spec.

**What still needs to be settled in the build.**
- Final repo name (Family Graph is the working name; user said "I don't really care")
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
| Building a generic person registry as the headline | Spent meaningful conversation on this | User clarified the registration data comes from existing systems; Family Graph consumes, doesn't create |
| Time-aware logic (grade rollover, age computation, alumni transitions) | Almost speced into v5 | The systems Family Graph consumes from already do this; Family Graph shouldn't duplicate |
| Sacrament eligibility windows | Considered as a registry feature | Same reason; sacramental register is the system of record |
| Bitemporal event sourcing | Almost adopted in v5 | Overkill for the actual use case; family-membership history is enough |
| Point-in-time queries ("who was in grade 5 in 2024") | Considered as v1 feature | Same; out of scope |
| Family Graph as MissionIQ's database backend | Briefly considered | Tight coupling; failures cascade; chose API contract instead |
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

6. **Future apps.** Build on Family Graph from day one. No new app should re-implement family resolution.

---

## Things to remember when this comes back up

- Family Graph is the registry. Anonymization is a feature, not the headline.
- PII vs pseudonym is a posture, not just a technical surface. Every consuming app must respect it.
- Person codes are stable across family changes. Family-membership history is queryable, not just an audit-log entry.
- Pseudonyms are non-semantic hex. They leak nothing.
- The dual API surface (`/api/families/:id` vs `/api/families/:id/safe`) is implemented as separate route files in code, not a query parameter. Make the security boundary visible.
- The audit log captures both internal events (Tier 1) and external-export consent events from consuming apps (Tier 2).
- Bearer token auth is shared local secret in v1. Per-app scoped keys are a known v2 evolution.
- Ministry Platform is the parish system to support, not ParishSOFT. Different segment.
- Family Graph is closed source for v1. The decision to open-source comes after field experience.
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
    `X-Family-Graph-Actor` header carries the consuming-app name into the audit
    log. Aliases are followed transparently — `GET /api/families/:loser`
    returns the survivor.
13. **Operator dashboard.** Vite + React 18. Routes for families, people,
    conflicts, import (preview + run), sanitize/desanitize round-trip,
    audit log. Bearer token kept in `localStorage`. Safe + PII surfaces are
    distinct in the UI as well as the API.
14. **CLI.** `bin/family-graph.js` wraps `start`, `rotate-secret`, `backup`,
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
- The Bearer token is regenerated by `family-graph rotate-secret` without
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
4. **Backup CLI improvements.** `family-graph list-backups` lists files in
   `~/.family-graph/backups/` newest first; `family-graph prune-backups [keep=10]`
   keeps the most recent N and deletes older. `family-graph status` prints
   schema version, paths, counts, and backup-file count in one place.
5. **Audit log CSV export.** `GET /api/audit/export` produces a CSV
   suitable for compliance review or board reporting. Filterable by
   `action`, `actor`, `entity_code`.
6. **Import wizard mapping override.** The dashboard's preview step now
   exposes the inferred mapping in an editable JSON textarea; the
   subsequent `Run import` call sends that mapping verbatim, so an
   operator with non-standard column names can fix them in place
   without leaving the dashboard.
7. **Folder-watch process-existing flag.** `FAMILY_GRAPH_WATCH_PROCESS_EXISTING=1`
   processes whatever is already in the watch dir at startup. Useful
   when files were dropped while Family Graph was down. Off by default so a
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
  `FAMILY_GRAPH_POSTMARK_TOKEN` (env var; never stored in the database). The
  `From:` address and message stream live in settings. 4xx (except 429)
  is treated as non-retryable; 429 and 5xx are retryable with
  exponential backoff (30s → 2m → 10m → 1h → 6h, capped at 5 attempts).
- **Log transport.** Default until Postmark is configured. Appends a
  JSONL line per message to `~/.family-graph/notifications.jsonl` so the
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
  delivers them. Disabled with `FAMILY_GRAPH_DISABLE_NOTIFY=1`. When
  `notifications.enabled=false` in settings the dispatcher returns
  `{ skipped: true }` so the queue continues to accumulate harmlessly.
- **API.** `GET /api/notifications` (filterable by status/kind, returns
  the effective config minus the token), `POST /dispatch`, `POST /test`,
  `POST /:code/retry`, `POST /:code/cancel`.
- **Dashboard.** New `/notifications` page shows the configuration
  banner ("Postmark token: configured / missing — set
  FAMILY_GRAPH_POSTMARK_TOKEN"), a test-send form, status filters, and the
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
2. Set `FAMILY_GRAPH_POSTMARK_TOKEN=...` in the environment / launchd plist
   / systemd unit and restart Family Graph.
3. Settings → flip `notifications.enabled` to `true` and
   `notifications.transport` to `postmark`.
4. Notifications page → "Send a test" to verify Postmark accepts the
   request.
5. Conflicts page → assign workflow now triggers email automatically.

---

## Rename: Sanctus → Family Graph (Claude Code, 2026-04-28, continued)

The product is no longer called Sanctus. It is **Family Graph**. Clean break,
no backward-compat aliases — the product is pre-production and has no
external integrations yet, so a hard rename is cheaper than a
deprecation period.

### Surface area touched

- **CLI:** `bin/sanctus.js` → `bin/family-graph.js`. `package.json#bin` now
  publishes `family-graph`. The catch-all `npm` aliases in `package.json`
  (`rotate-secret`, `backup`, `restore`) were repointed at
  `bin/family-graph.js` since the original separate `bin/rotate-secret.js`
  / `bin/backup.js` / `bin/restore.js` files never existed; a `status`
  alias was added.
- **Environment variables:** `SANCTUS_*` → `FAMILY_GRAPH_*` across the
  server, the CLI, the README, and tests:
    `FAMILY_GRAPH_HOME`, `FAMILY_GRAPH_DB`, `FAMILY_GRAPH_SECRET`, `FAMILY_GRAPH_PORT`,
    `FAMILY_GRAPH_BIND`, `FAMILY_GRAPH_WATCH_DIR`, `FAMILY_GRAPH_OUT_DIR`,
    `FAMILY_GRAPH_AUTO_MERGE`, `FAMILY_GRAPH_REVIEW`, `FAMILY_GRAPH_DISABLE_WATCH`,
    `FAMILY_GRAPH_WATCH_PROCESS_EXISTING`, `FAMILY_GRAPH_DISABLE_NOTIFY`,
    `FAMILY_GRAPH_POSTMARK_TOKEN`, `FAMILY_GRAPH_ENV`.
- **Default filesystem paths:** `~/.sanctus/` → `~/.family-graph/`. The
  default DB filename is now `family-graph.sqlite`. The encrypted backup
  extension is now `.family-graph-backup` (magic header bytes
  `FGRAPH01`). Existing `.sanctus-backup` files would no longer
  decrypt — fine, since none have been issued in production.
- **HTTP header:** `X-Sanctus-Actor` → `X-Family-Graph-Actor`. Apps that
  identify themselves to the audit log set the new header.
- **Email subjects:** `[Sanctus]` → `[Family Graph]`. Body signature line
  updated. The deep link in templates points to `dashboard_url` as
  before; only the brand text changes.
- **Dashboard:** sidebar `<h1>Family Graph</h1>`, `<title>Family Graph</title>`,
  token-banner copy, and the "X is running" splash all updated.
- **Documentation:** README, `business_spec.md`, `product_spec.md`,
  `session_notes.md`, and `ARCHITECTURE_MEMO_FAMILY_MANAGEMENT.md`
  now read "Family Graph" throughout.
- **Source comments:** every `// Family Graph …` and SQL header comment
  swapped. Audit-log header comment swapped.
- **Lock files:** both `package-lock.json` and
  `client/package-lock.json` regenerated so the package name in
  the lock matches the new `name` field.

### Verification

- 139 / 139 `node:test` cases still pass after the rename.
- End-to-end smoke: `npm start`, `node bin/family-graph.js status`, `health`
  endpoint, scoped-token issuance, queued notification (subject
  `[Family Graph] Test notification`), and the `X-Family-Graph-Actor` header all
  exercise cleanly.
- `grep -rIl --exclude-dir=node_modules --exclude-dir=.git
  --exclude-dir=dist 'sanctus\|Sanctus\|SANCTUS' .` returns zero
  matches.

---

## Windows / PowerShell runbook (Claude Code, 2026-04-28, continued)

A Windows section was added to `README.md` covering the install path
(Node 20 LTS via winget, Git, optional VS C++ build tools if the
prebuilt `better-sqlite3` binary doesn't pick up), per-session and
persistent env-var setting (`$env:VAR = …` vs
`[Environment]::SetEnvironmentVariable(…, 'User')`), running as a
service via NSSM, and the file-permission caveat (Node mode bits are a
no-op on Windows; v2 OS-keychain integration closes the gap).

One real Windows incompatibility found and fixed:

- **`package.json` `dev` script.** Was
  `"FAMILY_GRAPH_ENV=development node server/index.js"`, which is
  bash-only — fails on cmd and PowerShell because `VAR=value cmd` is
  not valid syntax outside POSIX shells. Replaced with
  `"node -r ./scripts/dev-env.js server/index.js"` (a tiny preload
  module sets `process.env.FAMILY_GRAPH_ENV` before the server boots). Now
  identical behaviour across bash, zsh, cmd, PowerShell 5.1, and
  PowerShell 7.

`product_spec.md` gained a "Cross-platform notes" subsection covering
path handling, file-mode behaviour, and the dev-env shim.

The 139-case `node:test` suite continues to pass after these changes.

---

## Rename: Custos → Family Graph + structured logging (Claude Code, 2026-04-28, continued)

Operator renamed the product. Clean break, same as the Sanctus → Custos
swap before it. Also added structured logging because the operator hit
an unfixable-from-the-UI auth issue (stale token in browser localStorage
masking a fresh paste) and we couldn't see why from the server side.

### Rename surface

- CLI: `bin/custos.js` → `bin/family-graph.js`. `package.json#bin`
  publishes `family-graph`.
- Env vars: every `CUSTOS_*` → `FAMILY_GRAPH_*` plus two new ones for
  logging (`_LOG_LEVEL`, `_LOG_FILE`).
- Default home: `~/.custos` → `~/.family-graph`.
- DB filename: `custos.sqlite` → `family-graph.sqlite`.
- Backup magic: `CUSTOS1` → `FGRAPH01`.
- HTTP header: `X-Custos-Actor` → `X-Family-Graph-Actor`.
- Email subjects: `[Custos]` → `[Family Graph]`.
- Dashboard: `<title>`, sidebar `<h1>`, token banner.
- localStorage key: `custos.bearer` → `family-graph.bearer` — which
  conveniently fixed the operator's stuck-on-stale-token issue, since
  the browser starts fresh under the new key.
- Docs: README, business_spec, product_spec, session_notes,
  ARCHITECTURE_MEMO_FAMILY_MANAGEMENT.
- The git-clone URL in the README still points at
  `github.com/christreadaway/custos.git` because the GitHub repo wasn't
  renamed; we clone it into a `family-graph` working copy.

Two sed artifacts cleaned up after the bulk replace:

- `X-Custos-Actor` had become `X-Family Graph-Actor` (broken hyphen +
  space). Restored to `X-Family-Graph-Actor`.
- `nssm install Custos …` had become `nssm install Family Graph …` —
  service name with a space breaks NSSM's argument parsing. Switched
  to `family-graph` (kebab) for the service name.

### Structured logging

New `server/log/index.js` plus `server/log/middleware.js`:

- **Output:** JSON-lines, one object per call. Stderr always; file
  copy to `$FAMILY_GRAPH_HOME/logs/server.log` by default
  (`FAMILY_GRAPH_LOG_FILE` overrides). `appendFileSync` rather than a
  write stream so tail-readers and tests see output without buffering
  latency.
- **Levels:** `debug` / `info` / `warn` / `error` / `silent`, filtered
  by `FAMILY_GRAPH_LOG_LEVEL` (default `info`).
- **Redaction:** values for keys named `authorization`, `token`,
  `master`, `secret`, `password`, plus the standard PII columns
  (`name`, `first_name`, `email`, …) are replaced with `[redacted]`
  before serialisation. Circular structures get a `[circular]`
  sentinel. JSON.stringify failures fall back to a sentinel object
  rather than crashing.
- **Request middleware** wraps `res.once('finish')` to log `method`,
  `path`, `status`, `ms`, `actor`, `ip`. 4xx logged at warn, 5xx at
  error.
- **Auth middleware** rewritten to log structured `auth.reject` /
  `auth.ok` lines with a `reason` code and (for mismatched tokens) a
  non-reversing 8-character SHA-256 fingerprint. The same `reason` is
  now returned in the JSON response body so the dashboard can show it
  to the operator.
- **Error middleware** records the stack of any unhandled exception
  before the generic 500 response is sent.

### Dashboard auth UX

`client/src/api.js`:

- Any 401/403 fires a `family-graph:auth-failed` `CustomEvent` carrying
  the server's `reason`/`detail`.
- New `validateToken()` helper that hits `/api/families` purely to
  prove the saved token actually works.

`client/src/App.jsx`:

- Listens for `family-graph:auth-failed`, clears the saved token, and
  re-shows the banner.
- The banner save handler validates the pasted token before treating
  it as valid; a bad paste no longer silently sticks.
- The banner shows a human-readable hint per `reason` code
  (e.g., `token_mismatch` → "the token saved in this browser doesn't
  match the server. Run `node bin/family-graph.js show-token` …").
- "Verifying…" state on the Save button while the round-trip happens.

### Tests

151 / 151 pass. Added:

- `tests/log.test.js` (6 cases): JSON shape, level filtering, redaction
  including arrays + nested + circular, file-mirror output.
- `tests/auth-reasons.test.js` (6 cases): every rejection path returns
  the right `reason` code; master token still works clean;
  `tokenFingerprint` is stable + non-reversing.

### Bugs found and fixed in this pass

- **Auth response disagreed with the auth log.** The middleware logged
  `unknown_or_revoked_scoped_token` for `sk_*` tokens not found in
  `api_keys`, but the response body always returned
  `reason: 'token_mismatch'` because of an unconditional fall-through.
  The test caught it. Split the scoped-token branch so the response
  matches what the log says.
- **Log file was buffered behind a write stream.** Tests reading the
  file straight after emitting saw nothing, because the stream
  flushes asynchronously. Switched to `appendFileSync` per line —
  simpler, observable immediately, well within budget at our log
  volume.

---

## Source tagging + per-import summary (Claude Code, 2026-04-28, continued)

Operator sketched three things they wanted: (1) source tagging with a
church/school category and free-form tags, (2) Google Sheets URL
ingestion, (3) ingest donation-shaped files but **don't** turn Family
Graph into a donor-analysis tool — money lives in MissionIQ. Plus a
follow-up: a per-import summary screen showing what the latest file did.

We dropped (2) (URL fetch out of scope for now), kept (1) and the
"identity-only ingestion of donation files" flavour of (3), and added
the import-run summary.

### Schema v5

Migration 0005 (`server/db/migrations/0005_source_tagging.js`):

- `source_records` gains `category`, `tags` (JSON array), and
  `import_run_code` columns + indexes.
- New `import_runs` table holds per-batch totals: rows,
  families_created/attached, persons_created/attached/enqueued,
  conflicts_opened, addresses/emails/phones attached, memberships
  opened/ended, plus actor + category + tags + source.

The bootstrap schema declares the same shape so fresh installs and
upgrades from v4 are equivalent.

### Pipeline + API

`server/identity/import.js`:

- `importRow` accepts `category` / `tags` / `importRunCode` and writes
  them into the source_records row. It now returns a `stats` object
  per row (counts of every effect).
- `importBatch` opens an `import_runs` row first, accumulates per-row
  stats inside the existing transaction, then UPDATEs the import-runs
  row with the totals. Audits `import_run` with the totals.
- New helpers: `getImportRun`, `listImportRuns`, `affectedEntities`
  (joins provenance against the run's source_records to list every
  distinct entity the run touched).

`server/api/import.js`:

- `POST /api/import/run` accepts `category` (allow-list:
  `church`/`school`/`other`) and `tags` (string or array). Returns
  `import_run` code + `totals` + per-row results.
- 400 on unknown category.

`server/api/imports.js` (new):

- `GET /api/imports` lists runs newest-first; filterable by `?category`.
- `GET /api/imports/:code` returns the run row + affected-entities list.

Folder-watch updated to use the new `importBatch` return shape and to
pass `category`/`tags` if the operator-provided opts include them.

### Dashboard

- **Import wizard** gets a Category dropdown (church/school/other) and
  a free-form Tags input (comma-separated). After "Run import",
  the page shows a stat-pill bar with families/persons created vs.
  attached, conflicts opened, etc., a deep link to the conflict queue
  if the run produced any conflicts, and a per-row outcome table.
- **Imports log** at `/imports` lists every past run with a row of
  stat tags. Click into `/imports/:code` for the run detail with the
  affected entities grouped by field (family / person / address) and
  linked to their detail pages.

### Donation-file posture

Family Graph still does not record dollar amounts, dates of donation,
payment methods, or aggregations. If the operator imports a donation
CSV, the resolver picks up identity (name, email, address) from the
recognised columns and ignores everything else. The file's `category`
and `tags` survive on every source_record so the operator can later
trace "Mary Smith first appeared in our church Q1-2026 donor list".
There is no `domain_events` table, no `amount_cents` column, no
running totals. A test asserts that.

### Tests

160 / 160 pass. Nine new cases in `tests/import-runs.test.js` cover:

- importBatch writes a run with correct totals.
- source_records inherit category + tags + import_run_code.
- affectedEntities lists distinct family/person/address codes.
- Donation-shaped CSV with extra columns is parsed identity-only;
  asserts there is no `domain_events` table to query.
- API rejects unknown category, accepts comma-separated tags string,
  returns import_run + totals.
- Listing and filtering /api/imports by category.
- /api/imports/:code returns affected entities.
- Migration 0005 is idempotent on a fresh schema.

One real bug found and fixed during the pass: changing `importBatch`'s
return shape broke the folder-watch agent (it expected an array of row
results; now it gets `{ importRunCode, totals, results }`). Updated the
folder-watch summary writer to match.

---

## Google Sheets URL ingestion (Claude Code, 2026-04-28, continued)

Operator changed their mind on the previously-skipped point (2): they
do want Sheets URL ingestion. Built it carefully because pulling
arbitrary URLs from a server is the classic SSRF foot-gun.

### What landed

- `server/sources/sheets-url.js`:
  - `parseSheetUrl(url)` strict: requires `https`, host exactly
    `docs.google.com`, path matching
    `^/spreadsheets/d/<id>(/<subpath>)?/?$`. We construct the
    `/export?format=csv` URL ourselves rather than fetching the user's
    URL directly. `gid` is read from `?gid=` or `#gid=`.
  - `fetchSheetCsv(url)`: manual redirect handling up to 5 hops; each
    hop must be `https` to `docs.google.com`, `*.google.com`, or
    `*.googleusercontent.com`. IP-literal hosts are rejected. 30 s
    request timeout. 10 MB body cap. Non-CSV `content-type` is
    rejected with a clear "make the sheet shared with anyone with the
    link" message — Google returns HTML on auth-walled access.
- `POST /api/import/fetch-sheet` — Bearer + `import` scope. Returns
  `{ content, content_type, byte_len, final_url, source_ref }` so the
  operator can feed the same content into the existing
  `/api/import/run` flow without changing that endpoint's contract.
  Each fetch (success or failure) writes one `audit_events` row with
  `sheet_id`, `gid`, `final_url`, and `byte_len`. Body content never
  appears in the audit log.
- Dashboard Import wizard now has a "Pull from a Google Sheets URL"
  panel above the paste box. Paste link → click Fetch → the CSV
  populates the box and the source/source_ref fields. Then preview /
  run as before.

### Tests

177 / 177 pass (17 new):

- Parser accepts `/edit`, `/edit?gid=`, `/edit#gid=`, `/export?format=csv`.
- Parser rejects non-`docs.google.com` hosts (including
  `docs.google.com.evil.com`, `www.docs.google.com`, `google.com`,
  `docs.google.co`), `http`, `javascript:`, `file:`, non-sheet
  paths, and `format=xlsx`.
- `_hostAllowedForRedirect` accepts `*.google.com` and
  `*.googleusercontent.com`, rejects IP literals + arbitrary hosts +
  case is normalised.
- Mocked `https.request`: 200 returns CSV body; 302 to allowlisted
  host follows; 302 to `attacker.example.com` aborts with
  "disallowed host"; 302 to http downgrades aborts with "non-https";
  401/403 yields the actionable share-access message; HTML response
  body (auth wall) yields "did not return CSV"; >5 redirects aborts.
- API integration: `POST /api/import/fetch-sheet` happy-path
  (returns CSV + audits sheet_fetch); rejects non-google URL with
  400; end-to-end fetch → run produces an `import_run` with the
  expected totals.

### Posture notes

- Sheet must be shared "Anyone with the link can view" for v1. OAuth
  flow is the planned v2 path. Private-org sheets work today via the
  existing manual download → paste path.
- The audit log records the sheet ID and final URL but not the
  pulled body. If an operator wants to know exactly what was
  ingested, they can re-fetch the same URL.
- The fetch happens with `User-Agent: family-graph/1.0`. No cookies,
  no auth headers, no referrer. Family Graph's identity is plain in
  the request.

---

## Doc sync (Claude Code, 2026-04-28, continued)

Audit of all five `.md` files at the end of the session.

- **README.md**: brought up to speed. Added the `X-Family-Graph-Actor`
  header convention + the `reason`-code vocabulary in the API summary.
  Sheets-URL section, source-tagging section, imports-log section,
  Postmark section, Windows runbook, logging section all already
  current.
- **product_spec.md**: full route table includes
  `/api/import/fetch-sheet`, `/api/imports`, `/api/imports/:code`,
  `/api/conflicts/assign`, `/api/notifications/*`, `/api/keys`. Logging
  section + cross-platform notes + env-var table all current.
- **business_spec.md**: branded as Family Graph; no stale Sanctus or
  Custos references. The "Family Graph does NOT do donor analysis"
  posture remains accurate — we ingest donation files identity-only,
  no amounts persisted.
- **session_notes.md**: ten dated entries from v1 build through this
  doc sync; each entry covers what was added, what bug was caught by
  the tests, and what was deferred.
- **ARCHITECTURE_MEMO_FAMILY_MANAGEMENT.md**: rewrote the
  Authentication section. The original said "per-app scoped keys are
  out of scope for v1" — but we shipped them. New section documents
  the master-vs-scoped token shapes, the
  `X-Family-Graph-Actor` header contract, the `reason` vocabulary
  (consuming apps can branch on it), and the v2 evolutions
  (OS-keychain storage + per-record-group capability tokens).

No code or test changes in this pass. 177/177 tests still pass.

---

## Dashboard reskin — Institutional design system (Claude Code, 2026-04-28)

The design team dropped seven files into the repo root —
`CLAUDE_CODE_HANDOFF.md`, `tokens.css`, `shared.css`, `overview.jsx`,
`fg-data.js`, `Home Overview.html`, and the printable
`Family Graph - Institutional Design System.html`. This session
applied them to the live `client/`. Branch:
`claude/reskin-app-design-v8SjA`.

### What landed

- **Design tokens.** `tokens.css` and `shared.css` copied to
  `client/src/styles/`. A new `app.css` adds the app shell
  (`.app`, `.sidebar`, `.main`), form-control styling, custom
  8px scrollbars (Windows parity per handoff §5.5), and a
  *compat layer* that maps the old `.panel`, `.tag`, and
  `<code>` markup to the new tokens. The compat layer means
  every view inherits the institutional look on day one even if
  it hasn't been individually migrated to the new component
  vocabulary.
- **Shared components** in `client/src/components/`:
  `<StatusRail>` (polls `/api/health` every 5s, posture dots,
  red on loopback loss), `<Header>` (institution + meta + view
  toggle), `<Pill state="…">` (semantic posture only),
  `<IdCode type="…">` (type-coloured identifier, prefix-inferred),
  `<ProvDot source="…">` (provenance palette, distinct from
  posture), `<ViewToggle>` (PII ↔ Pseudonym segmented toggle).
- **Tiny store** at `client/src/store.js` for the view toggle.
  No zustand dependency; just `useState` + a pub/sub set, plus
  `localStorage` persistence with `pseudonym` as the default.
- **API plumbing.** `listFamilies`, `getFamily`, `listPeople`,
  `getPerson` now accept `{ safe: true }` so the toggle can
  route list views to `/api/safe/...` in pseudonym mode. The
  client never tries to pseudonymize on its own.
- **Reskinned views.** Conflicts, Imports (list + detail),
  AuditLog, Search, Families, People migrated to the new
  components. FamilyDetail and PersonDetail switched their
  `<code>` references to `<IdCode>` and gained pseudonym
  redaction for display names and addresses.
- `client/src/styles.css` deleted.

### Acceptance state (CLAUDE_CODE_HANDOFF.md §10)

12 of 14 boxes pass. The two that don't:

1. *Native window decorations on each OS.* Deferred to the
   Tauri-shell milestone — the design contract says everything
   *below* the title bar must be identical, and that's what
   shipped.
2. *Fonts bundled as WOFF2; zero font requests.* Currently
   pulled from Google Fonts via `@import` in `app.css` so the
   type system reads correctly without bundled assets in dev.
   The system-font fallback chain matches if the network is
   absent. Bundling lands with the desktop shell.

The remaining DPI / pixel-diff box reads as "pending desktop
shell QA."

### Tests + verification

- `vite build` — clean, 60 modules, 241 kB JS / 71 kB gzip,
  15 kB CSS / 3.5 kB gzip.
- `npm test` — 177/177 server tests pass.
- Runtime smoke against a live server: booted
  `node server/index.js`, hit `/api/health`,
  `/api/families`, `/api/safe/families`, `/api/people`,
  `/api/safe/people`, `/api/conflicts?status=open`,
  `/api/audit`, `/api/imports`, `/api/profiles`,
  `/api/settings`. Seeded a CSV import and confirmed
  `/api/imports` returned the expected `import_runs` row plus
  matching `audit_events` entries. All client modules transpile
  through Vite (HTTP 200 for every `/src/...` URL).

### Posture notes

- Pseudonym remains the default operator view. The toggle
  swaps the surface, not just the rendering: list views fetch
  from `/api/safe/...` so the PII column ciphertext never
  decrypts when nobody asked for it.
- Posture pills are reserved for posture states. Arbitrary
  tags (categories, free-form labels) use `state="muted"` so
  the operator can still tell at a glance "this is a
  classification" vs. "this is a state."
- Provenance dots are deliberately on a different palette from
  posture. The operator should never confuse "where the data
  came from" with "what state it's in."

### Doc sync

`README.md`, `product_spec.md`, and this file were updated in
the same pass. `CLAUDE_CODE_HANDOFF.md` got a status header at
the top and a re-checked §10. `business_spec.md` and
`ARCHITECTURE_MEMO_FAMILY_MANAGEMENT.md` did not need changes —
the reskin doesn't alter the product's posture or the
cross-app integration plan.

---

## v9 — Comprehensive missionIQ port: imports, matching, external API, profile fields

**The trigger.** Operator imports a 370-row Google Sheet. Family Graph
preview cheerfully reports "370 rows" but creates zero families/persons.
Root cause: the heuristic mapper recognized none of the sheet's column
headers, so applyMapping returned canonical rows with `persons: []`
across the board, and the import path silently inserted source_records
without ever creating people. The operator had no way to see this
before clicking Import — there was no diagnostic, no warning, no count
of "rows that produced people." The user (correctly) said "do better"
and pointed at the missionIQ repo as the gold-standard reference.

**The instruction.** "Go back into the missionIQ repo and look at how
it imported the records and presented conflicts in the UI and do a
MUCH more comprehensive job pulling out that code and adapting it
here." Followed by: "look closely at the logic that determined if two
records needed to be automatically combined or if the user needed to
be prompted to resolve." Then: "we will need a way for those apps to
bring in their data but call on ours for matching and perform a back
and forth." Then: "improve upon what we built in missionIQ. Look at
the family profiles in missionIQ. I never liked the UI but a lot of
the data points were important to collect."

The missionIQ repo at `github.com/christreadaway/missioniq` was opened
read-only via WebFetch + raw.githubusercontent.com. Five files
mattered: `server/services/ingestion.js` (auto-mapper, alias
dictionary, date/phone/email normalization, summary-row filter),
`server/identity/resolver.js` (the 2,181-line scoring engine with
suffix stripping, nickname groups, address abbreviation handling,
compound-name `Timothy & Mary` splitting, cross-state veto),
`server/database/schema.js` (contacts/families/children with employer
/title/do_not_contact/not_living_together), `server/routes/conflicts.js`
and `client/src/pages/Upload.jsx`.

**What got vendored, in five phases.**

### Phase 1 — better imports

`server/sources/csv.js` rewritten end-to-end. The HEADER_HEURISTICS
dictionary expanded from ~20 entries to ~250 alias variants (parent
1/2 + p2/p1, contact 2, spouse, husband, wife, partner, secondary
contact, emergency contact, HOH, head of household, all the
diminutives and cross-language variants). New `headerMatchScore`
scores each (header, alias) pair via word-boundary regex (100 exact,
80/70 word-as-substring, 50 fuzzy fallback ≥4 chars). New
`autoMapFlat` does GLOBAL best-match assignment so "Child First Name"
wins over "First Name" rather than getting stolen by the generic.

`normalize.js` extended with `splitEmails`, `splitPhones`
(concatenated `+13143...+13145...` splits into two 10-digit values),
`normalizeDate` (Excel serial numbers — *critical* for Sheets
exports — plus `MM/DD/YYYY`, 2-digit year, ISO, textual), and the
summary-row filter that drops "Total" / "Grand Total" / "Subtotal".

The preview API now returns `headers`, `mapping_warning`,
`summary_rows_dropped`, `platform`, and a `diagnostic` block with
`rows_with_persons / rows_with_address / rows_blank / total_persons /
unmapped_columns`. The dashboard surfaces `rows_with_persons` of N
prominently, disables the Import button when zero, and auto-opens a
column-mapper editor when the auto-mapper failed.

### Phase 2 — matching primitives + resolver upgrade

`server/identity/matching.js` (new, ~470 lines) ports the missionIQ
scoring primitives in pure-function form: `normalize`, `stripSuffix`,
`nameSimilarityIgnoringSuffix`, `normalizeAddress`,
`addressSimilarity`, `stripUnit`, `normalizeState`, `addressesConflict`,
`splitEmails`, `splitPhones`, `NICKNAME_GROUPS`, `areNicknames`,
`isPrefixMatch`, `firstNameMatchesCompound`, `scoreMatch`.

The resolver was rewritten to use this. `findCandidates` now blocks on
every deterministic signal we can hash: family-name (suffix-aware),
every email, every phone, and the full address. The decision gate:
**definitive** (exact email/phone, name+DOB, address+name) →
auto_merge; confidence ≥ thresholds.autoMerge → auto_merge;
≥ thresholds.review → enqueue; otherwise → create new.

**Critical correctness fix vs missionIQ.** missionIQ treats an exact
address match as definitive on its own. That's wrong for a household
registry — Mary Escamilla and John Torre at the same address are a
couple, not duplicates. Family Graph treats address as definitive
only when paired with a name overlap. When names diverge, address
drives FAMILY-level attachment but the persons stay distinct.

`enc.normalizeAddress` extended to expand "St" → "Street" before
hashing, so `123 Main St` and `123 Main Street` collide on `norm_hash`
and cross-import dedup actually works.

Threshold recalibration: defaults are now `(autoMerge: 0.85,
review: 0.30)`. Lower review means even surname-only or
phonetic-variant matches surface for operator review — FG errs on the
side of asking.

### Phase 2c — sticky decisions

`conflicts.resolution_notes` captures the operator's free-form WHY
alongside the existing status WHAT.
`conflicts.hasStickyNonMatch(left, right)` returns true for pairs with
a previous `rejected` or `dismissed` decision; the resolver checks
this before opening a new conflict, so re-imports never re-flag a
pair the operator already triaged.

### Phase 3 — external matching API

`server/api/identity.js` exposes the back-and-forth: `POST
/api/identity/match` (peek), `POST /api/identity/resolve` (commit),
`POST /api/identity/feedback` (record `same` or `different`, with
`different` becoming sticky). Input shape accepts both flat
(`first_name`, `email`) and structured (`given_name`, `emails[]`,
`address: {...}`) keys so missionIQ / ParentPoint pass through their
native rows.

### Phase 4 — richer profile fields

`persons` table grew `employer_ct`, `title_ct`, `do_not_contact` flag,
`do_not_contact_reason_ct`, `not_living_together` flag — all from
missionIQ's contacts shape. Multi-address / multi-email / multi-phone
were already well-modelled.

### Phase 5 — docs + tests

`test_suite.md` is new — a canonical map of all 202 tests across the
24 test files. README + ARCHITECTURE_MEMO synced.

**By the numbers.** 9 commits, ~2,400 lines net added. 3 new
migrations (0007, 0008, 0009). 1 new module + 1 new API surface + 1
new test file. 25 new tests; 202 total, all passing. Client builds
clean.

### v9.1 — Playwright e2e + FamilyDetail enrichment + bulk do-not-call

After the v9 work I told the user the dashboard had three remaining
gaps: no Playwright tests, FamilyDetail still didn't expose
multi-address/email/phone or per-member profile flags, and Import.jsx
had only been verified via curl. They asked me to close all three
without stopping. The session also picked up two new requests
mid-flight: a "summer-grace" clarification on the grade display
between May 15 and Aug 15, and a school-side do-not-call workflow
("search a family by last name, flag every member at once").

**Playwright + chromium-headless-shell** is now wired up. New
`playwright.config.js` boots an isolated server under
`/tmp/fg-pw-<pid>/`; new `e2e/_setup.js` reads the master token and
seeds it + the PII view into localStorage. Twelve e2e tests across
four files exercise the conflict-notes textarea, the new profile
fields, the FamilyDetail enrichment (DOB / age / grade / channels
roll-up / pills), the import preview diagnostic, and the bulk
do-not-call flow.

**FamilyDetail enrichment.** Each member row now shows
DOB+age+grade-or-summer-equivalent, the "do not contact" / "separate
residence" pills, and an employer/title chip when filled. The
panel header rolls up "N adults · M kids". A new Contact channels
panel under Members shows every email + phone across the family
with attribution back to the contributing member. families.members
was extended to decrypt and surface the new profile fields.

**Three real bugs caught by the e2e tests** that the unit-only
suite never would have:

1. `FACTS_MAPPING null override`. The /api/import/run handler passes
   `mapping: null` when the operator hasn't customized anything. The
   FACTS / RenWeb / Ministry Platform handlers were spreading
   `{ mapping: PRESET, ...opts }` — which let `opts.mapping = null`
   wipe the preset and fall through to the inferred mapper. Switched
   to `{ ...opts, mapping: opts.mapping || PRESET }`. Real-world
   FACTS exports were silently being parsed via heuristics rather
   than the FACTS-specific mapping.
2. `Family Name` colliding between primary_family_name and
   family_display_name. With the missionIQ-style scoring, a header
   "Family Name" tied at 100 between the two slots and could win
   either. In FACTS / RenWeb / school rosters, "Family Name" is the
   household label, not an individual surname. Removed `'family
   name'` from the `primary_family_name` aliases — the household-
   label bucket wins now, and `Parent 1 Last Name` claims the
   primary_family_name slot via its specific alias.
3. `flatToStructured` always set the primary slot's role to
   `'member'`. In a roster with a child slot AND/OR a secondary
   adult, the primary is logically a parent. New rule: when either
   sibling slot is present, primary's role becomes `'parent'`.

Plus FACTS_MAPPING now accepts `Student DOB` / `Student Date of
Birth` / `Student Grade` etc. — earlier it only matched the bare
`DOB` and `Grade` columns, so live exports with the "Student"
prefix had their kid's DOB / grade silently dropped.

**Summer-grace grade display.** New `formatGrade(grade, now)`:
during the school year (Aug 16 – May 14) renders `grade N`; during
the May 15 – Aug 15 summer gap renders `completed N · rising N+1`
because "grade 3" in July is ambiguous between just-finished and
about-to-start. Non-numeric grades (PreK, K) pass through verbatim.

**Bulk do-not-call** got both an API endpoint and a UI:

- New `POST /api/families/:code/do-not-contact` body `{ value,
  reason? }` flips do_not_contact on every active member, audits
  per-person AND once at the family level. Clearing wipes the
  reason too.
- New `GET /api/families?q=<surname>` filters the families list
  server-side via `family_name_hash` HMAC equality, so the
  operator can find a family by any member's surname even when
  the family has no display_name set.
- FamilyDetail grew a "Do-not-call list" panel showing the current
  flagged-members aggregate, a reason input, and add/clear buttons.
- The Families list view grew a search box (powered by the new
  `?q=`) and a per-row "Add to do-not-call" / "Clear" quick action.

Two new server tests covering the bulk endpoint + the surname
filter; six new e2e tests covering the dashboard flows.

**By the numbers (v9.1).** ~880 lines net added across 7 changed
files + 5 new e2e files + 1 new playwright config. 218 total tests
green: 206 server + 12 e2e. Client builds clean (Vite v5.4.21).

**The throughline.** v9 closed the gap between "Family Graph is
conceptually inspired by missionIQ" and "Family Graph runs the
literal missionIQ logic, with the architectural mistakes corrected."

### v9 follow-up — dashboard UI for resolution notes + profile fields

After the backend port landed, the dashboard had two glaring gaps:
the operator could not record WHY they made a conflict decision
(`resolution_notes` was server-only), and the new person-profile
fields (employer / title / do_not_contact / not_living_together)
weren't editable anywhere.

Both shipped:

- **Conflicts.jsx**: each row now expands into an inline notes
  textarea (max 2000 chars, optional). The note threads through to
  every decision (`merge`/`reject`/`dismiss`) so the operator's
  reasoning persists in `conflicts.resolution_notes`. A new "Why"
  column displays the reason chips (`exact_email_match`,
  `nickname_or_short_form`, `address_conflict_present`, etc.) so the
  operator sees what triggered the conflict before deciding. Closed
  conflicts surface the stored note verbatim under the row, with
  `resolved_by` attribution.
- **PersonDetail.jsx**: new Profile section with employer / title
  free-text inputs and two checkbox flags (do_not_contact + reason
  textarea, not_living_together). The reason input only appears
  while do_not_contact is checked.

Two backend bugs surfaced during the dev-server integration test:

1. `SCHEMA_VERSION` was still hardcoded to 5 even though migrations
   0006-0009 had landed. The health endpoint reported the wrong
   number. Bumped to 9 with version-comment lineage updated.
2. `server/config.js` and the built-in profiles still used the
   old weighted-scoring thresholds (autoMerge=0.92, review=0.7).
   With the new additive scoring, name+name conflicts (0.50)
   weren't crossing review (0.7), so the user-invoked "Scan whole
   directory" button silently produced zero conflicts even when
   duplicates obviously existed. Recalibrated production defaults
   to autoMerge=0.85, review=0.30; profiles now scale relative
   from there (parish_donor 0.80 / school 0.85 / diocese 0.90).
   `tests/extensions.test.js` updated to expect the new diocese
   numbers.

End-to-end smoke against the live server confirmed:
- creating two duplicate Pio Pietrelcinas
- POST /api/scan/duplicates opens 1 conflict
- POST /api/conflicts/:code/resolve with `notes` persists to
  `resolution_notes` + `resolved_by`
- subsequent rescans don't re-flag (sticky non-match in effect)
- PATCH /api/people/:code with profile fields round-trips through GET

Tests +2 (resolve→profile-fields, conflict-notes persistence) for
204 total, all green. Client builds clean.

The next session should be Tauri/Electron desktop shell work
(CLAUDE_CODE_HANDOFF §5).

---

## v10 — Live API connectors (FACTS SIS + Ministry Platform)

Two new docs landed in the repo at the start of this session:
`API_ACCESS_GUIDE.md` (operator walk-through for getting credentials
from each vendor) and `PRD_LIVE_CONNECTORS.md` (the spec). The brief
was "build against these — test comprehensively, fix anything broken,
update the .md files." Then expanded mid-session: build the whole
PRD including the React UI, achieve parity with the file-import
experience, surface live progress as the sync runs, add a §5.9.1
adaptive 429 backoff with operator notification, and from now on
always update these notes.

**Shape of the change.** Family Graph already had a robust file
ingest path (CSV / Excel / Google Sheets / folder-watch) that flowed
every row through `identity/import.importBatch` → resolver →
conflicts queue. The connectors are two new "data sources" sitting
alongside the file handlers, calling vendor REST APIs on a schedule
and emitting the same canonical `{ family, persons[], address }`
shape the existing pipeline already consumed. Nothing about the
identity contract changes — the connectors are an alternate entry
point, not a parallel pipeline.

**Why the file-fallback wording matters.** The PRD is explicit that
API and file ingest are co-equal at all times. Real Catholic schools
and parishes don't always have IT staff who can keep API credentials
fresh; if FACTS rotates a secret, the operator needs to be able to
drop a CSV in `~/.family-graph/watch` the same day. The dashboard
surfaces this in the connector setup help text.

### What shipped, server side

`server/connectors/` — six new modules. `credentials.js` stores
plaintext URLs in `settings` and ciphertext for client_id /
client_secret using the existing `dataKey` (no new keys, no schema
change to `settings`; ciphertext is base64'd into the existing
`value_json` column). `http.js` is a 200-line OAuth 2.0
client_credentials helper with token caching, 401-refresh retry, and
(per §5.9.1) 429 backoff that respects `Retry-After`, retries once,
and throws `rate_limited` on a second 429. `runs.js` is the
state-machine for the new `connector_runs` table. `facts.js` and
`ministry-platform.js` are the vendor-specific connectors —
pagination, canonical-row construction, test-connection. `index.js`
orchestrates a sync end-to-end. `scheduler.js` is a 60-second tick
loop that fires due syncs.

`server/db/migrations/0010_connector_runs.js` adds the
`connector_runs` table, `conflicts.metadata` (JSON column the PRD
referenced as already-existing — it didn't), and
`import_runs.trigger` (`scheduled` / `manual` / `cli` / `file`).
Schema bumped to v10.

`server/api/connectors.js` exposes the nine endpoints the PRD
itemized. Sync was originally synchronous; the second pass changed
it to fire-and-forget so the HTTP response returns 202 immediately
and the dashboard can poll `GET /api/connector-runs/:code` for
progress. `bearerImport` and `bearerRead` scopes, no new auth
surface.

`server/api/health.js` gained a `connectors` array so the status rail
can render a colored dot per configured connector.

`server/api/settings.js` filters `connector.<name>.<field>_ct` rows
out of `GET /api/settings` and reduces them to `_set: true` flags;
direct `PUT` against any `connector.*` key is rejected with a 400.
Without this filter the base64 ciphertext was being returned, which
leaks length and existence even though it's not plaintext.

`server/identity/resolver.js` now annotates conflicts with
`metadata.cross_source = true` plus the two source tags when the
candidate's most recent provenance source differs from the incoming
record's source. The conflicts API gained `?cross_source=true` for
filtering. PRD §5.6.

`server/log/index.js` redactor extended to strip `client_id`,
`client_secret`, `access_token`, `refresh_token`, `bearer` so
connector credentials never accidentally appear in logs.

`server/connectors/credentials.js` emits `connector.credential.set`
and `connector.credential.deleted` log events in addition to the
existing audit records. PRD §11.1.

`bin/family-graph.js` gained a `connector` subcommand
(`status` / `test <name>` / `sync <name>`) for headless operation.

### What shipped, client side

`client/src/views/Connectors.jsx` — list view (cards) plus detail
view. The detail view was rewritten in the second pass to:

- Kick off sync as fire-and-forget; poll the run every 1.5 seconds.
- Render a live "Authenticating… → Pulling 100 students… → Pulling
  parents… → Importing 312 canonical rows… → Done" panel above the
  button while the run is in flight. Counters update as pages come
  back. The button is disabled and reads "Syncing…" until the run
  lands.
- On success, render the same `StatPillGrid` (Families created,
  Persons attached, New conflicts, etc.) the file-import view uses,
  with a rows-pulled tile prepended and a yellow warn panel pointing
  to `/conflicts` when conflicts_opened > 0. Click-through links to
  the matching `import_runs` detail for the per-row breakdown.
- On failure, render a red panel with the structured reason
  (`auth_failed` / `network_error` / `rate_limited` / `timeout`) and
  a one-line operator nudge.

`client/src/components/StatPill.jsx` — the StatPill from
`Import.jsx` extracted into a shared component plus a `StatPillGrid`
helper, so the connector view and the file-import view stay in sync
forever. Visually identical post-run summary regardless of how the
data arrived.

`client/src/components/ConnectorCard.jsx` — list-page card that
shows status pill, schedule, and (when a sync is running) the live
phase + counter line. Polls every 5s in the list view so a sync
started from the CLI or another tab lights up.

`client/src/components/StatusRail.jsx` — colored connector dots
along the right edge of the rail (green / blue / red). Driven by
`/api/health.connectors`. Hover text shows the failure reason.

`client/src/views/Imports.jsx` — Imports list table gained a
Trigger column rendering scheduled / manual / cli / file as colored
pills.

`client/src/views/Settings.jsx` — banner pointing to the new
connector panel, plus an `operator_email` field used by the
failure-notify path.

App routing: `/settings/connectors` and `/settings/connectors/:name`,
with a sidebar entry under the Posture group.

### Bugs caught, decisions made

- **`conflicts.metadata` did not exist.** PRD §5.6 said it did.
  Migration 0010 adds the column; the resolver writes
  `{ cross_source: true, sources: [...] }` JSON; the conflicts
  endpoint uses `json_extract` to filter. Future flags ride the
  same column without a new migration.
- **Encryption helpers are `encrypt` / `decrypt`, not
  `encryptString` / `decryptString`.** PRD called the latter; they
  don't exist. Connectors module wraps the actual exports.
- **OneRoster's `parent_1_*` / `parent_2_*` row-position model
  doesn't translate to the API.** API connector groups by each
  user's `agents[]` array instead, falling back to (familyName,
  address) if agents are absent. Materially better — handles
  siblings sharing parents, parents with multiple kids, and
  parent-only feeds.
- **MP OIDC discovery JSON is not parsed.** The vendor convention is
  `<api_base>/oauth/connect/token`; the connector auto-derives that
  unless the operator supplies an explicit token URL. Avoids adding
  `jose` as a dependency.
- **UTC schedule anchors, not local-time.** "Daily 02:00" and
  "Weekly Sun 02:00" fire at UTC. Across DST the run drifts by an
  hour relative to wall clock — acceptable for an overnight sync,
  sidesteps the surprisingly hard problem of detecting timezone from
  a server-side daemon.
- **Stalled `running` rows.** A crashed process would leave a row in
  status `running` forever, permanently blocking new triggers. The
  scheduler calls `runs.reapStalled(db)` on boot to mark anything
  older than 60 minutes as `error`.
- **`lastRun` / `consecutiveFailures` ordering tied on ms.** Two
  back-to-back operations in tests landed on the same `started_at`
  millisecond, so DESC ordering was non-deterministic and a "fail
  fail fail then succeed" sequence sometimes reported 1 consecutive
  failure instead of 0. Added `rowid DESC` as the tiebreaker.
- **`/api/settings` was leaking connector ciphertext.** The base64
  blobs were appearing in the response. PRD §5.1 says they should
  reduce to `_set: true` flags. Fixed; direct PUT against connector
  keys is also blocked.
- **No `operator_email` setting existed.** The 3-strikes
  notification path referred to it, but no allow-list entry
  existed. Added; the Settings page exposes it.
- **§5.9.1 was added mid-build.** The `Retry-After` parser handles
  both integer-seconds and HTTP-date forms; bad values fall back to
  60s; a second 429 throws `rate_limited`; both the request path
  and the token-endpoint path recognize 429. A `rate_limited`
  failure fires an immediate operator notification (separate from
  the 3-strikes path) because vendor rate-limiting is unusual
  enough to interrupt — either we're being more aggressive than
  expected or the vendor changed their policy. Notification body
  explains the no-partial-data guarantee and suggests lengthening
  the schedule.

### By the numbers (v10)

- 263 server tests passing (was 206, +57).
- 9 new HTTP endpoints (connectors + connector-runs).
- 1 new migration (0010), 1 new schema version (10).
- 17 new files across server, client, and tests.
- React client builds clean (Vite v5.4.21 → 281 KB JS, 15 KB CSS).
- Server boots clean on a fresh `~/.family-graph/` with the
  scheduler enabled.

### Throughline

v10 is the first time Family Graph reaches outside the operator's
machine on its own. Everything about the design — the encrypted
credentials, the 60-minute wall-clock cap, the concurrent-sync gate,
the no-partial-writes transaction discipline, the
operator-notification on auth_failed and rate_limited, the
file-fallback always-on guarantee — is shaped by the assumption that
the operator's network or the vendor's API can fail at any time and
the failure must be loud, recoverable, and never destructive. The
posture is "ingest is an integration that happens to use the
network," not "the network is the source of truth."

The connector path is now visually identical to the file-import path
post-run; the operator gets the same StatPill grid + yellow conflict
callout regardless of how the data arrived. During the sync, the
button reads "Syncing…", a live phase indicator updates as pages
come back, and a colored dot in the status rail tracks each
connector's last-known posture. If the vendor returns 429, the
operator gets an email within 60 seconds explaining what happened
and how to back off the schedule.

### Convention added this session

`CLAUDE.md` (new) codifies the working agreement for every future
Claude Code session in this repo: bias toward action, no filler
phrases, match the operator's writing voice, no shortcuts when
debugging, log files by default, PII rules (no real institution
names, paths, or credentials in committed files), the requirements-
doc section order, the design-auditor and PDF-designer activation
modes, and — explicit — always update `session_notes.md` at the end
of every session. The journal is the institutional memory; if a
decision isn't written down, it gets re-litigated.

The next session should pick up either: (a) the deferred Tauri /
Electron desktop shell from `CLAUDE_CODE_HANDOFF` §5, or (b) the v2
write-back surface from `PRD_LIVE_CONNECTORS` §8.1 once the [pilot
parish] confirms the read-only flow is solid.

---

## v11 follow-up — EIM certification + volunteer ministry rosters

The operator at the pilot parish kept asking the same question
off-band: who on this Lectors list still has a current EIM cert?
The ministry rosters lived in spreadsheets and the cert-tracking
lived in a binder, so every Sunday morning came with a "is Mary
still good?" stall. v11 puts both into Family Graph.

### What shipped

**Schema migration 0011** adds four EIM fields to `persons` and
two new tables. Status, completion date, and expiration date are
plaintext on persons (queryable - the dashboard needs to ask "who
expires in 30 days?" without decrypting the whole table); only
the free-form notes column lands as ciphertext.
`eim_expires_on` and `eim_status` are indexed for the
expiring-soon report.

`ministries` is a catalog row per volunteer roster (Lectors,
Eucharistic Ministers, Coffee & Donuts, etc.), with a
`requires_eim` flag the dashboard can join against to flag stale
certs. `ministry_assignments` puts a person OR a family on a
ministry — never both — with a partial unique index that prevents
duplicate active assignments. Whole-family rotations were a
deliberate choice; the operator already keeps "the Smith family"
on hospitality rotations and forcing one-or-the-other distorts
the data they actually keep.

**Renewal cycle** is configurable in settings as
`eim.renewal_years` (default 3, common diocesan value). When the
operator supplies only a completion date, the people identity
layer auto-fills `eim_expires_on = completed_on + renewal_years`
via `server/identity/eim.js`. Explicit expiration always wins
over auto-derivation, so a one-off shorter cert (a six-month
provisional, say) doesn't get clobbered.

**Daily expiration sweep** runs at boot and every 24h: any
`certified` row whose `eim_expires_on` is past today flips to
`expired`. Implemented as a cheap UPDATE on the indexed column;
runs alongside the existing audit-retention sweep.

**API surface** mounts at `/api/ministries` under the same
`pii.read` / `pii.write` scope split as people and families.
Endpoints: catalog CRUD, assignment create/end, by-person and
by-family listings, plus `/eim/expiring` (no PII fields in the
response — safe for any read scope) and an explicit
`/eim/recompute` trigger so the operator can force a sweep
without waiting 24h.

**Person merge** carries ministry assignments onto the winner.
If the loser was already on the same ministry as the winner, the
loser's row is ended rather than stacked, mirroring how
memberships handle the same conflict. Same treatment for
`family.merge` and family-level rosters.

**Client UI**: PersonDetail gains an EIM panel (status badge in
the header, completed/expires date inputs, encrypted notes field)
and a Ministries panel listing the person's active rosters with
inline End buttons and an Add form sourced from the catalog.
FamilyDetail gets the family-level Ministries panel for
whole-household rotations. New `/ministries` route lists the
catalog, surfaces certs expiring soon, and exposes the manual
recompute button.

### Design trade-offs

**Why plaintext EIM dates.** The convention in this repo is
encrypt-by-default for anything personal, and this rule was worth
breaking. The "expiring in 30 days" report is the whole point of
tracking the cert; if the date column is encrypted we either
decrypt every row on every dashboard load (slow, leaky) or we
never get the report. The dates aren't personally identifying on
their own — they're a flag and two dates that say "compliant /
not." The diocese-and-vendor commentary that *would* be PII goes
into `eim_notes_ct`, encrypted.

**Why "exactly one of person_code or family_code".** Some
parishes track Coffee & Donuts as "the Smiths" rather than
picking a member. Other ministries (Lectors, Cantors) only make
sense per-person. Letting the row toggle keeps the data shape
honest to how the operator already files it, and the partial
unique indexes keep the "active assignment" invariant clean.

**Why `eim_status` as text rather than derived.** It feels
redundant with the dates, but the operator needs a way to mark
someone as `pending` (paperwork in flight) before any dates
exist, and to manually flip to `expired` for a cert revocation
that wasn't a normal calendar lapse. The boot-time sweep handles
the common certified→expired transition; the column lets the
operator override.

### By the numbers (v11)

- 277 server tests passing (was 263, +14 in
  `tests/eim-ministries.test.js`).
- 11 new HTTP endpoints under `/api/ministries`.
- 1 new migration (0011), 1 new schema version (11), 2 new ID
  prefixes (`min_`, `ma_`).
- 5 new files (`server/identity/ministries.js`,
  `server/identity/eim.js`, `server/api/ministries.js`,
  `client/src/views/Ministries.jsx`,
  `tests/eim-ministries.test.js`).

### Throughline

v11 is the first time Family Graph carries operational state
beyond identity — who someone *is* gets a sibling now, *what
role they play this Sunday*. The encryption and audit conventions
held: the only field that landed as ciphertext was the free-form
notes on a cert (potentially "completed via [diocese] with a
waiver because [reason]"), and every assignment write goes to
`audit_events` so the operator can replay how a roster came to
look the way it does. The expiring-soon endpoint deliberately
returns no PII so a future "send a renewal nudge" workflow can
read it from a less-trusted scope.

---

*End of session notes*
