# Code review — 2026-06-10

**Scope:** the full feature branch (`main...HEAD`): identifier widening,
organizations + affiliations + rolling verification, alumni transitions
and departure classes, staff accounts with domain-verified magic-link
login, and the dashboard UI for all of it. 33 files, ~4,960 added lines.

**Method:** seven independent review angles run in parallel (line-by-line
diff scan, removed-behavior audit, cross-file tracer, reuse,
simplification, efficiency, altitude), ~32 candidate findings, deduped
and verified against the code, then fixed in the same session. Three
findings were independently surfaced by multiple angles, which is good
signal they were real.

**Outcome:** 13 findings fixed (every one has a regression test or was
covered by the build), 9 accepted with reasoning, 3 deferred with a
named trigger for when they become worth doing. Suite went from 518 to
529 tests through the fixes.

---

## Fixed — correctness and security

### 1. Organization reads omitted all domain fields (severity: high)
`row2org()` never returned `domain` / `domain_verified_at` /
`domain_verification_method`, but the new dashboard is built around
them — the verify buttons were gated on `org.domain`, which was always
undefined. Domain verification could literally never be completed from
the UI, and no test caught it because tests called the module and POST
endpoints directly, never the GET shape the client consumes.
**Fix:** fields added to every org read; the verification *token* stays
deliberately excluded from GETs (it belongs in DNS, not on a `pii.read`
surface). Regression test pins both halves.

### 2. Unvalidated `verified_at` could permanently poison staleness tracking (high)
Three angles flagged this independently. `verify()` accepted any string
and folded it into the lexicographic high-water mark
(`last_verified_at = MAX(old, new)`). A value like `'next week'` or
`'TBD'` sorts above every ISO timestamp, so one bad call would pin the
marker forever — the affiliation silently drops off the stale report
with no way to repair it. `ended_at` got validation in the same commit;
`verified_at` was missed.
**Fix:** same ISO shapes as `ended_at` (YYYY, YYYY-MM, YYYY-MM-DD, full
stamp) or 400. Regression test throws four garbage shapes at it.

### 3. Bare re-affiliation wiped notes and downgraded roles (high)
The re-activate-instead-of-duplicate path unconditionally overwrote
`role` (with the default when none was sent) and `notes_ct` (with null —
`encrypt(undefined)` returns null). A connector re-confirming presence,
or a second operator click, would silently demote every `student` to
`member` and destroy operator notes, returning 201 each time.
**Fix:** only fields actually supplied are touched. Regression test
re-affiliates bare and asserts role + notes survive.

### 4. Ending an already-ended affiliation returned 204 and wrote a false audit row (high)
`endAffiliation` short-circuited with a success-shaped return, so the
API replied 204 and recorded an `affiliation_end` audit row carrying the
caller's new reason/date — which were never applied. The audit trail
asserted a change that didn't happen, the precise thing the audit rule
exists to prevent.
**Fix:** an `ALREADY_ENDED` sentinel maps to 409 with no audit row; the
original reason/date are kept. Regression test covers it.

### 5. `transition()` bypassed the archived-org guard (medium)
`affiliate()` refuses new affiliations under an archived organization;
`transition()` minted its successor row with no such check, creating
exactly the state the guard forbids (and which the operator could never
recreate intentionally).
**Fix:** same guard, same error shape. Regression test archives the
school and asserts the transition 400s.

### 6. Merge repointing wrote no entity_changes snapshots (high, audit rule)
Two angles flagged it. `_repoint()` end-dates and re-points affiliations
during person/family merges with raw SQL and recorded nothing — so a
merge could end a registration with no actor, request id, or
before/after snapshot. Direct violation of "any change must have an
audit trail," introduced because the snapshot pass was added after the
repoint helpers.
**Fix:** every ended or re-pointed row records a snapshot, with the
merge's audit context threaded through from the API layer, and prepared
statements hoisted out of the loop while there. Regression test merges
two families and asserts the snapshot exists.

### 7. Two organizations sharing one domain broke invites and logins (high)
Real case (a school sharing campus and domain with its parish). The old
trust lookup was global-by-domain with no ordering: invites bound to an
arbitrary org, and login checks compared against whichever org the
lookup happened to return — permanently locking out the other org's
staff with `domain_no_longer_verified`.
**Fix:** invites against an ambiguous domain now require `org_code`
(the error lists the candidates); login trust is checked against the
account's *own* organization (active + this domain verified), so two
orgs sharing a domain can't lock each other out. Regression test runs
the parish+school shared-domain scenario end to end.

### 8. Un-verifying a domain or archiving an org left live sessions valid (high)
The PRD's letter said "stops logins"; the as-built stopped only *new*
logins, leaving up-to-12-hour sessions alive after the operator
un-verified a compromised mail domain — the exact moment they most mean
"stop trusting this NOW." Account-disable already revoked sessions
transactionally; the org-level trust breaks didn't.
**Fix:** clearing/changing a domain and archiving an organization now
revoke the org's live sessions and pending links in the same
transaction. Two regression tests (domain cleared, org archived) assert
the session dies on the next request.

### 9. A 403 logged staff out of the dashboard (high, UX-breaking)
The client's shared auth-failure handler cleared the stored token on
*any* 401/403. For the master token that's right; for a read-only staff
session, clicking any sidebar link beyond their scopes (Audit log, API
keys…) returned 403 `missing_scope`, wiped their perfectly valid
session, and dead-ended them in master-token instructions they must
never follow.
**Fix:** `missing_scope` no longer clears the credential; only dead
credentials (401) do.

