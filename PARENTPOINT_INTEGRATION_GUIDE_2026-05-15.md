# ParentPoint × FamilyGraph — Implementation Guide

**Date:** 2026-05-15
**Revision:** 2 (security-hardening pass — rate limits, response headers, error scrubbing, webhook DNS-rebinding defense, audit-log scrubbing)

**Audience:** the ParentPoint engineer wiring the FamilyGraph
connector. Read `FAMILYGRAPH_INTEGRATION.md` first for the contract
itself; this doc walks through how to actually implement against it.

**Companion:** `INTEGRATION_GUIDE.md` for the generic, app-agnostic
view (useful when a parish app or future sibling joins the same
hub).

**Versions covered:**
- Contract: `X-PP-Contract-Version: v0.1`
- FamilyGraph schema: `v13`

---

## 1. What's new since the original contract draft

The original `FAMILYGRAPH_INTEGRATION.md` v0.1 covered identity
reads, household reads, identity writes, school-context push, and
webhooks. The FG side has since shipped two additions that PP needs
to wire to:

1. **Per-school photo / directory consent overrides** (Q5 closed).
   ParentPoint can now write `{schoolId, photoConsent: 'deny'}` to
   represent "no photos at this school's events" without affecting
   the parent's identity-level base. Other sibling apps reading
   from FG see their own (or absent) override.
2. **Diocese as system of record for EIM** (Q6 closed). PP can
   create / read dioceses at `/v1/dioceses`, and every EIM cert
   write includes a `dioceseCode` + `dioceseRecordId` so the
   diocesan record reconciles.
3. **Archive / reinstate** with a full change-log audit. Any
   identity or household can be soft-deleted and restored.
   `person.deleted` / `household.deleted` webhooks fire on
   archive; the corresponding `.updated` events fire on reinstate.
   PP can render history via `GET /v1/persons/:id/history`.

Plus a batch of audit-pass fixes (idempotency on DELETE, tombstoning
archived rows in the changed feed, more-restrictive-wins consent
merge). See Appendix C of the contract spec for the full list.

## 2. Two-mode reminder

ParentPoint has two persisted modes:

### 2.1 Standalone mode (default)

ParentPoint owns 100% of identity data. No FG calls, no webhook
handler running. School admins maintain everything inside PP via
`/admin/parents`, `/admin/students`, `/admin/class-rosters`, etc.
Magic-link sign-in onboards new families.

This mode is unchanged by the contract. Keep it shipping.

### 2.2 FamilyGraph-connected mode

Identity reads come from FG. Identity writes go through the
contract. School-context writes (grade, classroom, activities)
flow up to FG. Webhook handler is running.

The toggle lives at:

```
schools/{schoolId}/settings/integrations.familyGraph
  .enabled: boolean
  .baseUrl: string                   // e.g. https://fg.example.org
  .webhookSecret: string             // 256-bit random, shared at registration
  .tokenSecretRef: string            // ref to the sk_... in Cloud Secret Manager
  .contractVersion: 'v0.1'           // pin for self-protection
```

Read this once at boot per tenant; cache for the duration of the
hot loop.

## 3. Bootstrapping the connector

### 3.1 Operator-side setup

Before PP can call FG, the FG operator does:

1. Provisions a scoped API key for PP:
   ```bash
   curl -X POST https://<fg-host>/api/keys \
     -H "Authorization: Bearer $MASTER_TOKEN" \
     -d '{"name": "parentpoint-st-theresa", "scopes": ["parentpoint"]}'
   ```
   Saves the returned `sk_...` token into Cloud Secret Manager and
   hands the reference to PP.
2. Decides on a webhook secret (256 random bits). PP will use this
   to verify inbound signatures.
3. Tells PP: `baseUrl`, the secret-manager reference for the token,
   and the webhook secret.

### 3.2 PP-side setup

In a Cloud Function (one-time, per-tenant):

