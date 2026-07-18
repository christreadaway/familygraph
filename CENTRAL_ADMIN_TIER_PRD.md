# Switchboard - Central Admin Tier PRD (v1)

**Status:** Draft for owner review. No code exists yet.
**Home:** This is a NEW standalone codebase in its own repo (working name:
`switchboard` - rename freely). This document is parked in the familygraph
repo only because the new repo doesn't exist yet; move it there at repo
creation. It follows the extraction pattern documented in
`ARCHITECTURE_MEMO_FAMILY_MANAGEMENT.md`.
**Owner decisions already made (2026-07-18):**
1. All ten portfolio apps are in scope.
2. Config-and-credentials only - Switchboard is NEVER in the AI request
   path (no gateway/proxy).
3. Keep Netlify simple - no Netlify API automation; env-var changes ship
   as generated paste-ready instructions.
4. New codebase, separate from FamilyGraph. FamilyGraph is a governed app
   like the others.
**Explicitly undecided:** kill-switch failure posture (see Open Questions).

---

## 1. What this is

Switchboard is a single tech-administration console, running as a local
service inside the school's firewall, where the operator administers the
whole app portfolio once: enter and rotate provider credentials (AI, email,
SMS, payments, search), choose the portfolio's AI provider and model, turn
each app's access on or off, and act fast in an emergency - without hopping
from app to app.

## 2. Who it's for

- **The operator** (school/parish tech admin - today, the owner). Single
  primary user, same posture as FamilyGraph's operator.
- **Named staff admins** (future, v1-optional): scoped delegated access via
  the invite-only magic-link pattern from FamilyGraph's staff accounts.
- **The apps themselves** are machine consumers: they receive config and
  credentials from Switchboard and report status back.

Not for: school principals, teachers, parents. Each app keeps its own
domain-level admin (lunch settings, schedules, rosters). Switchboard is
tech administration only.

## 3. User stories / jobs to be done

1. As the operator, I enter my Anthropic API key ONCE and every app that
   uses AI receives it - I never paste a key into six dashboards.
2. As the operator, I switch the portfolio's default AI provider (or
   model) in one screen and every consuming app follows.
3. As the operator, I click "disable app" on any app and its access stops
   - fast enough to matter in an incident.
4. As the operator, I hit one EMERGENCY STOP and every governed app is
   disabled, every distributed credential is revoked or flagged, and I get
   a checklist of the few manual steps automation can't reach.
5. As the operator, I rotate a leaked key and Switchboard re-distributes
   it everywhere automatically where it can, and prints exact paste-ready
   steps where it can't (Netlify env vars).
6. As the operator, I see one status board: every app, connected or not,
   config version, last check-in, what credentials it consumes.
7. As the operator, I read one audit trail answering "who changed what,
   when, and which apps received it."
8. As a future app author, I onboard a new app by registering it and
   implementing one small, documented contract.

## 4. Core features

### 4.1 App registry
One row per governed app. All ten launch entries: familygraph,
parentpoint, teacherAIde (on-prem box and cloud app registered
separately), beacon, litmus, sensibledebate, mathtracker, toots,
campusops, missionIQ.

Per app: display name, repo, **adoption mode** (`mandatory` | `optional` |
`standalone` - semantics partly open, see §9), **enabled flag**, delivery
mechanism (see 4.4), scoped credential for that app, config version
delivered vs acknowledged, last check-in time, notes.

### 4.2 Provider credential registry
General-purpose, not AI-only. Categories: `ai`, `email`, `sms`,
`payments`, `search`, `integration`. Launch inventory it must hold:

- AI: Anthropic, OpenAI, Google AI, OpenRouter, Groq keys; on-prem LLM
  endpoint config (base URL, model name, optional key, enabled).
- Email: Postmark server token, SendGrid key.
- SMS: Twilio SID/auth token/from number.
- Payments: Stripe secret + webhook secrets (publishable keys are
  non-secret config).
- Search: Serper.dev key (missionIQ donor research).
- Integration secrets: the existing shared HMAC secrets
  (`TEACHERAIDE_INGEST_SECRET`, `BEACON_FEED_SECRET`/`PARENTPOINT_TOKEN`),
  which today are minted and pasted by hand on both sides.

Behavior (all proven in the portfolio already): encrypted at rest
(FamilyGraph `_ct` pattern), never echoed after entry (masked to last-4,
Beacon `provider-keys` pattern), blank-on-edit preserves existing
(missionIQ settings pattern), every read/write audited. Each credential
records which apps consume it, so rotation shows a blast radius before
you confirm.

### 4.3 AI policy
Config-only - Switchboard chooses and distributes, apps call providers
themselves with the credentials they were handed.

