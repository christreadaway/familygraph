# Switchboard - Central Admin Tier PRD (v1)

**Status:** Draft for owner review. No code exists yet. This is the single
document the console AND every app's onboarding are built against.
**Home:** DEFERRED (see §9 Q9). The console may live in a new standalone
repo (working name: `switchboard`) OR inside familygraph as a new scoped
surface - a later decision. This PRD is written host-agnostic: nothing in
the contract or the apps changes based on where the console runs. Parked in
the familygraph repo for now. Follows the extraction pattern in
`ARCHITECTURE_MEMO_FAMILY_MANAGEMENT.md`.

**This PRD specifies TWO deliverables that share one contract:**
1. **The console** - a local admin service where the operator administers
   the whole portfolio.
2. **The admin-contract module** - one small, versioned file (schema +
   resolver + enrollment handshake) vendored byte-for-byte into every app,
   so all ten apps speak the same language. This is the thing that keeps
   the portfolio consistent; the console is just one end of it.

**Owner decisions already made (2026-07-18):**
1. All ten portfolio apps are in scope.
2. **Config-and-credentials only** - Switchboard is NEVER in the AI request
   path (no gateway/proxy). Apps make their own model calls with keys the
   console distributed.
3. **Dual-mode, per app** - every app can run *enrolled* (managed by the
   console) OR *standalone* (its own local admin, today's behavior). The
   mode is a per-app setting, stored locally, flipped by the operator.
4. **Keep Netlify simple** - no Netlify API automation; env-var changes
   ship as generated paste-ready instructions.
5. **Consistent admin look-and-feel across apps** - each app keeps an admin
   surface showing the functions relevant to it, drawn from one shared
   design/component kit so it looks and behaves the same everywhere, and
   maintained centrally through the contract rather than diverging per repo.

**Explicitly undecided:** (a) where the console lives - a new repo or inside
familygraph (§9 Q9); (b) kill-switch failure posture (§9 Q1). Both are later
decisions; the PRD is written so neither blocks building the contract.

---

## 1. What this is

Switchboard is a single tech-administration console, running as a local
service inside the school's firewall, where the operator administers the
whole app portfolio once: enter and rotate provider credentials (AI,
email, SMS, payments, search), choose the AI provider and model, turn each
app's access on or off, and act fast in an emergency - without hopping app
to app.

Every app keeps its own local admin. Enrolling an app in Switchboard makes
it *defer* its tech-admin settings to the console; unenrolling returns it
to standalone. Nothing forces an app to enroll, and an enrolled app whose
console is unreachable keeps running on the last config it received.

**What "tech administration" means here (the slice Switchboard governs):**
provider credentials, AI provider/model policy, and each app's access
on/off + kill switch. **NOT** domain administration - lunch settings,
schedules, rosters, moderation queues, gradebooks stay local to each app,
always, in both modes. Enrolling never takes a principal's own screens
away.

## 2. Who it's for

- **The operator** (school/parish tech admin - today, the owner). Single
  primary user, same posture as FamilyGraph's operator.
- **Named staff admins** (future, v1-optional): scoped delegated access via
  FamilyGraph's invite-only magic-link pattern.
- **The apps** are machine consumers: enrolled apps receive resolved config
  and credentials and report status back.

Not for: principals, teachers, parents. They use each app's own domain
admin.

## 3. User stories / jobs to be done

1. As the operator, I enter my Anthropic key ONCE and every enrolled app
   that uses AI receives it - I never paste a key into six dashboards.
2. As the operator, I switch the portfolio's default AI provider or model
   in one screen and every enrolled app follows.
3. As the operator, I enroll an app by pasting the console URL + an
   enrollment token into that app's local admin - and from then on its
   tech-admin screens show the centrally-managed values, read-only.
4. As the operator, I unenroll an app and it returns to its own local
   admin with no data loss - it was standalone before, it's standalone
   again.
5. As the operator, I click "disable app" on any enrolled app and its
   access stops fast enough to matter in an incident.
6. As the operator, I hit one EMERGENCY STOP and every enrolled app is
   disabled, every distributed credential is revoked or flagged, and I get
   a checklist of the few manual steps automation can't reach.
7. As the operator, I rotate a leaked key; the console re-distributes it to
   every enrolled consumer automatically where it can, and prints exact
   paste-ready steps where it can't (Netlify env vars).
8. As the operator, I see one status board: every app, enrolled or
   standalone, connected or not, config version delivered vs acknowledged,
   last check-in, what credentials it consumes.
9. As an app author, I make my app enrollable by vendoring one contract
   module, calling one resolver, and adding three facts to my repo's docs.

## 4. Core features

### 4.1 The shared admin contract (the spine)
One small, versioned module, authored once in the Switchboard repo and
**vendored byte-for-byte into every app** (the litmus/desloppify
`shared/admin/contract.js` + `SYNC.md` pattern - never hand-edited in a
copy). It is the single source of truth; the console and every app both
build against it. It defines:

- **Config schema** (`schemaVersion`, provider selections, per-app flags,
  masked-credential references) - the shape of what an app receives.
- **The resolver** - one function every app calls to get its effective
  config. Precedence, highest wins:
  `local env var → central (if enrolled) → local admin setting → baked default`.
  Env always wins (per-app escape hatch, Beacon precedent); a served
  central config never carries its own `inheritFrom` (single hop, litmus
  rule - no chains or loops).
- **The enrollment handshake** - `{ consoleUrl, enrollmentToken }` in →
  scoped app token + first config out. Stored locally so the app always
  knows its own mode without the network.
- **The check-in/ack shape** - what an enrolled app reports back (acked
  config version, health, which credentials it holds by reference) so the
  console can show delivered-vs-acked drift.
- **The log-redaction rule** - what an app may never write to disk
  (credential values, tokens), so the boundary is enforced identically
  everywhere.

Because the resolver is the same code in all ten apps, dual-mode is not
ten interpretations of a paragraph - it is one function whose "am I
enrolled" branch picks the source. That is what makes the whole portfolio
consistent.

### 4.2 Dual-mode resolution
Every app is either **enrolled** or **standalone**, per the mode stored
locally at enrollment.

- **Standalone** = today's behavior unchanged. The app's local tech-admin
  screens are fully editable; it never calls the console.
- **Enrolled** = the app resolves its tech-admin config through the
  contract (4.1). Its local tech-admin fields render **read-only**,
  showing the centrally-managed value with a "managed by Switchboard"
  label - never editable-but-ignored (the split-brain trap). The env
  override still applies as the deliberate local escape hatch.
- **Granularity (v1): all-or-nothing per app.** Enrolling defers the whole
  tech-admin slice, not individual settings. Per-category enrollment
  ("central owns my AI keys but I keep my own kill switch") is a v2
  refinement, noted in §9.
- **Mode changes are local and reversible.** Enroll and unenroll are
  operator actions in the app's own admin; neither destroys local
  settings.

### 4.3 App registry (console side)
One row per governed app; all ten registered at launch (teacherAIde's
on-prem box and cloud app are separate entries). Per app: display name,
repo, mode (enrolled/standalone), enabled flag, delivery mechanism (4.6),
scoped token, `onprem_ai_only` flag, failure posture (§9 Q1), config
version delivered vs acked, last check-in, notes.

### 4.4 Provider credential registry
General-purpose, not AI-only (CampusOps has no AI but holds SendGrid +
Twilio keys). Categories: `ai`, `email`, `sms`, `payments`, `search`,
`integration`. Launch inventory: Anthropic / OpenAI / Google AI /
OpenRouter / Groq keys and on-prem LLM endpoint config; Postmark, SendGrid;
Twilio SID/token/from; Stripe secret + webhook secrets; Serper.dev;
and the pairwise HMAC integration secrets (`TEACHERAIDE_INGEST_SECRET`,
`BEACON_FEED_SECRET`/`PARENTPOINT_TOKEN`) that today are hand-pasted on
both sides.

Behavior (each already proven somewhere in the portfolio): encrypted at
rest (FamilyGraph `_ct`), never echoed after entry (masked to last-4,
Beacon `provider-keys`), blank-on-edit preserves existing (missionIQ
settings), every read/write audited. Each credential tracks its consuming
apps, so rotation shows blast radius before you confirm.

### 4.5 AI policy (config only)
The console chooses and distributes; apps call providers themselves.
- Portfolio default provider + default model per provider (field model
  vendored from `missionIQ/server/services/aiProvider.js`).
- Allowed-provider list + per-app overrides (field model from ParentPoint's
  `SuperadminAiGovernance`); cost-cap fields carried as pass-through config
  for apps that implement caps.
- Connection test at key entry (vendored from missionIQ) - a bad key is
  caught at entry, not in a classroom. This is the ONLY place Switchboard
  ever calls a provider, and never in a production request path.
- **On-prem boundary as policy:** apps flagged `onprem_ai_only`
  (teacherAIde box, Beacon local mode) never receive cloud AI keys - only
  local-LLM endpoint config. This encodes, not replaces, teacherAIde's
  `assertNoExternalAI()` guard.

### 4.6 Distribution - how an enrolled app receives central config
Switchboard is inside the firewall; nothing dials in. Three mechanisms,
per app, all outbound-or-local (FamilyGraph "Option A - no open doors"):

1. **Local pull** - on-prem apps (familygraph, teacherAIde server, beacon
   on-prem, missionIQ local) call the console's LAN/loopback API with their
   scoped token via the contract resolver.
2. **Outbound push** - cloud apps with a server surface (parentpoint +
   teacherAIde-cloud shared backend, beacon cloud, campusops, litmus,
   sensibledebate once functions re-enable). The console dials out over
   ordinary HTTPS and writes each app's **server-only config doc** - the
   shape Beacon already consumes (`platform_config/providers`,
   env-always-wins, client-unreadable, last-4 masking). Requires each
   Firebase project's service-account credential stored (encrypted) in the
   console. Apps ack by version.
3. **Generated manual steps** - anything that lives only in a Netlify env
   var. The console renders exact dummy-proof copy-paste instructions and
   tracks the step as pending until marked done or proven by check-in.

Static no-backend apps (toots, mathtracker) get mechanism 2 into a
client-honored config doc (advisory enforcement) plus mechanism 3 for
build-time env. See Appendix A.

### 4.7 Kill switches
- **Per-app disable:** flips the registry `enabled` flag, revokes the app's
  token, pushes `enabled: false` to its config doc, prints residual manual
  steps. Runtime-checking apps stop on the next request (Beacon's
  `is_active` is the proof).
- **EMERGENCY STOP:** per-app disable applied to every enrolled app in one
  confirmed action, plus a generated incident checklist for unreachable
  surfaces. Big, guarded, audited.
- **Failure posture** when an enrolled app cannot reach the console (fail
  open vs fail closed) is undecided (§9 Q1). v1 ships fail-open everywhere,
  with posture as a per-app field so the decision is later config, not a
  rewrite.

### 4.8 Console + CLI
Dashboard (local web UI, FamilyGraph chassis style): status board,
registry, credentials, AI policy, kill-switch page, audit log, per-app
manual-steps queue. CLI mirror for load-bearing verbs: `status`,
`enroll <app>` / `issue-token <app>`, `disable <app>`, `emergency-stop`,
`rotate <credential>`, `deliveries`.

### 4.9 Shared admin look-and-feel (per-app relevant, centrally maintained)
Each app keeps its OWN admin surface - but it should look and behave the
same across the portfolio, showing only the functions relevant to that app.
This is the UI companion to the contract (4.1): the same way the config
schema is vendored so apps speak one language, a small **shared admin UI
kit** (design tokens + a few components: credential field with last-4 mask,
"managed by Switchboard" read-only state, enrollment panel, kill-switch
control) is vendored so apps present one language. The portfolio already
shares design tokens (Sensible Debate → toots inherited `tokens.css`/
`sd.css`; familygraph's `design-handoff`), so this extends an existing
habit rather than inventing one.

- **Relevant, not uniform.** CampusOps shows email/SMS credential fields and
  no AI policy; Beacon shows AI + on-prem LLM; litmus shows model/effort.
  The kit renders the subset each app declares, from one component set.
- **Centrally maintained, locally rendered.** The kit is versioned and
  SYNC-tracked like the contract module; a fix to the read-only state or
  the mask ships once and every app inherits it on the next vendor-sync.
- **Both modes use the same components** - enrolled renders them read-only
  with the managed label; standalone renders them editable. One code path,
  two states.

### 4.10 Auth
Vendored from FamilyGraph (copied, not shared DB): master operator token;
per-app scoped bearer tokens (`sk_`-style, hashed at rest, revocable,
last-used tracked); optional staff accounts later. Loopback bind by
default; LAN bind is an explicit operator choice.

## 5. Business rules and logic

1. **No app may hard-require Switchboard** (standing rule, owner
   2026-07-08). Absent enrollment = standalone. MissionIQ's
   `FAMILYGRAPH_ENABLED=auto` is the reference behavior.
2. **Env always wins inside each app** - the per-app escape hatch when the
   center is wrong (Beacon precedent).
3. **Single hop** - a served config never chains to another console
   (litmus rule).
4. **Enrolled ⇒ local tech-admin is read-only** - shown, labeled, not
   editable-but-ignored.
5. **Secrets never leave the server tier** - no secret on any
   unauthenticated endpoint, in any client bundle, or in any log line.
   Retiring the `VITE_*` AI keys in parentpoint/teacherAIde-cloud is a hard
   requirement of onboarding those apps, not a nice-to-have.
6. **Config is versioned; delivery is acknowledged** - delivered-vs-acked
   visible per app; drift is never silent.
7. **Rotation shows blast radius first** - every consuming app and manual
   step listed before confirm.
8. **Switchboard moves config and credentials only - never student or
   family data.** Identity stays FamilyGraph's; content stays in the apps.
9. **Mandatory vs optional** exists as a per-app field from day one; v1
   treats every app as optional until the owner rules otherwise.

## 6. Data requirements

New SQLite DB (FamilyGraph chassis: better-sqlite3, numbered migrations,
encrypted `_ct` columns, HMAC `_hash` columns, mode-0600 key file,
`~/.switchboard/` home):

- `apps` - registry (id, name, mode, enabled, delivery_mode,
  onprem_ai_only, failure_posture, config_version, acked_version,
  last_seen_at).
- `app_tokens` - scoped bearer tokens (hashed, revocable).
- `credentials` - provider credentials (category, provider, field map with
  `_ct` secrets, last4, enabled) + `credential_consumers` join.
- `policies` - AI policy + future portfolio-wide policy, versioned.
- `deliveries` - one row per push/pull/manual-step per version per app
  (status: pending/delivered/acked/failed/manual-pending/manual-done).
- `config_events` - append-only audit (actor, action, target, masked
  old→new, timestamp).
- `settings` - the console's own operational settings.

Push targets also need: per-Firebase-project service-account JSON
(encrypted, category `integration`), per-app config-doc path.

## 7. Integrations and dependencies

**Code vendored in (copy, don't link):**
- FamilyGraph: server chassis, scoped-token auth, encrypted
  settings/credentials store, audit, logger + redactor + parity test,
  dashboard skeleton.
- missionIQ `aiProvider.js`: provider/model catalog + connection-test
  (used only at key entry, never in production paths).
- litmus `shared/admin/contract.js` + `functions/lib/adminConfig.js`: the
  contract shape and resolver precedence - the seed for §4.1.
- Beacon `provider-keys.js` receiving-doc shape: the push-target spec.

**The other half of the build - per-app onboarding.** Each app vendors the
contract module (§4.1), calls the resolver, and adds its three facts
(config-doc path, default posture, `onprem_ai_only`) to its own docs. See
Appendix A. **Sequencing: build the contract, prove it on ONE app
(beacon or missionIQ - closest to the shape), then propagate.** Do not fan
out to ten repos before the contract survives one real app.

**Explicit non-dependencies:** no Netlify API, no Firebase project of its
own, no Anthropic/OpenAI SDKs in production paths.

## 8. Out of scope (v1)

- AI gateway/proxying of model calls (owner: config only).
- Netlify API automation (owner: paste-ready steps).
- Per-category enrollment (v2; v1 is all-or-nothing per app).
- Cross-app usage/billing aggregation dashboard (strong v2 - parentpoint
  and beacon already meter usage).
- Replacing any app's domain-level admin.
- Multi-school federation of the console itself; SSO between console and
  apps; automated secret leak-scanning.
- Server-issued student sessions for toots/mathtracker (tracked in those
  repos; sequenced with onboarding).

## 9. Open questions

1. **Kill-switch failure posture** (owner: "I don't yet know"). Enrolled
   app can't reach the console: fail open (keep working) or fail closed
   (lock)? Likely per-app, tied to mandatory-vs-optional. v1 ships
   fail-open with the field in place.
2. **Which apps are mandatory** in a deployment? Drives posture defaults.
3. **Repo + product name** - `switchboard` is a placeholder.
4. **Per-category enrollment** - worth building in v1, or is all-or-nothing
   per app enough until a school asks?
5. **Mathtracker prerequisite fork** - Google-auth + ownerUid vs
   teacher-code + family PIN (its audit C1/H7). Must resolve before
   mathtracker can meaningfully honor central config.
6. **Relationship to B24** (the "shared backend gets its own home" note in
   parentpoint/beacon docs): is Switchboard that home's control plane only,
   or eventually its host? v1 assumes control plane only.
7. **Staff-admin delegation** - v1, or operator-only until a second school
   exists?
8. **Integration-secret minting** - should the console also MINT the
   pairwise HMAC secrets (today hand-generated on both sides)? Proposed
   yes; cheap to add.
9. **Where the console lives** (owner: defer) - a new standalone repo
   (`switchboard`) or a new scoped surface inside familygraph. The contract
   (§4.1), the apps' onboarding, and the UI kit (§4.9) are identical either
   way, so this decision can wait until the contract is proven on the first
   app. Trade-off in brief: a new repo keeps familygraph purely
   identity-focused and lets the console have its own release cadence;
   hosting inside familygraph reuses its chassis, auth, and operator
   dashboard directly with nothing to vendor. Decide after the first proof
   app, not before.

## 10. Success criteria

1. Operator enters one AI key in one place; every enrolled consumer
   receives it within one delivery cycle; zero per-app dashboard visits
   except generated Netlify steps.
2. Enrolling/unenrolling an app is a local action with no data loss;
   enrolled apps show central values read-only.
3. Per-app disable takes effect under a minute for every runtime-checking
   app; EMERGENCY STOP produces a complete, accurate manual-steps
   checklist for the rest.
4. Zero AI/provider secrets in any client bundle portfolio-wide (`VITE_*`
   AI keys retired), verified by grep in CI.
5. Every app still builds, runs, and demos with Switchboard absent.
6. The audit log answers who/what/when/delivered-where for any config
   change in one query.
7. A future Claude Code session can build the console AND onboard any app
   from this PRD plus the four vendored sources, without this conversation.

---

## Logging infrastructure (required section)

- **Structured JSON logs** to `~/.switchboard/logs/server.log`, rotated,
  levels `info|warn|error`, one line per: config change, credential
  entry/rotation (provider + last4 only, never the value), token
  issue/revoke, enroll/unenroll, delivery attempt/result per app, auth
  success/failure (structured reason strings, FamilyGraph style),
  kill-switch action, emergency stop.
- **Redaction before disk** (vendor FamilyGraph's redactor + parity test):
  credential values, tokens, service-account JSON, PII can never land in a
  log line. The same redaction rule ships in the contract module (§4.1) so
  every enrolled app enforces it identically.
- **`config_events` audit table** - queryable twin of the log, append-only,
  masked old→new, actor attribution.
- **Operator debug path** - Diagnostics view with Copy log / Download log
  (the portfolio-standard "paste into a Claude Code session" loop) +
  `switchboard status --verbose`.
- **Per-app delivery logs** retained long enough to answer "did app X ever
  receive version N" (default 180 days, configurable).

---

## Appendix A - Per-app onboarding map (all ten in scope)

| App | Posture | Delivery | What moves to console | App-side work | Prerequisites / notes |
|---|---|---|---|---|---|
| familygraph | on-prem service | local pull | connector creds (optional); registry membership; kill switch | small: vendor contract + resolver + enabled check | Becomes a governed app; identity stays its own job |
| missionIQ | local Node+SQLite | local pull | `ai_provider`/`ai_model`/`ai_api_key`, Serper key, `donor_research_enabled` | small: point `getAiSettings()` precedence at resolver | Closest existing code; a good first proof app |
| teacherAIde (on-prem box) | Express+SQLite, no inbound | local pull | local-LLM endpoint config; ingest secret; enabled flag | small: env-wins resolver | `onprem_ai_only` - never gets cloud AI keys; `assertNoExternalAI()` untouched |
| beacon | Netlify+Firebase, dual | push (cloud) + pull (on-prem) | contents of `platform_config/providers` | small: already reads the target doc shape | Reference receiving side; a good first proof app |
| parentpoint + teacherAIde-cloud | Netlify+Firebase multi-tenant (shared backend) | push + manual | platform AI key handling, integration secrets, AI-governance defaults | medium: add server-only config-doc read; RETIRE `VITE_*` AI keys + client-direct calls | The `VITE_*` retirement is a security fix in its own right |
| campusops | Netlify+Firebase functions | push + manual | SendGrid/Twilio keys; enabled flag | small-medium: config-doc read in `config.js` | No AI - proves the tier isn't AI-only |
| litmus | Firebase functions + hosting | pull via existing `inheritFrom` → console endpoint; manual for its secret | model/effort/rate-limit; enabled flag | tiny: point `inheritFrom` at the console | Its contract is the wire template; key stays a Firebase secret in v1 |
| sensibledebate | Netlify static, functions parked | push-ready + manual | `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` at re-enable; enabled flag | small, deferred to unpark | Register now, activate at unpark |
| toots | Netlify static, no backend | client-honored doc + manual | enabled flag (advisory); future feed secrets | small: read config doc at boot, honor `enabled` | Advisory only until it grows a server seam (on its roadmap) |
| mathtracker | Netlify static, no backend | client-honored doc + manual | enabled flag (advisory) | blocked on identity/security fork (§9 Q5) | Onboarding and the security fix are one project |

*Advisory enforcement* = a client-side check a well-behaved build honors;
real enforcement for no-backend apps arrives when they gain a server seam.

## Appendix B - What was deliberately NOT chosen

- **AI gateway** - rejected by owner: config only.
- **Netlify API automation** - rejected by owner: keep Netlify simple.
- **Console reachable from the internet** - not required: the console dials
  out; nothing dials in. An internet-reachable home becomes a hosting
  decision only if the operator wants to act from outside the building -
  the contract is unchanged either way.
- **Ten hand-written integrations** - rejected: one vendored contract
  module (§4.1), copied and SYNC-tracked, is how the portfolio already
  keeps litmus/desloppify and the rearchitecture memo consistent.
- **Shared library instead of a service** - rejected by precedent: identity
  extraction already chose service-with-contract over shared library, and
  the portfolio spans runtimes a JS library can't reach (on-prem boxes,
  parked functions, static builds). The vendored *contract* is a thin
  shared module; the console is the service.