```ts
import { fetch } from 'undici';

async function subscribeWebhook(opts: {
  fgBaseUrl: string;
  fgToken: string;
  webhookUrl: string;
  webhookSecret: string;
  tenantSlug: string;
}) {
  const r = await fetch(`${opts.fgBaseUrl}/v1/webhooks`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${opts.fgToken}`,
      'x-pp-contract-version': 'v0.1',
      'x-source-app': 'parentpoint',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      url: opts.webhookUrl,
      secret: opts.webhookSecret,
      events: '*',                       // or pick a subset
      schoolHint: opts.tenantSlug,       // only get events for THIS school
    }),
  });
  if (r.status !== 201) {
    throw new Error(`webhook subscribe failed: ${r.status}`);
  }
  const { subscription } = await r.json();
  await saveSubscriptionMetadata(opts.tenantSlug, subscription.code);
}
```

Save the `subscription.code` against the tenant — you'll need it
to unsubscribe cleanly if the operator turns connected mode off.

### 3.3 Mode switch on the PP side

When `integrations.familyGraph.enabled` flips:

- **OFF → ON**: subscribe the webhook (above), then run an initial
  hydration: walk `/v1/persons/changed?since=1970-01-01T00:00:00Z`
  and cache every result against the corresponding PP record. Match
  by email first; admins resolve mismatches via the existing
  onboarding-correction UI.
- **ON → OFF**: `DELETE /v1/webhooks/:code` (soft-disable on the
  FG side; PP keeps its cached mirror but stops accepting
  updates). PP UI restores the local-edit affordances.

## 4. The core HTTP client

Wrap every FG call in one place. Pin headers, handle replay,
unify error shape.

```ts
// src/shared/data/familyGraph.ts
import { fetch, Response } from 'undici';
import { randomUUID } from 'crypto';

const CONTRACT_VERSION = 'v0.1';

export interface FGContext {
  baseUrl: string;          // from settings.familyGraph.baseUrl
  token: string;            // from secret manager
  sourceTenant: string;     // the school slug
}

export interface FGCallOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  ifMatch?: string;
  requestId?: string;       // pass through for write retries
}

export async function fgCall(ctx: FGContext, opts: FGCallOptions): Promise<{
  status: number;
  body: any;
  etag: string | null;
  idempotentReplay: boolean;
}> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {
    'authorization': `Bearer ${ctx.token}`,
    'x-pp-contract-version': CONTRACT_VERSION,
    'x-source-app': 'parentpoint',
    'x-source-tenant': ctx.sourceTenant,
  };
  if (method !== 'GET' && method !== 'HEAD') {
    headers['x-request-id'] = opts.requestId ?? `pp_${randomUUID()}`;
  }
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.ifMatch) headers['if-match'] = opts.ifMatch;

  const r = await fetch(`${ctx.baseUrl}${opts.path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = text; }

  if (r.status === 426) {
    throw new Error(`FG contract version mismatch — upgrade the PP connector. supported: ${parsed?.supported?.join(',')}`);
  }

  return {
    status: r.status,
    body: parsed,
    etag: r.headers.get('etag'),
    idempotentReplay: r.headers.get('x-fg-idempotent-replay') === 'true',
  };
}
```

A few opinions baked in:

- Auto-generated `X-Request-Id` per call. If your caller wants to
  retry, it passes its own UUID via `opts.requestId`.
- Hard error on 426. If FG bumps the major version, fail loudly
  and update the constant.
- Return `etag` so a follow-up PATCH can include `If-Match`.

## 5. Read flows

### 5.1 At sign-in: lookup by email

Replaces `useAuth.resolveRole`'s cross-tenant lookup step (§9 of the
contract):

```ts
async function lookupPersonByEmail(ctx: FGContext, email: string) {
  const r = await fgCall(ctx, {
    path: `/v1/persons?email=${encodeURIComponent(email)}`,
  });
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error(`FG lookup failed: ${r.status}`);
  return r.body.person;  // §6.1 Person object
}
```

If `null`, the email is unknown to FG — fall through to PP's
existing onboarding flow.

### 5.2 Hydrate a person's household for the parent dashboard

```ts
async function getHouseholdForPerson(ctx: FGContext, personId: string) {
  const r = await fgCall(ctx, {
    path: `/v1/households?personId=${personId}`,
  });
  if (r.status === 404) return null;
  return r.body.household;  // §6.2 Household object
}
```

The result includes the parent's siblings, children, custody flags,
and primary contact. Render the family card off this.

### 5.3 Hourly catch-up cron

```ts
// Cloud Scheduler → Cloud Function, every hour.
async function reconcileFromFamilyGraph(ctx: FGContext, tenantId: string) {
  const cursor = await getReconcileCursor(tenantId);
  let lastCursor = cursor;

  // Persons
  const personPage = await fgCall(ctx, {
    path: `/v1/persons/changed?since=${encodeURIComponent(cursor)}&limit=500`,
  });
  for (const person of personPage.body.items) {
    if (person.active === false) {
      await purgeCachedPerson(tenantId, person.personId);  // tombstone
    } else {
      await upsertCachedPerson(tenantId, person);          // full record
    }
  }
  lastCursor = personPage.body.cursor;

  // Households
  const householdPage = await fgCall(ctx, {
    path: `/v1/households/changed?since=${encodeURIComponent(cursor)}&limit=500`,
  });
  for (const h of householdPage.body.items) {
    if (h.active === false) {
      await purgeCachedHousehold(tenantId, h.householdId);
    } else {
      await upsertCachedHousehold(tenantId, h);
    }
  }

  await saveReconcileCursor(tenantId, lastCursor);
}
```

