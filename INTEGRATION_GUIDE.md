# FamilyGraph Integration Guide

**Audience:** engineers building an app that wants to use
FamilyGraph as the identity / household / consent layer. A
parent-engagement app, a parish faith-formation app, or a
school-events app would each be an example. This guide is
self-contained and app-agnostic - hand it to any team integrating
with a FamilyGraph install.

**Status:** v0.2 of the contract, May 2026. The contract is versioned
via the `X-FG-Contract-Version` header (current value: `v0.2`; `v0.1`
is still accepted). Community identifiers, the roster API, and the
identity crosswalk were added 2026-09-28 (§4.3, §4.4); they live on the
`/api` surface and do not change the `/v1` contract version.

---

## 1. What FamilyGraph is

A local-first family registry. The source of truth for *who is who* on
a Catholic campus — the names, emails, phones, addresses, household
links, custody flags, photo / directory consent, and EIM (safe-
environment) certifications that follow a person across every sibling
app on the same campus.

FamilyGraph is **not** an identity provider. Sibling apps sign users
in with their own auth (Firebase, OAuth, etc.) and consult FamilyGraph
only after they have a verified email or some other handle.

FamilyGraph is **not** the place to store app-specific context
(class rosters, lunch orders, attendance, donations, etc.). Each
sibling app keeps its own domain data; FamilyGraph just stores the
shared identity layer.

Picture it as the hub of a star — every spoke is a sibling app, and
every spoke speaks the same person/household vocabulary because they
all reference the same FamilyGraph identifiers.

## 2. When to use it

Use FamilyGraph when:

- Your app references **people** who exist in more than one community
  on the same campus (parents who appear in both the school app and
  the parish app, for instance).
- Your app needs to know **household structure** — which adults are
  linked to which kids, and with what custody flags.
- Your app surfaces **photo / directory consent** decisions.
- Your app cares about **safe-environment certifications**.

Don't use FamilyGraph when:

- You only need a single email-to-uid map. Use your own user table.
- You need to coordinate state changes that aren't about identity
  (game scores, lunch orders, etc.). Sibling apps own that data.
- The data is internal to your tenant and never travels to another
  community (the gym roster for one specific school, for instance).

## 3. Architecture at a glance

```
                                                ┌───────────────────┐
                                                │    Parish app     │
                                                │  (your future     │
                                                │   sibling app)    │
                                                └────────┬──────────┘
                                                         │
                                                         │  HTTPS
                                                         │  + Bearer
                                                         │
┌─────────────────────┐         ┌─────────────────┐     ▼
│  School app         │ ◀─────▶ │   FamilyGraph   │ ◀──────────
│  (a connected app)  │  HTTPS  │   /v1/...       │
└─────────────────────┘         │   + webhooks    │
                                └─────────────────┘
                                         │
                                         ▼
                                ┌─────────────────┐
                                │   sqlite store  │
                                │   (encrypted)   │
                                └─────────────────┘
```

- Sibling apps talk to FamilyGraph over plain HTTPS REST.
- FamilyGraph signs outgoing webhooks with HMAC-SHA256 so the
  receiver can verify integrity.
- The store is local to a single FamilyGraph install (one per
  campus / parish). PII columns are AES-256-GCM at rest; the key
  lives in `~/.family-graph/secret.key` (mode 0600).
- No telemetry, no analytics, no cloud sync. The integration is the
  only wire format.

## 4. Authentication & scopes

Every `/v1/...` call requires `Authorization: Bearer <token>`. Tokens
come in two flavours:

1. **Master token** — full access. Lives in
   `~/.family-graph/secret.key` and is shown to the operator at boot
   via `family-graph show-token`. Use the master token for the
   operator's own dashboard and for one-time admin scripts.
2. **Scoped key** — issued by the operator via the dashboard or
   `POST /api/keys`. A scoped key has a `name` (the consuming app)
   and one or more scope strings. The relevant scope for integrating
   apps is `integration`.

> **The `integration` scope** grants access to the `/v1/...` contract
> surface and nothing else. Any app can hold it; the operator issues
> one scoped key per app so reads and writes stay attributable.

Each scoped key is provisioned with its own name (`'engagement-app'`,
`'parish-app'`, `'cyo-sports'`, etc.). FamilyGraph records the name
on every audit row, so the operator can answer "which app read this
person's record?" by filtering the audit log.

**Header etiquette on every call:**

| Header | Required | Purpose |
|---|---|---|
| `Authorization: Bearer <token>` | yes | Auth |
| `X-FG-Contract-Version: v0.2` | strongly recommended | Lets FG reject incompatible majors with `426 Upgrade Required` instead of giving you a silently-wrong response. `v0.1` is still accepted for back-compat |
| `X-Source-App: <your-app>` | recommended | Recorded on every audit row + write log |
| `X-Source-Tenant: <slug>` | required on writes | Doubles as the webhook school-hint filter |
| `X-Request-Id: <uuid>` | required on writes | 24-hour idempotency dedupe (see §9) |

The `X-Source-Tenant` value is treated as a "school slug". The
validator accepts `[A-Za-z0-9][A-Za-z0-9._-]{0,127}` (start with
alphanumeric, then alphanumeric / dot / dash / underscore).

### 4.1 Provisioning a key for the partner app (the canonical consumer recipe)

the partner app is the first app integrating against FamilyGraph, and
it reaches three surfaces, not just `/v1`:

1. The versioned `/v1/...` contract surface — scope `integration`.
2. Identity resolution — `POST /api/identity/resolve`,
   `POST /api/identity/match`, `POST /api/identity/feedback`. These
   live on the legacy `/api` surface and their **write** verbs (all
   three are POSTs) are gated on scope `pii.write`.
