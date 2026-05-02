# Family Graph — Live API Connectors PRD

**Adding scheduled, credential-based ingest from FACTS SIS and Ministry Platform alongside the existing file-based source handlers.**

---

| | |
|---|---|
| **Status** | Draft v1 — for Claude Code execution |
| **Targets** | `christreadaway/familygraph` repo, `main` branch |
| **Companion docs** | `product_spec.md`, `business_spec.md`, `ARCHITECTURE_MEMO_FAMILY_MANAGEMENT.md` |
| **Owner** | Chris Treadaway |
| **Stack constraints** | Node.js 20+, Express, better-sqlite3, React 18 / Vite — no new languages, no new runtimes |

---

## 1. What this is

A pair of **live API connectors** for Family Graph that pull family/person/contact data directly from FACTS SIS (school) and Ministry Platform (parish) on a schedule, using credentials managed in the operator dashboard. Every record returned by a connector flows through the existing `identity/import.importRow` pipeline — same resolver, same conflict queue, same audit trail. Nothing about Family Graph's identity contract changes; this PRD only adds two new data sources alongside the existing CSV / Excel / Google Sheets / folder-watch paths.

---

## 2. Who it's for

| Role | What they get |
|---|---|
| **St. Theresa operator (initial)** | One-time credential entry per system. Daily automatic sync. No more uploading CSVs from FACTS or Ministry Platform. |
| **Future Catholic school + parish operators** | Same connector framework, configured for their own FACTS / Ministry Platform tenants. |
| **Sibling apps (MissionIQ, ParentPoint)** | No change. They still call `/api/identity/match` and `/api/identity/resolve`. They benefit because Family Graph's ledger is now fresh. |

---

## 3. User stories / jobs to be done

1. As the operator, I want to enter my FACTS API credentials once in Family Graph and have it pull rosters automatically every night, so I never have to export a CSV from FACTS again.
2. As the operator, I want to enter my Ministry Platform credentials once and have parishioner records sync automatically, so the same family appearing in both systems is reconciled to one Family Graph code.
3. As the operator, I want to manually trigger a connector sync from the dashboard (in addition to the schedule), so I can pull the latest data right before generating a report.
4. As the operator, I want to see when a connector last ran, what it pulled, and whether it errored — in the same Imports log I already use for file-based imports.
5. As the operator, I want connectors that fail loudly without taking the rest of Family Graph down, so a bad credential or a network hiccup doesn't break my dashboard.
6. As the operator, I want to be able to disable a connector temporarily without deleting the credentials, for testing or troubleshooting.

---

## 4. Core features (what the user sees and does)

### 4.1 Settings → Connectors panel (new dashboard route)

A new route at `/settings/connectors` (also reachable via the existing Settings sidebar entry). The panel lists every supported connector. v1 ships two:

- **FACTS SIS** — fields: API Base URL, Client ID, Client Secret, Access Token URL (OAuth 2.0 endpoint), enable/disable toggle, schedule selector (Off / Hourly / Daily at 2 AM / Weekly Sunday at 2 AM).
- **Ministry Platform** — fields: API Base URL (e.g., `https://my.parish.org/ministryplatformapi/`), Client ID, Client Secret, OAuth Discovery URL, enable/disable toggle, schedule selector (same options).

For each connector, the panel shows:

- Connection status: `untested` / `ok` / `error: <reason>`
- Last successful sync timestamp (whether via API or file)
- Last attempted sync timestamp + outcome
- A **Test connection** button (validates credentials, pulls a single sample row, does not write anything)
- A **Run sync now** button (triggers a full sync immediately, writes to the ledger)
- A **Disable** toggle (stops the schedule without deleting credentials)
- A **Delete credentials** button (red, with a confirm modal)

Credentials are stored encrypted in the existing `settings` table using the existing `dataKey`. The plaintext is never returned by `GET /api/settings`; the field shows `••••••••` when set, and the operator types fresh values to update.

### 4.1.1 Coexistence with file-based ingest (API and files are co-equal)

API connectors and file-based ingest are **never mutually exclusive**. The operator can use either one, both, or switch between them at any time without losing data, history, or identity continuity. This is a hard product rule.

Concretely:

- A connector being enabled does NOT disable the existing file-upload, paste-CSV, Google Sheets, or folder-watch paths for the same source. All paths remain available simultaneously. If FACTS goes down, the operator can drop a CSV into `~/.family-graph/watch` and the import flows through the same pipeline with no friction.
- Each ingest path tags its rows so the operator can tell them apart. `import_runs.source` already distinguishes `facts` (CSV) from `facts_api` (live connector), and `ministry_platform` (CSV) from `ministry_platform_api` (live connector). Records produced by either path get the same provenance treatment.
- The dashboard's connector panel surfaces the most recent successful sync **regardless of how it happened**. A connector card for FACTS shows "Last sync: 2026-05-15 02:01 UTC (API, scheduled)" or "Last sync: 2026-05-14 14:32 UTC (file upload, manual)" — same row, same field, different annotation.
- Switching from one path to the other is a no-op operationally. The operator does not need to "migrate" anything. Identity codes are stable across sources because the resolver runs on every row regardless of where it came from.
- The connector setup help text explicitly tells the operator: "You can use the API, drop files in the watch folder, or upload through the dashboard. Pick what works for you on any given day. Family Graph treats them all the same."

