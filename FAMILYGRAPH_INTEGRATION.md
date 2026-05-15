# ParentPoint × FamilyGraph — Integration Contract

**Audience:** engineers building the FamilyGraph repo + future ParentPoint
contributors wiring the connector.
**Status:** Draft v0.1 — May 2026.
**Companion file:** none required on the FamilyGraph side yet, but this doc
defines the read / write contract FamilyGraph must satisfy.

---

## 1. What ParentPoint is

ParentPoint is an AI-powered family-engagement app for a single Catholic
school community. A school's parents, teachers, coaches, school admins,
after-care staff, and enrichment instructors all sign in to one tenant and
get a role-appropriate view of:

- Calendar + tagged grade-level events
- Class rosters, parent ↔ teacher messaging, class announcements
- Bulletin / handout AI extraction
- Lunch ordering and balances
- Attendance alerts, carpool / pickup, drop-off requests
- Athletics (teams, schedules, RSVPs, worker assignments, scores)
- Volunteer hours with required-per-family minimums
- EIM (Ethics in Ministry) certification tracking
- Outbound push (email + SMS) for admins
- Optional MissionIQ family-sync mirror for enrollment

Data is multi-tenant by school: `schools/{schoolId}/...` under one Firebase
project. A single hardcoded superadmin can impersonate roles and switch
tenants. Auth today is Firebase: Google, Microsoft, passwordless email link,
and a salted-SHA-256 email allowlist baked into the bundle (beta).

ParentPoint stands up **standalone** today — every roster is entered by an
administrator (CSV or in-app CRUD). FamilyGraph is the planned identity
layer; ParentPoint must continue to work without it.

## 2. What FamilyGraph is (assumed)

A separate repository that hosts the **identity** and **household** layer for
people who appear in more than one community on the same campus — e.g. a
parish + its school. One person, one record, regardless of how many
ParentPoint-style apps reference them.

FamilyGraph is the place where:
- A person's name, email, phone, mailing address live.
- A household's adult ↔ child links live (mother / father / step-parent /
  guardian / grandparent / other) plus custody flags.
- Photo / communication consent flags that follow the person across contexts
  live.

FamilyGraph is **not** an identity provider. ParentPoint continues to use
Google / Microsoft / email-link / password sign-in. FamilyGraph is a data
backend; the auth handshake stays in Firebase.

---

## 3. Boundary of ownership *(connected mode)*

The line is: **identity and family structure belong to FamilyGraph; the
school context that wraps an identity belongs to ParentPoint.** Standalone
mode collapses this entirely — see §4.1.

| Entity / fact | FamilyGraph (when connected) | ParentPoint |
|---|---|---|
| **Person record** (name, preferred name, email, phone, address) | ✅ source of truth | cached read-only mirror |
| **Household** (which adults are linked to which kids, custodial flag, relationship label) | ✅ source of truth | cached read-only mirror |
| **Photo / DNP consent** | ✅ source of truth | cached, surfaced per-school |
| **EIM / safe-environment certifications** | ✅ source of truth (follows the person) | cached read-only mirror |
| **Identity ID** (`personId`, `householdId`) | ✅ issuer | stored on every PP entity that references a person |
| **Student → grade** (e.g. "Annie is in 3rd grade for 2026-2027") | mirror (read-only, pushed by PP) | ✅ source of truth |
| **Student → classroom + teacher** | mirror (read-only, pushed by PP) | ✅ source of truth |
| **Teacher → classroom assignment** | ❌ | ✅ source of truth |
| **School role** (parent / teacher / coach / school_admin / after_care / enrichment) | mirror (read-only, pushed by PP) | ✅ source of truth |
| **Child interests / activities** (e.g. "plays basketball", "drama camp", "after-care MWF") | mirror (read-only, pushed by PP, see §7.3) | ✅ source of truth |
| **School year** | ❌ | ✅ source of truth |
| **Messaging, lunch orders, attendance, athletics, volunteer hours, EIM expiration tracking per school** | ❌ | ✅ source of truth |

> **Hard rule from product:** *"Assignment of students to grades and classes
> happens in ParentPoint, by school administrators."* FamilyGraph never
> writes a grade or classroom into a ParentPoint record. Even when FG is
> connected, the AdminClassRosters editor in ParentPoint remains the only
> place a student gets dropped into a classroom. The reverse direction —
> ParentPoint pushing the resulting grade / classroom / activities up to
> FamilyGraph so FG has a fuller picture of the child — is in §7.3.

## 4. Modes of operation

ParentPoint has two persisted modes. The active mode is set per tenant at
`schools/{schoolId}/settings/integrations.familyGraph.enabled` and is
read at boot.

### 4.1 Standalone mode (default)

**ParentPoint owns 100% of the data.** No FamilyGraph involvement
whatsoever — no read calls, no write calls, no webhook handler running.
Everything an administrator needs is uploaded or entered directly into
ParentPoint.

What the superadmin / school admin maintains directly in ParentPoint:

- **Families & parents** — name, primary + secondary email, phone(s),
  mailing address, custody flags, photo / directory consent. Editable
  on `/admin/parents`.
- **Students** — name, current grade, allergies / medical notes,
  interests/activities. Editable on `/admin/students` and via
  `/admin/class-rosters` for classroom assignment.
- **Class rosters** — students per classroom, parent linkages, teacher
  assignment. Editable on `/admin/class-rosters`. Supports CSV bulk
  upload and the setup-wizard manual mode.
- **Teachers** — `/admin/teachers`, backed by `faculty_directory`
  filtered to `role: 'teacher'`.
- **Coaches** — `/admin/coaches`, filtered to `role: 'coach'`.
- **School admins / after-care / enrichment staff** — `/admin/admins`
  (the staff sidebar groups school_admin + after_care + enrichment
  together; finer filtering is a tab inside the page).