**Important:** the changed feed tombstones archived rows. Don't
treat `active: false` as a real record; it's a "purge from cache"
signal. The tombstone has only `personId | householdId, active,
status, updatedAt`. A direct `GET /v1/persons/:id` of the same id
will return the full record (operator's historical view) — don't
call the GET unless your operator UI needs it.

## 6. Write flows

### 6.1 Admin adds a new parent in PP

Two-step: create the identity in FG, then save the local PP record
keyed by the returned `personId`.

```ts
async function createParentInFG(ctx: FGContext, parent: {
  firstName: string;
  lastName: string;
  primaryEmail: string;
  phone?: string;
  mailingAddress?: { line1: string; city: string; state: string; postal: string };
}, requestId: string) {
  const r = await fgCall(ctx, {
    method: 'POST',
    path: '/v1/persons',
    requestId,                          // ← per-logical-call UUID
    body: {
      firstName: parent.firstName,
      lastName: parent.lastName,
      kind: 'adult',
      primaryEmail: parent.primaryEmail,
      phones: parent.phone ? [{
        value: parent.phone,
        type: 'mobile',
        smsConsent: false,              // explicit, never assume
        is_primary: true,
      }] : [],
      mailingAddress: parent.mailingAddress,
    },
  });
  if (r.status !== 201) throw new Error(`FG create failed: ${r.status}`);
  return r.body.person;                 // .personId is the FG id you store locally
}
```

Generate the `requestId` ONCE per logical call. If your HTTP client
retries on its own, pass the same UUID through so FG's idempotency
dedupes the duplicate POST.

### 6.2 Admin edits a parent's contact info

```ts
async function updateParentInFG(ctx: FGContext, personId: string, patch: any) {
  // Fetch current to grab the ETag.
  const current = await fgCall(ctx, { path: `/v1/persons/${personId}` });
  const r = await fgCall(ctx, {
    method: 'PATCH',
    path: `/v1/persons/${personId}`,
    ifMatch: current.etag!,             // ← optimistic-concurrency guard
    body: patch,
  });
  if (r.status === 412) {
    // Stale cache. Re-fetch and re-prompt the admin if the diff is non-trivial.
    throw new StaleCacheError(personId);
  }
  if (r.status !== 200) throw new Error(`FG update failed: ${r.status}`);
  return r.body.person;
}
```

### 6.3 Admin creates a new household + adds members

```ts
async function createHouseholdInFG(ctx: FGContext, household: {
  displayName: string;
  primaryContactPersonId: string;
  members: Array<{ personId: string; role: 'mother' | 'father' | 'child' | ...; custodial?: boolean }>;
}) {
  const r = await fgCall(ctx, {
    method: 'POST',
    path: '/v1/households',
    body: household,
  });
  return r.body.household;
}

async function addMemberToHousehold(ctx: FGContext, householdId: string, personId: string, role: string, custodial = false) {
  const r = await fgCall(ctx, {
    method: 'POST',
    path: `/v1/households/${householdId}/members`,
    body: { personId, role, custodial },
  });
  return r.body.household;
}
```

PP's `ClassRosterParentLinkage.relationship` values translate
1:1 to FG's role values (`mother | father | step_parent |
guardian | grandparent | other | child`).

## 7. Per-school photo / directory consent override

This is the new bit — the FG side now models per-school overrides
on top of the identity-level base.

### 7.1 Mental model

```
identity base (1 row per person)          per-school override (0..N per person)
   photoConsent: 'allow'    ─────┐         schoolId: 'st-theresa'
   directoryListing: 'allow'     │         photoConsent: 'deny'      ← overrides photo
                                 │         directoryListing: null     ← falls back to base
                                 │
                                 ▼
                       effective consent at st-theresa:
                         photoConsent: 'deny'
                         directoryListing: 'allow'
                         overrideApplied: true
                         basePhotoConsent: 'allow'
                         baseDirectoryListing: 'allow'
```

### 7.2 Set an override

```ts
async function setSchoolConsentOverride(ctx: FGContext, personId: string, schoolId: string, override: {
  photoConsent?: 'allow' | 'group_only' | 'deny';
  directoryListing?: 'allow' | 'deny';
}) {
  const r = await fgCall(ctx, {
    method: 'POST',
    path: `/v1/persons/${personId}/photoConsent`,
    body: { schoolId, ...override },
  });
  return r.body.consent;
}
```

Omitting `directoryListing` leaves that field's override unchanged.
Passing only one field overrides just that field — the other falls
back to the base.

### 7.3 Clear an override

```ts
async function clearSchoolConsentOverride(ctx: FGContext, personId: string, schoolId: string) {
  await fgCall(ctx, {
    method: 'DELETE',
    path: `/v1/persons/${personId}/photoConsent?schoolId=${schoolId}`,
  });
}
```

### 7.4 Read effective consent before sending an outbound photo email

```ts
async function effectiveConsent(ctx: FGContext, personId: string, schoolId: string) {
  const r = await fgCall(ctx, {
    path: `/v1/persons/${personId}/consent?schoolId=${schoolId}`,
  });
  return r.body.consent;
}

// In your outbound photo blast:
if ((await effectiveConsent(ctx, kid.personId, tenant.slug)).photoConsent === 'deny') {
  // Skip this child for the photo blast.
}
```

### 7.5 UI: list all overrides for a person

```ts
const r = await fgCall(ctx, { path: `/v1/persons/${personId}/consent/overrides` });
// r.body.items is an array of { person_code, school_id, photo_consent, directory_listing, updated_at }
```

Render this when an admin opens the person's detail page — gives a
"at school X: deny photos; at school Y: directory deny" view.

### 7.6 Webhook implications

When you set a school override, FG fires a `consent.updated` event
with `schoolId` in the payload:

```jsonc
{
  "event": "consent.updated",
  "personId": "p_a7b3c91d",
  "schoolHints": ["st-theresa"],
  "schoolId": "st-theresa",            // ← present when school-scoped
  "updatedAt": "2026-05-15T10:35:00Z"
}
```

When `schoolId` is absent on a `consent.updated`, the identity-level
base changed and PP should invalidate cached consent for that person
across every school it tracks.

## 8. EIM certifications with the diocese as system of record

PP's existing EIM tracking lives at the parish level. The
v0.2 update lets PP attach each cert to the issuing diocese so
multiple parishes that share a diocese don't fight over the
authoritative record.

### 8.1 Register dioceses (operator setup)

The FG operator typically pre-loads dioceses via the dashboard
before PP starts pushing certs. PP just consumes:

```ts
async function listDioceses(ctx: FGContext) {
  const r = await fgCall(ctx, { path: '/v1/dioceses' });
  return r.body.items;  // array of §6.5 Diocese objects
}
```

Cache this for the duration of the user's session. The diocese
list rarely changes.

### 8.2 Add a cert with diocesan attribution

```ts
async function addEimCert(ctx: FGContext, personId: string, cert: {
  status: 'pending' | 'certified' | 'expired';
  completed_on?: string;               // YYYY-MM-DD
  expires_on?: string;                 // optional; auto-derived from diocesan renewal interval
  dioceseCode: string;                 // dio_xxxxxxxx
  dioceseRecordId?: string;            // the diocese's own form number
  source?: string;                     // e.g. "diocese-vendor-name"
  notes?: string;
}) {
  const r = await fgCall(ctx, {
    method: 'POST',
    path: `/v1/persons/${personId}/eimCertifications`,
    body: cert,
  });
  return r.body;                       // { code, certifications: [...] }
}
```

When `expires_on` is omitted:

1. If `dioceseCode` is set and the diocese has its own
   `eim_renewal_years`, FG auto-derives `expires_on = completed_on
   + renewal_years` for THAT diocese.
2. Otherwise FG falls back to the global `eim.renewal_years`
   setting (defaults to 3).
3. If neither is set, expires_on stays null.

### 8.3 Reading the current cert

```ts
async function getEimCerts(ctx: FGContext, personId: string) {
  const r = await fgCall(ctx, { path: `/v1/persons/${personId}/eimCertifications` });
  return r.body.certifications;        // reverse-chronological
}
```

The first item is the most recent cert. To know if a person is
*currently* EIM-current, look at the person record's `eim_status`
column (returned on `GET /v1/persons/:id` — note the snake_case
field on the person object; this is a v0.1 artifact and stays for
compat).

## 9. School-context enrichment (PP → FG push)

This is the "PP tells FG what it knows about each child" channel.
FG stores the snapshot keyed by `(personId, schoolId)` so the
parish app can render "Annie, 3rd grade, plays basketball" without
needing access to PP's class rosters.

### 9.1 When to push

Every time PP changes any of:

- `class_rosters` — student added/removed/moved
- `sport_teams.rosterStudentIds` — player added/removed
- `registrations` (enrichment / camp) — child registered
- `after_care_registrations` — child enrolled
- Allergies updated on the student record

The Cloud Function fanout (PP side) debounces per `personId` to
one POST every 5 minutes — admins doing bulk edits won't pile up
FG calls.

### 9.2 The POST

```ts
async function emitSchoolContextSnapshot(ctx: FGContext, personId: string, snapshot: {
  schoolYear: string;                  // e.g. "2026-2027"
  grade: string;                       // e.g. "3"
  classroomId: string;                 // e.g. "3A"
  classroomName?: string;              // e.g. "Room 204 — Ms. Lee"
  homeroomTeacherPersonId?: string;    // FG personId of the teacher, if known
  activities: Array<{ kind: string; label: string; season?: string }>;
  allergies?: string[];
}) {
  await fgCall(ctx, {
    method: 'POST',
    path: `/v1/persons/${personId}/schoolContext`,
    body: {
      schoolId: ctx.sourceTenant,      // your tenant slug
      ...snapshot,
    },
  });
}
```

### 9.3 Important semantics

- `activities` is the **current state**, not a log. FG overwrites
  the previous snapshot on every POST. PP keeps its own activity
  history.
- The snapshot is keyed by `(personId, schoolId)`. A student in
  two PP-administered schools gets two snapshots (rare but legal).
- The snapshot does not trigger a webhook on the FG side. Sibling
  apps that want school-context updates poll
  `GET /v1/persons/:id/schoolContext` (with their own cache).

## 10. Webhook handler implementation

### 10.1 Cloud Function shape

```ts
// functions/src/familyGraphWebhook.ts
import * as functions from 'firebase-functions';
import crypto from 'crypto';

export const familyGraphWebhook = functions.https.onRequest(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send();

  // 1. Verify signature.
  const secret = await loadWebhookSecretForTenant(req);
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(req.rawBody)               // RAW bytes — not the parsed body
    .digest('hex');
  const provided = req.get('x-fg-signature') || '';
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) {
    return res.status(401).send('bad signature');
  }

  // 2. Parse the event.
  const event = req.body;
  if (!event || !event.event) return res.status(400).send('bad payload');

  // 3. Dispatch.
  try {
    switch (event.event) {
      case 'person.updated':
        await handlePersonUpdated(event);
        break;
      case 'person.deleted':
        await handlePersonDeleted(event);
        break;
      case 'household.updated':
        await handleHouseholdUpdated(event);
        break;
      case 'household.deleted':
        await handleHouseholdDeleted(event);
        break;
      case 'consent.updated':
        await handleConsentUpdated(event);
        break;
      default:
        // Future events PP doesn't know about — accept and log.
        console.warn('unknown event', event.event);
    }
    return res.status(204).send();
  } catch (e) {
    console.error('webhook handler failed', e);
    return res.status(500).send();      // FG will retry with exponential backoff
  }
});
```

### 10.2 Pivotal handler bodies

```ts
async function handlePersonUpdated(event: any) {
  // FG bumped the person row. Drop our cached copy; the next
  // read will refetch from FG. Also fan out to derived collections
  // (class_rosters, sport_teams) that store phone/email inline.
  await invalidatePersonCache(event.personId);
  await rebuildOutboundSmsQueueForPerson(event.personId);
}