This matters because real-world Catholic schools and parishes don't always have IT staff available to maintain API credentials, and credentials sometimes break (FACTS rotates a secret, MP staff changes the API client). The file path must always be a viable fallback, not a deprecated leftover.

### 4.2 Imports log integration

Connector runs appear in the existing `/imports` log alongside file-based imports, distinguished by:

- A `source` field set to `facts_api` or `ministry_platform_api` (sits next to the existing `facts`, `renweb`, `ministry_platform`, `csv`, `excel`, `google_sheets` source values).
- A `trigger` field set to `scheduled` or `manual` so the operator can tell at a glance whether a sync was automatic.
- Same totals as file-based imports: families created/attached, persons created/attached/enqueued, conflicts opened, addresses/emails/phones attached, rows skipped.

Clicking a connector run opens the same per-import detail view, listing every family and person the run produced.

### 4.3 Dashboard status rail integration

The status rail (already present on every screen) gains two small posture indicators when connectors are configured:

- A green dot if the most recent scheduled sync for each connector succeeded
- A red dot if the most recent sync errored, with hover text showing the reason

Connectors that aren't configured at all are not shown in the rail.

### 4.4 CLI commands (operator escape hatch)

Three new CLI commands for headless operation and debugging:

- `node bin/family-graph.js connector test <name>` — runs the test-connection flow for `facts` or `ministry_platform`
- `node bin/family-graph.js connector sync <name>` — runs a full sync immediately
- `node bin/family-graph.js connector status` — prints last-run timestamps and outcomes for all configured connectors

---

## 5. Business rules and logic

### 5.1 Credential storage

- Credentials are stored as encrypted ciphertext in `settings`, keyed by `connector.facts.client_id`, `connector.facts.client_secret_ct`, `connector.facts.api_base_url`, etc. Same `_ct` suffix convention already in use elsewhere in the codebase.
- The `_ct` columns use the existing `encryptString` / `decryptString` helpers backed by `dataKey`. No new keys are introduced.
- `GET /api/settings` returns `{ ..., connector_facts_client_id_set: true, connector_facts_client_secret_set: true, ... }` flags, never the plaintext values. The dashboard renders `••••••••` for set fields.
- A new endpoint `POST /api/connectors/:name/credentials` accepts plaintext credentials, encrypts them, writes to `settings`, and returns no plaintext.
- A new endpoint `DELETE /api/connectors/:name/credentials` removes the credentials and disables the connector.

### 5.2 Authentication flows

- **FACTS:** OAuth 2.0 client credentials grant. Connector POSTs to the configured Access Token URL with Client ID + Secret, receives a Bearer token, uses it on every OneRoster API call. Token cached in memory for its TTL minus a 60s safety window. On 401, token is invalidated and re-fetched once before the call is treated as failed.
- **Ministry Platform:** OAuth 2.0 client credentials grant against MP's OIDC discovery endpoint. Same caching pattern. The MP convention is to also include the `ministry_platform.openid` scope; connector requests that explicitly.

### 5.3 What gets pulled

**FACTS (OneRoster v1.1 endpoints):**
- `/orgs` — for institution context
- `/users?role=student` — students
- `/users?role=teacher` — teachers (only when teacher = parent/guardian, optional in v1)
- `/users?role=parent` — parents/guardians
- `/enrollments` — to associate students with classes
- Each pull uses `?filter=dateLastModified>'<last_sync_iso>'` for incremental syncs after the first run. First run is a full pull.

**Ministry Platform (REST API):**
- `Households` table — base family records (`Household_ID`, `Household_Name`, `Address_ID`, etc.)
- `Contacts` table — individuals (`Contact_ID`, `First_Name`, `Last_Name`, `Email_Address`, `Mobile_Phone`, `Date_of_Birth`, `Household_ID`, `Household_Position_ID`)
- `Addresses` table — joined via `Address_ID`
- After the first run, queries use the existing `filter` syntax: `Contacts.Date_Modified > 'YYYY-MM-DDTHH:MM:SS'`

### 5.4 Mapping to canonical shape

Each connector outputs records in the same `{ family, persons[], address }` canonical shape that the existing `sources/*.js` handlers produce, so they can flow straight into `identity/import.importRow` without changes to the import pipeline.

The canonical mapping is implemented inside the connector module (`server/connectors/facts.js`, `server/connectors/ministry-platform.js`) and reuses the existing source-handler logic as much as possible:

- FACTS API connector reuses field mappings from `server/sources/facts.js` (the existing CSV handler). Extracted to a shared helper if needed.
- Ministry Platform API connector reuses field mappings from `server/sources/ministry-platform.js`. Same extraction pattern.

### 5.5 Source tagging

Every connector run writes one `import_runs` row tagged with:

- `source` = `facts_api` or `ministry_platform_api`
- `category` = `school` (FACTS) or `church` (MP) — set automatically, not operator-supplied
- `tags` = `[connector, scheduled]` or `[connector, manual]`
- `source_ref` = the connector run timestamp + a UUID for traceability

### 5.6 Identity resolution behavior

No change to the existing resolver. Every row goes through `identity/import.importRow` regardless of source. Auto-merges happen when confidence ≥ threshold; conflicts get enqueued; new families/persons are created when there's no match. Sticky non-match decisions still apply.

**Cross-system resolution is allowed but never silent.** The "Treadaway family is enrolled at the school AND registered at the parish" case is the architectural payoff of having both connectors flow through one resolver — but it must be accurate, not aggressive. Three rules govern this:

1. **Auto-merge across sources requires the same evidence as auto-merge within a source.** A family appearing in both FACTS and MP only auto-merges to one Family Graph code if the existing definitive signals fire (exact email, exact phone, exact name + DOB, or address-line1 ≥ 0.85 with name overlap). Cross-source presence alone is not a signal. The resolver does not get more permissive just because two connectors are involved.
2. **Soft-similarity matches across sources are surfaced as conflicts, never auto-merged.** If FACTS shows "Treadaway family at 123 Main St with dad's email" and MP shows "Treadaway family at 123 Main St with mom's email," the address + last-name overlap puts them above the review threshold but below the auto-merge threshold. That conflict appears in `/conflicts` with a `cross_source` flag set to true and both source codes (`facts_api`, `ministry_platform_api`) listed in the conflict's metadata. The operator decides.
3. **Cross-source conflicts get a dedicated filter in the conflicts dashboard.** A new query parameter `?cross_source=true` on `/api/conflicts` lets the operator see only conflicts that involve records from two different connectors. The Conflicts UI gains a small "School + Parish" badge on these rows so they're visually distinct. This makes it easy to do a periodic "are my school families and parish families correctly linked?" review without scrolling through within-source conflicts.

The `cross_source` flag is computed when a conflict is opened by checking whether the candidate record's most recent provenance source differs from the incoming record's source. It is stored in the existing `conflicts.metadata` JSON column — no new database column needed.

What this prevents: Family Graph silently merging two families that happen to share a last name and a city across systems. What this enables: the operator getting a clear, surfaced list of "these probably go together — confirm or reject" without having to mentally cross-reference two CSV exports.

### 5.7 Schedule semantics

- A single in-process scheduler (similar to the existing notification dispatcher loop) wakes every 60 seconds, checks each connector's configured schedule against `last_run_at`, and triggers due syncs.
- Concurrent syncs of the same connector are prevented (a `connector_runs` row in status `running` blocks new triggers).
- Cross-connector concurrency is allowed (FACTS and MP can sync in parallel).
- If a sync is overdue (e.g., laptop was offline at the scheduled time), it runs at the next scheduler tick after the machine is awake — no catch-up loop, no double runs.
- `FAMILY_GRAPH_DISABLE_CONNECTORS=1` env var disables the scheduler entirely (parallel to `FAMILY_GRAPH_DISABLE_NOTIFY`).

### 5.8 Failure handling

- Connection failures (network, DNS, refused), auth failures (401, 403), and parse failures (unexpected schema) are caught at the connector boundary, recorded as a `connector_run` row with status `error` and a `reason` string, and surfaced in the dashboard.
- A failed sync does NOT write any partial data — the whole batch is wrapped in a transaction. Either the entire run lands or nothing does.
- Three consecutive failures of the same connector trigger a notification (using the existing notification dispatcher) to the operator email configured in Settings. After the notification, the connector keeps trying on its schedule but won't notify again until it succeeds at least once and then fails three more times.

### 5.9 Rate limiting and politeness

- FACTS is paginated (default 100/page); the connector handles pagination transparently and inserts a 100ms delay between pages to avoid hitting any rate ceiling.
- Ministry Platform's published rate limit is generous; the connector still sets a max of 1 request/100ms.
- A single sync is bounded to 60 minutes max wall-clock; longer runs are killed with a `timeout` reason.

---

## 6. Data requirements

### 6.1 New tables