3. Anonymization round-trip — `POST /api/sanitize`,
   `POST /api/desanitize` — gated on scope `sanitize`.

A single scoped key can carry all three scopes, so the partner app needs exactly
**one** key. The operator mints it from the dashboard (Keys page) or
over the API with the master token:

```sh
curl -sS http://127.0.0.1:3500/api/keys \
  -H "Authorization: Bearer <MASTER_TOKEN>" \
  -H 'content-type: application/json' \
  -d '{ "name": "partner", "scopes": ["integration", "sanitize", "pii.write"] }'
# → { "code": "sk_...", "token": "sk_xxxxxxxx", "scopes": [...] }
```

The `token` is shown **once**; store it in the partner app's server-side secret
store (never the browser bundle). All of the partner app's FamilyGraph calls then
ride that one `Authorization: Bearer sk_xxxxxxxx`. Because the key is
named `partner`, every audit row FG writes for the partner app is attributed to
that name (scoped keys cannot spoof a different `X-Family-Graph-Actor`;
the actor is forced to the key's name).

No new auth surface or scope was needed: `integration`, `sanitize`,
and `pii.write` already exist in the scope vocabulary
(`server/auth/api-keys.js`). If the operator wants to split read-only
identity peeks from writes later, `pii.read` covers `POST
/api/identity/match` reads — but the three POSTs the partner app uses all require
`pii.write`, so the single-key recipe above is the minimal grant that
makes the partner app fully functional.

### 4.2 Option A — the "no open doors" outbound topology (as deployed)

The §4.1 recipe describes the inbound mode where the partner app calls FG's `/api`
and `/v1` surfaces directly. The operator instead deployed **Option A**:
FamilyGraph opens **no inbound internet port** (it binds loopback), and
**FG is the sole initiator** — it dials the partner app's public endpoints outbound. The partner app never calls FG. The FG-side build and protocol are documented in
`FAMILYGRAPH_INTEGRATION.md` Appendix F. The short version:

- The operator pairs the partner app tenant in FG (CLI `partner-pairing set/enable`,
  the `/api/partner-pairings` API, or the **the partner app** dashboard tab),
  supplying `partner_base_url`, the partner app-issued bearer credential, a shared HMAC
  webhook secret, and a 32-byte envelope key. Secrets are stored
  encrypted and never echoed.
- Once enabled, FG dials the partner app every `check_in_interval_s` (default 20s):
  `POST {ppBaseUrl}/familygraph-sync` → `GET .../familygraph-outbox` →
  process locally → `POST .../familygraph-inbox`. Every call carries the
  bearer plus `X-FG-Signature: sha256=<HMAC(rawBody, sharedSecret)>`,
  `X-Source-Tenant`, `X-FG-Contract-Version: v0.2`,
  `X-Family-Graph-Actor: familygraph`, and (on writes) `X-Request-Id:
  fg_<uuid>`.
- PII-bearing payloads are envelope-encrypted on top of TLS; codes,
  cursors, request ids and acks are cleartext inside the TLS+HMAC
  envelope. The partner app holds the same envelope key and decrypts server-side.

In Option A, the partner app needs no scoped key against FG (it serves the public
endpoints FG dials). The §4.1 key recipe still applies if a future
deployment also wants the partner app to make direct inbound `/v1` calls.

**Document Vault.** Sensitive child documents (sacramental,
accommodation, health) live encrypted in FG and surface to the partner app
just-in-time over the same outbound spine — no new endpoints. The partner app parks
`document.store` (FG persists the bytes, returns an opaque `doc_…` ref)
and `document.fetch` (FG applies the access matrix to the partner app's asserted
viewer, enforces a 10 MB cap, returns sealed bytes on ALLOW or
`{ ok:false, error }` on DENY) outbox items. Document + health-safety
changes also flow as metadata-only ChangeEvents in the sealed sync batch.
**FG is the authoritative access gate** — it makes the policy decision
and writes a Tier-2 audit on every store and fetch. The operator manages
the vault locally via `/api/documents` (master bearer). Wire shapes and
the full access matrix are in `FAMILYGRAPH_INTEGRATION.md` §7.

### 4.3 Community identifiers and the roster API (`roster` scope)

Added 2026-09-28. Every person a roster or parishioner list surfaces gets
one lifelong identifier, and every household one family identifier. The
community id IS the FamilyGraph code, re-spelled: `p_<16 hex>` is
`I<16 HEX>` and `f_<16 hex>` is `F<16 HEX>` (legacy 8-hex codes render
the same way, `I` + 8 hex). FG accepts any case on input and always
emits uppercase. FamilyGraph is the only minter; a sibling app asks FG
and never mints its own. Merges turn the loser code into a permanent
alias of the winner, so an old id still looks up. An id is never
reissued.

The API is mounted at `/api/identity/roster`:

| Verb + path | Purpose |
|---|---|
| `POST /api/identity/roster/plan` | Dry run. Runs the real import inside a transaction and rolls it back. Writes nothing. Returns every item that needs a human |
| `POST /api/identity/roster/commit` | Writes it in one transaction, 201. Refused with `409 { error: 'review_incomplete', plan }` while any review item is undecided |
| `GET /api/identity/roster/lookup/:id` | `I…`/`F…` (or `p_`/`f_`) to the current record, following merges: `{ kind, code, community_id, status, requested, redirected }`; 404 `not_found` |

All three need the `roster` scope (or the master token). Issue a
roster-only key for a caller that should see the people a roster
matches but not the directory or connector settings:

```sh
cd ~/familygraph
node bin/family-graph.js issue-key docanonymizer roster
```

Body for plan and commit:

```jsonc
{
  "sheets": [{ "name": "Sheet1", "headers": ["..."], "rows": [["..."]], "mapping": {} }],
  // or "households": [...] - not both
  "decisions": {
    "0:3:1":      { "action": "attach", "target": "I0123456789ABCDEF" },  // attach | create | skip
    "0:3:family": { "action": "create" }                                  // attach | create
  },
  "source": "your-app",
  "source_ref": "upload-2026-09-28-001",   // names ONE upload; never reuse
  "category": "school",                     // church | school | other
  "tags": [],
  "idempotency_key": "your-app:abc123"      // commit only; 8-200 of [A-Za-z0-9._:-]
}
```

- Decision keys are `<sheet>:<row>:<slot>` for people and
  `<sheet>:<row>:family` for households. A `target` is an `I…`/`F…` id
  or an earlier row's key on the same upload (`"0:3:1"`,
  `"0:3:family"`), because that row's id is not known yet.
