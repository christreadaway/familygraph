# Chamberlain Contract v1 (wire + module spec)

**What this is:** the concrete, build-against specification of the shared
admin contract named in `CENTRAL_ADMIN_TIER_PRD.md` §4.1. The PRD says WHY;
this says HOW. A developer or a future Claude Code session builds the
console AND onboards any app from this file alone.

**Name / marker:** Chamberlain. Package `@chamberlain/contract`; per-app
flag `chamberlainEnabled` / env `CHAMBERLAIN_URL` + `CHAMBERLAIN_TOKEN`;
config-key prefix `chamberlain.*`; per-repo doc `CHAMBERLAIN_INTEGRATION.md`;
manifest `chamberlain.json`. To answer "is this repo wired in?", grep
`rg -l chamberlain`; to answer "is it compatible?", read
`chamberlain.json.contractVersion` (see §1).

**Status:** draft, no code yet. This is the artifact each repo vendors
against.

---

## 0. How an app uses this contract (the whole job, four steps)

1. **Vendor** `@chamberlain/contract` into the repo (copied, SYNC-tracked -
   never hand-edited in the copy; the litmus `shared/admin/` + `SYNC.md`
   pattern).
2. **Declare** a `chamberlain.json` manifest at repo root (§2) and add
   `CHAMBERLAIN_INTEGRATION.md` (§9).
3. **Resolve** effective tech-admin config by calling `resolveConfig()`
   (§4) instead of reading env/local settings directly for the governed
   keys.
4. **Report** back by calling the check-in endpoint on a timer + at boot
   (§6), and honor `enabled:false` at request time (§7).

Standalone apps implement steps 1-3 and simply never enroll; the resolver
returns local values and `resolveConfig().mode === 'standalone'`.

## 1. Versioning and compatibility

- `contractVersion` is **semver**. This file specifies **v1** (`1.x`).
- **Additive changes** (new optional keys) bump minor. **Breaking changes**
  (renamed/removed keys, changed precedence, changed handshake) bump major.
- An app declares the version it implements in `chamberlain.json`. The
  console declares a **supported range** (e.g. `>=1.0 <2.0`).
- **"Compatible"** = the app's `contractVersion` major matches a major the
  console supports. Same major ⇒ interoperable; the newer side ignores keys
  the older side doesn't know (forward-compatible by construction - unknown
  keys are dropped, never fatal).
- **The compatibility check is greppable and mechanical:** the console's
  status board and a CI script read every repo's `chamberlain.json`,
  compare majors, and flag mismatches. No human judgment.

## 2. The integration manifest (`chamberlain.json`, repo root)

The single declaration that makes a repo "integrated." Everything the
console needs to know about an app without reading its code.

```json
{
  "app": "beacon",
  "displayName": "Beacon",
  "contractVersion": "1.0",
  "modesSupported": ["enrolled", "standalone"],
  "delivery": "push",              // "pull" | "push" | "manual" | "advisory"
  "onpremAiOnly": false,
  "categories": ["ai", "onprem_llm"],   // which credential/policy categories this app consumes
  "governedKeys": [                // the exact tech-admin keys this app defers when enrolled
    "chamberlain.ai.provider",
    "chamberlain.ai.model",
    "chamberlain.credential.anthropic",
    "chamberlain.onpremLlm",
    "chamberlain.enabled"
  ],
  "configDoc": {                   // present only for delivery:"push"/"advisory"
    "store": "firestore",
    "path": "platform_config/chamberlain"
  },
  "failurePosture": "open"         // "open" | "closed" (PRD §9 Q1; v1 default "open")
}
```

Rules:
- `categories` drives the **relevant-UI subset** (a no-AI app like campusops
  lists `["email","sms"]` and its admin never shows AI policy).
- `governedKeys` is the exact set that goes read-only when enrolled (§5).
  Anything not listed stays locally editable in both modes - this is how
  "tech-admin slice only, never domain admin" is enforced per app.
- `delivery` must match what the app can actually honor: `pull` (on-prem,
  calls the console), `push` (server-side config doc the console writes),
  `manual` (Netlify env, operator pastes), `advisory` (client-honored doc,
  no server enforcement - toots/mathtracker).

## 3. The config payload (what an enrolled app receives)

The resolved object the console hands an app. Secrets are delivered
**by reference + delivery channel**, never inlined into anything an app
might log.