**`connector_runs`** (mirrors `import_runs` but specific to scheduled connector activity)
```
code           TEXT PRIMARY KEY    -- e.g., crun_a1b2c3d4
connector      TEXT NOT NULL       -- 'facts_api' | 'ministry_platform_api'
trigger        TEXT NOT NULL       -- 'scheduled' | 'manual' | 'cli'
status         TEXT NOT NULL       -- 'running' | 'ok' | 'error' | 'timeout'
started_at     INTEGER NOT NULL    -- unix ms
ended_at       INTEGER             -- unix ms (null while running)
import_run     TEXT                -- FK to import_runs.code if the sync produced one
reason         TEXT                -- error reason; null on ok
metadata       TEXT                -- JSON: { rows_pulled, last_modified_cursor, etc }
```

**No changes to** `families`, `persons`, `import_runs`, `audit_events`, `conflicts`, `provenance`. Connector activity flows into all of these via the existing pipeline.

### 6.2 New settings keys (allow-listed)

Added to the existing `settings` allow-list:
- `connector_facts_enabled` (boolean as text)
- `connector_facts_schedule` ('off' | 'hourly' | 'daily_2am' | 'weekly_sun_2am')
- `connector_facts_api_base_url` (plain text — URL is not PII)
- `connector_facts_access_token_url` (plain text)
- `connector_facts_client_id_ct` (encrypted)
- `connector_facts_client_secret_ct` (encrypted)
- `connector_facts_last_sync_at` (unix ms as text)
- `connector_facts_last_modified_cursor` (ISO timestamp from the last successful sync, used for incremental pulls)
- Same six keys for `connector_ministry_platform_*`

### 6.3 Provenance

Every person/family/address record produced by a connector run gets a `provenance` row tagged with the connector source, so the operator can see in any record's detail view that "this came from the FACTS API on 2026-05-15".

---

## 7. Integrations and dependencies

### 7.1 New npm dependencies

- None preferred. Use Node 20+ built-in `fetch` for both connectors. OAuth 2.0 client credentials is a 30-line implementation; not worth pulling in `simple-oauth2` or similar.
- If Ministry Platform's OIDC discovery requires JWT validation (verify based on actual MP behavior in test connection), then add `jose` (zero-dep, supports Node natively).

### 7.2 External services

- **FACTS OneRoster API.** Requires school to enable in FACTS admin (`System > Configuration > Integrations > OneRoster > API Export`). FACTS Support issues credentials. ~$500/year subscription. Documented in the dashboard's connector setup help text.
- **Ministry Platform REST API.** Operator creates an API Client in MP admin (`Administration > API Clients`), assigns a security role, copies Client ID + Secret. No additional fee.

### 7.3 Internal dependencies

- `server/identity/import.js` — unchanged; consumed as-is.
- `server/sources/facts.js`, `server/sources/ministry-platform.js` — field mapping logic extracted into shared helpers if needed (`server/sources/facts.mapper.js`, etc.) so the API connector and CSV handler share the canonical-row construction.
- `server/db/encrypt.js` — unchanged; `encryptString` / `decryptString` consumed for credential storage.
- `server/notifications/index.js` — unchanged; consumed for failure notifications.
- `server/audit/index.js` — unchanged; new audit event types `connector_sync_ok`, `connector_sync_error`, `connector_credential_set`, `connector_credential_deleted` added.

### 7.4 New API endpoints

```
POST   /api/connectors/:name/credentials   # set credentials (encrypted)
DELETE /api/connectors/:name/credentials   # delete credentials, disable
GET    /api/connectors                     # list status of all connectors
GET    /api/connectors/:name               # one connector's status + last run
POST   /api/connectors/:name/test          # test connection, no write
POST   /api/connectors/:name/sync          # trigger sync immediately
PATCH  /api/connectors/:name               # update schedule, enabled flag
GET    /api/connector-runs                 # list, filterable by connector + status
GET    /api/connector-runs/:code           # one run's full detail
```

All endpoints require a Bearer token with `import` or `*` scope (consistent with existing import endpoints).

---

## 8. Out of scope

Explicitly NOT in v1:

- **Write-back to FACTS or MP.** v1 connectors are read-only. Family Graph never pushes data back. This is a deliberate v1 scoping decision, not an architectural prohibition. See §8.1 for the planned future evolution.
- **OAuth Authorization Code flow.** Both connectors use Client Credentials (server-to-server). User-context OAuth is a v2 evolution if Family Graph ever needs to act on behalf of a specific operator.
- **Multi-tenancy.** v1 supports one FACTS tenant and one MP tenant per Family Graph install. No "school A's FACTS + school B's FACTS" in the same instance.
- **Custom field mapping UI.** Field mappings are hard-coded in the connector (matching the existing CSV handlers). If FACTS or MP add fields the operator wants to capture, that's a code change. v2 may add a mapping editor.
- **OneRoster Gradebook endpoints (line items, results, score scales).** v1 only pulls rostering data. Gradebook sync is a separate platform decision tied to the write-back roadmap below.
- **Real-time webhooks from FACTS or MP.** Polling only. Neither system reliably exposes webhooks for the entities Family Graph cares about.
- **Diff-and-delete.** If a student or family is removed from FACTS or MP, Family Graph does NOT delete the corresponding record. The operator must explicitly merge or end-date in Family Graph's dashboard. This is a deliberate safety choice — no cascading deletes from external systems.