async function handlePersonDeleted(event: any) {
  // FG archived the person. Treat as "no longer enrolled" — purge
  // from class rosters, end memberships, but keep historical
  // attendance records.
  await archivePersonInPP(event.personId, { reason: 'fg.person.deleted' });
}

async function handleHouseholdUpdated(event: any) {
  await invalidateHouseholdCache(event.householdId);
}

async function handleHouseholdDeleted(event: any) {
  await archiveHouseholdInPP(event.householdId);
}

async function handleConsentUpdated(event: any) {
  if (event.schoolId) {
    // School-scoped override — invalidate just THIS school's cached
    // consent for the person.
    await invalidateSchoolConsentCache(event.personId, event.schoolId);
  } else {
    // Identity-level base — invalidate every school's cached
    // consent for the person.
    await invalidateAllConsentCachesForPerson(event.personId);
  }
}
```

### 10.3 Idempotent receive

A single FG event can produce more than one delivery if your
endpoint timed out and FG retried. Make the handler idempotent:

- Each delivery row in FG has its own `code` (whd_xxxxxxxx). The
  delivery is logged once per delivery code on the FG side; on the
  PP side, you don't see this code in the body. Use `updatedAt`
  instead: compare the event's `updatedAt` against the cached
  record's. If the cached record is already newer-or-equal, no-op.
- For deletes, the operation is naturally idempotent (the second
  call finds the record already archived in PP).

## 11. Archive / reinstate

The contract now supports soft-delete + restore. Two cases matter
for PP:

### 11.1 An admin removes a family from the school

```
PP admin clicks "Remove family" in /admin/families
     │
     ├──▶ PP archives its local family record (current behavior)
     │
     └──▶ PP calls POST /v1/households/:id/archive
          with { reason: 'no longer enrolled' }
              │
              ├──▶ FG flips status = 'archived'
              ├──▶ FG writes a change-log row (snapshot + actor + reason)
              └──▶ FG fires 'household.deleted' webhook
                   - PP's webhook handler is the SOURCE of the event,
                     so we ignore self-fired echoes (see §11.3)
                   - But OTHER sibling apps (parish) see it and
                     purge their own caches
