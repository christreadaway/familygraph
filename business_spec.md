# Family Graph — Business Specification

**The identity layer for church and school software.**

---

| | |
|---|---|
| **Author** | Chris Treadaway |
| **Status** | v1 shipped to the pilot institution; v0.2 of the integration contract live; a connector in flight as the first demonstrator |
| **Last updated** | 2026-05-15 (was: initial draft April 2026) |
| **Document type** | Business spec (the "why," not the "how") |
| **Companion docs** | `product_spec.md` (the "how"), `FAMILYGRAPH_INTEGRATION.md` (the wire contract), `INTEGRATION_GUIDE.md` (how any app integrates), `ARCHITECTURE_MEMO_FAMILY_MANAGEMENT.md` (the original integration plan), `session_notes.md` (decision log) |

---

## What this is

Family Graph is the identity layer for software that runs in a church or school. It owns the master record for every family in a community: names, emails, phones, addresses, household structure, custody flags, photo and directory consent, safe-environment certifications. Other applications — built by us, by partners, by the wider Catholic Digital Commons — consume that record through a versioned local API and store their own domain data against Family Graph's stable identifiers.

Think of it as the rails. Apps are the trains.

The first train is the demonstrator, a parent-engagement application for a single school community. It demonstrates what running on top of Family Graph looks like: identity reads and household reads flow down from Family Graph; school-specific context (grades, classrooms, rosters, activities) flows up; webhooks keep both sides in sync; per-school consent overrides let one school's photo policy differ from a sibling parish's without losing the identity-level base. Every architectural pattern the app uses is documented as a generic contract so the second, third, and tenth app can be wired up without re-deriving the integration.

Family Graph is not an analytics tool. It does not score donors, track enrollment trends, or report on engagement. It does one thing: it knows who is who, with the highest accuracy possible, kept up to date by an operator who reconciles new information into it, and serves that knowledge to every consumer that needs it.

---

## The problem

Catholic institutions run on family data. A parish knows its members through the parish management system. A school knows its students through the enrollment system. A development office knows its donors through CRM. A faith-formation program knows its catechists through some other tool. The same family appears in all of them, often with different spellings, different addresses, different points of contact.

Today, every app the institution uses solves the identity problem on its own. Each maintains its own families table. Each runs its own resolution logic. Each builds its own conflict review UI. The result:

- **Duplicated work.** The same identity-resolution problem is solved three or four times in three or four codebases.
- **Drift.** An operator merges two families in the donor system. The school system still has them as separate. The parish directory has both. Within a month, the three systems disagree about who is in the family.
- **Unsafe AI.** When the operator wants to use AI on family data, every app has to invent its own anonymization. Most don't. PII flows freely to public LLMs because there's no shared infrastructure to prevent it.
- **Privacy risk on exports.** When a board member asks for a report and someone exports a CSV, real names go out by default because that's what the system shows. There's no architectural mechanism to enforce "pseudonyms unless you explicitly consent."
- **Consent ambiguity.** A parent who said "no photos at this school's events" must have that wish honored in the parish app too, but the two apps don't talk. The school's privacy flag never makes it to the parish.

These problems compound as the institution adopts more software. Every new tool is another copy of the family graph. Every new tool is another place where AI integration risks PII leakage. Every new tool is another export channel without a unified privacy posture.

---

## The solution

A single, local source of truth for family identity, with a documented contract for any application — current or future — to consume it.

### What Family Graph does

