# familygraph Implications — Classroom A/V Pilot Work Order

**Provenance:** written 2026-08-04 in a sibling-repo session (TeacherAIde / ParentPoint /
AudioScribe side) against a read-only clone of this repo, and carried here by hand because those
repos have no direct connection to this one. Sections 1-7 are that document **verbatim** — the
record of intent, unedited. **Appendix A** is this repo's verification of its claims against the
as-built code, added 2026-08-04. **Appendix B** records the owner's scope ruling the same day,
which withdraws section 3.3's FERPA framing and answers decision 7.3. Read both appendices
before acting on sections 1-7.

---

**Status:** implications analysis, 2026-08-04, grounded in the actual `familygraph` repo
(read-only clone reviewed this session; that repo is NOT edited from here). Revised same day per
two owner rulings: **(1) people do not interact with familygraph for consents; parents consent
in ParentPoint. (2) familygraph is OPTIONAL per deployment: TeacherAIde and ParentPoint may run
without it, configurable on those two platforms.** familygraph, where enabled, is invisible
plumbing: identity, families, crosswalks. Companion: `parentpoint-ecosystem-integration.md`
(the full ecosystem design). *Not legal advice; counsel review checkpoint applies.*

---

## 1. familygraph's role, stated precisely (owner ruling 2026-08-04)

The classroom pipeline attributes speech to SEATS. Turning a seat into a named student runs
seat -> seating map -> studentCode -> person -> name, with the last hop gated by a parental
release. The division of labor:

- **ParentPoint is the consent surface AND the consent authority for the study release.**
  Parents grant and revoke there; its consent state is what the pipeline gates on. No parent,
  teacher, or admin ever touches familygraph for this.
- **familygraph is the identity layer underneath:** who a person is, which family they belong to,
  guardianship and custody facts, and the crosswalks between app-local student keys. Where it
  participates, it participates silently, app-to-app.
- One observed fact worth knowing when designing: familygraph is ALREADY the silent backend for
  one consent kind (photo/do-not-photograph, section 6), with ParentPoint as the surface. If the
  owner ever wants the study release stored on those same backend rails for durability across
  app churn, the rails exist. That is an option to raise later, not the plan: **the plan is
  ParentPoint holds the release.**
- **familygraph is optional per deployment** (owner ruling 2026-08-04), configurable on
  TeacherAIde and ParentPoint. This only stays cheap under one invariant, which the existing
  repos already honor and every new integration must too: **no downstream consumer ever talks to
  familygraph directly. ParentPoint mediates.** TeacherAIde's contracts contain no familygraph
  anywhere; AudioScribe's inherit paths terminate at ParentPoint's feed bus. Flipping the
  familygraph switch therefore changes what sits BEHIND ParentPoint (local records vs
  familygraph-backed records) and changes no wire contract downstream.

## 2. What familygraph has that the pilot actually uses (verified in-repo)

| Capability | Where | Why the pilot cares |
|---|---|---|
| Minted opaque person/family codes (`p_`/`f_` + 16 hex; legacy 8 valid) | `server/crypto/identifiers.js` | The durable subject key behind every app-local code |
| `identity.resolve` / `resolve-batch` with conflicts queue + human adjudication | `server/identity/resolver`, `FAMILYGRAPH_INTEGRATION.md` A.2-A.3 | Seeding student crosswalks from rosters without silently minting duplicate identities |
| Dated memberships with custody flags; organizations + dated affiliations | contract identity sections; migrations 0014-0016 | Guardianship facts (who may act for a child) and the school as a first-class org |
| Sealed per-tenant changed-feed sync + the v0.1 changed-feed Beacon consumes | `FAMILYGRAPH_INTEGRATION.md` sync/feed sections | Existing app-to-app propagation transport, if/when wired |
| Photo/DNP consent backend: `person_consents` + per-school `person_consent_overrides` (deny > allow on merge), effective-consent endpoint, `consent.updated` webhook | contract consent sections | Today's do-not-photograph source of truth behind ParentPoint (section 6) |
| Everything audited (`audit_events` + `entity_changes` snapshots, hard rule) | `IDENTITY_MODEL_SUMMARY.md` | Crosswalk and merge actions carry the required trail |

## 3. The implications (identity work only)

### 3.1 Crosswalks: app-local student keys resolve to `p_` codes

Three sibling apps key students three ways: TeacherAIde studentCodes (`Cla`), ParentPoint
studentIds, familygraph `p_` codes. When familygraph is wired in, it holds the crosswalk as
first-class data: `(app, school org, external_key) -> p_code`, tenant-scoped and dated (codes
can be reassigned across school years), seeded via `resolve-batch` so sparse or ambiguous roster
rows land in the conflicts queue for a human instead of minting duplicates. A person merge
repoints crosswalks like every other related row (the machinery exists; add the table to its
list and a test). The seat-to-station map is NOT familygraph data: it is per-day teaching
context and stays in TeacherAIde.