```

Hard rule from the contract: PP does NOT archive a `personId` in FG
just because the parent left this school. The identity belongs to
the campus, not to one school. PP archives the local family record
in PP; the identity stays alive in FG. Use the consent / membership
flag to express "no longer in our tenant."

The exception: when the operator (FG-side admin) decides the
person is gone from the campus entirely, they archive on the FG
side, which then fans out to every sibling.

### 11.2 Restoring a family that was archived in error

```ts
await fgCall(ctx, {
  method: 'POST',
  path: `/v1/households/${householdId}/reinstate`,
  body: { reason: 'restored — was not actually leaving' },
});
```

FG flips status back, writes another change-log row, and fires
`household.updated`.

### 11.3 Echo suppression

When PP archives or reinstates via the contract, FG fires a webhook
back. PP's handler should detect "this came from us" and skip
re-processing. Two ways:

1. **By actor.** Webhook payload doesn't include the actor today,
   but the change log does. PP can call
   `GET /v1/households/:id/history` and check the most recent
   `actor` — if it matches PP's bearer name, no-op.
2. **By idempotent state.** Cheaper: just no-op if the action you'd
   take leaves state unchanged (you'd be archiving an already-
   archived local record).

We recommend option 2. It's simpler and resilient to other
actors (operator dashboard, future apps) hitting the same code path.

### 11.4 History view in admin UI

```ts
async function getPersonHistory(ctx: FGContext, personId: string) {
  const r = await fgCall(ctx, { path: `/v1/persons/${personId}/history?limit=100` });
  return r.body.items;
}
```

Each item is `{ code, entity_kind, entity_code, operation, before,
after, actor, actor_kind, request_id, related_codes, reason,
created_at }`. Render a timeline:

- `create` → "Created by [actor] on [date]"
- `update` → "Edited by [actor] on [date]"
- `archive` → "Archived by [actor]: [reason]"
- `reinstate` → "Reinstated by [actor]"
- `merge` → "Merged into [related_codes[0]] by [actor]"

The `before` / `after` snapshots contain encrypted BLOB columns as
base64 strings. PP doesn't decrypt these — FG does on subsequent
GETs. The snapshots are useful for diff-style audit views ("phone
changed from X to Y") if PP holds its own copy and compares.

## 11.5 Rate limits to design around (rev 2)

The `/v1` surface has a per-Bearer-token rate limit of 1,200 req/min
(20/s sustained, 300 burst capacity). For a single school tenant this
is wildly generous — reconcile sweeps and admin sessions both fit
comfortably. But two patterns DO bump against it:

1. **Backfill from a cold start.** When you flip a tenant to
   FG-connected mode for the first time and walk
   `/v1/persons/changed?since=1970-01-01` to hydrate the local cache,
   the walk can paginate fast. Use `?limit=500` (the max) and let the
   bucket refill between pages. A 1000-person tenant takes ~3 pages
   over 1 second of wall clock; well under the limit.
2. **Bursty school-context fan-outs.** When an admin imports a CSV that
   touches 500 students, your Cloud Function fanout debounces per
   `personId` to one POST every 5 minutes (§9.1 above) — that single
   choke point already protects FG. Don't bypass it.

On `429`, FG returns:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 15
X-RateLimit-Bucket: v1
```