- **Owns the master record** for every person and household in the community. Names, contact info, household links, custody flags, photo and directory consent, safe-environment certifications.
- **Ingests data from any source.** A SIS export, a parish management report, a Google Sheet, an Excel workbook, a hand-typed CSV from a clipboard - any list of people can be federated into the ledger regardless of where it came from. Many parishes don't use a formal platform at all; they keep records in spreadsheets or on paper. Family Graph serves all of them. Shipped handlers cover common formats and systems (FACTS, RenWeb, Ministry Platform, Google Sheets, Excel, generic CSV); consuming apps can also write directly through the API.
- **Auto-merges high-confidence matches; surfaces ambiguous pairs to the operator** for review. Creates new entries for genuinely new people. Resolution rules accumulate over time and reduce the queue depth.
- **Builds household and relationship structure.** Multiple addresses per family. Custody designations. Family-to-family links for divorced parents and connected households. Free-form notes for the situations real people don't fit into clean schemas.
- **Serves identity to authorized apps over a versioned contract.** Apps read household-and-person objects through `GET /v1/persons/:id` and friends. Apps suggest new identities through `POST /v1/persons`. Per-school consent overrides, diocesan-EIM linkage, and archive / reinstate workflows are all first-class endpoints.
- **Notifies apps when state changes.** Signed webhooks (`person.updated`, `consent.updated`, `household.deleted`, etc.) keep every consumer's cache fresh without a polling tax.
- **Anonymizes files for AI consumption.** Drop a file in a folder, get a sanitized version out, where names and contact details are replaced with stable identifiers. The AI sees identifiers; the operator sees real names when they get the response back. The three-layer sanitizer (regex, registry HMAC, NER heuristics) catches the large majority of PII, but novel names or unusual formats can slip through; operators should review sanitized output before sharing with untrusted parties.
- **Logs every PII access and every export consent event.** One place for the operator to see what data has left the machine. Every meaningful write is also captured in a row-snapshot change log so a soft-archived record can be reinstated cleanly.

### What Family Graph does NOT do

- Donor analysis, giving history, engagement scoring (a donor-intelligence app does that)
- Parent communication, school engagement (a parent-engagement app does that)
- Sacramental records, parish accounting (the parish management system does that)
- School enrollment management (the school information system does that)
- Time-aware logic like grade rollover or sacrament eligibility (those belong to the systems that own the underlying processes)

Family Graph is deliberately narrow. It does the one thing the existing ecosystem doesn't do: maintain a unified, accurate, privacy-conscious identity ledger, and serve it to every app that needs to reference it.

---

## The platform thesis

The original draft of this spec positioned Family Graph as infrastructure for *Chris's portfolio of Catholic software* - a donor-intelligence app, a parent-engagement app, and sibling tools. The thesis has clarified since then. Family Graph is infrastructure for **any application that runs in a church or school**. The portfolio is the first customer, not the only one.

That's a meaningful shift for two reasons.

First, the contract becomes a first-class product. `FAMILYGRAPH_INTEGRATION.md` (the wire spec) and `INTEGRATION_GUIDE.md` (the generic, app-agnostic integration walkthrough) are now operator-facing artifacts in their own right. A developer who has never spoken to us can read the integration guide, build against the contract, and ship a working consumer. We're going to find out very quickly whether the contract is honest, because someone is going to try it.

Second, the demonstration matters more than the demo. We're not selling "the donor-intelligence app, the parent-engagement app, and the sibling tools come with Family Graph included." We're saying: here is the rails, here is one train running on them (the first connected app), here are the patterns. If you build the second train, it gets the same identity layer, the same privacy posture, the same audit trail, the same restore-on-delete guarantee.

The portfolio remains the practical expression of the thesis. But the thesis is bigger than the portfolio.

---

## Who it's for

### Primary user: the institutional operator

Business managers, advancement directors, principals, COOs of Catholic schools and parishes. They juggle multiple systems. They handle sensitive family data daily. They want to use AI to make their work easier but cannot legally or ethically expose family information to public LLMs. They have no IT department.

This person is already running a donor-intelligence app. They already understand the identity-resolution problem because that app surfaces it through its conflict queue. Family Graph is the natural extension of that work, applied across the entire data ecosystem rather than just donor intelligence.

### Secondary users (consumers)