- **Welcome message templates** — per-role, editable at
  `/admin/welcome-messages`. Stored in
  `schools/{schoolId}/settings/app.welcomeMessages`.

When the superadmin adds a person via any of these screens:

1. The record is written locally with `source: 'manual'`.
2. A magic-link sign-in email is dispatched using the configured
   per-role welcome template. The recipient clicks the link, lands in
   the app already authenticated, and proceeds straight to the role's
   home view (parents drop into the parent onboarding;
   teachers / coaches / admins drop into their dashboards).
3. The user can also sign in any time with Google or Microsoft using
   the same email — the role lookup in `useAuth.resolveRole` matches
   them to the existing record so no temp password is ever needed.

Bulk import is supported in every roster surface (CSV + Google Sheet
URL) so the superadmin can lift an entire school's data into ParentPoint
in one pass without any external system.

### 4.2 FamilyGraph-connected mode
- Identity / household data is **read from FamilyGraph**. Local CRUD on
  identity fields is disabled in the UI; "Edit in FamilyGraph" buttons
  deep-link out.
- ParentPoint still owns the school-context fields (grade, classroom,
  teacher, role) and writes them.
- New FamilyGraph events (a parent updates their phone) propagate to
  ParentPoint via webhook or pull-on-read cache invalidation.
- School-context changes that imply identity changes — e.g. an admin
  adds a brand-new student who isn't yet in FamilyGraph — POST a
  create-suggestion to FamilyGraph and block enrollment until it's
  accepted (configurable: hard-block vs soft-create-stub).

### 4.3 Mode-aware data layer
Every ParentPoint repo write tags `source: 'manual' | 'familygraph'` so
that a future audit knows which writes came from a sync vs an admin
keystroke. Repos preserve `manual` edits even if FamilyGraph later
returns conflicting data — see §7.

---

## 5. ParentPoint data model recap

Read this section as the **target** that FamilyGraph syncs need to satisfy.
All collections live under `schools/{schoolId}/`.

| Collection | Doc id convention | Holds |
|---|---|---|
| `class_rosters` | `classroomId` slug | Students per classroom, parent emails, teacher email, school year |
| `faculty_directory` | lowercased email (`.` → `_`) | Teachers / coaches / school admins / after-care / enrichment + assigned classrooms |
| `invitations` | random | Pending staff invitations |
| `parent_contacts` *(new for standalone)* | lowercased email | Parent CRUD record with full contact info (added in this branch) |
| `users/{uid}` | Firebase uid (top-level) | Per-user profile + role mirror; created on first login |
| `pending_onboarding`, `onboarding_correction` | random | Parent-side onboarding flags admin resolves |
| `family_extras/{familyId}` | lowercased primary parent email | Other-school kids + pending spouse invites |
| `eim_certifications` | random | Per-person EIM training, required to volunteer |
| `do_not_photo` | random | Per-student photo restrictions |

ParentPoint's `UserRole` is:
```
'parent' | 'teacher' | 'school_admin' | 'platform_admin'
  | 'coach' | 'after_care' | 'enrichment'
```

Today the join keys are **email addresses**. Onboarding matches a parent's
email against `class_rosters[].students[].parentEmails`. When FamilyGraph
is connected we add a stable `personId` to every parent/student/staff
record so reassignments (email change, remarriage) stay linked even when
the email rotates.

---

## 6. Read contract — what ParentPoint needs to read from FamilyGraph

FamilyGraph must expose a stable HTTPS API (REST or GraphQL — TBD). The
shape below describes the **semantics** ParentPoint needs, regardless of
transport.

### 6.1 Identity object

```jsonc
{
  "personId": "fg_p_01HQX...",          // FamilyGraph-issued, immutable
  "primaryEmail": "amanda@example.com", // lowercased
  "additionalEmails": ["amanda2@example.com"],
  "phones": [
    { "e164": "+15125550101", "type": "mobile", "smsConsent": true },
    { "e164": "+15125550102", "type": "home", "smsConsent": false }
  ],
  "displayName": "Amanda Lee",
  "firstName": "Amanda",
  "lastName": "Lee",
  "preferredName": "Mandy",
  "dateOfBirth": "1985-04-12",           // optional, for adults
  "mailingAddress": {
    "line1": "...", "line2": "...",
    "city": "...", "state": "TX", "postal": "78701", "country": "US"
  },
  "kind": "adult" | "child",
  "active": true,
  "updatedAt": "2026-05-15T10:31:22Z"
}
```

### 6.2 Household object

```jsonc
{
  "householdId": "fg_h_01HQX...",
  "members": [
    { "personId": "fg_p_a1", "role": "mother", "custodial": true },
    { "personId": "fg_p_a2", "role": "father", "custodial": true },
    { "personId": "fg_p_c1", "role": "child" },
    { "personId": "fg_p_c2", "role": "child" }
  ],
  "primaryContactPersonId": "fg_p_a1",
  "communicationLanguage": "en",
  "updatedAt": "..."
}
```

`role` values match ParentPoint's existing
`ClassRosterParentLinkage.relationship`: `mother | father | step_parent |
guardian | grandparent | other | child`.

### 6.3 Consent flags

```jsonc
{
  "personId": "fg_p_c1",
  "photoConsent": "allow" | "group_only" | "deny",
  "directoryListing": "allow" | "deny",
  "updatedAt": "..."
}
```

### 6.4 Endpoints ParentPoint expects

| Verb + path | Purpose | Caller |
|---|---|---|
| `GET /v1/persons/{personId}` | Hydrate a cached person on demand | Client + Cloud Function |
| `GET /v1/persons?email={email}` | Lookup at sign-in (does this email exist?) | `useAuth` cross-tenant lookup |
| `GET /v1/households/{householdId}` | Render the family card on the parent dashboard | Client |
| `GET /v1/households?personId={pid}` | Find a person's household | Client |
| `GET /v1/persons/changed?since={iso}` | Incremental pull for caches | Cloud Function (cron) |
| `GET /v1/households/changed?since={iso}` | Incremental pull for caches | Cloud Function (cron) |