### 8.1 Future enhancements (post-v1, separate PRDs required)

The following are deferred to future versions. They are listed here so the v1 architecture leaves room for them without lock-in.

**Write-back to FACTS (v2 candidate).** OneRoster v1.1 supports gradebook write endpoints (`PUT /lineItems/{id}`, `PUT /results/{id}`). A future version of Family Graph could push back:
- *Updated contact info* — when an operator corrects a parent email or phone in Family Graph, push to FACTS so the school's system of record stays current.
- *Gradebook line items and results* — only relevant if Family Graph ever owns a teacher gradebook UI. Currently out of scope; in scope only if the broader Catholic school OS spec adds a gradebook module.
- *Custom fields back to FACTS* — pushing tags, custody flags, or family notes back into FACTS custom fields, where supported.

Write-back requires its own consent model: every write is operator-confirmed (or batch-confirmed via a "publish changes to FACTS" workflow), every write is logged to the tier-2 audit trail with destination = `facts_api`, and every write is reversible (Family Graph keeps the pre-write value for at least 30 days). No silent two-way sync. The operator always knows what's about to leave the machine.

**Write-back to Ministry Platform (v2 candidate).** MP's REST API supports `POST` and `PUT` on most tables. Candidate writes:
- *Updated contact info* — same logic as FACTS write-back.
- *New household registrations* — if Family Graph becomes the front door for new parishioner sign-ups (via a public form), creating the corresponding MP household automatically.
- *Engagement events from sibling apps* — ParentPoint or MissionIQ recording an event in their own system, then pushing a summary to MP's Contact Logs table so parish staff see it without leaving MP.

Same consent model as FACTS write-back: explicit, logged, reversible.

**Webhook receivers (v2 or v3 candidate).** If FACTS or MP add reliable webhook support for the entities we care about, a future Family Graph version could replace polling with event-driven sync. Lower latency, less network load, but requires Family Graph to expose a public-facing endpoint or a tunnel — which contradicts the local-first posture. Probably stays deferred unless a clear operator pain point emerges.

**Multi-tenancy (v3 candidate).** Supporting multiple FACTS tenants or multiple MP tenants in one Family Graph install. Useful for a diocese running Family Graph on behalf of multiple schools. Architecturally significant — requires per-tenant credential scopes, per-tenant identity isolation, and a tenant selector throughout the UI. Likely a separate product offering ("Family Graph Diocese Edition") rather than a v1 feature flag.

**Custom field mapping editor (v2 candidate).** A dashboard UI that lets the operator inspect what fields a connector is pulling and map additional source columns to Family Graph fields without a code change. Useful when MP customers customize their Contacts table with parish-specific fields. Requires careful PII handling (the mapper must not let an operator accidentally route SSN data into a non-encrypted column).

None of these block v1. They're listed so when an operator asks "can it do X," the answer is "not yet, but here's where it fits in the roadmap" rather than "no."

---

## 9. Open questions

1. **Multi-source identity resolution.** When a family appears in both FACTS and MP with different contact info (school uses dad's email, parish uses mom's email), should Family Graph proactively suggest a merge in the conflicts queue, or wait for the operator to notice? Recommendation: queue as a low-confidence conflict and let the resolver score it normally.
2. **MP custom fields.** Different parishes customize MP's Contacts and Households tables. The connector currently pulls only standard fields. Do we need a way to surface "we saw fields we don't recognize" so the operator knows what's being dropped? Recommendation: log unmapped column names in `connector_runs.metadata` for the first 5 rows of every sync, so the operator can see what's being ignored.
3. **Diocesan reporting concern (FACTS).** The diocese requires FACTS as the SIS of record. This connector is read-only and doesn't change that. But if Family Graph eventually exports a "school directory" PDF for parents, do we need to flag that the directory was sourced from FACTS via API rather than direct from FACTS? Recommendation: yes; the existing provenance + tier-2 audit handles this.
4. **Initial-run sizing.** First sync of a 200-family parish or 50-family school should complete in well under 60 minutes. Need to confirm with a test pull. Recommendation: Phase 1 testing measures this and we adjust the timeout if needed.
5. **What if the school doesn't pay the $500 for FACTS API access?** The existing CSV / SFTP / folder-watch path remains the fallback. Document this clearly in the FACTS connector's setup help text.

---

## 10. Success criteria (how we know it works)

### 10.1 Functional acceptance