- **The institution's apps.** A parent-engagement app (in flight), a donor-intelligence app, sibling tools, and any partner-built or community-built tool that handles families. They consume identity from Family Graph instead of building their own.
- **AI workflows.** Local LLM agents, public LLM integrations, anything that needs family data but should not see PII.
- **Pastors, principals, board members.** They consume reports built on Family Graph-anonymized data. They don't operate Family Graph directly.

### Tertiary users (developers)

- **Developers building on top of Family Graph.** The audience for `INTEGRATION_GUIDE.md`. They read the contract, provision a scoped API key from the operator, write a connector, and ship. Family Graph's documentation surface is shaped around their experience.

---

## Why now

Three things are true that weren't true five years ago.

**AI is becoming the operator's most useful tool.** A small Catholic institution can, today, summarize meeting notes, draft donor correspondence, identify giving patterns, and triage parent communications using an off-the-shelf LLM. The productivity gain is enormous. But the privacy risk is also enormous, and there's no shared infrastructure to manage it.

**Catholic institutions are accumulating software.** Five years ago, a parish might have had a single management system. Today, that same parish runs FACTS for the school, Ministry Platform for sacramental records, a donor-intelligence app for development, a parent-engagement app for the school community, and a half-dozen spreadsheets for everything else. The integration problem is real and getting worse.

**The Catholic Digital Commons is real.** There is a growing ecosystem of mission-aligned software being built for Catholic institutions. Family Graph is foundational infrastructure for that ecosystem. Every Catholic Digital Commons app that handles families benefits from a shared identity layer — and there is now a documented contract for any of them to plug in.

---

## The demonstrator

The first connected app is a parent-engagement app for a single Catholic school community. Parents see the calendar, message teachers, order lunch, RSVP to athletics, log volunteer hours. Teachers and coaches see class rosters and communicate with parent groups. Administrators see everything plus the outbound communication queue.

It is the first sibling app to run on Family Graph in connected mode, and it is the demonstrator of every integration pattern Family Graph exposes:

- **Identity reads.** The app hydrates a parent's record at sign-in by looking up by email, and renders the family card on the parent dashboard by fetching the household.
- **Identity writes.** When an administrator adds a new family, the app suggests the new identity to Family Graph, which assigns the stable `personId` that every other consumer will reference.
- **Per-school consent overrides.** A parent in two schools' programs can say "no photos at school A's events" without affecting school B. Family Graph stores the override per `(person, school)` pair; the app reads the effective consent (override-or-base) before every outbound photo blast.
- **Diocesan EIM linkage.** When the app records that a volunteer completed safe-environment training, the record points back at the issuing diocese plus the diocese's own record id, so a reconciliation against the diocesan registry is a one-join operation.
- **School-context push.** The app's view of each child - grade, classroom, sports teams, drama camp, after-care - flows up to Family Graph as a snapshot, debounced server-side to five minutes per child. The parish app reading that child's snapshot now knows what's going on at school without needing access to the demonstrator's class rosters.
- **Webhook-driven cache invalidation.** When a parent updates a phone number, Family Graph signs a `person.updated` event with HMAC-SHA256 and POSTs to the app's Cloud Function. The app invalidates its cached copy and re-derives every downstream record (messaging recipients, SMS queue) on the next read.
- **Restorable deletions.** When an administrator removes a family at the end of the school year, the soft-archive flips status, captures a full row snapshot in the change log, and fires `household.deleted`. If the administrator made a mistake, `reinstate` reverses it with a single call. The audit trail records both directions.

Every one of these patterns is documented in the generic `INTEGRATION_GUIDE.md`. The app isn't doing anything proprietary; it's exercising the contract. The second sibling app (a parish faith-formation app, say) implements the same patterns and gets the same guarantees.

If the app × Family Graph works for one school community for ninety days without incident, the contract is real and the platform thesis is proven for the first time. That is the v1 + v0.2 milestone, and it is what 2026 is for.

---

## How it makes money (or doesn't)

