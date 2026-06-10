# 2026-06-10 — Identity, affiliation, and verification model

A summary of the line of thinking worked out in this session and what
shipped because of it. Written so a future session (or a developer who
wasn't in the conversation) can pick up the model without re-litigating
it.

## The line of thinking

It started with a practical question: every member of a household needs
a unique identifier, especially when sibling apps (a school app, a
parish app) need to identify children individually. Should there be a
separate individual identifier AND a family identifier?

Yes — and the deeper principle that fell out of the conversation governs
everything below: **facts about the present should be computed from
dated events, never stored as flags that rot.**

- A person's identity must not be derived from their family, because
  person-to-family is not 1:1 in real life (joint custody, splits,
  merges). FamilyGraph already had this right: `p_` codes for persons,
  `f_` codes for families, joined by dated `memberships` rows.
- The same logic extends to communities. School affiliation is temporal
  (kids graduate). Parish affiliation is temporal (people move, die,
  stop attending). Technically it all is. So "parish, school, or both"
  must never be a stored flag — it's a query over dated affiliation
  rows. Leaving a community is an end-date with a reason, not a delete.
- Registration should be a living thing, verified on a rolling, ongoing
  basis — but verification refreshes **confidence**, it never gates
  **existence**. Staff will know when a family is truly gone, and the
  signal is the absence of activity: no more giving, no ministry
  participation, no communications landing. The system's job is to
  surface "nothing has confirmed this affiliation in N months" as a
  work queue for a human, never to silently un-register a family.

## What shipped

### 1. Identifier suffix widened to 16 hex chars

`server/crypto/identifiers.js` previously minted codes with 4 random
bytes (8 hex chars, 32 bits) — 50% birthday-collision odds around 77k
codes per kind, with no insert retry. Now 8 random bytes (16 hex chars,
64 bits); the 50% bound moves past ~5 billion codes per kind. Legacy
8-hex codes remain valid; no migration needed because codes are opaque
TEXT keys everywhere.

### 2. Organizations as first-class entities (migration 0014)

`organizations` table: `org_` codes, `kind` = `parish` / `school` /
`other`, optional soft FK to `dioceses`, encrypted notes, active /
archived status. Previously `school_contexts.school_id` was a bare TEXT
id minted by the external school app; organizations give parishes and
schools a real FamilyGraph identity.

### 3. Dated affiliations

`affiliations` table: links a person OR a family (exactly one — the
`ministry_assignments` pattern) to an organization with a role,
`started_at` / `ended_at`, and a reason when ended (`graduated`,
`moved`, `deceased`, `withdrew`). Parish registration is family-level
by convention (a family at a parish defaults to role `registered`);
school enrollment is person-level (`student` requires a person).
Unique indexes prevent stacked duplicate active rows; re-affiliating
updates in place, leaving-and-returning produces a second dated row so
history survives. Person and family merges re-point affiliations onto
the winning code, ending duplicates instead of colliding.

### 4. Rolling verification

`affiliation_verifications` table: an append-only trail of WHY we
believe an affiliation is alive. Methods mirror how a parish actually
sees activity: `registration`, `sacrament`, `liturgy`, `ministry`,
`giving`, `communication` (envelopes / mailings / emails still
landing), `connector_sync`, `attestation` (an explicit operator
confirmation), `other`. Each row bumps the affiliation's
`last_verified_at` high-water mark; backdated activity (a giving batch
imported late) is recorded in the trail but never moves the marker
backwards.

`GET /api/organizations/:code/stale?days=N` is the rolling-verification
work queue: active affiliations nothing has confirmed within the window
(default 365 days). Three effective states: active (verified recently),
stale (active but quiet — computed, not stored), ended (a human or an
authoritative source said so). Nothing auto-expires. The annual
verification drive many parishes run alongside stewardship renewal is a
campaign the operator runs against this report, not a 365-day clock
hard-coded into the schema.

### 5. API surface

`/api/organizations` mounted with the same scope posture as ministries
(reads need `pii.read`, writes need `pii.write`). Full route list in
`README.md` § "Organizations + affiliations". Every write is audited;
merge behavior is covered by tests.

### 6. Tests

12 new tests in `tests/organizations.test.js` covering the lifecycle,
the computed-not-stored claim (graduation ends the school affiliation,
parish registration survives), validation, re-affiliation, the
verification trail, the backdated high-water mark, the stale report,
both merge directions, and the auth posture. Suite total: 503 tests,
502 pass, 1 pre-existing skip.

## Captured requirement, not yet built: church-admin login

Church administration needs to log in and edit records directly. Today
FamilyGraph has no per-user accounts: the dashboard is driven by the
master Bearer token, sibling apps get scoped `sk_` keys, and the safe
surface is loopback-only. That's an operator tool, not a staff tool.

The requirement as stated: staff accounts must be **verified by the
domain of the church's web site**. Sketch for the next session:

- Named admin accounts with email verification restricted to the
  organization's domain (e.g. `[staff-name]@[parish-domain.org]`),
  proven by a magic-link sent to that address. No passwords to leak.
- The organization's domain is itself verified once, by DNS TXT record
  or a well-known file on the parish web site, and stored on the
  `organizations` row — which is exactly why organizations needed to be
  first-class entities.
- Each account maps onto the existing scope system (`pii.read`,
  `pii.write`, ...) so no new auth surface is invented; the audit
  `actor` becomes a real person instead of `master_app`.
- If the parish runs Google Workspace or Microsoft 365 on that domain,
  OIDC sign-in restricted to the verified domain is the stronger
  version of the same idea and should be the preferred path.

This is a meaningful feature with security surface area; it deserves
its own session and PRD (including the logging-infrastructure section
CLAUDE.md requires) rather than riding along at the end of this one.

### Source-of-truth rules once staff can edit (decided 2026-06-10)

Staff edits make FamilyGraph a peer source alongside the connectors,
so the PRD must encode these decisions:

1. FamilyGraph-native data (affiliations, verifications, ministry
   rosters, EIM notes, consents, merges) has no ambiguity — FG is the
   source of truth, nothing upstream holds it.
2. For connector-mapped fields, truth is per-observation, not
   per-system. Every field value remembers its source (the existing
   `provenance` / `source_records` machinery); a manual staff edit is
   one more source kind with high default credibility.
3. Manual edits outrank connector data by default, but a NEWER
   connector value that contradicts a manual edit opens a conflict
   ("upstream disagrees with a manual correction") rather than
   silently winning or losing. Precedence is per-field, never
   per-record.
4. **Precedence and write-back are configurable either way** (operator
   decision, 2026-06-10). Per connector, the operator chooses whether
   manual FG edits or connector values win by default, and whether
   corrections write back upstream. Safe defaults: manual-wins,
   write-back OFF. Write-back, when enabled, requires upstream API
   credentials with write scope, a dry-run preview mode, and its own
   audit events.
   Direction of travel (operator decision, 2026-06-10): **read/write
   should be possible both in and out of FamilyGraph.** Bidirectional
   flow is a product goal, not a reluctant add-on — FG reads from and
   writes to the upstream systems, and sibling apps read from and
   write to FG. What keeps this from becoming a sync loop is that
   every inbound value goes through the resolver and every
   disagreement surfaces as a conflict instead of an overwrite.
   The end state (operator decision, 2026-06-10): **FamilyGraph is
   ideally THE source of truth.** FACTS / MP are feeds and consumers;
   FG holds the canonical record, arbitrates disagreements, and — when
   write-back is enabled — propagates its truth outward. The
   configurability in this point is the migration path: a parish starts
   with FG downstream (write-back off), builds trust, then flips the
   per-connector switches as FG earns the canonical role.
5. Every change to any record in FamilyGraph — staff edit, connector
   sync, write-back push, merge, archive — must leave an audit trail
   recording who/what/when/before/after (operator requirement,
   2026-06-10, stated as a hard rule: ANY change must have an audit
   trail). The foundations exist: `audit_events` (tier-1/2) and the
   `entity_changes` before/after snapshot log from migration 0013.
   Partially enforced already: the same day this rule was stated, the
   new organizations / affiliations / verifications surface was found
   to be writing `audit_events` but not `entity_changes` snapshots, and
   was wired up (with a test asserting every write shape lands a
   snapshot with actor and before/after). The PRD's job is to guarantee
   coverage everywhere else — no write path may bypass either log,
   including future staff-account sessions and write-back.