- [ ] Operator can enter FACTS credentials in the dashboard, click Test Connection, and see `ok` within 10 seconds.
- [ ] Operator can enter MP credentials, click Test Connection, and see `ok` within 10 seconds.
- [ ] Manual sync of FACTS pulls all currently-enrolled families and produces `import_runs` + per-record `provenance` rows.
- [ ] Manual sync of MP pulls all active households and produces the same.
- [ ] Daily scheduled sync runs at the configured time without manual intervention for 7 consecutive days.
- [ ] When a credential is invalidated externally (FACTS rotates the secret), the next sync fails with reason `auth_failed` and surfaces in the dashboard within 60s.
- [ ] When the network is unreachable, the next sync fails with reason `network_error` and does not corrupt the ledger.
- [ ] Disabling a connector via the toggle stops scheduled syncs immediately. Re-enabling resumes them on the configured schedule.
- [ ] Deleting credentials removes them from `settings`, disables the connector, and emits a `connector_credential_deleted` audit event.

### 10.2 Identity resolution acceptance

- [ ] A family present in both FACTS and MP with matching email, phone, OR address resolves to a single Family Graph family code after both syncs complete.
- [ ] A family present in both with no matching identifiers creates two distinct Family Graph families and (if the soft-similarity score crosses the review threshold) opens a conflict for operator review.
- [ ] Sticky non-match decisions made via Conflicts continue to suppress re-flagging across subsequent connector syncs.

### 10.3 Logging and debugging acceptance

- [ ] Every connector run writes a `connector_runs` row with `started_at`, `ended_at`, `status`, `reason` (if applicable), and the resulting `import_run` code.
- [ ] Every HTTP call to FACTS or MP is logged at `debug` level (path, status, latency) with credentials redacted.
- [ ] Every auth failure includes a structured `reason` field consistent with the existing auth-reject vocabulary (`token_mismatch`, `unknown_or_revoked_scoped_token`, etc.) so the operator can distinguish "credentials wrong" from "network down".
- [ ] Connector errors surface in `~/.family-graph/logs/server.log` with full stack traces (existing logging patterns).
- [ ] The dashboard's Imports log shows connector runs alongside file imports with no visual difference in the data quality of the row (totals, drilldown, audit linkage).

### 10.4 Security acceptance

- [ ] Credentials are stored only as ciphertext in `settings`; SQLite inspection with `sqlite3` CLI shows no plaintext.
- [ ] `GET /api/settings` never returns credential plaintext, even with the master Bearer token.
- [ ] The dashboard never displays full credential strings — `••••••••` only.
- [ ] `family-graph backup [passphrase]` includes the encrypted credentials; restoring to a new machine and re-keying preserves them.
- [ ] Rotating the master Bearer token (`rotate-secret`) does NOT invalidate stored connector credentials, because they're encrypted with `dataKey`, not `master`.

### 10.5 Performance acceptance

- [ ] Initial sync of a school with 300 families completes in under 5 minutes.
- [ ] Initial sync of a parish with 1,500 households completes in under 15 minutes.
- [ ] Incremental sync (subsequent runs using `dateLastModified` cursor) completes in under 60 seconds for a school with 300 families and 50 daily changes.
- [ ] Connector activity does not noticeably degrade dashboard responsiveness (status rail polling stays under 100ms).

---

## 11. Logging infrastructure (built-in for debugging)

Per project standards, this PRD ships with structured logging that lets the operator (or Claude Code in a debugging session) paste straight from `server.log` into a chat to identify failures.

### 11.1 New log event types

All emitted at `info` level by default; downgrade to `debug` once the connector is stable. JSON-line format consistent with the existing logger.

| Event | Level | Fields |
|---|---|---|
| `connector.scheduler.tick` | debug | `connectors_due[]` |
| `connector.run.started` | info | `connector`, `trigger`, `run_code` |
| `connector.run.finished` | info | `connector`, `run_code`, `status`, `duration_ms`, `rows_pulled`, `families_created`, `families_attached`, `persons_created`, `persons_attached`, `conflicts_opened` |
| `connector.run.failed` | error | `connector`, `run_code`, `reason`, `stack` |
| `connector.http.request` | debug | `connector`, `method`, `path`, `status`, `duration_ms` (credentials always redacted) |
| `connector.http.auth_refreshed` | debug | `connector`, `expires_in` |
| `connector.http.auth_failed` | error | `connector`, `reason`, `status` |
| `connector.credential.set` | info | `connector`, `actor` |
| `connector.credential.deleted` | info | `connector`, `actor` |
| `connector.scheduler.disabled` | warn | (logged at boot if `FAMILY_GRAPH_DISABLE_CONNECTORS=1`) |

### 11.2 Redactor coverage

The existing redactor already strips `authorization`, `token`, `secret`, `password`, etc. Extend the key list to include `client_id`, `client_secret`, `access_token`, `refresh_token`, `bearer` so connector credentials never appear in logs even by accident.

### 11.3 Operator escape hatch

`node bin/family-graph.js connector status` prints, in plain text:

```
FACTS API
  enabled:           true
  schedule:          daily_2am
  last attempt:      2026-05-15 02:00:14 UTC (ok)
  last sync ended:   2026-05-15 02:01:47 UTC
  rows pulled:       312
  families created:  4
  families attached: 308
  conflicts opened:  1
  next scheduled:    2026-05-16 02:00:00 UTC

Ministry Platform API
  enabled:           true
  schedule:          daily_2am
  last attempt:      2026-05-15 02:00:14 UTC (error: auth_failed)
  last successful:   2026-05-13 02:01:33 UTC
  next scheduled:    2026-05-16 02:00:00 UTC

  Last error:
    auth_failed: Token endpoint returned 401. Check that the API Client
    in Ministry Platform admin has not had its secret rotated.
```

When something is broken, the operator (or a debugging session) can paste this output into Claude Code to get an immediate read on what went wrong.

---

## 12. File layout (additions only)

```
server/
├── connectors/
│   ├── index.js               # registry: { facts, ministry_platform } → connector modules
│   ├── scheduler.js           # 60-second tick loop
│   ├── runs.js                # CRUD + state machine for connector_runs
│   ├── credentials.js         # encrypted set/get/delete in settings
│   ├── facts.js               # FACTS OneRoster API connector
│   ├── ministry-platform.js   # MP REST API connector
│   └── http.js                # shared OAuth 2.0 client credentials helper
├── db/
│   └── migrations/
│       └── 20260501_connector_runs.js   # new table
├── routes/
│   └── connectors.js          # the new /api/connectors/* + /api/connector-runs/* endpoints
└── sources/
    ├── facts.mapper.js        # extracted from sources/facts.js if needed
    └── ministry-platform.mapper.js   # extracted from sources/ministry-platform.js if needed

client/src/
├── views/
│   ├── Settings.jsx           # add Connectors tab
│   └── ConnectorDetail.jsx    # per-connector configuration screen
└── components/
    └── ConnectorCard.jsx      # reusable card showing status + last run

tests/
├── connectors-facts.test.js           # unit tests with mocked HTTP
├── connectors-ministry-platform.test.js
├── connectors-scheduler.test.js
├── connectors-credentials.test.js
└── api-connectors.test.js             # endpoint tests
```

---

## 13. Test plan

### 13.1 Unit tests (new, run via `npm test`)

- Encrypted credential round-trip via `settings`.
- OAuth 2.0 client credentials flow against a mock token endpoint (success, 401, network error, malformed response).
- FACTS canonical-row construction from a fixture of OneRoster API JSON responses.
- MP canonical-row construction from a fixture of MP REST API JSON responses (Households + Contacts joined via Household_ID).
- Scheduler tick logic — given a set of last-run timestamps and configured schedules, returns the correct due list.
- Concurrent-sync prevention — second trigger while first is running returns immediately without starting a duplicate run.
- Failure path: bad credentials → no partial writes, `connector_run` row in status `error` with correct reason.
- Notification trigger: three consecutive failures emit one notification, fourth failure does not emit a duplicate.

### 13.2 Integration tests (new, run via `npm test`)

- Full flow: set credentials → test connection (mocked) → run sync → verify families/persons created in the ledger → verify provenance rows present → verify import_runs row written → verify connector_runs row written.
- Cross-connector identity resolution: seed FACTS with a family, sync, then seed MP with the same family (same email), sync, verify single Family Graph family code shared.

### 13.3 Manual acceptance (operator-driven, against real FACTS + MP test tenants)