Family Graph is **open source under the Apache License 2.0** (see `LICENSE` and `NOTICE`). The decision is made: the core is free, foundational infrastructure for the entire Catholic software ecosystem. Any institution or developer can run it, fork it, and build on it without asking permission or paying a license fee.

Apache-2.0 was chosen for two reasons. It is permissive enough that a partner or community developer can ship a connector without legal friction, and its explicit patent grant gives downstream adopters cover that a bare MIT license does not. Revenue, if it comes at all, comes from companion services, integrations, or hosted variants - not from the core product.

The platform thesis made this the obvious call. The more independent developers there are building on Family Graph, the more valuable the network gets, and an open core removes the single largest barrier to that. The integration guide was already written as if any developer might pick it up; opening the core matches the documentation posture that was already in place.

---

## What success looks like

### v1 has shipped when

- The pilot institution is running Family Graph in production for at least one weekly workflow. **Done — April 2026.**
- The operator has migrated their donor-intelligence app's identity data into Family Graph and is using Family Graph as the master record.
- AI workflows at the pilot institution receive pseudonyms only; no PII has reached a public LLM.
- The audit log shows every PII access and every export consent event.

### v0.2 of the integration contract has shipped when

- Per-school photo / directory consent overrides are a first-class API endpoint. **Done — May 2026.**
- Diocese records are the system of record for EIM, with `dioceseCode` + `dioceseRecordId` on every cached cert. **Done.**
- Restorable deletions: archive flips status, the row stays, an audit-loggable reinstate restores it. **Done.**
- The first connector documented end-to-end, contract documented for any sibling. **Done - `INTEGRATION_GUIDE.md` + `FAMILYGRAPH_INTEGRATION.md`.**

### The demonstration is working when

- The first connected app runs against Family Graph at the pilot institution for at least 30 days without a data-integrity incident.
- The operator can demonstrate "I changed Annie's phone in Family Graph; the SMS reminder Annie's class teacher sent two minutes later went to the right number" to a peer at another Catholic institution.
- The webhook delivery success rate is above 99% measured over a rolling week.
- Zero confirmed PII leakage incidents from the first connected app's integration with Family Graph in the first 90 days.

### The platform is working when

- A second sibling app gets wired to Family Graph in under a developer-day using only the published contract, with no person-to-person handoff.
- A bug in identity resolution is fixed once, in Family Graph, and propagates to every consumer on the next deploy.
- At least one application built by someone outside the portfolio connects to Family Graph through the documented contract.
- The donor-intelligence app migration begins (per the architectural memo) within 90 days of v1 stability at the pilot institution.

---

## What could go wrong

**The identity resolution is harder than expected and the conflict queue overwhelms the operator.** Mitigation: the resolver thresholds are tunable. Auto-merge can be made more aggressive. Resolution rules accumulate over time and reduce queue depth.

**Consuming apps don't get migrated and Family Graph stays an island.** Mitigation: the first connected app is the first migration in flight. The integration contract is documented to a level that lets a developer wire a new consumer without us in the room. The architectural memo restates the migration plan for the donor-intelligence app. Each migration is phased so it doesn't have to happen all at once.

**The shared local secret authentication model is too primitive and a security incident occurs.** Mitigation: per-app scoped keys are now first-class; the `integration` scope gates the `/v1` contract surface. The webhook delivery layer signs every payload with HMAC-SHA256. Loopback / RFC1918 / link-local destinations are rejected at subscription time. If mTLS becomes necessary, the architecture supports adding it in v0.3 without breaking existing consumers.

**A consuming app silently violates the PII posture (exports without consent, logs PII to its own files).** Mitigation: the integration guide restates the posture in stark terms. The audit log catches what it can. The change-log captures every meaningful write. The rest is discipline; we lean on the contract being clear enough that a violation is obviously a violation.

