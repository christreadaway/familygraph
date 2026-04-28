# Architectural Memo: Centralizing Family Management

**How MissionIQ, ParentPoint, and future apps will consume identity from a shared registry.**

For: MissionIQ project, ParentPoint project, and any future Catholic Digital Commons app that handles family data.

| | |
|---|---|
| **Author** | Chris Treadaway |
| **Status** | Architectural direction. Migration timing TBD. |
| **Trigger** | Family Graph v1 (family registry) shipping to St. Theresa. |
| **Action expected** | Each consuming project will write its own migration PRD against this memo when ready to migrate. |
| **Migration timing** | Not yet. Wait until Family Graph is running properly in production. |

---

## The decision

Family management — knowing which families exist, who lives in them, where they live, who's related to whom — is being extracted out of MissionIQ and ParentPoint and into a standalone local registry called Family Graph. Each app will eventually stop maintaining its own family records and instead query Family Graph for identity. Each app retains its own domain data (donations for MissionIQ, engagement for ParentPoint) but stores that data against Family Graph identifiers.

This memo describes the architectural target. It does not specify the migration plan for any individual app. Each project will write its own migration PRD against this memo, on its own timeline, after Family Graph is stable in production at St. Theresa.

---

## Why this is happening

Today, MissionIQ and ParentPoint each maintain their own family graph. When the operator uploads a tuition list, both apps independently parse it, run their own resolution logic, and create their own records. The result is three problems.

### Three problems

1. **Duplicated effort.** The same identity-resolution logic runs in two codebases. A bug fix in one doesn't propagate.
2. **Drift.** Operator merges two families in MissionIQ. ParentPoint still has them as separate. The operator has to remember to do the same edit twice. They won't.
3. **PII handling is inconsistent.** MissionIQ may handle PII one way; ParentPoint another. AI integrations in each app face the same anonymization problem and solve it differently.

### What Family Graph solves

- One place to maintain the family graph. The operator works in Family Graph's dashboard for identity edits.
- Stable identifiers across the entire portfolio. The same family has the same code in MissionIQ, ParentPoint, and every future app.
- PII vs pseudonym is decided centrally. Apps request what they need; AI workflows always get pseudonyms; export consent is logged in one audit trail.
- The hard problem of identity resolution is solved once, by the team that cares about it most.

---

## What Family Graph is, in one paragraph

A local desktop service that runs on the same machine as MissionIQ, ParentPoint, and any other consuming app. It exposes an HTTP API on `localhost:3500`. It owns a persistent SQLite database, encrypted at rest, that holds families, people, addresses, contact info, relationships, and household composition. Every family and every person has a stable opaque identifier (e.g., `f_a7b3c91d`, `p_e4d2f8a1`) that never changes. The API serves either PII (real names, real emails, real addresses) or pseudonyms (just the identifiers), based on the caller's authentication. Family Graph is the single source of truth for who is who.

---

## What this means for consuming apps

### Conceptual change

Today: each app contains its own families table, its own contacts table, its own resolver.

Future: each app contains its own domain tables (donations, engagement events) keyed by Family Graph identifiers. The app does not own family records. It queries them when needed.

### Concrete change in data model

| Today | Future | How |
|---|---|---|
| App owns families table with name, address, contact info | App stores Family Graph family code only, fetches details from API | Replace local family records with foreign keys to Family Graph |
| App owns contacts table with names, emails, phones | App stores Family Graph person code, fetches details from API | Replace local contact records with foreign keys to Family Graph |
| App runs its own identity resolution on imports | App sends incoming records to Family Graph, receives identifiers back | Replace local resolver call with HTTP POST to Family Graph |
| App's domain data (donations, engagement) keyed by app's internal IDs | Same domain data, keyed by Family Graph identifiers | Migration script translates internal IDs to Family Graph codes one time |
| App displays family names from its own tables | App fetches names from Family Graph PII API on demand | Cache layer recommended; cache invalidated when Family Graph reports changes |

### Concrete change in behavior

- **Imports.** When an app ingests a file (donor list, roster), instead of running its own resolver, it forwards the records to Family Graph. Family Graph reconciles, returns identifiers (or queues conflicts for the operator to resolve in the Family Graph dashboard). The app stores its domain data against those identifiers.
- **Display.** When an app's UI needs to show a family name, it fetches from Family Graph. Apps may cache for performance but must respect Family Graph as authoritative.
- **Edits.** Operators edit family records in Family Graph's dashboard, not in the consuming app. The consuming app's UI may link out to Family Graph for identity edits, or display the data read-only.
- **Exports.** Default to pseudonyms. PII in exports requires explicit user consent and gets logged to Family Graph's audit trail via `POST /api/audit/external-export`.
- **AI workflows.** Always pseudonyms. No exception. If an AI feature in MissionIQ or ParentPoint needs family data, it requests pseudonyms only.

### What does NOT change