```json
{
  "schemaVersion": "1.0",
  "app": "beacon",
  "configVersion": 47,             // monotonic; the app acks this number
  "enabled": true,                 // false = kill switch (see §7)
  "ai": {
    "provider": "anthropic",
    "model": "claude-haiku-4-5-20251001",
    "allowedProviders": ["anthropic", "google"],
    "monthlyUsdCap": 50,           // pass-through; apps that implement caps honor it
    "capBehavior": "downgrade"     // "warn" | "pause" | "downgrade"
  },
  "onpremLlm": {                   // present only for onprem-capable apps
    "baseUrl": "http://10.0.0.5:11434",
    "model": "llama-3.1-8b",
    "enabled": true
  },
  "credentials": {                 // references + last4, NEVER the value
    "anthropic": { "ref": "cred_anthropic_1", "last4": "9f2a", "present": true }
  },
  "issuedAt": "2026-07-22T14:03:00Z"
}
```

**How the secret value actually reaches the app** (never in the JSON above):
- `delivery:"pull"` - the loopback/LAN response includes the value over the
  authenticated channel to a server-side caller only; the app holds it in
  process memory / its own server-side store, never a client bundle.
- `delivery:"push"` - the console writes the value into the app's
  **server-only** config doc (Firestore rules deny client read; Beacon's
  `platform_config/providers` is the reference). The app's own server reads
  it; env still overrides.
- `delivery:"manual"` - not delivered; the console emits paste-ready steps
  and the value lands in a Netlify env var by hand.

## 4. The resolver (every app calls this)

One function, identical in all apps. Precedence, highest wins:

```
local env var  >  central (if enrolled)  >  local admin setting  >  baked default
```

```
resolveConfig(key) -> { value, source, mode }
  // source: "env" | "central" | "local" | "default"
  // mode:   "enrolled" | "standalone"
```

- **Env always wins** - the deliberate per-app override when the center is
  wrong (Beacon precedent). If an env var for a governed key is set, it
  wins even while enrolled, and the app's UI shows that field as
  env-overridden.
- **Single hop** - a central config never carries its own `inheritFrom`;
  the console is always a leaf source, never a relay (litmus rule - no
  chains, no loops).
- **Standalone** short-circuits central entirely: `env > local > default`.
- **Unknown keys** returned by a newer console are ignored (forward-compat,
  §1). Missing keys fall through to the next source, never throw.

## 5. Dual-mode behavior (what the app's admin UI does)

- **Standalone:** governed-key fields fully editable; app never calls the
  console.
- **Enrolled:** each key in `governedKeys` renders **read-only** showing the
  central value with a "managed by Chamberlain" label - never
  editable-but-ignored (the split-brain trap). Non-governed (domain) keys
  stay editable. An env-overridden governed key renders read-only with an
  "overridden locally by env" label instead.
- **Granularity is all-or-nothing per app (v1):** enrolling defers the whole
  `governedKeys` set at once. Per-category is a v2 change (would make
  enrollment a per-key subscription).
- Enroll/unenroll are local operator actions; neither destroys local
  settings, so unenrolling restores the prior standalone values.

## 6. Enrollment handshake and check-in