**Family Graph becomes a bottleneck and consuming apps suffer when it's down.** Mitigation: the integration guide explicitly tells consumers to fall back to a local mirror on read and to queue writes for retry. The webhook stream + hourly catch-up cron keep the mirror fresh. Family Graph's own code is kept simple and dependable specifically because so much depends on it.

**The published contract turns out to have a gap and an early consumer has to be told "we'll fix that in v0.3."** Mitigation: the versioning is explicit (`X-FG-Contract-Version: v0.1`) and the contract document maintains an Appendix for every revision. A consumer that pins v0.1 doesn't break when v0.3 ships; they upgrade on their own timeline.

**The licensing call turns out to be wrong and the project draws either too little community contribution or unwanted commercial forks.** Mitigation: the project is now open source under the Apache License 2.0, the call that best fits the platform thesis. The codebase was built clean enough that the public surface holds up under outside eyes. The integration guide was already written as if any developer might pick it up; opening the core required no re-architecting of the public surface.

---

## Strategic context

Family Graph is part of a larger thesis: **church and school institutions deserve software built specifically for them, not generic SaaS shoehorned into their contexts.** A portfolio of Catholic software - a donor-intelligence app, a parent-engagement app, and sibling tools - is the practical expression of that thesis. Family Graph is the foundational layer that makes the portfolio coherent, and - increasingly - the foundational layer that makes any *other* mission-aligned application coherent with the portfolio.

The order matters. Ship to the pilot institution. Demonstrate with the first connected app. Document the contract well enough that the second consumer doesn't need a phone call. Decide what's next based on what's true, not what's hoped.

If Family Graph works at the pilot institution, the portfolio becomes more powerful at the pilot institution. If Family Graph plus the first connected app hold together for ninety days, the demonstration is real and the contract is honest. If a second consumer wires in successfully, the platform is real. And because Family Graph is now open source under the Apache License 2.0, it is already infrastructure any Catholic-aligned developer can build on, multiplying the impact beyond what one builder could achieve alone.

That's the staircase. Each step depends on the one below. Don't skip steps.

---

## Addenda from v1 implementation

The v1 implementation surfaced a few decisions that the original spec didn't
address explicitly. They are recorded here so future work doesn't relitigate
them:

- **PII at rest is encrypted at the column level, not via SQLCipher.** Application-layer AES-256-GCM on every PII column gives the same "plaintext never lives in the SQLite file" guarantee without forcing a custom SQLite native build on every consumer. The on-disk ciphertext format is independent of the storage backend; if a future deployment moves to SQLCipher, the existing rows continue to decrypt unchanged. The data key, master Bearer token, and HMAC key live together in `$FAMILY_GRAPH_HOME/secret.key`, mode 0600. Migrating the secret file into the OS keychain is a one-time copy-out.
- **Searchable equality on PII.** Names, emails, phones, and addresses each have an HMAC-SHA256 hash column alongside the ciphertext. The hash is what the resolver and the dashboard search against. Free-form fields (notes, raw payloads) are encrypted-only, never hashed, because their value space is not amenable to safe HMAC equality.
- **Token rotation does not re-encrypt existing data.** `family-graph rotate-secret` regenerates the master Bearer token only; the data key is preserved so existing ciphertext remains readable. Operators rotate when they suspect token compromise; rotating the data key is a v2 concern that requires a planned re-encryption pass.
- **Audit log self-redaction.** Every metadata object passed to the audit recorder is run through a key-name redactor before write. Audit rows are therefore safe to share with peers, partners, or compliance reviewers; the operator does not need to hand-screen them.
- **Folder-watch is non-recursive and idempotent.** Files are picked up only at the root of `$FAMILY_GRAPH_WATCH_DIR`. Processed inputs move to `out/processed/`; collisions are renamed with a numeric suffix; errors land in `out/errors/` with a `.error.txt` sidecar. The agent never overwrites existing output, and never re-reads a moved file.
- **Default is loopback.** The HTTP server binds to `127.0.0.1` and the safe API surface enforces loopback origin. Exposing Family Graph to a LAN address is a deliberate operator action (`FAMILY_GRAPH_BIND=0.0.0.0`) and is out of scope for the trusted-desktop threat model.
- **Bulk-import "preview" is not a write.** The import wizard's preview path is pure parsing; the operator runs the actual writes only after they've reviewed the inferred mapping and the canonical preview. This shape became necessary as soon as we wired vendor-specific handlers (FACTS, RenWeb, Ministry Platform), since auto-detection by header is heuristic and the operator needs visibility into what Family Graph thinks the file is before committing to a write.
- **Conflict resolution is a one-way street, but reversible by alias resolution.** Resolving a conflict by merge is permanent in the sense that the loser code becomes an alias forever. But an operator who later realizes the merge was wrong can split the surviving family / re-create the loser as a new entity; the original alias still resolves transparently for any consumer that stored it.