### 3.2 Withdrawal support: subject-side key enumeration

AudioScribe's CANONICAL withdrawal primitive erases by scope pointers it cannot construct alone:
it holds stations and time ranges, never subjects. When a parent revokes in ParentPoint, the
cleanup needs "every app-local key this child has held, per tenant, per period." That
enumeration is exactly what the crosswalk answers, and it is familygraph's contribution to the
flow. The consent timeline itself (when the release was granted and revoked) lives with the
consent authority, ParentPoint. Propagation to on-prem boxes rides ParentPoint's existing signed
feed bus, inside the ecosystem's 60-second opt-out SLA (TeacherAIde CONTRACTS.md 3.3).

### 3.3 A hard data boundary: what must NEVER enter familygraph

familygraph is an identity and family system. The pilot must not turn it into a shadow
education-record store:

1. **No classroom-derived content.** Transcripts, segments, intensity envelopes, participation
   analytics, station coverage, raw A/V: none of it, in any field, including `school_contexts`
   snapshots and conflict evidence.
2. **No classroom signals as affiliation verification.** The rolling-verification design accepts
   methods like `communication` and `connector_sync`; it will be tempting to count "appeared in
   class capture" as proof an enrollment is alive. That is purpose-creep across the binding
   purpose limitation (recognition outputs feed the transcript pipeline only, HANDOFF control 5).
   Enrollment verification keeps using registration, attestation, and roster syncs.
3. **No biometrics** (nothing in this pipeline produces one, and familygraph must not become the
   place one appears).

Suggested: familygraph adds the `PROTECTED_DATA_CLASSES.md` / FERPA-posture treatment its
sibling repos carry; its school-tenant slice (enrollment affiliations for minors) is
education-record adjacent and should say so in-repo.

### 3.4 Tenancy: the school becomes a real organization

The ecosystem stamps a bare `schoolId` string on every payload, and familygraph historically had
`school_contexts.school_id` as "a bare TEXT id minted by the external school app." Organizations
are first-class now (`org_` codes, domains, dioceses), so record the crosswalk once:
`schoolId <-> org_ code`, and key the student crosswalks by the org.

### 3.5 Guardianship facts, consumed by ParentPoint's consent design

Since ParentPoint owns the release, the consent-policy questions bind THERE, but they are
answered with familygraph's facts (memberships, custody flags, dated changes):

1. **Two-guardian rule:** does one guardian's grant suffice, and does either guardian's
   revocation always win? Recommended strictest-wins (any revocation beats any grant), matching
   familygraph's own `deny > allow` merge posture for photo consent. Counsel confirms.
2. **Custody change mid-term:** does an existing grant survive when the granting guardian's
   status changes? "Who could grant, when" is answerable from dated memberships; policy must say
   what happens next.
3. **Child leaves the school:** recommended the release auto-suspends when enrollment ends
   (computed from the dated affiliation, not a flag), triggering 3.2's enumeration for cleanup.
4. **Under-13 (COPPA):** the release is guardian-granted by definition here (K-8 pilot); the
   ParentPoint consent record should carry enough to demonstrate verifiable parental consent if
   COPPA applies to any processing.

## 4. Non-goals for familygraph (kept out on purpose)

- **A consent surface or consent authority for the study release** (owner ruling 2026-08-04:
  parents consent in ParentPoint; familygraph is not something people interact with here).