Honour `Retry-After`. Don't retry sooner.

Read responses also carry `X-RateLimit-Remaining: <int>` so a
proactive client can pace itself before hitting the cap.

If you need a higher cap for a specific tenant, ask the operator;
they can bump the bucket sizes per FG install via env vars.

---

## 12. Common pitfalls

### 12.1 "Why does the changed feed return a person with no email?"

You hit a tombstone — `active: false`. Don't drop the personId from
your cache because you couldn't render a name; PURGE the cached
copy entirely. Direct `GET /v1/persons/:id` returns the full record
for the operator UI to render historical detail.

### 12.2 "POST /v1/persons returned 412 — what?"

You sent an `If-Match` header on a CREATE. `If-Match` is for PATCH
only. Drop the header from your create path.

### 12.3 "Why is my consent override saving but not affecting reads?"

Two cases:

1. You sent the schoolId in the URL but not in the body. The
   endpoint accepts schoolId from both; the BODY wins if both are
   set. Pick one.
2. You're reading from `/v1/persons/:id/consent` without
   `?schoolId=`. That returns the IDENTITY base, which doesn't
   reflect overrides. Include the schoolId on reads too.

### 12.4 "Why am I getting `426 Upgrade Required`?"

You're pinning a contract version FG no longer supports. Check
`/api/health` for FG's `schema` version and update your client
constant.