- Output per person: `key`, `slot`, `role`, names, `name_cells`,
  `action` (`matched | new | review | skip`), `community_id` (null in a
  plan for anyone new), `candidates` (each with `community_id`, or
  `sheet_ref` for someone new earlier in the same upload),
  `review_reasons`, `same_as`, `told_apart`. Households follow the same
  idea. `summary` counts persons `{matched, new, review, skipped}`,
  families `{matched, new, review}`, `crosswalk`, and `told_apart`.
- A decision that no longer answers the current question (a `create`
  where the plan now finds a definitive match, or one that would repeat
  an earlier commit of the same `source_ref`) is refused as stale; the
  plan lists `stale_decisions`. Re-plan and ask again.
- Idempotency: same `idempotency_key` + same request returns the stored
  result with HTTP 200 and `"replayed": true`, writing nothing. Same key
  + a different request is `409 idempotency_conflict`. Keys are scoped
  per caller and kept 7 days. Refusals are not stored.
- A caller other than the master token may not send crosswalk refs or
  code hints, and may not use another app's `source` name once that
  source has crosswalk links: `403 roster_forbidden`.
- Limits: 20 MB body, 25 sheets, 20,000 rows, 300 columns, 4,000 chars
  per cell. Plan and commit have their own rate-limit bucket (§13.1).
  They run on FG's request thread, so a very large roster (2,000 rows is
  roughly 10 s) holds other FG requests for that long.

Matching is strict: an exact email or phone only counts when the first
name lines up, same name needs a birthdate or the same home address to
confirm, Jr/Sr and birthdate conflicts veto, and anything short of
certain becomes a review item for a person. The full rule set lives in
the code (`server/identity/roster.js` and `server/identity/matching.js`).

### 4.4 Crosswalk on `/api/identity/resolve`

Added 2026-09-28 (migration 0020, `SCHEMA_VERSION` 20). The
`external_refs` table links another app's record id to a FG code, keyed
by `(source, ref)`. MissionIQ's refs are `contact:<id>`, `child:<id>`,
and `family:<id>`. Only deliberate imports write it (the
`family-graph import-missioniq` CLI). `POST /api/identity/resolve` and
`/resolve-batch` read it when the body carries `source` and a
`source_ref` (per record on `/resolve-batch`):

- Only the master token or a scoped key whose NAME equals the source
  may read that source's crosswalk. MissionIQ's key must be issued as
  `family-graph issue-key missioniq`. A key under any other name that
  sends that source's record refs, once the source has crosswalk links,
  gets `403 crosswalk_forbidden` naming the fix. It is never silently
  resolved by name.
- A hit comes back as `{ code, action: 'attached', via: 'crosswalk' }`
  only if the incoming record still describes that person (exact first
  name, a real nickname, or the same birthdate with a resembling first
  name, and no birthdate or Jr/Sr contradiction). Otherwise the record
  goes through the normal resolver, nothing is attached to the linked
  person, and the result carries `via: 'crosswalk_mismatch'`.
- `with_family`: one active household returns that household; several
  return the one crosswalk-linked from the same source if exactly one
  qualifies, else no `family` plus `families: [codes]`.

## 5. Versioning

`X-FG-Contract-Version: v0.2` is the active wire version. `v0.1` is
still on the compatibility allowlist, so an older client keeps working
unchanged. Bump semantics:

- **Minor** (v0.1 → v0.2) when adding fields or additive endpoints.
  Existing fields stay the same shape. Clients that ignore unknown
  keys keep working without code changes. v0.2 added the canonical
  `POST /v1/consents` and `POST /v1/schools/:schoolId/context` write
  surfaces alongside the older person-keyed routes.
- **Major** (v0.2 → v1.0) when changing field semantics. FG accepts
  only the major versions in its allowlist; unknown majors return
  `426 Upgrade Required`. Plan ahead.

FG also returns `X-FG-Contract-Version: v0.2` on every response so a
client can confirm which side of the wire it's on (this reflects what
FG itself speaks, even when the request declared `v0.1`).

## 6. Object schemas

All payloads are JSON. Field names use camelCase on the wire.

### 6.1 Person object

The shape returned by `GET /v1/persons/:id`, `GET /v1/persons?email=`,
and the body of `POST /v1/persons` / `PATCH /v1/persons/:id` (with
the request omitting whatever fields the caller doesn't want to
touch).

```jsonc
{
  "personId": "p_a7b3c91d",          // FG-issued; immutable
  "primaryEmail": "[email@example.org]",
  "additionalEmails": ["[email2@example.org]"],
  "phones": [
    {
      "e164": "+15125550101",       // canonical international format
      "raw": "(512) 555-0101",
      "type": "mobile",             // mobile | home | work | other
      "smsConsent": true
    }
  ],
  "displayName": "[Parent Name]",
  "firstName": "[First]",
  "lastName": "[Last]",
  "preferredName": "[Nickname]",     // optional
  "dateOfBirth": "1985-04-12",       // optional (adults usually omitted)
  "mailingAddress": {
    "line1": "[Street]",
    "line2": null,
    "city": "[City]",
    "state": "TX",
    "postal": "78701",
    "country": "US"
  },
  "kind": "adult",                   // adult | child | null
  "active": true,
  "updatedAt": "2026-05-15T10:31:22Z"
}
```

