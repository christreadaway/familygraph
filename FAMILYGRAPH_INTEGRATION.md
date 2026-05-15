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