### 12.5 "My webhook handler keeps re-firing for the same event"

Either your handler returns non-2xx (FG retries), or your
idempotent-receive check isn't catching the duplicate. Verify by
looking at `GET /v1/webhooks/:code/deliveries` on the FG side —
each retry is one row.

### 12.6 "Idempotency replays seem to also replay the side effects"

They don't. The replay returns the CACHED response (the wire body
+ status code from the first attempt). The side effect (DB write,
audit row) happened only once, during the original call. Retries
are safe.

### 12.7 "I subscribed http://localhost:5432/cb for testing and FG rejected"

The SSRF guard (correctly) blocks loopback / link-local / RFC1918
hosts. For local testing, use a tunneling service (ngrok,
Cloudflare Tunnel) or run FG in your local dev environment and
target it directly without going through a webhook.

## 13. Testing strategy

### 13.1 Test FG in isolation

FG ships with 463 tests and a smoke runner. The PP team doesn't
need to test FG's contract behaviour from scratch. What you DO
need to test:

- Your HTTP client wraps headers correctly.
- Your webhook handler verifies signatures.
- Your handler is idempotent on duplicate delivery.
- Your `If-Match` flow handles 412 by re-fetching.

### 13.2 Contract tests (PP side)

Write a contract test suite that stubs FG with a Pact-style
expectation file:

```ts
describe('PP × FG contract', () => {
  it('lookupPersonByEmail returns null on 404', async () => {
    fgStub.get('/v1/persons?email=ghost@example.com').reply(404);
    const result = await lookupPersonByEmail(ctx, 'ghost@example.com');
    expect(result).toBeNull();
  });

  it('createParent passes X-Request-Id', async () => {
    let observed;
    fgStub.post('/v1/persons').intercept(req => { observed = req.headers; return [201, mockPerson] });
    await createParentInFG(ctx, { firstName: 'A', lastName: 'B', primaryEmail: 'a@b.example' }, 'pp_test_1');
    expect(observed['x-request-id']).toBe('pp_test_1');
    expect(observed['x-pp-contract-version']).toBe('v0.1');
  });

  // ... etc.
});
```

This catches client-side regressions without needing FG running.

### 13.3 End-to-end against a dev FG

Run FG in a dev container (`docker run -p 3500:3500 familygraph:dev`),
provision a scoped key, and run an E2E that exercises:

1. `POST /v1/persons` for a new parent
2. `POST /v1/households` for a new family
3. `POST /v1/households/:id/members` linking parent
4. `POST /v1/persons/:id/photoConsent` setting a school override
5. `POST /v1/persons/:id/schoolContext` pushing a grade
6. Verify webhook fires by polling `/v1/webhooks/:code/deliveries`
7. `POST /v1/persons/:id/archive` to soft-delete
8. `POST /v1/persons/:id/reinstate` to restore
9. `GET /v1/persons/:id/history` to verify the audit trail

PP can land this E2E in its existing Playwright suite.

## 14. Migration from standalone to FG-connected

When a school adopts FG mid-flight:

### 14.1 Discovery phase

1. PP operator provides FG operator with a CSV of every active
   parent + student + staff person, with primary email.
2. FG operator runs the existing import pipeline (`/api/import`)
   against the CSV. Conflicts surface in `/admin/familygraph-
   conflicts` (existing FG admin UI) and the operator resolves.
3. FG ends with a person record for every PP record. The
   `personId` for each lives in FG.

### 14.2 Backfill phase

PP needs to learn the `personId` for each of its existing local
records. Two options:

- **Sweep approach:** PP iterates its `parent_contacts` and
  `students` collections, calls `GET /v1/persons?email=`, and
  stores the returned `personId` against the local record. Email
  is the join key for v0.1.
- **Push approach:** FG operator exports the resulting
  `personId → email` map and PP imports it back. Faster for
  big tenants.

### 14.3 Flip the switch