When `active: false` and the response came from the **changed feed**
(`/v1/persons/changed?since=...`), the object is a *tombstone*:

```jsonc
{
  "personId": "p_a7b3c91d",
  "active": false,
  "status": "archived",              // archived | merged
  "updatedAt": "2026-05-15T10:31:22Z"
}
```

The tombstone deliberately omits PII so the app can purge its cache
without rebroadcasting a removed person's contact info. Direct
`GET /v1/persons/:id` of an archived person still returns the full
record (operator UI use case).

### 6.2 Household object

```jsonc
{
  "householdId": "f_88a3c0d2",
  "members": [
    { "personId": "p_a1...", "role": "mother",     "custodial": true },
    { "personId": "p_a2...", "role": "father",     "custodial": true },
    { "personId": "p_c1...", "role": "child",      "custodial": false },
    { "personId": "p_c2...", "role": "child",      "custodial": false }
  ],
  "primaryContactPersonId": "p_a1...",
  "communicationLanguage": "en",
  "active": true,
  "updatedAt": "2026-05-15T10:31:22Z"
}
```

`role` values: `mother | father | step_parent | guardian |
grandparent | other | child`.

`custodial` is `true` when membership custody is `'sole'` or
`'joint'`; `false` otherwise.

Archived households tombstone the same way as persons.

### 6.3 Consent object

```jsonc
{
  "personId": "p_c1...",
  "photoConsent": "allow",            // allow | group_only | deny
  "directoryListing": "allow",        // allow | deny
  "updatedAt": "2026-05-15T10:31:22Z",
  "schoolId": null,
  "overrideApplied": false
}
```

With a `schoolId` query parameter, the object reflects the effective
consent for that school (override-or-base) and includes the base
values for transparency:

```jsonc
{
  "personId": "p_c1...",
  "schoolId": "[school-slug]",
  "photoConsent": "deny",             // from the override
  "directoryListing": "allow",        // from the base (no override on this field)
  "updatedAt": "2026-05-15T10:35:00Z",
  "overrideApplied": true,
  "basePhotoConsent": "allow",        // what the identity-level base says
  "baseDirectoryListing": "allow"
}
```

A missing consent row reads as `"allow"` for both fields (the
permissive default — operators flip to deny explicitly).

### 6.4 EIM certification object

```jsonc
{
  "code": "eim_8d1f2a3b",
  "status": "certified",              // pending | certified | expired
  "completed_on": "2026-05-01",
  "expires_on": "2029-05-01",
  "source": "[program-name]",
  "diocese_code": "dio_2ec039e5",
  "diocese_record_id": "EIM-TX-12345",
  "created_at": "2026-05-15T10:31:22Z",
  "updated_at": "2026-05-15T10:31:22Z"
}
```

The diocese is the system of record. FG caches what it knows and
points back via `diocese_code` + `diocese_record_id`.

### 6.5 Diocese object

```jsonc
{
  "code": "dio_2ec039e5",
  "name": "[Diocese Name]",
  "region": "Texas",
  "contact_url": "https://example.org",
  "eim_program_name": "[EIM Program]",
  "eim_renewal_years": 3,             // overrides global eim.renewal_years for this diocese
  "status": "active",                 // active | archived
  "created_at": "...",
  "updated_at": "..."
}
```

### 6.6 School-context (enrichment) snapshot

```jsonc
{
  "schoolId": "[school-slug]",
  "schoolYear": "2026-2027",
  "grade": "3",
  "classroomId": "3A",
  "classroomName": "[Room Number] - [Teacher]",
  "homeroomTeacherPersonId": "p_t1...",
  "activities": [
    { "kind": "sport",      "label": "[Team Name]",       "season": "2026-2027 Winter" },
    { "kind": "enrichment", "label": "[Camp Name]",       "season": "2026-2027" },
    { "kind": "after_care", "label": "After-care: MWF",   "season": "2026-2027" }
  ],
  "allergies": ["peanuts"],
  "snapshotAt": "2026-05-15T10:31:22Z",
  "sourceApp": "engagement-app",
  "updatedAt": "2026-05-15T10:31:22Z"
}
```

`activities` is the *current state*, not a log. FG overwrites the
previous snapshot on every POST.

## 7. Endpoint reference

### 7.1 Reads

| Verb + path | Purpose |
|---|---|
| `GET /v1/persons/:personId` | Hydrate one person (full PII if active or archived) |
| `GET /v1/persons?email=...` | Lookup by email; 404 if no match |
| `GET /v1/persons/changed?since=<iso>` | Incremental pull; archived rows tombstone |
| `GET /v1/persons/:personId/consent` | Identity-level base |
| `GET /v1/persons/:personId/consent?schoolId=...` | Effective consent (override-or-base) |
| `GET /v1/persons/:personId/consent/overrides` | List every per-school override |
| `GET /v1/persons/:personId/schoolContext` | All snapshots for this person |
| `GET /v1/persons/:personId/schoolContext?schoolId=...` | One snapshot |
| `GET /v1/persons/:personId/history` | Entity-change log (reverse-chronological) |
| `GET /v1/households/:householdId` | Hydrate one household |
| `GET /v1/households?personId=...` | Find a person's active household |
| `GET /v1/households/changed?since=<iso>` | Incremental pull; archived rows tombstone |
| `GET /v1/households/:householdId/history` | Entity-change log |
| `GET /v1/dioceses` | List dioceses; `?status=archived` or `?status=all` to widen |
| `GET /v1/dioceses/:code` | Read one diocese |
| `GET /v1/webhooks` | List your webhook subscriptions (active by default; `?status=all`) |
| `GET /v1/webhooks/:code/deliveries` | Inspect recent delivery attempts |