---

## Addenda from v0.2 of the integration contract (May 2026)

The contract surface (`/v1/...`) shipped in two passes. v0.1 covered the
read / write basics, idempotency, ETag / If-Match, and webhook delivery.
v0.2 added per-school consent overrides, diocese-of-record for EIM, and
the entity-change log that makes deletions reinstatable. A comprehensive
audit pass then caught and fixed a batch of bugs that became regression
tests. Decisions worth recording at the business-spec level:

- **The contract is versioned via `X-FG-Contract-Version`.** Consumers pin a major version; FG rejects unsupported majors with `426 Upgrade Required`. New minor versions add fields; clients that ignore unknown keys keep working. Major bumps require client updates. The full changelog lives in the Appendices of `FAMILYGRAPH_INTEGRATION.md`.
- **Per-school consent overrides are an FG-side concern, not an app-side workaround.** The original draft of the contract proposed that FG hold the identity-level base and the consuming app hold the per-school override on its own. We picked instead to hold both in FG, so a sibling app (the parish faith-formation surface, for instance) inherits the override without having to ask the first app for it. The effective consent for a `(person, school)` pair is `override-or-base` per field; the more restrictive value wins on merge.
- **Diocese is the system of record for EIM certifications.** FG caches the cert payload, points back at the issuing diocese via `dioceseCode` + `dioceseRecordId`, and uses the per-diocese renewal interval (when set) for auto-derivation of `expires_on`. The diocese itself remains authoritative; FG is a cache that knows where the source lives.
- **Deletions are recoverable.** Persons, households, and dioceses can be archived (status flips to `'archived'`, the row stays, a snapshot is captured in `entity_changes`) and reinstated cleanly. The change log is what makes the round trip auditable; the row preservation is what makes it cheap. Merges still produce alias rows; "un-merge" stays a manual operator workflow because later edits to the survivor make automatic restoration error-prone.
- **Every meaningful write is logged in `entity_changes` with a full row snapshot.** Create, update, archive, reinstate, merge, split — each emits a row with before/after JSON (BLOB columns base64-encoded; the dataKey is still required to decrypt PII). The write and the log row are wrapped in a single transaction so a log failure rolls back the data write. The audit trail and the data are never out of sync.
- **The webhook delivery surface is its own first-class subsystem.** HMAC-SHA256 signed payloads, exponential backoff retry (30s / 2m / 10m / 1h / 6h), school-hint filtering, soft-unsubscribe that preserves the row + secret for resubscribe. Loopback / RFC1918 / link-local destinations are rejected at subscription time. Plain http:// is permitted with a logged warning; the operator owns network-level confidentiality.
- **The first connector is the first demonstration of the contract; the generic integration guide is the deliverable for the next consumer.** The app-agnostic docs are what ship: `INTEGRATION_GUIDE.md` (how any app integrates) and `FAMILYGRAPH_INTEGRATION.md` (the wire contract). Both are versioned so a connector can pin its code to a specific contract revision, and any one app's connector is just an exercise of those generic patterns rather than a doc of its own.

---

*End of business specification*