### 10. Duplicate-email edge cases surfaced raw constraint behavior (medium)
Invite of an already-active email relied on the unique index; re-enabling
a disabled account after the same email was re-invited hit the partial
unique index mid-transaction. (The generic error mapper would have
caught the worst of it — the original finding overstated "opaque
error" — but the behavior was still wrong-shaped.)
**Fix:** explicit pre-checks with named messages ("an active account
already exists for this email" / "…disable it first"). Regression test
covers both paths.

### 11. Migration 0016 rebuilt tables on every fresh database (medium)
The rename-and-rebuild ran unconditionally. Fresh databases bootstrap
the final schema from schema.sql, then 0016 rebuilt both tables anyway —
meaning every future column added to schema.sql would also have to be
added to 0016's inline DDL or fresh and migrated databases would
silently diverge (plus ~180 pointless rebuilds per test run).
**Fix:** the 0015-style guard — presence of `reason_detail` means
nothing to do. Flagged independently by two angles.

### 12. Legacy 8-hex codes validated for kinds that never had them (low)
The legacy carve-out applied to all kinds, including the six minted only
after the widening (`org_`, `aff_`, `av_`, `acct_`, `mlt_`, `asn_`). A
truncated paste of an org code would pass validation and surface as a
confusing 404 instead of the 400 the validation exists to give.
**Fix:** legacy 8-hex acceptance is now limited to the kinds that
predate the widening.

### 13. The PII-leak tripwire test went vacuous for new codes (medium)
`tests/notifications.test.js` asserted templates never leak codes using
`/\bp_[0-9a-f]{8}\b/` — which a 16-hex code no longer matches (the 9th
hex char defeats the word boundary). The guard passed without guarding.
**Fix:** patterns now match 8- or 16-hex exactly. Also updated the
published identifier validators in `product_spec.md` (the documented
contract still said 8-only, which would have made integrators reject
every new code).

---

## Fixed — cleanup riding along

- **Token hashing deduplicated:** `accounts._hash` now aliases
  `apiKeys.hash` — one place to change if token storage ever moves to
  keyed hashes.
- **Audit context helper extracted:** the four byte-identical `ctx(req)`
  copies across routers are now one `auditCtx` in `server/api/_ctx.js`.
  When staff attribution grows fields (session_code, org_code), they get
  added once.
- **Session write debounce:** `lookupSession` refreshed `last_used_at`
  with a write on every staff request; now at most once a minute (it's a
  freshness signal, not a ledger).
- **Hot-path require hoisted:** `require('./accounts')` moved from
  inside the per-request auth handler to module top.
- **Communities panels stopped downloading the whole org catalog:**
  `listAffiliations` now joins `org_name`/`org_kind` onto every row, and
  both detail views use it instead of fetching every organization per
  page visit. Regression test pins the new response fields.

---

## Accepted (deliberate, with reasoning)

1. **`transition()` shares logic with `endAffiliation()`/`affiliate()`
   by parallel code, not composition.** Real duplication, but composing
   them would nest transactions and tangle the sentinel/guard semantics
   that were just fixed; the archived-org guard and reason validation
   are now identical in both paths and tested in both. Revisit if a
   third "end + successor" operation appears.
2. **Vocabulary lives in JS Sets + schema CHECKs + client lists.** The
   CHECKs are belt-and-suspenders by design (the JS layer is the
   validator of record), and migrations are frozen copies by definition.
   The honest gap is client drift — see Deferred #2.
3. **Master-only domain routes are inline checks, not a sub-router
   middleware.** Two routes today; the inline checks are adjacent and
   identical. The finding is right that a third route could forget the
   check — noted in the file's section comment so the template a future
   contributor copies includes it.
4. **`_repoint` prepared statements per merge** (not per row anymore —
   hoisting shipped with fix #6). Matches the ministries repoint style.
5. **`last_used_at` parity with `api_keys.recordUse`:** the debounce
   shipped for sessions; the identical pre-existing pattern for `sk_`
   keys was left untouched (out of branch scope).
6. **Test helpers (`listen`/`req`/`makeServer`) copy-pasted across
   suites:** 15+ pre-existing copies; absorbing them into
   `tests/_helpers.js` is a repo-wide refactor, not a branch concern.
7. **Status-flash duplication in views** (5 copies, 3 pre-existing) and
   **exported-but-unconsumed constants** (`ROLES`, `END_REASONS`,
   `GRANTABLE_SCOPES`, TTLs): harmless; the exports document the
   vocabulary and become load-bearing if Deferred #2 ships.
8. **`period` free text vs `school_contexts.school_year`:** two
   expressions of school-year exist. Accepted for now because `period`
   is operator-vocabulary by design; reconciliation belongs to the
   future "connector sync auto-verifies affiliations" feature, where a
   canonical year format must be chosen anyway.
9. **Communities panel JSX duplicated between Person/Family detail:**
   born identical this session; extract a `CommunitiesPanel` component
   the next time either copy needs a change (that's the cheapest moment
   to converge them).

## Deferred (named trigger)

1. **`useStatusFlash()` / `StatusBanner` extraction** — do it when the
   next accessibility or UX change to flash messages lands, and apply to
   all five views at once.
2. **Serve the role/reason/method vocabularies to the client** (one
   endpoint or a generated constants file) — do it with the next
   vocabulary addition; the client lists already omit `connector_sync`
   and `merge` deliberately (system-only values), so the generator needs
   an "operator-selectable" flag.
3. **Test-helper consolidation into `tests/_helpers.js`** — do it the
   next time `buildApp`'s options change, which is the moment the 15+
   copies would otherwise each need hand-editing.

---

*All fixes verified: 529 tests, 528 pass, 1 pre-existing skip; client
builds clean. Every fixed finding has a regression test except the two
client-only fixes (#9, catalog fetch), which are covered by the build
and the joined-fields regression test.*