- Each app's domain expertise. MissionIQ still does donor intelligence. ParentPoint still does parent engagement.
- Each app's UI. The consumer-facing experience stays similar; the data plumbing changes underneath.
- The operator's workflow. They still upload files, see analysis, run reports — but identity reconciliation moves to Family Graph's dashboard, where it's a better experience anyway.
- Each app's storage of its own domain data. Donations stay in MissionIQ. Engagement events stay in ParentPoint.

---

## The API contract

Family Graph exposes an HTTP API on `localhost:3500`. Apps authenticate via a shared local secret stored in the OS keychain. Two surfaces are exposed: PII (full data, requires Bearer token) and pseudonym (identifiers only, requires loopback origin only). Below are the endpoints most relevant to consuming apps.

| Endpoint | Auth | Use case |
|---|---|---|
| `POST /api/sanitize` | optional | App ingests a file. Sends raw records to Family Graph. Receives identifiers back. |
| `POST /api/desanitize` | required | App receives an AI response containing pseudonyms. Restores names for display. |
| `GET /api/families/:id` | required | App needs to display a family's real details (e.g., when showing donor name). |
| `GET /api/families/:id/safe` | none | App needs pseudonymous family details (e.g., when feeding AI). |
| `GET /api/people/:id` | required | App needs to display a person's real details. |
| `GET /api/people/:id/safe` | none | App needs pseudonymous person details. |
| `POST /api/audit/external-export` | required | App logs that its user consented to exporting PII. Records what left the machine. |
| `GET /api/health` | none | App checks if Family Graph is responsive before making other calls. |

---

## Identifiers

Every entity in Family Graph has a stable, opaque hex code with a type prefix.

| Entity | Prefix | Example | How apps use it |
|---|---|---|---|
| Family | `f_` | `f_a7b3c91d` | Foreign key for app's family-scoped data |
| Person | `p_` | `p_e4d2f8a1` | Foreign key for app's person-scoped data |
| Email | `e_` | `e_b91c4f23` | Reference for contact-channel records |
| Phone | `ph_` | `ph_2d8a5e91` | Reference for contact-channel records |
| Address | `addr_` | `addr_4c7f2a91` | Reference for location data |

### Permanence rules

- Codes are assigned once. Never reused, never reissued.
- When two entries are merged in Family Graph, the loser's code becomes a permanent alias of the winner. Apps that have stored the loser's code can still resolve it via `/api/desanitize` or via `/api/families/:id` (Family Graph follows the alias automatically).
- Person codes are stable across family-membership changes. A child emancipating gets a new family, not a new person ID. Apps can rely on person codes as durable foreign keys.
- Family codes do not change when household composition changes. Adding or removing a member keeps the family code the same.

### Implication for app data models

Family Graph identifiers are safe to use as foreign keys in your app's database. Use them directly. Do not derive your own internal IDs from them. Do not assume a one-to-one mapping between your app's internal IDs and Family Graph codes — over time, two of your records may turn out to be the same person, and Family Graph will tell you that via the alias mechanism.

---

## Authentication

Shared local secret model in v1. Single 256-bit secret stored in the OS keychain. Apps read it at startup and include it as a Bearer token on PII-surface API calls.

### Setup

1. Family Graph is installed first. On first run, it generates the secret and stores it in the keychain.
2. Each consuming app, at startup, reads the Family Graph secret from the keychain (same key namespace).
3. App includes the secret in the `Authorization` header as a Bearer token on all PII-surface calls.
4. Pseudonym-surface calls require no token but must originate from loopback (which they already do).

### Rotation

Operator can run `family-graph rotate-secret` to invalidate the old token. Apps re-fetch from the keychain on next startup. A graceful rotation procedure (apps reload tokens without restart) may be added later if needed; for v1, restart on rotation is acceptable.

### Threat model

- Any app on the same machine that can read the Family Graph keychain entry can read PII. This is acceptable for v1 (single-operator desktop, all apps trusted by the operator).
- If the threat model expands (untrusted code on the same machine, multi-user installations), per-app scoped keys with capability boundaries become necessary. Out of scope for v1.

---

## PII vs pseudonym: a posture, not just a technical surface

This is the architectural commitment that makes the whole portfolio coherent. Each consuming app must internalize it.

### The posture

- **Default to pseudonyms.** Whenever an app is unsure whether PII is needed, it asks for pseudonyms. The PII surface is the exception, not the default.
- **AI sees pseudonyms only.** No exceptions. Any AI feature, whether it's a summarization, a chat agent, or an embedding pipeline, receives pseudonymous data only.
- **Exports default to pseudonyms.** When the user exports a CSV from MissionIQ for a board report, it should contain identifiers, not real names. The user can override, but it's an explicit action with a consent step.
- **PII export consent is logged centrally.** Every time the user overrides the default and exports real names, the app calls `POST /api/audit/external-export` with the calling app, the operator, the entity codes, and the destination. Family Graph's audit log becomes the operator's single view of "what PII has left this machine."
- **In-app display of PII is the consuming app's call.** Family Graph does not gatekeep what your UI shows to the user who's logged in. That's your decision based on your app's settings, the user's role, and the screen they're on.

