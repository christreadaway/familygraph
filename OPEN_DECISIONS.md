# Open decisions

**What this is.** The running list of decisions this repo is waiting on, plus
the ones already closed and the reasoning that closed them. Split out of
`CLASSROOM_AV_IMPLICATIONS.md` on 2026-08-04 so the decision list isn't buried
inside one pilot's document.

**How to use it.** When a decision is made, move it to Closed with the date and
the ruling, and write the reasoning into `session_notes.md`. A decision that
lives only in a chat log gets re-litigated.

---

## Open — needs an owner call

### D1. The document vault's accommodation taxonomy (`iep` / `504` / `mtss`)

The sharpest one, because it's the only place the 2026-08-04 scope ruling
contradicts a shipped, deliberate design.

**The question.** The vault treats `iep`, `504`, and `mtss` as first-class
document subtypes (`server/integration/documents.js:37`), under an access matrix
keyed on `learning_team` and `assigned_teacher` staff roles
(`server/integration/documentPolicy.js:81`). An IEP is the canonical education
record and no parish has one. Under the scope boundary that's school-specific
data. Does it stay?

**Why it isn't obvious.** Migration 0017 put it here on purpose: Family Graph
"becomes the authoritative ACCESS GATE" so the partner app never holds the bytes
— one encrypted store, one policy decision, one audit trail, no inbound ports.
Relocating the bytes to ParentPoint inverts that, and makes ParentPoint rebuild
at-rest encryption, the access matrix, and the audit trail with a weaker story
than the one it replaces.

| Option | What changes | Cost |
|---|---|---|
| **A. Taxonomy-neutral** *(recommended)* | The vault keeps storing encrypted bytes and enforcing access, but stops knowing what an IEP is. The school app derives `policy_key` and passes it in; the subtype vocabulary and the matrix move out | Small. `SUBTYPE_TO_POLICY` and the matrix leave `documentPolicy.js`, `policy_key` becomes caller-supplied and validated. Keeps 0017's one-gate property |
| **B. Move the bytes** | `accommodation` documents leave entirely; ParentPoint stores them | Large, and it gives up the security property 0017 was built for |
| **C. Keep as-is** | An explicit, named exception to the scope boundary | Free today, but the boundary stops being a rule and the next session cites it as precedent |

**Recommendation: A.** Family Graph never parses a document, so what makes the
vault *look* like an education-record store is the taxonomy, not the storage.
Dropping the vocabulary satisfies the ruling and keeps the gate.

**Decides:** owner. **Blocks:** D2.

### D2. Does `school_contexts` move to ParentPoint?

**The question.** `school_contexts` holds `grade`, `classroom_id`,
`classroom_name`, homeroom teacher, `school_year`, `activities`, and
`allergies` — school state with a school's name on it, and out of scope under
the boundary.

**Blast radius if it moves.** `server/integration/schoolContext.js`, the `/v1`
read + write pair (`POST /v1/schools/:schoolId/context` plus the legacy
person-keyed routes), the merge repoint at `server/identity/people.js:504`, the
sealed-envelope and outbound-agent paths, and seven test files. It's a `/v1`
contract break, but ParentPoint is the only consumer and is where the data
belongs.

**Recommendation:** move it, after D1 settles. Same underlying question —
deciding them apart invites an inconsistent answer.

**Decides:** owner. **Blocked on:** D1. **Blocks:** the `school_contexts` half
of the plaintext-PII work below.

### D3. Profile B: build the crosswalk and the org link, and when?

Neither exists today. `crosswalk`, `external_key`, and `app_local` return zero
hits across `server/`; `school_contexts.school_id` is a bare `TEXT` with no
foreign key; `organizations` has no tenant-slug column. Both would be new
migrations off `SCHEMA_VERSION = 19`.

Both are Profile B work (`CLASSROOM_AV_IMPLICATIONS.md` §5). The pilot runs
Profile A today, explicitly doesn't block on the profile choice, and a school
can move A→B later without touching TeacherAIde or AudioScribe.

**Recommendation:** don't build until a school actually commits to Profile B.
Wiring order when it happens, each step independently useful: org crosswalk
(§3.4) → student crosswalks via `resolve-batch` (§3.1) → withdrawal enumeration
as a feed consumer (§3.2).

Interaction with D2: if `school_contexts` leaves, the `schoolId ↔ org_`
crosswalk loses a consumer, and the org link should be designed against
`affiliations` rather than against `school_contexts.school_id`.

**Decides:** owner, driven by a real deployment.

### D4. Long-term studentCode minting

TeacherAIde mints name-prefix student codes today, flagged as guessable. If
codes are ever re-minted, Family Graph's random per-tenant minting (`newCode()`,
`server/crypto/identifiers.js:35`) is the fix at the source. Only actionable if
the owner wants a re-mint; not urgent.

**Decides:** owner, with TeacherAIde.

---

## Open — decided elsewhere, tracked here

### D5. Guardianship rules for the study release

Binds in ParentPoint's consent design with counsel, not here, but it's answered
using this repo's facts (`memberships.custody`, dated memberships, dated
affiliations). Four sub-questions in `CLASSROOM_AV_IMPLICATIONS.md` §3.5:
two-guardian grant/revoke, custody change mid-term, child leaves the school, and
COPPA for under-13.

One thing to carry over carefully. §3.5.1 recommends strictest-wins by analogy
to this repo's `deny > group_only > allow` posture. That posture is real, but
it's the PERSON-MERGE rule (`server/identity/people.js:435`), not the per-school
override rule — overrides are override-or-base per field
(`server/integration/consents.js:201`), and a school override can loosen a
family's identity-level deny. The analogy supports the recommendation; it isn't
evidence that override behavior already works that way.

**Decides:** owner + counsel, in ParentPoint.

---

## Closed

### C1. Does the study release move onto Family Graph's consent rails? — **NO** (2026-08-04)

Answered by the scope ruling: a school-scoped study release is school-scoped
state. ParentPoint holds the release, which was already the plan of record.

This also retires a trap found during verification. Reusing `effective()` would
have let a school-scoped override silently re-enable classroom capture for a
family that denied at identity level, so a restrictive-merge variant would have
been required. It now never needs building.

### C2. Should Family Graph adopt a FERPA / `PROTECTED_DATA_CLASSES.md` posture? — **WITHDRAWN** (2026-08-04)

FERPA binds the institution. Family Graph is at most a processor running on the
institution's own hardware, and it does not enforce FERPA. The posture is to not
hold education records at all — which is what the scope boundary in `CLAUDE.md`
now says.

---

## Not decisions — pending work already agreed

Here so the outstanding picture sits in one place. None of these need a ruling;
they need someone to do them. Full context in `session_notes.md`, 2026-07-29.

- **`phones.e164` plaintext column.** A plaintext indexed column beside the
  encrypted `value_ct`, against this repo's own rule. Fix is `e164_hash` for the
  index plus decrypt-on-read — a migration plus a row rewrite. Unrelated to
  D1/D2 and still stands. Must be run and tested locally by the operator with
  `sfw` and `node --test`, not by an autonomous session.
- **`school_contexts.allergies` / `.activities` plaintext.** Same class of
  problem. **HOLD** — if D2 moves the table, the columns go with it and this
  migration never needs writing.
- **Cursor data loss.** The partner-sync check-in advances one cursor to the
  cross-feed maximum, and keyset pagination uses strict `> since` on a
  non-unique timestamp; both silently drop records. Fix is per-feed cursors plus
  a composite `(updated_at, code)` keyset with a drain loop — `federation.js`
  already does exactly this and is the pattern to mirror.