1. Configure FACTS credentials with the school's actual API client.
2. Test connection → expect `ok`.
3. Run sync now → expect families/persons appearing in the ledger within 5 minutes.
4. Configure MP credentials with the parish's actual API client.
5. Test connection → expect `ok`.
6. Run sync now → expect parish families/persons appearing within 15 minutes.
7. Identify a family that exists in both systems → confirm Family Graph resolved them to a single code (or correctly enqueued them as a conflict if contact info doesn't overlap).
8. Wait 24 hours → confirm scheduled sync ran at 2 AM and produced an incremental update only.
9. Rotate the FACTS Client Secret in FACTS admin → wait for next scheduled run → confirm dashboard shows error with reason `auth_failed` within 24 hours.
10. Restore the credential → confirm next sync succeeds.

---

## 14. Rollout plan

### Phase 1 — Build and test against mocks (this PRD)
- Implement everything in this PRD.
- Pass all unit + integration tests.
- Build runs on Mac and Windows per existing cross-platform support.

### Phase 2 — St. Theresa pilot (FACTS first, then MP)
- Operator pays $500 for FACTS API access.
- Configure FACTS connector against the live St. Theresa FACTS tenant.
- Run for 7 days; verify daily syncs, surface any field-mapping gaps.
- Then configure MP connector against St. Theresa parish's MP tenant.
- Run for another 7 days; verify cross-system identity resolution.

### Phase 3 — Stabilization
- Tune resolver thresholds based on observed cross-system match rates.
- Refine error-notification thresholds based on observed failure patterns.
- Document any field mappings that needed adjustment.

### Phase 4 — Open the door for sibling apps
- MissionIQ and ParentPoint can now consume a Family Graph that's actively synced from both FACTS and MP, without either app needing its own connector code.
- Architectural memo's "Phase 0: Family Graph stability" criterion (30 days production) starts the clock from end of Phase 2.

---

*End of PRD. Hand to Claude Code with this file + the existing `product_spec.md` and `ARCHITECTURE_MEMO_FAMILY_MANAGEMENT.md` as the only required context. No additional briefing needed.*

---

## Appendix A — Phase 1 build notes (as-built deviations)

The Phase 1 build (`server/connectors/*`, migration `0010_connector_runs`,
`/api/connectors/*` routes, `tests/connectors-*`) lands the PRD as
specified, with a few small deviations the implementing pass discovered:

1. **`conflicts.metadata` is a real column.** §5.6 stated the cross-source
   flag would live "in the existing `conflicts.metadata` JSON column — no
   new database column needed." That column did not in fact exist; the
   pre-PRD schema only had `reasons`, `resolution_notes`, `decided_by_rule`,
   etc. Migration `0010_connector_runs` adds `metadata TEXT` to
   `conflicts` alongside the new `connector_runs` table. The semantics
   match the PRD: cross-source conflicts get
   `{ cross_source: true, sources: ['facts_api', 'ministry_platform_api'] }`
   stored as JSON, queryable via `json_extract`. Any future flag can ride
   the same column without another migration.

2. **Encryption helpers are `encrypt` / `decrypt`, not `encryptString` /
   `decryptString`.** The PRD references the latter names, which don't
   exist. `server/crypto/encryption.js` exports `encrypt(secrets, plaintext)
   → Buffer` and `decrypt(secrets, blob) → string`. The connectors module
   wraps these and base64-encodes the ciphertext blob into the existing
   `settings.value_json` column — no schema change to `settings`, no
   double-encoding gotchas.

3. **`api_keys` scope name for connector endpoints is `import`.** The PRD
   says "Bearer token with `import` or `*` scope." `/api/connectors/*` is
   mounted behind `bearerImport`; `/api/connector-runs` is mounted behind
   `bearerRead` (the read-only run history is parallel to
   `/api/imports`). Master token satisfies both.

4. **OneRoster `agents` linkage is the canonical join key.** §5.4 said the
   FACTS connector "reuses field mappings from `server/sources/facts.js`."
   The CSV handler joins parents+students by row position (parent_1_*,
   parent_2_*, plus the student row), which doesn't translate to the API
   shape. The API connector instead groups by each user's `agents[]`
   array, falling back to `(familyName, address)` when agents are absent.
   This is materially better — it resolves siblings into one household
   even when their address fields drift, and it cleanly handles
   parent-only rows for parishes that subscribe to OneRoster without a
   student roster.

5. **Ministry Platform OIDC discovery is not parsed.** The PRD listed
   `jose` as a possible new dependency for OIDC discovery. In practice MP
   exposes the token endpoint at the well-known path
   `<api_base>/oauth/connect/token`, which the connector derives
   automatically when `oauth_discovery_url` is left blank. No new
   dependency was added; if a future MP version moves the endpoint or
   requires JWT validation, that becomes a separate change.

6. **Scheduler uses UTC anchor times, not local time.** §5.7's
   `daily_2am` / `weekly_sun_2am` schedules fire at 02:00 **UTC**, not
   local time. Across DST boundaries the run can drift by an hour
   relative to the operator's wall clock — acceptable for an overnight
   sync, and sidesteps the surprisingly hard problem of detecting the
   operator's intended timezone from a server-side daemon.

7. **Failure-notify recipient is the `operator_email` setting.** §5.8
   specified that three consecutive failures emit a notification to the
   operator email "configured in Settings." That setting key wasn't yet
   defined. The connector uses `settings['operator_email']` if present
   and notifications are enabled; if the operator hasn't set one, the
   notification is logged but not enqueued. This is a soft dependency —
   adding the setting to the dashboard is a one-line follow-up that
   doesn't block the connector from working.

8. **Test injection via `fetchImpl`.** Every connector function accepts an
   optional `fetchImpl` parameter that defaults to the global `fetch`.
   This is what lets `tests/connectors-*.test.js` exercise the full
   sync pipeline without touching the network. Production code never
   passes the parameter, so there's no runtime cost.

Test coverage at end of Phase 1: 247 tests pass (was 206), covering
credential round-trip, token caching, 401 retry, pagination, FACTS+MP
canonicalization, end-to-end sync against mocked vendor APIs, concurrent-
sync prevention, scheduler due-detection, cross-source auto-merge on
exact-email evidence, and cross-source conflict generation when evidence
is soft. The full test suite (`npm test`) is green on Node 20+.