All `GET` responses **must** include `Cache-Control: max-age` and an
`ETag` so ParentPoint can avoid re-pulling unchanged objects.

### 6.5 Webhook ParentPoint expects to consume

FamilyGraph POSTs to a ParentPoint Cloud Function endpoint when an
identity / household record changes:

```jsonc
POST https://us-central1-{project}.cloudfunctions.net/familyGraphWebhook
Headers: { "X-FG-Signature": "sha256=..." }
Body: {
  "event": "person.updated" | "person.deleted"
        | "household.updated" | "household.deleted"
        | "consent.updated",
  "personId": "fg_p_...",
  "householdId": "fg_h_...",       // when applicable
  "updatedAt": "2026-05-15T10:31:22Z",
  "schoolHints": ["st-theresa"]    // optional, FG knows which PP tenants reference this person
}
```

ParentPoint's webhook handler does **two** things:
1. Invalidates the cached copy of that personId / householdId across all
   tenants in `schoolHints` (or all tenants if absent).
2. Fans out to any derived records — e.g. updating
   `class_rosters[].students[].parentLinkages[].phone` for matching
   children.

---

## 7. Write contract — what ParentPoint writes to FamilyGraph

ParentPoint writes two kinds of things to FamilyGraph:

1. **Identity events** (§7.1) — suggestions to create / update an
   identity or household record that originated in ParentPoint.
2. **Child enrichment context** (§7.3) — a read-only mirror of what
   ParentPoint knows about each child: current grade, classroom, the
   activities and interests they're engaged in. FG never overrides
   these locally; it just stores them so that when another consumer of
   the FG identity (e.g. the parish app) needs to render "Annie, 3rd
   grade, plays basketball and is in drama camp" they can.

Generic write semantics (idempotency, ETags, request IDs) in §7.2 apply
to both. Conflict resolution rules in §7.4 also apply to both.

### 7.1 Identity write endpoints