1. Set `integrations.familyGraph.enabled = true` on the tenant.
2. Subscribe the webhook.
3. Gate the identity-editing UI in `/admin/parents` /
   `/admin/students` etc. — show the FG values as read-only,
   with "Edit in FamilyGraph" deep-link buttons.
4. Future admin CRUD on identity fields goes through the
   contract.

### 14.4 Watch for divergence

For the first 30 days post-migration, run a daily reconcile job:

```sql
SELECT pp.email, pp.phone, fg.primaryEmail, fg.phones
FROM pp.parent_contacts pp
LEFT JOIN fg_cache fg ON fg.personId = pp.familyGraphPersonId
WHERE pp.last_local_edit_at < fg.updatedAt - INTERVAL '60 seconds'
  AND (pp.phone <> fg.phones[0].e164 OR pp.email <> fg.primaryEmail);
```

Anything that drifts goes into a `/admin/familygraph-conflicts`
queue. The 60-second window is the same one the contract uses
for last-writer-wins conflict resolution.

## 15. Operational runbook

### 15.1 "FG is down — what does PP do?"

The contract layer is best-effort. PP should fall back to the
local mirror for reads and queue up writes for retry. The mirror is
populated by the hourly reconcile cron plus the webhook stream, so
it's never more than ~1 hour stale.

Writes that 5xx'd should be retried with the SAME `X-Request-Id`
so FG dedupes when it comes back. Don't generate a new UUID per
retry — that creates duplicates.

### 15.2 "Webhook deliveries are stuck"

Check `GET /v1/webhooks/:code/deliveries?status=pending`. If
deliveries are accumulating, your endpoint is likely returning
non-2xx. Fix the endpoint; FG will continue retrying on its own
schedule (30s, 2m, 10m, 1h, 6h). After 5 failures, deliveries flip
to `failed` and stop retrying — the operator can manually re-fire
from the FG dashboard.

### 15.3 "How do I rotate the webhook secret?"

Today, the secret is set at subscription time. To rotate:

1. `POST /v1/webhooks` with the new secret → get a new subscription
   code.
2. Update PP to use the new secret for verification (deploy).
3. `DELETE /v1/webhooks/<old-code>` to soft-disable the old
   subscription.

The new + old run in parallel for a short window so no delivery is
lost. The old `pp_webhook_deliveries` rows survive the soft delete
for audit.

### 15.4 "How do I debug a 'phone change didn't propagate' bug?"

The flow is:

1. Parent updates phone in FG (or in PP, which PATCHes FG).
2. FG fires `person.updated` to every matching webhook.
3. PP's handler invalidates the cached person + fans out to
   `class_rosters[].students[].parentLinkages[].phone`.

Diagnose by checking, in order:

- Did FG write the new phone? `GET /v1/persons/:id` → check `.phones[]`.
- Did FG fire the webhook? `GET /v1/webhooks/:code/deliveries` →
  look for a recent `person.updated` with that personId.
- Did your handler succeed? Check your Cloud Function logs for
  the delivery; non-2xx triggers a FG-side retry.
- Did your fanout reach the derived collections? Inspect one
  affected `class_rosters` doc.

The audit log on the FG side (`/api/audit?action=pp_person_update`)
records every PP-initiated update with the actor and request_id —
useful for "who wrote this when?" investigations.

## 16. What's not in v0.2 (don't write code against these)

- **mTLS between repos.** v0.2 uses Bearer + signed webhooks.
- **Un-merge.** Merge produces alias rows; the change log captures
  the loser snapshot but FG doesn't offer a one-button un-merge.
  Operator workflow only.
- **Cross-tenant scope isolation.** A scoped key with `parentpoint`
  scope can read all PII through `/v1`. Per-tenant tokens (one key
  per school) work but the scope is identical.
- **`person.deleted` to a subset of tenants.** Archive is global
  on the FG side; every matching webhook fires. PP needs the echo-
  suppression logic above.
- **Conflict-resolution UI.** PP's planned `/admin/familygraph-
  conflicts` page is in §7.4 of the contract but not yet wired to
  FG-side events. Treat as a manual operator workflow for v0.2.

When v0.3 ships, this guide's "version covered" header bumps and
the changelog spells out the migration.

---

**Last updated:** 2026-05-15. See also:

- `FAMILYGRAPH_INTEGRATION.md` — the contract spec, with v0.1 +
  v0.2 + audit-pass appendices.
- `INTEGRATION_GUIDE.md` — the generic, app-agnostic reference
  doc. Useful when a parish app or future sibling joins.
- `API_ACCESS_GUIDE.md` — operator-facing key-provisioning guide.