### Why this matters

If even one consuming app treats PII casually, the architecture's privacy guarantee collapses. The portfolio's strength is that every app shares the same posture: pseudonym by default, PII on demand, exports require consent, every PII event audited centrally. This is a discipline, not just a code change. Each migration PRD should restate this posture explicitly so the team building the migration internalizes it.

---

## Migration approach (per consuming app)

Each app will write its own migration PRD when ready. Below is the recommended shape. The actual schedule, sequencing, and rollout decisions belong to each project.

### Recommended phases

1. **Phase 0: Family Graph stability.** Do not start migrating any consuming app until Family Graph has been running in production at St. Theresa for at least 30 days without data-integrity issues.
2. **Phase 1: Read-through cache.** App continues to own its identity tables. On every read of a family or person, the app also fetches from Family Graph and compares. Discrepancies are logged but not acted on. This validates the API integration without putting production at risk.
3. **Phase 2: Family Graph is authoritative for new data.** New imports go to Family Graph first. The app stores Family Graph identifiers on new records. Existing records continue to use the app's internal IDs. App maintains a mapping table during transition.
4. **Phase 3: Backfill.** One-time migration translates the app's existing internal IDs into Family Graph identifiers. The mapping table is consulted; for unmatched records, Family Graph's import API resolves them. Conflicts surface in Family Graph's dashboard for the operator.
5. **Phase 4: Drop legacy tables.** After successful backfill, the app's identity tables become read-only views over Family Graph, then are removed entirely. The app's domain data references Family Graph identifiers exclusively.

### Fallback path

If Family Graph is unreachable (process crashed, machine offline), consuming apps must degrade gracefully. Recommended behavior:

- Health check at startup; if Family Graph is unreachable, log loudly and surface a warning in the app's UI.
- Cached identity data may be served read-only with a stale-data indicator.
- Writes that would create new identities are queued or refused with a clear error.
- Apps must not silently fall back to creating their own family records. The whole point of the migration is one source of truth.

---

## Notes specific to each app

### MissionIQ

MissionIQ has the most mature identity logic in the portfolio. The Family Graph identity module is vendored from MissionIQ. The migration is conceptually a re-routing exercise: MissionIQ stops calling its own resolver and starts calling Family Graph's API instead.

- MissionIQ's existing JSON export becomes the format for the one-time bulk import that seeds Family Graph.
- MissionIQ's resolution rules table gets translated into Family Graph's `resolution_rules` during the seed import.
- MissionIQ's UI for conflict review may eventually be retired in favor of Family Graph's dashboard, or kept as a thin wrapper that links to Family Graph.
- MissionIQ's domain data (donations, giving history, engagement scoring) stays in MissionIQ, keyed by Family Graph identifiers.

### ParentPoint

ParentPoint's family management is less mature than MissionIQ's. The migration is more of a green-field opportunity: ParentPoint has been doing limited family resolution; Family Graph replaces that work entirely.

- ParentPoint's school registration imports go through Family Graph from the start of the migration, not after a transition period.
- ParentPoint's domain data (engagement events, parent communication preferences, etc.) stays in ParentPoint, keyed by Family Graph identifiers.
- Custody and household complexity, which ParentPoint may have been handling lightly, becomes Family Graph's responsibility. ParentPoint queries Family Graph for custody designation and acts on it (e.g., "who gets the email when the child has joint custody").

### Future apps

Any future Catholic Digital Commons app that handles families starts on Family Graph from day one. No app should re-implement family resolution. The migration story above is for projects that predate Family Graph.

---

## What to do with this document

Each consuming project should:

1. Read this memo end to end.
2. Wait for the trigger: Family Graph running in production at St. Theresa for 30+ days without data-integrity issues.
3. Write a project-specific migration PRD that follows the phased approach above and accommodates that project's particular constraints (existing schema, deployment timeline, user-visible changes).
4. Plan the migration as a multi-phase rollout, not a single big-bang refactor.
5. Treat the PII vs pseudonym posture as a non-negotiable architectural commitment, not an optional feature.

### What NOT to do

- Do not start migrating before Family Graph is stable. The risk of a half-migrated app is much worse than the cost of waiting.
- Do not implement a partial Family Graph integration that bypasses the API for performance reasons. The whole point is one source of truth.
- Do not let the consuming app's UI silently expose PII while telling Family Graph it served pseudonyms. The audit log only works if apps are honest.
- Do not extend the migration to scope creep ("while we're refactoring identity, let's also redo the dashboard"). Migrations succeed when they are surgical.

---

*End of architectural memo*