- Sections and rosters (ParentPoint owns), seating maps and attendance timelines (TeacherAIde
  owns), engine policy (chamberlain), transcripts and coverage telemetry (AudioScribe ->
  TeacherAIde), cross-install federation (explicitly not designed yet, per familygraph's docs).

## 5. Deployment profiles and sequencing

Two supported profiles, switchable per school on TeacherAIde and ParentPoint (owner ruling
2026-08-04). Every downstream contract is IDENTICAL in both, because ParentPoint mediates:

**Profile A, standalone (no familygraph; the pilot's reality today).** ParentPoint holds
identity locally: its roster, its `teacheraide_student_codes` map, the release, and the DNP
records. Withdrawal enumeration answers from those same maps. Nothing in the classroom pipeline
is missing or degraded; what you give up is cross-app durability (a family known to the parish
AND the school is two records), merge/dedup machinery, and custody facts richer than the roster.

**Profile B, familygraph-wired.** ParentPoint's config-gated client (already written, marked
NOT YET WIRED) connects, and familygraph silently provides what section 3 describes: durable
`p_` codes behind the app-local keys, roster seeding through resolve-batch with the human
conflicts queue, merge handling that repoints rather than duplicates, custody/guardianship facts
for the consent-policy rules, org-level tenancy. Wiring order, each step independently useful:
org crosswalk (3.4) -> student crosswalks via resolve-batch (3.1) -> withdrawal enumeration as a
feed consumer (3.2).

Nothing in the pilot blocks on the profile choice, and a school can start in A and move to B
without touching TeacherAIde or AudioScribe. Anything beyond this (e.g. moving consent storage
onto familygraph's backend rails) is a later owner decision, not assumed.

## 6. The do-not-photograph list (context for the TeacherAIde integration)

Owner direction 2026-08-04: TeacherAIde may need a do-not-photograph list to integrate, and the
election's scope is **sharing, on social media and in newsletters** (it does not restrict
classroom A/V capture, which the study release governs). The relevant fact from this repo: in Profile B,
**familygraph is already the DNP source of truth**
("Photo / DNP consent: source of truth" in its integration contract), with per-school overrides
(`person_consent_overrides`, strictest-wins), an effective-consent endpoint, and `consent.updated`
webhooks; ParentPoint writes it from `/admin/do-not-photo` and caches it per school. In Profile A
the same records simply live in ParentPoint alone. Either way, the TeacherAIde integration is a
NEW CONSUMER of ParentPoint's serving layer, not new consent machinery: ParentPoint serves the
code-keyed DNP list over the signed feed bus, identically in both profiles, and familygraph
needs no new work beyond what it already does. The integration contract and the classroom-camera
implications live in `parentpoint-ecosystem-integration.md` section 5.8.

## 7. Decisions needed

1. The guardianship rules in 3.5 (decided in ParentPoint's consent design, with counsel).
2. Long-term studentCode minting: TeacherAIde mints name-prefix codes today (flagged as
   guessable in the ecosystem doc 5.4); if codes are ever re-minted, familygraph's random
   per-tenant minting is the fix at the source.
3. Whether the study release ever moves onto familygraph's backend consent rails for durability
   (option noted in section 1; ParentPoint-held is the plan of record).

---

## Appendix A — Verification against the as-built repo (2026-08-04)

Sections 1-7 were written from a read-only clone. This appendix is the check from inside the
repo. Per this project's convention the body prose above stays unedited as the record of intent;
corrections live here.

**Verdict: the analysis is sound.** Every capability it leans on exists. Three claims need
correcting, two of which change nothing about the plan and one of which is a real design trap
for decision 7.3.

### A.1 Corrections

**1. Per-school consent overrides are NOT strictest-wins.** Section 6 says
"per-school overrides (`person_consent_overrides`, strictest-wins)". They are not. The effective
value for a `(person, school)` pair is **override-or-base, per field** — the override wins
outright in either direction (`server/integration/consents.js:201-220`, `effective()`). A school
that writes `photo: allow` overrides a family's identity-level `deny`. Each override column is
nullable, so a school can override one flag and inherit the other, but nothing clamps the
override toward the more restrictive value.

The `deny > group_only > allow` (photo) / `deny > allow` (directory) restrictive-wins rule is
the **person-merge** rule — when two person records merge, the surviving row keeps the stricter
value (`server/identity/people.js:435` and the merge body at `:351`, documented in
FAMILYGRAPH_INTEGRATION.md Appendix E). Section 3.5.1's citation of "familygraph's own
`deny > allow` merge posture" is therefore CORRECT as written — that posture is real, it just
lives on merge, not on override. Section 2's table row ("deny > allow on merge") is also correct
but sits inside the overrides parenthetical, which is what invited section 6's error.

Consequence for decision 7.3, and this is the one that matters: **override-or-base is the wrong
semantic for a study release.** If the release ever moves onto these rails, a school-scoped
override could silently re-enable classroom capture for a family that denied at identity level.
Moving the release here means building a restrictive-merge variant of `effective()`, not reusing
it. That cost belongs in the decision.

**2. The wire contract is v0.2, not v0.1.** Section 2 cites "the v0.1 changed-feed."
`CONTRACT_VERSION` is `v0.2` (`server/api/integration.js:53`) since 2026-06-19, with the
accepted-versions allowlist `{v0.1, v0.2}`, so an existing v0.1 consumer keeps working and
nothing about the analysis breaks. New integration work should declare `v0.2`.

**3. Sections 3.1 and 3.4 are unbuilt, not merely unwired.** The document reads in places as if
the crosswalk exists and needs connecting. It does not exist in any form: no table, no column,
no code — `crosswalk`, `external_key`, and `app_local` return zero hits across `server/`.
Likewise there is no `schoolId <-> org_` link: `school_contexts.school_id` is a bare `TEXT` with
no foreign key (`server/db/migrations/0012_integration_contract.js:154`), and `organizations`
has no external-tenant-slug column (`server/db/schema.sql:759`). Both are new migrations
against a schema currently at `SCHEMA_VERSION = 19`.

Section 3.1's work estimate is accurate, though: `merge()` in `server/identity/people.js:351` is
a linear list of repoint statements (`:374`-`:515`), so a crosswalk table is one more line plus
a test. And the slug shape is already constrained — `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`
(`server/integration/consents.js:30`) — so a `schoolId` column can reuse that validator.

### A.2 Confirmed as stated

| Claim | As-built |
|---|---|
| `p_`/`f_` + 16 hex, legacy 8 valid | `newCode()` at `server/crypto/identifiers.js:35` mints 8 random bytes; `LEGACY_8HEX_KINDS` gates which kinds may still be 8 hex |
| `resolve-batch` with conflicts queue | `server/api/identity.js:244`; single transaction, 1000-record cap, per-record `source_ref` so each conflict traces to its upstream row |
| Dated memberships with custody flags | `memberships.custody` ∈ `sole \| joint \| other_guardian \| unspecified` (`server/db/schema.sql:129`), plus `relation_label` |
| Organizations + dated affiliations | `organizations` (`schema.sql:759`, kind ∈ parish/school/other), `affiliations` (`:788`) with `started_at` / `ended_at` |
| Photo/DNP backend | `person_consents` (migration 0012), `person_consent_overrides` (0013), `GET /v1/persons/:id/consent?schoolId=`, `consent.updated` webhook |
| Everything audited | `audit_events` (`schema.sql:393`) + `entity_changes` (`:724`) |
| Sealed feed transport | `server/integration/envelope.js`, `changes.js`; `GET /v1/persons/changed?since=` |

Two of these are stronger than the document assumed:

**Section 3.5.3 is directly supportable today.** "The release auto-suspends when enrollment ends,
computed from the dated affiliation, not a flag" needs no new schema. `affiliations` carries
`started_at` / `ended_at`, `role = 'student'` is person-only (`PERSON_ONLY_ROLES`,
`server/identity/organizations.js:32`), and `ended_at` pairs with a `reason` class from
`graduated | transferred | moved | deceased | withdrew | inactive | merge | other` (`:36`).
There is a partial unique index enforcing one active affiliation per `(org, person)`
(`schema.sql:814`), so "is this child currently enrolled at this org" is a single indexed read.

**Section 3.3.2's purpose-creep warning binds a real enum.** `VERIFICATION_METHODS` is
`registration | sacrament | liturgy | ministry | giving | communication | connector_sync |
attestation | other` (`server/identity/organizations.js:37-40`). The guard is concrete: no
classroom-derived method is ever added to that set, and `connector_sync` never gets fed by a
capture pipeline.

### A.3 One live repo risk that touches section 3.3's boundary

Section 3.3 says familygraph must not become a shadow education-record store, and names
`school_contexts` snapshots specifically. The closest existing instance of that risk is already
open: the 2026-07-29 security review found `school_contexts.allergies` and `.activities` stored
as **plaintext** columns while an encrypted `health_safety` table exists alongside them
(`server/db/migrations/0017_document_vault.js:56`, whose allergen/severity/medication columns are
all `_ct` blobs), against this repo's own "never a plaintext PII column" rule. The fix is a
migration plus a row rewrite that the operator must run locally with `sfw` and `node --test`; it
is still pending. Student health data in plaintext, keyed by school, is the education-record
exposure section 3.3 is trying to prevent — the boundary and the pending migration are the same
concern, and the migration should land before any Profile B school pushes real snapshots.

### A.4 Not done here, on purpose

Section 3.3 suggests this repo add a `PROTECTED_DATA_CLASSES.md` / FERPA-posture document. It
does not exist here and was not written in this session: a data-classification posture with
FERPA implications is an owner-and-counsel call, not something to autogenerate from a sibling
repo's suggestion. **Superseded by Appendix B** — the owner has since ruled against the FERPA
framing entirely.

### A.5 What changed in this repo

Nothing but this file and `session_notes.md`. No schema, no code, no contract surface. Test
count unchanged.

---

## Appendix B — Owner ruling, 2026-08-04: familygraph's scope

**The ruling, in the owner's words:** the purpose of familygraph is a single, federated source
of identity for a church or church+school. School-specific items live in ParentPoint /
TeacherAIde. familygraph focuses on **identity and anonymity**. It does not take on a FERPA
posture.

Three things follow, and the third is the one with teeth.

### B.1 The FERPA framing was wrong

familygraph never "enforces FERPA." FERPA binds the educational institution. A vendor is at most
a processor acting under the school's direction, and familygraph — local-first on the
institution's own hardware, no telemetry, no cloud — is about as clean a processor story as this
architecture allows. Whether FERPA attaches at all is a question about the SCHOOL, answered by
counsel, not something this repo decides.

So section 3.3's suggestion that familygraph "adds the FERPA-posture treatment its sibling repos
carry" is withdrawn, and A.4's framing of it as an open decision goes with it. The owner's
posture is upstream of the whole question: **don't hold the records, and it never has to be
answered here.**

### B.2 The pilot was never the exposure — migration 0017 was

Worth being blunt, because the ruling doesn't land where the doc was looking. The classroom A/V
pilot proposes nothing that enters familygraph beyond a crosswalk of opaque keys. But the
document vault already treats `iep`, `504`, and `mtss` as first-class subtypes
(`server/integration/documents.js:37`), under an access matrix keyed on `learning_team` and
`assigned_teacher` staff roles (`server/integration/documentPolicy.js:81`). An IEP is the
canonical education record. No parish has one. That is school-specific data, held here by
design, and it predates this pilot by months.

That design had a reason, recorded in the 0017 header: familygraph "becomes the authoritative
ACCESS GATE" so the partner app never holds the bytes — one encrypted store, one policy
decision, one audit trail, no inbound ports. Moving accommodation plans to ParentPoint inverts
it: ParentPoint would hold IEP bytes and would have to rebuild encryption at rest, the access
matrix, and the audit trail. The ruling and 0017's security posture pull in opposite directions.
That tension is the decision, not a detail.

### B.3 The line worth drawing, and what moves under it

Proposed, for the owner to confirm: **familygraph holds identity, relationships, and access
decisions. It does not hold school-authored content or school-scoped state.** That keeps the
ruling's spirit without discarding what 0017 bought.

**Stays.** Persons, families, memberships and custody, organizations, affiliations. Enrollment is
an identity fact — "this person is a student at this org, from this date to that date" is a
relationship, not an education record, and it is exactly what makes the federated view work.
Opaque codes, encrypted contact PII, and the pseudonym layer (`server/sanitize/index.js`,
`server/api/safe.js`) that keeps AI workflows from ever seeing a real name. That layer IS the
anonymity half of the ruling, and nothing in the pilot touches it.

**Stays, reframed.** The documents vault as an encrypted byte store plus an access gate.
familygraph holds `content_ct` and a derived `policy_key`; it never parses a document and never
knows what an IEP says. What makes it LOOK like an education-record store is the taxonomy, not
the storage. If the ruling is applied literally here, the move is to make the vault
taxonomy-neutral — the school app owns the meaning and hands over a policy key — rather than to
relocate the bytes into an app with a weaker at-rest story.

**Moves.** `school_contexts`: grade, `classroom_id`, `classroom_name`, homeroom teacher,
`school_year`, activities, allergies. That is school state with a school's name on it, and under
the ruling ParentPoint / TeacherAIde own it. The blast radius is contained — one module
(`server/integration/schoolContext.js`), the `/v1` read+write pair, the merge repoint at
`server/identity/people.js:504`, the sealed-envelope and outbound-agent paths, and seven test
files. It is a `/v1` contract break, but ParentPoint is the only consumer and is where the data
would live anyway.

### B.4 The ruling may retire a pending migration

The plaintext-PII fix outstanding since 2026-07-29 covers `school_contexts.allergies` and
`.activities`. If that table leaves under B.3, the migration never needs writing — the columns
go with it. Don't start that work until the scope call is made. The `phones.e164` half of that
finding is unrelated and still stands on its own.

### B.5 Effect on section 7's decision list

- **Item 3 (moving the study release onto familygraph's consent rails) is answered: no.** A
  school-scoped study release is school-specific state. The ruling settles it, and A.1's
  override-or-base trap becomes moot rather than something to design around.
- **New item: the vault's accommodation taxonomy** — `iep` / `504` / `mtss` in or out, per B.2.
  This is the only place the ruling contradicts a shipped, deliberate design.
- Items 1 and 2 are unaffected; both already bind in ParentPoint and TeacherAIde.

### B.6 Still not done here

No code or schema changed for this ruling. `school_contexts` is untouched, the vault taxonomy is
untouched, and no migration was written. B.3 is a proposal awaiting confirmation, not a
completed move.