**Enroll** (operator pastes `CHAMBERLAIN_URL` + a one-time enrollment token
into the app's local admin):

```
POST {CHAMBERLAIN_URL}/v1/enroll
  body: { app, enrollmentToken, contractVersion }
  200:  { appToken: "sk_...", config: <§3 payload> }
```

The app stores `{ consoleUrl, appToken, mode:"enrolled" }` locally so it
knows its own mode without the network. `appToken` is scoped to this app,
hashed at rest on the console, revocable.

**Check-in / ack** (on a timer + at boot; also how pull-apps fetch config):

```
GET {CHAMBERLAIN_URL}/v1/config        Authorization: Bearer {appToken}
  200: <§3 payload>                    // pull-apps resolve from this

POST {CHAMBERLAIN_URL}/v1/ack          Authorization: Bearer {appToken}
  body: { configVersion, health: "ok"|"degraded", heldCredentialRefs: [...] }
  200: { ok: true }
```

The console shows **delivered-vs-acked** per app from these; a stale
`ackedVersion` is visible drift, never silent.

**Unenroll:** `POST /v1/unenroll` (revokes `appToken`), and the app clears
its stored `{consoleUrl, appToken}` and flips `mode:"standalone"`. The
operator can also revoke from the console side; the app discovers it on the
next check-in (401) and falls to its failure posture (§7).

## 7. Enabled / kill switch semantics

- `config.enabled === false` = this app is disabled. A **runtime-checking**
  app (any pull-app, or a push-app whose server reads the doc per request)
  MUST refuse its governed function on the next request (Beacon's
  `is_active` → `ServiceSuspended` is the reference).
- **EMERGENCY STOP** on the console sets `enabled:false` for every enrolled
  app + revokes tokens + emits the manual checklist for the rest.
- **Failure posture** when the console/config is unreachable is per-app
  (`chamberlain.json.failurePosture`, PRD §9 Q1):
  - `open` (v1 default): keep running on the last-received config. Optional
    apps.
  - `closed`: refuse governed function until the console is reachable again.
    Mandatory apps.
  - Advisory apps (toots/mathtracker) can only honor `enabled` as a
    client-side check; real enforcement waits for a server seam.

## 8. Secrets and redaction (contract-level, non-negotiable)

- The §3 payload NEVER contains a secret value - only `ref` + `last4` +
  `present`. Secret values travel only by the delivery channel in §3 and
  land only in a server-side store or env var.
- The contract module ships the **redaction rule** (same list the console
  logger uses): credential values, `appToken`, enrollment tokens, and
  service-account JSON must never be written to any log line. Vendoring the
  contract vendors the redactor, so the boundary is identical everywhere.
- No governed secret may appear in a client bundle. For the two cloud SaaS
  apps this means **retiring the `VITE_*` AI keys** as part of onboarding -
  a hard requirement, verified by `rg -l "VITE_.*_API_KEY"` in CI.

## 9. Per-repo footprint (`CHAMBERLAIN_INTEGRATION.md`)

Every integrated repo carries this doc (portfolio convention, mirrors the
FamilyGraph integration docs). Minimum contents:

- The app's `chamberlain.json` values in prose: mode support, delivery,
  categories, governed keys, `onpremAiOnly`, failure posture.
- Where the resolver is wired in (file + function).
- For push/advisory apps: the exact config-doc path and its security-rule
  posture (client read denied).
- The onboarding checklist result (§10).

## 10. Conformance checklist (what "done / compatible" means for an app)

An app is a conformant Chamberlain consumer when:

1. `chamberlain.json` exists, validates, and its `contractVersion` major is
   in the console's supported range.
2. `@chamberlain/contract` is vendored and SYNC-tracked (unmodified copy).
3. Every `governedKeys` entry is read through `resolveConfig()`, not direct
   env/local reads.
4. Enrolled mode renders governed fields read-only with the managed label;
   standalone leaves them editable; unenroll restores local values.
5. The app checks in + acks its `configVersion`; the console shows it
   connected.
6. `enabled:false` is honored per the app's `failurePosture`.
7. No governed secret in any client bundle (`VITE_*` AI keys retired where
   applicable); redactor active.
8. The app still builds, runs, and demos with Chamberlain absent (standing
   "no app may hard-require a sibling" rule).

Items 1-3 are the greppable/mechanical compatibility gate; 4-8 are the
behavioral gate proven at onboarding.

## 11. The shared admin UI kit (companion module, versioned alongside)

Vendored the same way as the contract (SYNC-tracked). Provides the
components that make every app's admin surface look and behave the same
while showing only its declared `categories`:

- `CredentialField` (last-4 mask, blank-preserves-existing, present/unset).
- `ManagedValue` (the read-only "managed by Chamberlain" state, and the
  "overridden locally by env" variant).
- `EnrollmentPanel` (paste URL + token; enroll/unenroll; shows mode).
- `KillSwitchControl` (disable/enable this app; reflects `enabled`).
- Design tokens extending the portfolio set (`tokens.css`/`sd.css`), so it
  drops into any app without a restyle.

Both modes use the same components: enrolled = read-only state, standalone =
editable state. One code path, two states. The kit carries its own
`uiKitVersion` (semver) tracked next to `contractVersion`.

---

## Appendix - open items this spec inherits from the PRD

These do not block building v1 of the contract; each has a field or default
already in the spec. Owner decisions, tracked in `CENTRAL_ADMIN_TIER_PRD.md`
§9: kill-switch failure posture default (Q1, per-app field, ships `open`);
which apps are mandatory (Q2, sets `closed` postures); console host (Q9);
integration-secret minting (Q8); staff-admin delegation (Q7). Mathtracker's
identity fork (Q5) blocks only mathtracker's move past `advisory`.