All GET responses set:

- `ETag: W/"<hash>"` (a weak validator over the response body)
- `Cache-Control: private, max-age=<seconds>` (30 for objects, 5
  for change feeds)
- `X-FG-Contract-Version: v0.2`

### 7.2 Writes

| Verb + path | Purpose |
|---|---|
| `POST /v1/persons` | Suggest a new identity. Returns 201 + person object |
| `PATCH /v1/persons/:personId` | Update contact fields. Honors `If-Match` |
| `POST /v1/consents` | **Canonical** person-keyed consent write. Body `{ personId\|personCode, schoolId?, photo, directory }`. `schoolId` present → per-school override; absent → identity base |
| `POST /v1/persons/:personId/photoConsent` | Legacy alias for the consent write; same rows. Set identity-base OR per-school override (body / query `schoolId`) |
| `DELETE /v1/persons/:personId/photoConsent?schoolId=...` | Clear a per-school override |
| `POST /v1/persons/:personId/eimCertifications` | Add/extend an EIM cert |
| `POST /v1/schools/:schoolId/context` | **Canonical** school-keyed enrichment snapshot. Body `{ personId\|personCode, schoolYear?, grade?, classroomId?, classroomName?, homeroomTeacherPersonId?, activities?[], allergies?[] }`. Overwrites the previous snapshot for this (person, school) pair |
| `POST /v1/persons/:personId/schoolContext` | Legacy alias for the enrichment snapshot; same rows |
| `POST /v1/persons/:personId/archive` | Soft-delete |
| `POST /v1/persons/:personId/reinstate` | Reverse archive |
| `POST /v1/households` | Suggest a new household |
| `POST /v1/households/:id/members` | Add a member |
| `POST /v1/households/:id/archive` | Soft-delete |
| `POST /v1/households/:id/reinstate` | Reverse archive |
| `POST /v1/dioceses` | Create |
| `PATCH /v1/dioceses/:code` | Update; honors `If-Match` |
| `POST /v1/dioceses/:code/archive` | Soft-delete |
| `POST /v1/dioceses/:code/reinstate` | Reverse archive |
| `POST /v1/webhooks` | Subscribe (add `"federationPush": true` for fat hex-keyed batches — see §8.7) |
| `POST /v1/webhooks/:code/resync` | Reset federation cursors so the next tick re-hydrates the consumer |
| `DELETE /v1/webhooks/:code` | Soft-unsubscribe (row + secret survive) |

All POST returns 201 (Created); PATCH returns 200; DELETE returns
204. Mismatched `If-Match` returns 412 (Precondition Failed).
Malformed input returns 400.

## 8. Webhook protocol

### 8.1 Subscribe

```http
POST /v1/webhooks
Authorization: Bearer <token>
Content-Type: application/json

{
  "url": "https://your-cloud-function.example.com/familyGraphWebhook",
  "secret": "<random-256-bit-string>",
  "events": "*",
  "schoolHint": "[school-slug]"     // optional; receive events from this school only
}
```

`events` is either `'*'` (all) or a comma-separated list. Known
events: `person.updated`, `person.deleted`, `household.updated`,
`household.deleted`, `consent.updated`.

### 8.2 SSRF guard

Subscription rejects URLs whose hostname is loopback, link-local
(including the cloud metadata endpoint 169.254.169.254), or
RFC1918 private. Plain `http://` is accepted but logged with a
warning — signed payloads are integrity-protected but not
confidential; operators who care about confidentiality use HTTPS.

### 8.3 Delivery shape

```http
POST <your-url>
Content-Type: application/json
X-FG-Signature: sha256=<hmac-sha256-hex-of-body-using-your-secret>
X-FG-Contract-Version: v0.2
User-Agent: familygraph-webhook/0.2

{
  "event": "person.updated",
  "personId": "p_a7b3c91d",
  "householdId": "f_88a3c0d2",   // when applicable
  "updatedAt": "2026-05-15T10:31:22Z",
  "schoolHints": ["[school-slug]"],
  "schoolId": "[school-slug]"    // optional; present on consent.updated when school-scoped
}
```

### 8.4 Signature verification

```js
const crypto = require('crypto');

function verify(req, secret) {
  const provided = req.headers['x-fg-signature'] || '';
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(req.rawBody)            // raw bytes, not parsed JSON
    .digest('hex');
  return provided === expected;
}
```

### 8.5 Retry semantics

FG retries failed deliveries 5 times with exponential backoff
(30s, 2m, 10m, 1h, 6h). After 5 failures the delivery is marked
`failed` and the operator can manually retry from the dashboard.

Your endpoint should:

- Return `2xx` on success.
- Return `4xx` for permanent failure (FG won't retry meaningfully
  — though it will still mark `failed` after 5 tries).
- Return `5xx` or time out for transient failure (FG retries).

### 8.6 Idempotent receive

A single FG-side event can produce multiple deliveries if your
endpoint timed out once and FG retried. Make your handler
idempotent — track seen delivery codes, or check whether the
`updatedAt` is newer than your cached copy before applying.

### 8.7 Federation push (for consumers that can't pull)

The webhook in 8.1–8.6 is a THIN notification: it carries only the
changed entity's id and assumes you'll `GET /v1/persons/:id` to fetch
the record. That assumes your app can reach FamilyGraph's inbound API.

If your app runs OUTSIDE FamilyGraph's network — for example a cloud
service while FamilyGraph runs on-prem behind a firewall — you can
receive FG's outbound POSTs but you can't reach back in to pull. A thin
notification is useless to you: you'd hold an id you can never resolve.