| Verb + path | Purpose | Trigger |
|---|---|---|
| `POST /v1/persons` | Suggest a new identity (e.g. admin added a parent or student who isn't yet in FG) | `/admin/parents → Add`, `/admin/students → Add` |
| `POST /v1/households` | Suggest a new household | `/admin/parents → Add` when no household match |
| `POST /v1/households/{id}/members` | Add a person to a household | Admin links a parent to a student already in FG |
| `PATCH /v1/persons/{personId}` | Update contact field (email change, phone change) | Admin edits in `/admin/parents` after the parent reported a change |
| `POST /v1/persons/{personId}/photoConsent` | Update DNP / photo consent | `/admin/do-not-photo` writes |
| `POST /v1/persons/{personId}/eimCertifications` | Add/extend an EIM cert | EIM admin page write |

### 7.3 Child enrichment context (PP → FG mirror)

Because FamilyGraph spans communities on the same campus, a sibling app
(e.g. the parish's faith-formation app) benefits from a richer picture
of each child than just "name + DOB". ParentPoint pushes a denormalized
**enrichment snapshot** keyed by `personId` so FG can show it
elsewhere.

```jsonc
POST /v1/persons/{personId}/schoolContext
Headers:
  Authorization: Bearer <service-jwt>
  X-Source-App: parentpoint
  X-Source-Tenant: st-theresa
Body: {
  "schoolId": "st-theresa",
  "schoolYear": "2026-2027",
  "grade": "3",                          // current school year
  "classroomId": "3A",
  "classroomName": "Room 204 — Ms. Lee",
  "homeroomTeacherPersonId": "fg_p_t1",  // optional, only if FG knows the teacher
  "activities": [
    { "kind": "sport",      "label": "Basketball — Girls 4A",       "season": "2026-2027 Winter" },
    { "kind": "sport",      "label": "Volleyball — Girls 4A",       "season": "2026-2027 Fall" },
    { "kind": "enrichment", "label": "Drama Camp (May 2026)",       "season": "2026-2027" },
    { "kind": "after_care", "label": "After-care: MWF",             "season": "2026-2027" }
  ],
  "allergies": ["peanuts"],              // when admin / parent has entered them
  "snapshotAt": "2026-05-15T10:31:22Z"
}
```

**Triggers (server-side, via Cloud Function fanout)** — every write that
changes one of the underlying records re-emits the snapshot for the
affected `personId`:

- `class_rosters` write — re-emit for every child added / removed and
  for any child whose grade or classroom changed.
- `sport_teams.rosterStudentIds` write — re-emit for every player
  added / removed.
- `registrations` (enrichment / camp) write — re-emit for the registered
  child.
- `after_care_registrations` write — re-emit for the enrolled child.

The Cloud Function debounces fanouts per `personId` to one POST every
5 minutes — admins doing bulk edits won't pile up FG calls.

**Important:** the `activities` array is the **current state**, not a
log. FG is expected to overwrite the previous snapshot on every POST.
ParentPoint keeps the activity history in its own collections; FG only
needs the now-picture.

### 7.2 Write semantics

- Every PATCH carries an `If-Match: {etag}` header so a stale ParentPoint
  cache can't blindly overwrite FamilyGraph. On 412 Precondition Failed,
  ParentPoint re-pulls and surfaces a "merge with their newer record?"
  prompt to the admin.
- Writes are **idempotent by client request id**: ParentPoint sends
  `X-Request-Id: pp_{uuid}` and FamilyGraph dedupes within 24h so retries
  on flaky networks don't double-create.
- A successful create returns the new `personId` / `householdId`, which
  ParentPoint immediately stores against its local record so all
  subsequent writes use the FG id.

### 7.4 Conflict resolution

The product rule is **last-writer-wins per-field, with manual edits
beating sync writes inside their freshness window.** Concretely:

- Local ParentPoint repos store `lastManualEditAt` alongside
  `source: 'manual' | 'familygraph'` per field-set (one timestamp per
  doc, granular per-doc is enough).
- When the FamilyGraph webhook fires, the sync handler compares the
  incoming `updatedAt` against `lastManualEditAt`:
  - If `updatedAt > lastManualEditAt + 60s` → accept FG's version.
  - Otherwise → keep ParentPoint's manual edit, flag a row in
    `schools/{sid}/familygraph_conflicts` for admin review.
- Admins resolve conflicts at `/admin/familygraph-conflicts` (planned UI;
  not yet built).

The 60s buffer covers the case where an admin clicks Save and a
FamilyGraph webhook fires for the same field within seconds — without
the buffer the admin's local edit gets clobbered.

---

## 8. Sync semantics summary

| Concern | Choice |
|---|---|
| Primary direction | Bidirectional, FG-leaning for identity |
| Transport | Webhooks (FG → PP) + REST (PP → FG) |
| Reconciliation | Hourly cron pulls `/v1/persons/changed?since=` and `/v1/households/changed?since=`; webhook failures are caught up. |
| Cache | Firestore `schools/{sid}/familygraph_mirror/{personId}` + `.../household_mirror/{householdId}` with TTL refreshed on webhook. |
| Auth between repos | mTLS or signed webhook + service-account JWT for REST. Final choice tracked in §11. |
| Personally identifying logging | Off by default; only personId / householdId logged, never raw emails. |

---

## 9. Authentication & identity flow

Sign-in remains Firebase. FamilyGraph is consulted only **after** Firebase
hands us a verified email.

```
User clicks "Sign in with Google" (or Microsoft / email-link)
    ↓
Firebase verifies, returns { uid, email, displayName }
    ↓
useAuth.resolveRole(firebaseUser):
    1. Superadmin? → platform_admin
    2. faculty_directory[email]? → staff role + tenant
    3. invitations[email]? → invited role + tenant
    4. schools.domains contains email's domain? → parent in that school
    5. (familygraph mode) GET /v1/persons?email=... → if found, use the
       returned personId to look up which schools reference it, then
       proceed as parent in that school (or staff if FG tags them)
    6. Fall back to parent in default tenant
```

A note: even in FamilyGraph mode, ParentPoint never asks the user to
*log in to FamilyGraph*. Identity is whatever Firebase verified plus
whatever FamilyGraph data hangs off the verified email.

---

## 10. Sample end-to-end scenarios

### 10.1 Admin adds a new family in standalone mode
1. `/admin/parents → New parent` with name + email + phone + address.
2. ParentPoint writes `parent_contacts/{lowercaseEmail}` with
   `source: 'manual'`. No external call.
3. Admin opens `/admin/students` and adds the child. Writes a new doc
   to `students` (new collection in this branch) with `source: 'manual'`.
4. Admin opens `/admin/class-rosters`, drops the child into 3A, picks
   the parent from the autocomplete. Writes `class_rosters/3A` with the
   new linkage.

### 10.2 Same flow with FamilyGraph connected
1. Admin types the parent's email. Autocomplete hits
   `GET /v1/persons?email=...` and resolves to an existing personId. The
   contact fields autofill, read-only, with an "Edit in FamilyGraph" link.
2. Admin proceeds to add the child. They click "Add new student" — the
   form requires a `personId`. ParentPoint either:
   - Searches FamilyGraph by name and the admin picks an existing child, or
   - Sends `POST /v1/persons` to suggest a new identity (kind=child). FG
     responds with a personId; admin attaches it to the household.
3. Admin opens `/admin/class-rosters` and assigns to 3A — *this is the
   only step ParentPoint writes locally*.

### 10.3 Parent changes their phone in FamilyGraph
1. The parent updates their phone in the FamilyGraph parish app.
2. FG POSTs `person.updated` to the ParentPoint webhook.
3. ParentPoint:
   - Updates `familygraph_mirror/{personId}` with the new payload.
   - Re-derives phone on every `class_rosters` doc that references this
     personId (so messaging recipient pickers and SMS queues are correct).
   - Notifies subscribed Cloud Function consumers (e.g. the outbound SMS
     queue rebuilder).

### 10.4 Child gets added to the basketball team (PP → FG enrichment push)
1. Athletic Director adds Annie Lee to the Girls 4A basketball roster
   on `/admin/sports/teams`.
2. The `sport_teams.rosterStudentIds` write triggers the Cloud Function
   `emitSchoolContextSnapshot(personId)` for Annie's `personId`.
3. The Cloud Function debounces by personId (5-min window) and then
   POSTs `/v1/persons/{personId}/schoolContext` to FamilyGraph with the
   full current snapshot — grade, classroom, *and* the updated
   `activities` array now including basketball.
4. FG stores the snapshot; the parish app querying
   `GET /v1/persons/{annie}/schoolContext` now sees the basketball
   activity alongside any drama-camp / after-care entries already there.

### 10.5 Admin moves a student to a different classroom
1. Admin edits `/admin/class-rosters/3A`, removes Annie, then adds her
   to `/admin/class-rosters/3B`.
2. The Cloud Function fires `emitSchoolContextSnapshot(annie.personId)`
   once the debounce window settles.
3. ParentPoint pushes the new snapshot to FG with `classroomId: '3B'`,
   `classroomName: 'Room 207 — Mr. Patel'`, `homeroomTeacherPersonId:
   <Mr. Patel's personId if known>`.
4. FG overwrites the previous snapshot for Annie. Activity history in
   PP is unaffected (PP keeps its own audit log).

---

## 11. Open questions

| # | Question | Owner | Status |
|---|---|---|---|
| Q1 | REST vs GraphQL for the FG-side API? | FG repo | open |
| Q2 | Single shared Firebase project, or separate FG project with cross-project IAM? | both | open |
| Q3 | Auth between repos — mTLS, signed webhooks + service-account JWT, or both? | both | open |
| Q4 | Should ParentPoint admins be able to *create* FamilyGraph identities, or only suggest? (Hard-block vs soft-create-stub.) | product | open |
| Q5 | Are `do_not_photo` records identity-level (FG) or school-level (PP)? Today they're per-student in PP. Proposal: identity-level in FG, PP keeps a per-school override for "no photos at this school's events" specifically. | product | open |
| Q6 | EIM cert: who is the system of record — the diocese? Does FG just cache it? | product | open |
| Q7 | When an admin in PP archives a parent, does that propagate as a delete to FG, or just unlink from this school's tenant? Strongly recommend the latter. | product | open |

---

## 12. Versioning

This contract is **v0.1**. Every FG API call ParentPoint makes will
include `X-PP-Contract-Version: v0.1` and FG should refuse calls whose
declared version isn't on its compatibility list. Bump the minor when
adding fields, the major when changing semantics.

---

## 13. Implementation checklist (ParentPoint side)

When FamilyGraph is ready to wire up:

- [ ] Add `familyGraph` block to `SchoolAppSettings`:
      `{ enabled: boolean, baseUrl: string, webhookSecret: string }`.
- [ ] Add `personId` + `householdId` optional fields to:
      `UserProfile`, `ClassRosterStudent`, `ClassRosterParentLinkage`,
      `FacultyDirectoryEntry`, new `ParentContact` type, new `StudentRecord` type.
- [ ] Implement `src/shared/data/familyGraph.ts` client (REST + cache).
- [ ] Implement Cloud Function webhook receiver
      (`functions/src/familyGraphWebhook.ts`).
- [ ] Implement Cloud Function `emitSchoolContextSnapshot(personId)`
      with 5-min debounce per `personId`, triggered from `class_rosters`,
      `sport_teams`, `registrations`, `after_care_registrations` writes.
- [ ] Add hourly catch-up cron to the existing Cloud Functions deploy.
- [ ] Gate identity-editing fields in `/admin/parents`, `/admin/students`,
      `/admin/teachers`, `/admin/coaches`, `/admin/admins` behind
      `useFamilyGraphMode()` — read-only with deep-links when connected.
- [ ] Add `/admin/familygraph-conflicts` UI for the conflict queue.
- [ ] Wire `source: 'familygraph'` writes through every existing repo
      so future audits can distinguish manual from sync writes.

## 14. Why two modes?

Some schools that adopt ParentPoint won't have a sibling parish app on
the same campus — for them, FamilyGraph is overkill. Forcing them to
stand up an identity service before they can roster their families
would kill adoption.

Other schools share a campus and staff with a parish, so a single
mother-of-three doesn't want to maintain her phone number in two
places. For them, FamilyGraph is the single front door.

Both customers should get the same ParentPoint UX. The connector is the
only thing that changes. That's why every ParentPoint repo write
tags `source` and every identity-editing UI gates on
`useFamilyGraphMode()`.

Last updated: 2026-05-15.

---

## Appendix A — As-built FamilyGraph contract surface (2026-05-15)

This appendix records what shipped on the FamilyGraph side against v0.1 of
the contract. Any divergence from the spec sections above is documented
here rather than rewritten into the body, per the convention in
`CLAUDE.md` (PRDs are historical records of intent; the appendix records
what shipped).

### Schema additions (migration 0012)

New columns on existing tables:

- `persons.kind` — `'adult' | 'child' | NULL`. Pre-contract rows are
  NULL; the operator can backfill via the existing PATCH path.
- `persons.preferred_name_ct` — AES-256-GCM ciphertext. Surfaces as
  `preferredName` in the §6.1 person object.
- `families.primary_contact_person_code` — soft pointer at the primary
  contact (the household object's `primaryContactPersonId`). Soft because
  a merge can retire the referenced code; the API falls back to the
  first active adult member.
- `families.communication_language` — ISO-639-1 short code. Default `en`.
  Surfaces as `communicationLanguage`.
- `memberships.relation_label` — finer-grained label than the existing
  `role` bucket: `mother | father | step_parent | guardian | grandparent
  | other | child`. Lets the household members[] round-trip without
  losing the mother-vs-father distinction.
- `phones.e164` — canonical `+15125550101` representation. Existing rows
  get e164 populated lazily on the next write that touches the row.
- `phones.sms_consent` — per-phone SMS opt-in. Surfaces inside the
  phones[] array of the person object.

New tables:

- `person_consents` — photo + directory consent per person. Lazy-created
  on first set; missing rows read as the contract default `'allow'` for
  both fields. `person_consents.updated_at` feeds the changed-since
  endpoint.
- `eim_certifications` — history of safe-environment certs per person.
  The existing `persons.eim_*` columns continue to hold the "current"
  cert pointer for the expiring-soon dashboard view; the new table
  preserves the audit trail of every renewal.
- `school_contexts` — PP-pushed enrichment snapshots, unique per
  `(person_code, school_id)`. POSTs overwrite (the doc treats activities
  as current state, not a log).
- `pp_webhook_subscriptions` / `pp_webhook_deliveries` — registered PP
  endpoints + per-attempt delivery rows with exponential backoff. Same
  retry shape as the existing notifications queue.
- `pp_idempotency_keys` — `X-Request-Id` dedupe cache. 24-hour TTL per
  the contract; lazy expiry on lookup, sweep every 6h.

### HTTP surface

Mounted at `/v1/...`. All routes require Bearer auth with the new
`parentpoint` scope (master token also works). The router lives in
`server/api/parentpoint.js`; helper modules under `server/parentpoint/`:
`objects`, `consents`, `certifications`, `schoolContext`, `webhooks`,
`changes`, `etag`, `idempotency`.

| Verb + path | Purpose | Notes |
|---|---|---|
| `GET /v1/persons?email=` | Lookup by email | Normalised hash match |
| `GET /v1/persons/changed?since=` | Incremental pull | `since` is ISO-8601 |
| `GET /v1/persons/:personId` | Hydrate one person | ETag + `Cache-Control: max-age=30` |
| `GET /v1/persons/:personId/schoolContext` | Read snapshot(s) | `?schoolId=` for one |
| `GET /v1/persons/:personId/consent` | Read consent | Defaults applied |
| `POST /v1/persons` | Suggest a new identity | Body accepts both PP shape and FG shape |
| `PATCH /v1/persons/:personId` | Update contact fields | Honors `If-Match` (412 on mismatch) |
| `POST /v1/persons/:personId/photoConsent` | Update consent | Emits `consent.updated` webhook |
| `POST /v1/persons/:personId/eimCertifications` | Add/extend EIM cert | Promotes to current when later than existing |
| `POST /v1/persons/:personId/schoolContext` | Enrichment snapshot upsert | Overwrites previous snapshot |
| `GET /v1/households?personId=` | Find a person's household | First active membership |
| `GET /v1/households/changed?since=` | Incremental pull | Includes families with merged-in updates |
| `GET /v1/households/:householdId` | Render the household | ETag + Cache-Control |
| `POST /v1/households` | Suggest a new household | Optional members[] at create time |
| `POST /v1/households/:id/members` | Add a member | Bumps family.updated_at |
| `POST /v1/webhooks` | Subscribe a PP webhook URL | Body: `{ url, secret, events?, schoolHint? }` |
| `GET /v1/webhooks` | List subscriptions | |
| `DELETE /v1/webhooks/:code` | Unsubscribe | Cascades pending deliveries |
| `GET /v1/webhooks/:code/deliveries` | Recent attempt rows | Filter `?status=` |

Per-request middleware:

- `X-PP-Contract-Version` is recorded on every call. Unknown values
  return `426 Upgrade Required`; missing values are accepted and logged
  (some early PP clients won't set the header).
- `X-Source-App` / `X-Source-Tenant` are recorded on writes. Tenant doubles
  as the school-hint when fanning out webhook deliveries — only
  subscriptions that match the hint or have no hint receive the event.
- `X-Request-Id` triggers idempotency dedupe on POST/PATCH. A second
  request with the same id within 24h replays the cached response and
  sets `X-FG-Idempotent-Replay: true`.
- GET responses set `ETag` (weak validator, sha-256 of stable JSON) and
  `Cache-Control`.
- PATCH compares `If-Match` against the current ETag. Mismatch → 412.

### Webhook emission

POSTs the §6.5 body shape to every matching subscription:

```
POST <subscription.url>
Headers:
  Content-Type: application/json
  X-FG-Signature: sha256=<HMAC-SHA256(secret, body)>
  X-FG-Contract-Version: v0.1
  User-Agent: familygraph-webhook/0.1
```

Triggered by:

- `POST /v1/persons` and `PATCH /v1/persons/:id` → `person.updated`
- `POST /v1/persons/:id/photoConsent` → `consent.updated`
- `POST /v1/persons/:id/eimCertifications` → `person.updated`
- `POST /v1/households` → `household.updated`
- `POST /v1/households/:id/members` → `household.updated`

Delivery semantics mirror the existing notifications queue: 5 attempts,
exponential backoff (30s / 2m / 10m / 1h / 6h). Dispatcher runs once per
60s in the background; disable with `FAMILY_GRAPH_DISABLE_PP_WEBHOOKS=1`.

### Authentication

A new `parentpoint` scope on the existing per-app key surface
(`server/auth/api-keys.js`). Provision a key with that scope and PP
calls go through; the master token continues to work. mTLS (Q3) is not
implemented in v0.1; the signed-webhook + scoped-bearer combination is
the v0.1 answer.

### What's deliberately NOT in scope yet

- The conflict-resolution UI for §7.4 (`schools/{sid}/familygraph_conflicts`
  in PP, `/admin/familygraph-conflicts` UI). FamilyGraph already has a
  conflict queue at `/api/conflicts` — wiring "PP detected a divergence"
  rows into it is a follow-up.
- `do_not_photo` per-school override (§11 Q5). The current consent table
  is single-tenant; the per-school override needs a join table that the
  product team hasn't decided on.
- Diocese-as-source-of-truth for EIM (§11 Q6). FamilyGraph caches the
  certification payload as PP sends it; the diocesan integration is a
  separate workstream.
- `person.deleted` / `household.deleted` webhook emission. Both are
  defined in the contract but FamilyGraph never deletes today (status
  flips to `'archived'` or `'merged'`). When the archive workflow ships,
  the emission point will be wired to it.

### Test count

Migration 0012 + the contract surface + scenario tests added 80 cases.
The full suite went from 310 → 390 passing (1 skipped on root, as before).

---

## Appendix B — v0.2 additions: per-school overrides, dioceses, change log (2026-05-15)

The follow-up to Appendix A picked up the three §11 open questions the
operator wanted resolved beyond v0.1:

- **Q5 (per-school photo consent)** — implemented in FG, not just PP.
  Identity-level base remains the source of truth; a school can
  override either field (photo or directory) and the effective value
  for `(person, school)` is `override-or-base`.
- **Q6 (diocese as system of record for EIM)** — implemented as a
  `dioceses` catalog with optional per-diocese renewal interval. Cached
  EIM certs point back via `diocese_code` + `diocese_record_id` so the
  operator can reconcile against the diocesan record.
- **Architectural: restorable deletions** — added the `entity_changes`
  log with full row snapshots and an archive/reinstate workflow that
  replaces hard deletes. Merges still produce alias rows (the harder
  "un-merge" needs a separate operator workflow; it's a manual replay
  of the change log).

### Migration 0013 schema additions

New columns:

- `eim_certifications.diocese_code` — soft FK to `dioceses.code`.
- `eim_certifications.diocese_record_id` — external id from the
  diocese's own system (paper form number, vendor record id).

New tables:

- `dioceses` — `code` / `name` / `region` / `contact_url` /
  `eim_program_name` / `eim_renewal_years` / encrypted `notes_ct` /
  `status: active|archived`. Partial unique index on `name` where
  `status = 'active'` so a re-introduced diocese name doesn't collide
  with an archived one.
- `person_consent_overrides` — `(person_code, school_id)` composite
  PK; each consent column independently nullable so a school can
  override only one field. Cleared automatically when both override
  columns end up null.
- `entity_changes` — append-only log of every meaningful write.
  Columns: `entity_kind`, `entity_code`, `operation` (one of
  `create | update | archive | reinstate | merge | split | delete`),
  `before_json`, `after_json`, `actor`, `actor_kind`, `request_id`,
  `related_codes` (JSON array, e.g. `[winner_code]` on merge),
  `reason`. BLOB columns in the snapshots ride through as
  base64-encoded strings, so the dataKey is still required to decrypt
  PII.

New identifier prefixes:

- `dio_` — diocese (`dio_xxxxxxxx`)
- `chg_` — entity change row (`chg_xxxxxxxx`)

### New / updated HTTP surface

| Verb + path | Purpose | Notes |
|---|---|---|
| `POST /v1/persons/:id/photoConsent` | Update consent | Body / query `schoolId` writes the per-school override; absent = identity-level base |
| `DELETE /v1/persons/:id/photoConsent?schoolId=` | Clear an override | Falls back to the base |
| `GET /v1/persons/:id/consent?schoolId=` | Effective consent | Includes `basePhotoConsent` / `baseDirectoryListing` when an override is applied |
| `GET /v1/persons/:id/consent/overrides` | List active overrides | One row per school |
| `GET /v1/dioceses` | List dioceses | `?status=archived` to see archived ones; `?includeNotes=1` to decrypt notes |
| `POST /v1/dioceses` | Create | Body: `{ name, region?, contact_url?, eim_program_name?, eim_renewal_years?, notes? }` |
| `GET /v1/dioceses/:code` | Read | |
| `PATCH /v1/dioceses/:code` | Update | Honors `If-Match` |
| `POST /v1/dioceses/:code/archive` | Soft-delete | Writes a change row + audit row |
| `POST /v1/dioceses/:code/reinstate` | Reverse archive | |
| `POST /v1/persons/:id/eimCertifications` | Add/extend EIM cert | Now accepts `dioceseCode` + `dioceseRecordId`; per-diocese renewal interval supersedes the global setting for auto-derivation |
| `POST /v1/persons/:id/archive` | Soft-delete | Emits `person.deleted` webhook |
| `POST /v1/persons/:id/reinstate` | Reverse archive | Emits `person.updated` webhook |
| `GET /v1/persons/:id/history` | Entity change log | Reverse chronological |
| `POST /v1/households/:id/archive` | Soft-delete | Emits `household.deleted` |
| `POST /v1/households/:id/reinstate` | Reverse archive | Emits `household.updated` |
| `GET /v1/households/:id/history` | Entity change log | |

### Webhook payload additions

`consent.updated` events now carry `schoolId` in the body when the change
was school-scoped:

```jsonc
{
  "event": "consent.updated",
  "personId": "p_a7b3c91d",
  "updatedAt": "2026-05-15T14:35:11.012Z",
  "schoolHints": ["st-theresa"],
  "schoolId": "st-theresa"
}
```

A consent change at the identity level omits `schoolId`. PP clients that
already ignored unrecognised keys continue to work; clients that want
the fanout precision can switch on the presence of `schoolId`.

`person.deleted` and `household.deleted` events now actually fire — the
archive operation is the trigger point, and reinstate fires
`person.updated` / `household.updated`. The doc-level v0.1 placeholders
graduate to real behaviour here.

### Merge → archive interaction

A caller passing a merged-loser code to the archive endpoint is rejected
with `400 Bad Request` ("cannot archive a merged person; merge owns the
row"). The same applies to reinstate. This is deliberate: alias-follow
through to the winner row would silently archive a record the caller
didn't expect. If the operator wants to archive a merged identity, they
should target the winner directly.

### Restorability semantics

- Persons + families: archive → status = 'archived'; reinstate → status
  = 'active'. The row stays in the database the entire time; its
  related rows (memberships, consents, school_contexts, EIM certs)
  ride along under the parent's status without being touched. Reinstate
  restores the whole graph in one operation.
- Webhook subscriptions: `DELETE /v1/webhooks/:code` is now a soft
  unsubscribe (`enabled = 0`). The row + its secret survive so a later
  `resubscribe` puts the same delivery pipeline back in place. The
  default `GET /v1/webhooks` filters to active subscriptions; pass
  `?status=all` to see soft-disabled rows.
- Webhook deliveries are NOT cascaded on unsubscribe — the audit trail
  for past deliveries survives.
- Idempotency keys: still hard-deleted on TTL expiry. The point of an
  idempotency key is "did we already process this request?" and an
  expired one carries no information worth preserving.
- Merges: still produce alias rows. The change log captures the
  surviving and retired sides at merge time so a manual operator
  workflow can replay the state, but `POST /v1/persons/:id/reinstate`
  on a merged-loser code refuses (see above).

### Retention

`entity_changes` has its own retention setting at
`entity_changes_retention_days`. Unset = keep forever (the contract
explicitly supports restoring soft-archived records, so retention
should default to indefinite). Operators who want a hard cap set the
value and the daily sweeper trims rows older than the cap.

### Test count

Migration 0013 + the new endpoints + scenario coverage added 40 more
cases. The full suite went from 390 → 431 passing (1 skipped on root,
as before).

---

## Appendix C — Audit pass and bug fixes (2026-05-15)

A comprehensive multi-agent audit of the v0.1 + v0.2 surface caught a
batch of real bugs across the contract. Every one is now fixed and
covered by a regression test; the full suite went from 431 → 463
passing (+32 cases).

### Critical fixes

- **Archived persons used to leak full PII through the
  `/v1/persons/changed` feed.** `personObject` decrypted firstName,
  lastName, primaryEmail, phones, mailingAddress for archived rows.
  The change feed now tombstones non-active records — the response is
  `{ personId, active: false, status, updatedAt }` only. Direct GET
  `/v1/persons/:id` still returns the full record because operator UIs
  need it for the historical view; same pattern for households.
- **The retention sweep deleted the latest `entity_changes` snapshot
  for each entity** when retention was configured. That broke the
  audit trail for currently-archived records (the operator couldn't
  see WHEN/WHY the archive happened). The sweep now preserves
  `MAX(rowid) GROUP BY entity_kind, entity_code` — a floor that
  guarantees the latest event for every entity survives regardless of
  age. Operators can still cap retention; the floor is the safety net.
- **`person_consent_overrides` were orphaned on merge.** When person A
  was merged into person B, A's per-school overrides stayed on A's
  code and became unreachable through `listOverridesForPerson(B)`.
  `people.merge` now re-points overrides to the winner. When both
  sides have an override for the same school, the more-restrictive
  value per field wins (`deny > group_only > allow` for photo;
  `deny > allow` for directory). `person_consents`, `eim_certifications`,
  and `school_contexts` get the same treatment.
- **`DELETE` endpoints bypassed idempotency on retry.** The middleware
  only ran for POST/PATCH, and the `captureResponse` wrapper only
  caught `res.json` (not `res.end`). Retrying
  `DELETE /v1/persons/:id/photoConsent?schoolId=...` re-executed the
  clear, potentially nuking an override the operator re-set in
  between attempts. The middleware now includes DELETE, the capture
  wraps both `res.json` and `res.end`, and the replay path uses
  `.end()` for cached null-body 204s.

### High fixes

- **`GET /v1/dioceses?status=all`** returned an empty list. The query
  did `WHERE status = 'all'` which never matches; now `all` skips the
  WHERE clause entirely and returns active + archived together.
- **`people.merge` / `families.merge` / `families.split` didn't write
  to `entity_changes`.** The architectural ask was that every
  meaningful write be loggable; merges and splits were holes. Now all
  four operations emit a row with the loser/new-family code in
  `related_codes` so a manual un-merge workflow can reconstruct.
- **`schoolId` validation** wasn't enforced consistently. Slashes in a
  schoolId broke the composite history entity_code
  (`${person}/${schoolId}`). The validator
  (`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`) is now applied at every
  write boundary in consents and schoolContext.

### Medium fixes

- **Snapshot serializer recursion.** `_normaliseValue` only handled
  top-level Buffers; nested Buffers got silently dropped to `{}` by
  JSON.stringify. Now recurses, handles Buffer / Uint8Array / Date /
  BigInt / NaN / Infinity, and strips `__proto__` / `constructor` /
  `prototype` defensively. Circular detection switched from
  any-prior-sight to ancestor-only so siblings that share a reference
  (e.g. two memberships pointing at one address row) serialise
  correctly instead of one being marked `[circular]`.
- **`dioceses.update` camelCase / snake_case asymmetry.** A patch
  with `eimRenewalYears` was previously preferred over
  `eim_renewal_years` only when the snake_case key was absent; now a
  `_normalisePatch` helper maps the camelCase form into the
  snake_case slot if no snake_case key exists, and snake_case wins on
  tie-breaks (matching what FG itself emits).
- **`PATCH /v1/dioceses/:code` was racy.** The handler did a read for
  ETag and a read inside `dioceses.update` separately. Concurrent
  writes could slip between them. The ETag check now runs INSIDE the
  update transaction, returning a sentinel that the router maps to a
  412.
- **`diocese_record_id` length cap.** The column is unbounded TEXT;
  the helper now rejects values over 256 chars.
- **Webhook URL SSRF guard.** `webhooks.subscribe` rejects loopback,
  link-local, RFC1918, and the cloud metadata endpoint
  (169.254.169.254). Plain http:// is allowed but logs a warning at
  subscription time (signed payloads are integrity-protected but not
  confidential).
- **Webhook dispatcher graceful shutdown.** `stop()` now returns the
  in-flight delivery promise so the boot path can await it during
  SIGINT/SIGTERM — an orphaned fetch mid-delivery used to leave the
  delivery `pending` and trigger a re-send on the next process start.

### Atomicity hardening

- Every write path that touches an entity AND writes a history row
  now runs inside a single `db.transaction(() => ...)`. Pre-fix, a
  history.record() failure (e.g. unknown kind, snapshot serialiser
  bug) left the data row written but no log row recorded — a
  state-vs-audit-trail divergence that violated the architectural
  ask. Covered: people.create / update / archive / reinstate /
  merge, families.create / update / archive / reinstate / merge /
  split, dioceses.create / update / archive / reinstate,
  consents.set / setOverride / clearOverride, certifications.add.

### Test count

The audit + fix pass added 32 cases (parentpoint-bugfixes.test.js,
parentpoint-merge-migration.test.js, plus updates to existing tests).
The full suite went from 431 → 463 passing (1 skipped on root, as
before).