- Portfolio default provider + default model per provider (vendor the
  field model from `missionIQ/server/services/aiProvider.js`).
- Allowed-provider list and per-app overrides (field model from
  ParentPoint's `SuperadminAiGovernance`: `aiAllowedProviders`,
  `aiProvider`, plus cap fields carried as pass-through config for apps
  that implement caps).
- Connection test per provider (vendored from missionIQ) so a bad key is
  caught at entry, not in a classroom.
- The on-prem boundary is preserved as policy data: apps flagged
  `onprem_ai_only` (teacherAIde box, Beacon local mode) never receive
  cloud AI keys from Switchboard, only local-LLM endpoint config. This
  encodes, not replaces, teacherAIde's `assertNoExternalAI()` guard.

### 4.4 Distribution - how config reaches each app
Switchboard is inside the firewall; cloud functions cannot dial in. Three
mechanisms, per app, all outbound-or-local (FamilyGraph "Option A - no
open doors" precedent):

1. **Local pull** - on-prem apps (familygraph, teacherAIde server, beacon
   on-prem, missionIQ local) call Switchboard's LAN/loopback API with
   their scoped token: `GET /v1/config` returns their resolved config +
   credentials. Litmus's `inheritFrom` contract is the shape template:
   single-hop, cached, sanitized, any failure falls through to local
   defaults.
2. **Outbound push** - cloud apps with a server surface (parentpoint +
   teacherAIde-cloud shared backend, beacon cloud, campusops, litmus,
   sensibledebate once functions are re-enabled). Switchboard dials out
   and writes each app's **server-only config doc** - the exact shape
   Beacon already consumes (`platform_config/providers`, env-always-wins,
   client-unreadable, last-4 masking). Requires each Firebase project's
   service-account credential stored (encrypted) in Switchboard. Apps ack
   by version so the dashboard shows drift.
3. **Generated manual steps** - anything that only lives in a Netlify env
   var (owner ruling: keep Netlify simple). Switchboard renders exact,
   dummy-proof, copy-paste instructions per app ("Netlify → site X →
   Environment variables → set `ANTHROPIC_API_KEY` to: [shown once]"),
   and tracks the step as pending until the operator marks it done or the
   app's next check-in proves it.

Static no-backend apps (toots, mathtracker) get mechanism 2 into a
client-honored config doc (advisory enforcement - see per-app appendix)
plus mechanism 3 for build-time env.

### 4.5 Kill switches
- **Per-app disable:** flips the registry `enabled` flag, revokes the
  app's Switchboard token, pushes `enabled: false` to its config doc, and
  prints any residual manual steps. Apps that check at runtime (all
  on-prem apps; cloud apps with a backend - Beacon's `is_active` proves
  the pattern) stop on the next request.
- **EMERGENCY STOP:** the per-app disable applied to every governed app in
  one confirmed action, plus a generated incident checklist covering the
  unreachable surfaces. Big, guarded, audited.
- Failure posture when an app CANNOT reach Switchboard (fail open vs fail
  closed) is deliberately undecided - see §9. v1 implements fail-open for
  every app and carries the posture as a per-app field so the decision is
  a config change, not a rewrite.

### 4.6 Console + CLI
Dashboard (local web UI, FamilyGraph chassis style): status board, app
registry, credentials, AI policy, kill-switch page, audit log, per-app
"manual steps" queue. CLI mirror for the load-bearing verbs: `status`,
`issue-token <app>`, `disable <app>`, `emergency-stop`, `rotate
<credential>`, `deliveries`.

### 4.7 Auth
Vendored from FamilyGraph (code copied, not shared DB): master operator
token; per-app scoped bearer tokens (`sk_`-style, hashed at rest,
revocable, last-used tracked); optional staff accounts later. Loopback
bind by default; LAN bind is an explicit operator choice.

## 5. Business rules and logic

1. **No app may hard-require Switchboard** (standing portfolio rule,
   owner 2026-07-08). Token/config absent = the app runs standalone on
   its own local settings. MissionIQ's `FAMILYGRAPH_ENABLED=auto` is the
   reference behavior.
2. **Env always wins inside each app.** A locally-set env var overrides
   Switchboard-delivered config (Beacon precedent). This is the per-app
   escape hatch when the center is wrong.
3. **Single hop.** A served config never chains to another Switchboard
   (litmus rule - prevents loops).
4. **Secrets never leave the server tier.** No secret on any
   unauthenticated endpoint, in any client bundle, or in any log line.
   Retiring the `VITE_*` AI keys in parentpoint/teacherAIde-cloud is part
   of onboarding those apps - that is a hard requirement, not a nice-to-have.
5. **Config is versioned; delivery is acknowledged.** Every change bumps
   a version; the dashboard shows delivered-vs-acked per app; drift is
   visible, never silent.
6. **Rotation shows blast radius first.** Rotating a credential lists
   every consuming app and every manual step before the confirm button.
7. **Switchboard moves config and credentials only - never student or
   family data.** Identity stays FamilyGraph's job; content stays in the
   apps. The on-prem AI boundary (`onprem_ai_only` apps) is enforced at
   distribution time.
8. **Mandatory vs optional** exists as a per-app field from day one, but
   v1 treats every app as optional until the owner rules otherwise.

## 6. Data requirements

New SQLite database (FamilyGraph chassis: better-sqlite3, numbered
migrations, encrypted `_ct` columns, HMAC `_hash` columns, secret material
in a mode-0600 key file, `~/.switchboard/` home dir):

- `apps` - registry (id, name, adoption_mode, enabled, delivery_mode,
  onprem_ai_only, failure_posture, config_version, acked_version,
  last_seen_at).
- `app_tokens` - scoped bearer tokens per app (hashed, revocable).
- `credentials` - provider credentials (category, provider, field map
  with `_ct` secrets, last4, enabled) + `credential_consumers` join.
- `policies` - AI policy + any future portfolio-wide policy, versioned.
- `deliveries` - one row per push/pull/manual-step per version per app
  (status: pending/delivered/acked/failed/manual-pending/manual-done).
- `config_events` - append-only audit (actor, action, target, old→new
  with secrets masked, timestamp).
- `settings` - Switchboard's own operational settings.

Push targets additionally require: per-Firebase-project service-account
JSON (encrypted, category `integration`), per-app config-doc path.

## 7. Integrations and dependencies

**Code vendored in (copy, don't link - the portfolio's proven pattern):**
- FamilyGraph: server chassis, auth/scoped-token module, encrypted
  settings/credentials store, audit, logger+redactor, dashboard skeleton.
- missionIQ `server/services/aiProvider.js`: provider/model catalog and
  connection-test logic (as config metadata - Switchboard doesn't call
  providers in production paths, only for entry-time key tests).
- litmus `shared/admin/contract.js` + `functions/lib/adminConfig.js`: the
  pull-contract shape and resolver precedence (local → inherited → env →
  default).
- Beacon `provider-keys.js` receiving-doc shape as the push target spec.

**Per-app onboarding (the other half of the build)** - each app gets a
small change in its own repo to consume Switchboard. See Appendix A.

**Explicit non-dependencies:** no Netlify API, no Firebase project of its
own (SQLite local), no Anthropic/OpenAI SDKs in production paths.

## 8. Out of scope (v1)

- AI gateway/proxying of model calls (owner ruling: config only).
- Netlify API automation (owner ruling: paste-ready steps instead).
- Cross-app usage/billing aggregation dashboard (strong v2 candidate -
  parentpoint and beacon both meter usage already).
- Replacing any app's domain-level admin surfaces.
- Multi-school / multi-diocese federation of Switchboard itself.
- SSO between Switchboard and the apps' admin logins.
- Automated secret SCANNING or leak detection.
- Server-issued student sessions for toots/mathtracker (tracked in those
  repos; sequenced with onboarding, not part of Switchboard).

## 9. Open questions

1. **Kill-switch failure posture** (owner: "I don't yet know"). If an app
   can't reach Switchboard or its config doc: fail open (keep working) or
   fail closed (lock)? Likely per-app and tied to mandatory-vs-optional.
   v1 ships fail-open everywhere with the field in place.
2. **Which apps are mandatory** in a school deployment? Drives posture
   defaults and the onboarding pitch.
3. **Repo + product name.** `switchboard` is a placeholder.
4. **Mathtracker prerequisite fork:** Google-auth + ownerUid scoping vs
   teacher-issued code + family PIN (its audit C1/H7). Must be resolved
   before mathtracker can meaningfully honor central config.
5. **Relationship to B24** (the "shared platform backend gets its own
   home" note in parentpoint/beacon docs): is Switchboard that home's
   control plane only, or eventually its host? v1 assumes control plane
   only.
6. **Staff-admin delegation:** needed in v1, or operator-only until a
   second school exists?
7. **Integration-secret minting:** should Switchboard also MINT the
   pairwise HMAC secrets (today hand-generated and pasted on both sides)?
   Cheap to add; proposed yes, but confirming scope.

## 10. Success criteria

1. Operator enters one AI key in one place; every consuming app receives
   it within one delivery cycle; zero per-app dashboard visits except the
   generated Netlify steps.
2. Per-app disable takes effect in under a minute for every
   runtime-checking app; EMERGENCY STOP produces a complete, accurate
   manual-steps checklist for the rest.
3. Zero AI/provider secrets in any client bundle portfolio-wide
   (`VITE_*` AI keys retired), verified by grep in CI.
4. Every app still builds, runs, and demos with Switchboard absent.
5. The audit log answers who/what/when/delivered-where for any config
   change in one query.
6. A future Claude Code session can build Switchboard from this PRD plus
   the four vendored sources without this conversation.

---

## Logging infrastructure (required section)

- **Structured JSON logs** to `~/.switchboard/logs/server.log`, rotated,
  levels `info|warn|error`, one line per: config change, credential
  entry/rotation (values NEVER logged - provider + last4 only), token
  issue/revoke, delivery attempt/result per app, auth success/failure
  (with structured reason strings, FamilyGraph style), kill-switch
  action, emergency stop.
- **Redaction before disk** (vendor FamilyGraph's redactor + its parity
  test): credential values, tokens, service-account JSON, and PII can
  never land in a log line.
- **`config_events` audit table** is the queryable twin of the log -
  append-only, masked old→new values, actor attribution.
- **Operator debug path:** a Diagnostics view with Copy log / Download
  log (the portfolio-standard "paste a few lines into a Claude Code
  session" loop), plus `switchboard status --verbose` for the CLI.
- **Per-app delivery logs** retained long enough to answer "did app X
  ever receive version N" (default 180 days, configurable).

---

## Appendix A - Per-app onboarding map (all ten in scope)

| App | Posture | Delivery | What moves to Switchboard | App-side work | Notes / prerequisites |
|---|---|---|---|---|---|
| familygraph | on-prem service | local pull | its FACTS/Ministry Platform connector creds optionally; registry membership; kill switch | small: config-pull client + enabled check | Becomes a governed app; identity remains its own job |
| missionIQ | local Node+SQLite | local pull | `ai_provider`/`ai_model`/`ai_api_key`, Serper key, `donor_research_enabled` default | small: point `getAiSettings()` precedence at pull client | Closest existing code to the contract; `FAMILYGRAPH_ENABLED=auto` is the adoption template |
| teacherAIde (on-prem box) | Express+SQLite, no inbound | local pull | `TEACHERAIDE_LOCAL_LLM_*` endpoint config; ingest secret; enabled flag | small: env-wins pull client | `onprem_ai_only` - never receives cloud AI keys; `assertNoExternalAI()` untouched |
| beacon | Netlify+Firebase, dual-mode | push (cloud) + local pull (on-prem) | contents of `platform_config/providers` (AI keys, local-LLM, ParentPoint token) | small: it already reads the target doc shape | The reference implementation for the receiving side |
| parentpoint + teacherAIde-cloud | Netlify+Firebase multi-tenant (shared backend) | push + manual steps | platform `ANTHROPIC_API_KEY` handling, integration secrets, AI governance defaults | medium: add server-only platform config doc read; RETIRE `VITE_*` AI keys and client-direct AI calls | The `VITE_*` retirement is a security fix in its own right |
| campusops | Netlify+Firebase functions | push + manual steps | SendGrid/Twilio keys; enabled flag honored in functions | small-medium: platform config doc read in `config.js` | No AI; proves the tier is not AI-only |
| litmus | Firebase functions + hosting | pull via existing `inheritFrom` → Switchboard's published endpoint; manual steps for its Firebase secret | model/effort/rate-limit policy; enabled flag | tiny: point `inheritFrom` at Switchboard | Its contract is the wire-format template; key stays a Firebase secret in v1 |
| sensibledebate | Netlify static, functions parked | push-ready + manual steps | `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` at functions re-enable; enabled flag | small, deferred until functions unpark | Register now, activate at unpark |
| toots | Netlify static, no backend | client-honored config doc + manual steps | enabled flag (advisory), future feed secrets | small: read config doc at boot, honor `enabled` | Advisory enforcement only until it grows a server seam |
| mathtracker | Netlify static, no backend | client-honored config doc + manual steps | enabled flag (advisory) | blocked on its identity/security fork (Open Q4) | Onboarding and the security fix are one project |

*Advisory enforcement* means a client-side check that a well-behaved build
honors - real enforcement for no-backend apps arrives when they gain a
server seam (already on toots's roadmap via server-issued student
sessions).

## Appendix B - What was deliberately NOT chosen

- **Hosting the tier inside FamilyGraph** - rejected by owner
  (2026-07-18): new codebase, own repo. FamilyGraph's code is vendored,
  not extended.
- **AI gateway** - rejected by owner: config only.
- **Netlify API automation** - rejected by owner: keep Netlify simple.
- **Shared library instead of a service** - rejected by precedent: the
  identity extraction already chose service-with-contract over shared
  library ("tight coupling; failures cascade"), and the portfolio spans
  runtimes where a JS library can't reach (on-prem boxes, parked
  functions, static builds).