Subscribe with `"federationPush": true` instead. FamilyGraph then sends
FAT batches: the full person / household objects (the same shapes
`GET /v1/persons/:id` and the changed feed return), so you federate
identity on the canonical hex **without ever pulling**.

```http
POST /v1/webhooks
Authorization: Bearer <token>
Content-Type: application/json

{
  "url": "https://your-cloud-function.example.com/familyGraphFederation",
  "secret": "<random-256-bit-string>",
  "federationPush": true
}
```

A federation subscription does NOT also receive thin `person.updated`
notifications — the fat batch is the single channel.

**Delivery shape** (signed identically: `X-FG-Signature: sha256=…`,
`X-FG-Event: federation.sync`):

```json
{
  "type": "federation.sync",
  "contractVersion": "v0.1",
  "hydration": true,
  "generatedAt": "2026-05-15T10:31:22Z",
  "persons":   [ { "personId": "p_a7b3c91d", "firstName": "...", "active": true, ... } ],
  "households":[ { "householdId": "f_88a3c0d2", "members": [ { "personId": "p_...", ... } ], ... } ],
  "cursors": { "persons": "2026-05-15T10:31:22Z", "households": "2026-05-15T10:30:00Z" }
}
```

- **Hydration.** A brand-new federation subscription's first batch
  carries `"hydration": true` and contains every currently-active
  person and household. Treat it as a full snapshot (mark-and-sweep
  your cache). Subsequent batches are changed-since deltas with
  `"hydration": false`.
- **Tombstones.** An archived/merged record arrives as
  `{ "personId": "p_…", "active": false }` with no PII — purge it from
  your cache.
- **The hex is the join key.** Every record is keyed by the immutable
  `personId` / `householdId` hex (8.x). That is the identifier you
  federate every other system on; FG resolves merges to a single
  canonical hex before it leaves the box, so you never see two ids for
  one person.
- **At-least-once.** A failed batch is retried on the next tick with
  the same window; dedupe by `(personId, updatedAt)`.
- **Recovery / re-hydrate.** `POST /v1/webhooks/:code/resync` resets
  the subscription's cursors so the next tick re-sends the full active
  graph. Use it if your cache is ever lost or suspected stale.

Pushes run on a ~60s tick. Disable the whole pusher server-side with
`FAMILY_GRAPH_DISABLE_FEDERATION_PUSH=1`.

## 9. Idempotency on writes

§7.2 of the contract: FG dedupes inbound writes within 24h.

Send `X-Request-Id: <uuid>` on every POST/PATCH/DELETE. If you
retry with the same UUID, FG replays the cached response from the
first attempt and sets `X-FG-Idempotent-Replay: true` on the
response.

The dedupe key is `(request_id, method, path)`. Different methods
or paths under the same UUID are independent.

```js
async function createPerson(person, requestId) {
  const r = await fetch('/v1/persons', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${TOKEN}`,
      'x-fg-contract-version': 'v0.2',
      'x-source-app': 'your-app',
      'x-source-tenant': 'your-tenant',
      'x-request-id': requestId,         // ← idempotency key
      'content-type': 'application/json',
    },
    body: JSON.stringify(person),
  });
  if (r.headers.get('x-fg-idempotent-replay') === 'true') {
    // We've seen this request before; the response is the cached one.
  }
  return r.json();
}
```

Generate the request id per logical call, NOT per attempt. If your
HTTP client retries on its own, the same UUID rides each attempt
so FG's dedupe catches the duplicate.

## 10. ETag / If-Match

PATCH endpoints honour `If-Match`:

```js
async function updatePerson(personId, patch, etag) {
  const r = await fetch(`/v1/persons/${personId}`, {
    method: 'PATCH',
    headers: {
      // ... usual headers
      'if-match': etag,                  // ← the W/"..." you got from the prior GET
    },
    body: JSON.stringify(patch),
  });
  if (r.status === 412) {
    // Your cache is stale. Re-fetch and re-apply.
  }
  return r.json();
}
```

The ETag is a weak validator (`W/"<8-char-hash>"`) over the
deterministic JSON of the response body. Two byte-identical
responses produce the same ETag; whitespace-only changes don't.

`If-Match: *` matches any current state and is useful for "I don't
care what was there, just overwrite" semantics.

## 11. Error responses

| Status | Meaning | Recover |
|---|---|---|
| 400 | Malformed input | Fix the body and retry |
| 401 | Missing / invalid bearer | Provision a new key |
| 403 | Bearer is valid but lacks the required scope | Ask the operator to add `integration` (or `roster` for `/api/identity/roster`) |
| 403 `crosswalk_forbidden` / `roster_forbidden` | Key may not use that source's crosswalk (§4.3, §4.4) | Use the key named after the source (`issue-key missioniq`) or the master token |
| 404 | Entity not found | Either it was archived (look at the changed feed) or the id is wrong |
| 409 | Roster commit: `review_incomplete` (body carries the plan), `idempotency_conflict`, or a decision target that is not a valid id / earlier row | Answer every review item and re-commit; use a new key for a different request |
| 412 | If-Match mismatch (stale cache) | Re-fetch, re-apply |
| 413 | Payload too large (256KB on `/v1`, 20MB on `/api/import` and `/api/identity/roster`) | Split the request |
| 426 | Unsupported `X-FG-Contract-Version` | Upgrade your client |
| 429 | Rate limit exceeded | Honour `Retry-After`; back off |
| 5xx | FG bug or transient failure | Retry with the same `X-Request-Id` |

The body of every error response is:

```jsonc
{
  "error": "<short_code>",
  "detail": "<human-readable>"           // not always present
}
```

FG sanitises error messages aggressively — SQLite constraint
violations, OS error codes, and internal stack traces are normalised
into short generic strings before they cross the wire. The full
detail is always available in FG's structured server log. If a
specific error is confusing your client, ask the operator to paste
the relevant log line.

## 12. Boundary of ownership

| Entity / fact | FamilyGraph owns | Sibling app owns |
|---|---|---|
| Person record (names, emails, phones, address) | ✅ source of truth | cached mirror |
| Household structure + custody | ✅ source of truth | cached mirror |
| Photo / directory consent (identity-base) | ✅ source of truth | cached mirror |
| Per-school photo consent override | ✅ source of truth | cached mirror |
| EIM certifications | ✅ source of truth (diocese-of-record cached) | cached mirror |
| Identity ID (`personId`, `householdId`) | ✅ issuer | store on every entity that references a person |
| Community id (`I…` / `F…`, the same codes re-spelled) | ✅ sole minter | store it; never mint your own |
| Crosswalk (your record id to FG code) | ✅ written by deliberate imports only | send `source` + `source_ref` on resolve |
| Student → grade / classroom / activities | mirror (read-only, pushed by sibling) | ✅ source of truth |
| School role (teacher / coach / admin) | ❌ | ✅ source of truth |
| Messaging / lunch / attendance / scores / volunteer hours | ❌ | ✅ source of truth |

**Hard rule:** assignment of children to grades and classes happens
in the sibling app, by the sibling app's administrators.
FamilyGraph never writes a grade or classroom into a sibling's
record. The reverse direction — sibling app pushing the resulting
grade / classroom / activities up to FG via
`POST /v1/persons/:id/schoolContext` so FG has a richer picture of
the child — is supported.

## 13. Operational notes

### 13.1 Rate limits

FamilyGraph enforces a per-Bearer-token rate limit on every
write surface. The buckets are intentionally generous so reconcile
sweeps and bursty admin sessions don't trip them:

| Surface | Default capacity | Refill rate | Per-minute steady state |
|---|---|---|---|
| `/v1/...` (sibling apps) | 300 | 20/s | 1,200 |
| `/api/...` (PII + admin) | 200 | 10/s | 600 |
| `/api/sanitize` + `/api/desanitize` | 30 | 1/s | 60 |
| `/api/import` | 20 | 0.5/s | 30 |
| `/api/identity/roster/plan` + `/commit` | 20 | 0.5/s | 30 |

Roster lookup (`GET /api/identity/roster/lookup/:id`) uses the `/api`
PII bucket.

When a bucket is exhausted, FG responds `429 Too Many Requests` with
`Retry-After: <seconds>` and `X-RateLimit-Bucket: <name>`. Honour the
header; don't retry faster.

Every successful response carries `X-RateLimit-Bucket: <name>` and
`X-RateLimit-Remaining: <integer>` so a client can adjust pacing
proactively. The buckets are keyed on a hash of the bearer token,
so each consumer gets its own capacity — a rogue caller can't starve
the others.

Operators with extreme needs disable rate-limiting entirely via
`FAMILY_GRAPH_DISABLE_RATE_LIMIT=1`. That's not the normal posture.

### 13.2 Logging

FG writes structured JSON logs to `~/.family-graph/logs/server.log`.
Every `/v1/...` request produces one line with method, path, status,
latency, actor (the bearer key's name), and IP. The operator can
paste a few lines into chat and we can usually diagnose a failure
in one round-trip.

PII is never logged. Audit metadata is redacted before write.
Personally identifying logging is off by default; only personId /
householdId appear in webhook payload logs, never raw emails.

### 13.3 Mode awareness

A sibling app should be able to operate WITHOUT FamilyGraph — local
admins maintain their own data. The FG connector is the way to
collapse that local maintenance once the campus shares an identity
layer. Build with two modes:

1. **Standalone** — your app owns 100% of identity. No FG calls.
2. **FG-connected** — identity reads come from FG, identity writes
   go through the contract, school-context writes also flow up.

Gate the FG-connected mode behind a per-tenant settings flag so an
operator can flip it on / off without redeploying.

### 13.4 Caching

The contract layer sets `Cache-Control` on every GET. A
straightforward client cache:

- Cache `/v1/persons/:id` and `/v1/households/:id` responses with
  their ETag and `Cache-Control: max-age=30`.
- Invalidate on webhook receipt: when a `person.updated` event
  arrives, drop the cached person.
- Reconcile via the changed feed every hour: pass `since=` your
  last cursor, walk the result, invalidate cached entries that
  changed.

### 13.5 Health check

`GET /api/health` is unauthenticated and returns FG's schema
version, counts, and watch-state, plus a capabilities block
(`capabilities_version` 3; the `community_ids` and
`identity_crosswalk` flags say the roster API and the resolve
crosswalk are present). Use this for liveness probes —
don't probe `/v1/` because that requires a real bearer.

## 14. Versioning your own client

Bake the `X-FG-Contract-Version: v0.2` header into your HTTP client
as a constant. When FG bumps the major version, your CI will start
seeing `426 Upgrade Required` immediately, which is your signal to
review the changelog and update the constant.

We recommend tagging your client release with the contract version
it speaks (`my-app v3.1.2 (FG contract v0.2)`) so an operator
debugging a mismatch knows what to expect.

## 15. Implementation checklist

When you're ready to wire FG into a sibling app:

- [ ] Get an `sk_…` key from the operator with the `integration` scope.
- [ ] Pin `X-FG-Contract-Version: v0.2` in your HTTP client.
- [ ] Set `X-Source-App` and `X-Source-Tenant` on every call.
- [ ] Generate a fresh `X-Request-Id` per logical write.
- [ ] Store `personId` and `householdId` on every entity that
      references a person; never use raw emails as the join key.
- [ ] Subscribe a webhook URL via `POST /v1/webhooks` with a fresh
      256-bit secret. Verify `X-FG-Signature` on every incoming
      delivery.
- [ ] Idempotency on receive: dedupe by delivery code or by
      `updatedAt > cached.updatedAt`.
- [ ] Hourly cron that polls `/v1/persons/changed?since=` and
      `/v1/households/changed?since=`. Honour tombstones.
- [ ] Gate identity-editing UI in your app behind a feature flag
      that defers to FG when the tenant is in connected mode.
- [ ] Push `POST /v1/persons/:id/schoolContext` whenever your
      app's view of the child changes (grade, classroom, sport
      roster, after-care registration). Debounce at 5 minutes per
      person on your side; FG just stores what you send.

## Connected apps: tags, grandparent links, alumni class year

Added 2026-09-29 for donor apps such as MissionIQ. A key issued with
`family-graph issue-key missioniq` (default scopes `pii.read`, `pii.write`,
`sanitize`, `audit.write`) can call every endpoint below: reads need
`pii.read`, writes need `pii.write`. FamilyGraph stores facts about people
and households only - never dollar amounts or gifts.

### Tags (grandparent household, alumni)

Tags are free-form, lowercased, and deduped. Two standard values for this use:

| Tag | Meaning |
|---|---|
| `grandparent` | The family is a grandparent household |
| `school-alumni` | The family or person is a school alumnus |

Add tags without replacing the list (the read and write happen in one
transaction, so two apps adding at once never lose a tag):

```
POST /api/families/f_0123456789abcdef/tags/add
{ "tags": ["grandparent"] }

200 { "code": "f_0123456789abcdef", "tags": ["grandparent", "parishioner"] }
```

`POST /api/people/:code/tags/add` is the same for a person. `400` when
`tags` is not a non-empty array of strings, `404` when the record does not
exist. Remove one tag with `DELETE /api/families/:code/tags/:tag` (or
`/api/people/...`) -> `200 { "tags": [...] }`. `PUT .../tags` still replaces
the whole list; avoid it from a connected app.

### Grandparent links

Relationship kinds `grandparent_of` and `grandchild_of` link two families
(a grandparent household and the grandchild's household) or two persons,
never a family to a person. Each creates its reverse: `A grandparent_of B`
also writes `B grandchild_of A`.

```
POST /api/relationships
{ "from": "f_aaaaaaaaaaaaaaaa", "to": "f_bbbbbbbbbbbbbbbb", "kind": "grandparent_of" }

201 { "code": "r_0123456789abcdef" }
```

`POST /api/relationships` is idempotent for every kind: posting an identical
(from, to, kind) again - or the reverse of an existing pair - returns the
row already there instead of a duplicate:

```
200 { "code": "r_0123456789abcdef", "from_code": "f_aaaaaaaaaaaaaaaa",
      "to_code": "f_bbbbbbbbbbbbbbbb", "kind": "grandparent_of", "detail": null,
      "created_at": "...", "updated_at": "...", "existing": true }
```

`400` for missing fields, an unknown kind, a family paired with a person,
or a self-link.

Remove a link by its triple (the reverse goes too):

```
DELETE /api/relationships?from=f_aaaaaaaaaaaaaaaa&to=f_bbbbbbbbbbbbbbbb&kind=grandparent_of
204 (removed)   404 (no such link)   400 (from, to, kind missing or invalid)
```

`DELETE /api/relationships/:code` still works; for the grandparent kinds it
removes the reverse as well. Read links with
`GET /api/relationships/:code?kind=grandparent_of`.

### Alumni class year

Affiliations take an optional `class_year` (integer 1900-2100, or `null`):

```
POST /api/organizations/org_0123456789abcdef/affiliations
{ "person_code": "p_0123456789abcdef", "role": "alumni", "class_year": 2009 }

201 { "code": "aff_0123456789abcdef" }
```

`400` for anything else ("2009" as a four-digit string is accepted).
Re-affiliating without `class_year` keeps the stored year; `null` clears it.
Affiliation reads (`GET /api/organizations/:code`, a person's or family's
affiliations) return `class_year`. The student -> alumni transition
(`POST /api/organizations/affiliations/:code/transition`) carries the year
over, or takes a new `class_year` in its body.

### The one-time MissionIQ import

`family-graph import-missioniq` also reads MissionIQ's `families.donor_types`
(`grandparent` -> tag `grandparent`, `alumni` -> tag `school-alumni`) and its
`family_links` rows of type `extended_family`. MissionIQ does not record
which side of a link is the grandparent, so the family marked `grandparent`
in donor_types is taken as the grandparent side; when both or neither are,
the link is skipped and counted. Re-running changes nothing. Donations and
amounts are never read.

## 16. Open questions for v0.3

These are documented as deferred in the FamilyGraph spec, but
sibling apps should be aware:

- **mTLS between repos.** v0.2 uses Bearer + signed webhooks.
  mTLS is the eventual answer but isn't shipped yet.
- **Per-app scoped key isolation.** A token with the `integration`
  scope can read all PII through `/v1`. There's no narrower
  "metadata only" scope today.
- **Un-merge.** Merged identities produce alias rows. The change
  log captures the loser snapshot at merge time, but FG doesn't
  ship a one-button un-merge — manual operator workflow only.
- **Cross-tenant person.deleted.** Archiving a person fires
  `person.deleted` to every subscriber matching the school hint.
  There's no "archive in tenant X but keep in tenant Y" today.

When v0.3 ships, the `X-FG-Contract-Version` header bumps and the
changelog will spell out what changed.

---

**Last updated:** 2026-09-28 (community ids, roster API, crosswalk). See also:

- `FAMILYGRAPH_INTEGRATION.md` — the contract spec (with v0.1, v0.2,
  and audit-pass appendices).
- `API_ACCESS_GUIDE.md` — operator-facing key-provisioning guide.
