# Family Graph

**Local family registry for Catholic institutions.** Closed source for v1.

Family Graph is the source of truth for family identity in an institution's data
ecosystem. It accepts files from existing systems (FACTS, RenWeb, Ministry
Platform, Google Sheets, Excel, generic CSV), reconciles them against a
persistent ledger, and exposes that ledger to the institution's other tools
through a local HTTP API. PII at rest is encrypted; AI workflows always see
pseudonyms; PII exports require explicit consent and land in a tier-2 audit
trail.

The "why" lives in [`business_spec.md`](./business_spec.md). The "how" lives
in [`product_spec.md`](./product_spec.md). The decision history lives in
[`session_notes.md`](./session_notes.md). The cross-app integration plan
lives in
[`ARCHITECTURE_MEMO_FAMILY_MANAGEMENT.md`](./ARCHITECTURE_MEMO_FAMILY_MANAGEMENT.md).

---

## Run it (macOS / Linux)

```sh
npm install
npm run client:install
npm run client:build
npm start
```

Family Graph listens on `http://127.0.0.1:3500` and serves the React dashboard at
`/`. On first boot it creates `~/.family-graph/` (mode 0700), writes
`secret.key` (mode 0600), initialises the SQLite database, seeds the
built-in profiles, and starts the folder-watch agent on `~/.family-graph/watch`.

Print the master Bearer token (paste into the dashboard the first time):

```sh
node bin/family-graph.js show-token
```

---

## Run it (Windows · PowerShell)

Tested on Windows 11 with PowerShell 7. PowerShell 5.1 (the default
shipped with Windows) also works.

### One-time setup

1. **Install Node.js 20 LTS or newer.** Either via [nodejs.org](https://nodejs.org)
   or `winget`:
   ```powershell
   winget install OpenJS.NodeJS.LTS
   ```
   Close and reopen your terminal so `node` and `npm` are on `PATH`.
   Verify:
   ```powershell
   node --version
   npm --version
   ```

2. **Install Git** if you haven't already:
   ```powershell
   winget install Git.Git
   ```

3. **(Probably not needed)** `better-sqlite3` ships prebuilt Windows
   binaries for Node 20+, so `npm install` should succeed without a C++
   toolchain. If you ever see a `node-gyp` failure, install the build
   tools once:
   ```powershell
   winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --quiet"
   winget install Python.Python.3.12
   ```

### Clone and start

```powershell
git clone https://github.com/christreadaway/custos.git family-graph
cd family-graph
npm install
npm run client:install
npm run client:build
npm start
```

The first boot creates `$HOME\.family-graph\` (i.e. `C:\Users\<you>\.family-graph\`)
with `secret.key`, the SQLite database, the watch and backups
directories, and seeds the built-in profiles. Open
<http://127.0.0.1:3500> in a browser. To get the Bearer token to paste
into the dashboard:

```powershell
node bin/family-graph.js show-token
```

Stop the server with `Ctrl+C` in the PowerShell window.

### Setting environment variables in PowerShell

Per-session (only affects the current PowerShell window):

```powershell
$env:FAMILY_GRAPH_POSTMARK_TOKEN = "your-server-token-here"
$env:FAMILY_GRAPH_HOME           = "D:\family-graph-data"   # if you don't want it under your profile
npm start
```

Persistent (user-level, applies to every new PowerShell window from now on):

```powershell
[Environment]::SetEnvironmentVariable('FAMILY_GRAPH_POSTMARK_TOKEN', 'your-server-token-here', 'User')
```

Reopen PowerShell after running that command for the new value to be
visible.

### Running as a Windows service (optional)

For an always-on deployment, the easiest path is **NSSM** (Non-Sucking
Service Manager):

```powershell
winget install NSSM.NSSM
# In an *Administrator* PowerShell:
nssm install family-graph "C:\Program Files\nodejs\node.exe" "$PWD\server\index.js"
nssm set     family-graph AppDirectory "$PWD"
nssm set     family-graph AppEnvironmentExtra "FAMILY_GRAPH_POSTMARK_TOKEN=your-token"
nssm start   family-graph
# To stop:    nssm stop family-graph
# To remove:  nssm remove family-graph confirm
```

Alternatively, register a Scheduled Task that runs at logon with
`At log on of <user>` triggering `pwsh.exe -Command "cd C:\path\to\family-graph; npm start"`.

### Windows-specific caveats

- **File permissions.** Node's `fs.mkdirSync(p, { mode: 0o700 })` and
  `fs.writeFileSync(p, data, { mode: 0o600 })` are silently ignored on
  Windows; the secret key file inherits the user-profile NTFS ACL.
  That's acceptable on a single-operator workstation. Treat
  `$HOME\.family-graph\` as you would any folder containing credentials —
  don't share it. v2 will move the master/data/HMAC keys to the
  Windows Credential Manager.
- **Long paths.** If `$env:FAMILY_GRAPH_HOME` is on a deeply nested path,
  enable Windows long-path support (`Group Policy → Computer
  Configuration → Administrative Templates → System → Filesystem →
  Enable Win32 long paths`) before installing — otherwise some
  `node_modules` extraction may fail.
- **Antivirus.** SQLite write-ahead-log files (`*.sqlite-wal`,
  `*.sqlite-shm`) are excluded from Defender by Microsoft's standard
  exclusions. If you use a third-party AV, exclude `$HOME\.family-graph\`
  to avoid intermittent locks.
- **Folder watch.** `chokidar` uses Windows native file events, which
  is reliable on local drives but can be flaky on network shares.
  Keep `$env:FAMILY_GRAPH_WATCH_DIR` on a local disk.

---

## CLI

| Command | What it does |
|---|---|
| `node bin/family-graph.js start` | Default. Runs the API server + folder-watch agent. |
| `node bin/family-graph.js status` | Prints schema version, profile, audit count, backup count, key + watch dir paths. |
| `node bin/family-graph.js show-token` | Prints the master Bearer token. |
| `node bin/family-graph.js rotate-secret` | Regenerates the master Bearer token. The data + HMAC keys are preserved so existing ciphertext keeps decrypting. |
| `node bin/family-graph.js backup [passphrase]` | Hot snapshot. Encrypted with PBKDF2 + AES-256-GCM if a passphrase is given. |
| `node bin/family-graph.js list-backups` | Lists files in the backups directory. |
| `node bin/family-graph.js prune-backups [keep=10]` | Keeps the most recent N backups, deletes older. |
| `node bin/family-graph.js restore <passphrase> <src> <dest>` | Restores an encrypted backup to a new sqlite path. |
| `node bin/family-graph.js connector status` | Prints last-run timestamps + outcomes for FACTS / Ministry Platform connectors. |
| `node bin/family-graph.js connector test <facts\|ministry_platform>` | Runs the test-connection flow without writing data. |
| `node bin/family-graph.js connector sync <facts\|ministry_platform>` | Runs a full sync immediately (same path the scheduler uses). |

`npm run start`, `npm run dev`, `npm run status`, `npm run backup`,
`npm run rotate-secret`, and `npm test` are equivalent shortcuts and
work identically on macOS, Linux, and Windows PowerShell.

---

## Folder-watch agent

Drop a file in `~/.family-graph/watch`:

| Extension | Behaviour | Output in `~/.family-graph/out` |
|---|---|---|
| `.csv`, `.tsv` | Source-handler import | `<file>.import-summary.json`, source moved to `processed/` |
| `.xlsx`, `.xls`, `.xlsm` | Excel import (first sheet) | same |
| `.txt`, `.md`, `.eml`, `.json` | Text sanitization | `<stem>.sanitized.<ext>` + `<stem>.token-set.json` |
| anything else | Error | moved to `errors/` with a `.error.txt` sidecar |

Set `FAMILY_GRAPH_WATCH_PROCESS_EXISTING=1` to process whatever is already in the
watch dir at startup (default: only new files are picked up).

---

## Imports & source tagging

Every file you bring in (via the dashboard, the `/api/import/run` endpoint,
or the folder-watch agent) writes one `import_runs` row that records the
totals: families created vs. attached, persons created vs. attached vs.
enqueued, conflicts opened, addresses/emails/phones attached, and the
count of rows skipped as blank. The dashboard's **Imports log** lists
every run; click into one to see exactly which families and people that
file produced.

The auto-mapper is vendored from missionIQ's ingestion module
(`server/sources/csv.js`). Every column header is scored against a
dictionary of ~250 alias variants — including primary/secondary slots
("Parent 1 First Name", "P2 First", "Spouse Last", "Husband Email",
"HOH First", "Guardian Phone"), nicknames across English/French/Spanish,
and child-roster shapes. Highest-scoring (header, field) pairs are
assigned globally, so "Child First Name" wins over "First Name" for the
child slot rather than being stolen by the generic. The preview always
returns:

- `mapping_warning` — a plain-English string when no identity columns
  were detected, surfaced prominently in the dashboard (and the Import
  button stays disabled);
- `summary_rows_dropped` — the count of "Total" / "Grand Total" rows
  silently filtered out;
- `diagnostic.rows_with_persons` / `rows_blank` — so the operator sees
  "10 of 370 rows produced people" before clicking Import, not after;
- `unmapped_columns` — the list of headers that didn't claim a slot,
  ready to be mapped by hand in the column editor.

Date columns are normalized to ISO `YYYY-MM-DD` regardless of input
format: Excel serial numbers (critical for Sheets exports), `MM/DD/YYYY`,
2-digit year forms, ISO, and textual ("Jan 15, 2025"). Phones split
concatenated values (`+13143783612+13145607897` → two phones) and strip
the `+1` country code. Emails lowercase and de-dupe.

Each file is also tagged. At import time the operator picks:

- a **category** (`church` / `school` / `other`) — the only short label
  Family Graph asks for, useful so a directory entry can later be traced
  back to "this came from our church donor list" vs. "from the school
  enrollment system";
- any number of **free-form tags** (e.g., `q1-2026`, `donor-list`,
  `fr-mike-onboarded`) for finer slicing.

Family Graph deliberately does not store financial facts. If a donation
file contains date/amount/payment-method columns, those columns are
parsed and discarded; only the identity columns produce database rows.
The category + tags survive on the source-record so the operator can
audit the provenance later. Money lives in MissionIQ, not here.

### Importing from a Google Sheets link

The Import wizard has a "Pull from a Google Sheets URL" panel. Paste a
link of the form `https://docs.google.com/spreadsheets/d/<ID>/edit?gid=<GID>`,
click **Fetch**, and the published-CSV content is pulled into the paste
box. Then preview / run as normal.

Requirements:

- The sheet must be shared as **"Anyone with the link can view"**.
  Private sheets cannot be ingested through this path in v1
  (OAuth-backed access is a v2 evolution).
- Family Graph parses the URL strictly: the host must be exactly
  `docs.google.com`, the path must look like
  `/spreadsheets/d/<id>(/<sub>)?`. We construct the export URL
  ourselves rather than blindly fetching whatever you paste.
- Redirects from Google's export endpoint are followed for up to five
  hops, and every hop must end up on `*.google.com` or
  `*.googleusercontent.com`. Anything else aborts with a clear error.
- Body is capped at 10 MB. Total request timeout is 30 s.
- Every fetch is logged in the audit trail (`sheet_fetch` action) with
  the sheet ID, the gid, the final URL, and the byte length — no body
  content.

If you'd rather paste a CSV downloaded from Sheets manually, the
existing **paste / file-upload** path still works exactly the same.

---

## API (summary)

- `GET /api/health` — open. Returns schema version, watch state, audit count, etc.
- `GET /api/safe/...` — loopback only, no PII ever.
- Everything else under `/api/` requires a Bearer token.

The Bearer can be the master token (full access) or a per-app `sk_…` scoped
token issued via `POST /api/keys` with one or more of the scopes
`pii.read`, `pii.write`, `sanitize`, `audit.read`, `audit.write`, `import`,
`rules.write`, or `*`.

Consuming apps SHOULD set the `X-Family-Graph-Actor` header to a short
stable identifier (e.g. `missioniq`, `parentpoint`). It is recorded on
every audit row so the operator can see who read or wrote what. For
master tokens the header is honoured verbatim; for scoped tokens the
actor is forced to the key's name so a consuming app cannot spoof a
different identity.

When auth fails, the response body includes a stable `reason` field —
`no_bearer`, `token_mismatch`, `unknown_or_revoked_scoped_token`,
`missing_scope`, or `non_loopback_origin`. The dashboard surfaces this
reason in the token banner; the same string also appears in
`server.log` next to the matching `auth.reject` line.

The full route table is in [`product_spec.md`](./product_spec.md#api-contract).

### Live connectors (FACTS SIS · Ministry Platform)

In addition to the file-based ingest paths, Family Graph can pull rosters
and household records directly from FACTS (school) and Ministry Platform
(parish) on a schedule. Credentials are stored encrypted with the
existing `dataKey`; the dashboard never displays plaintext.

- `GET /api/connectors` — list configured connectors with last-run status.
- `GET /api/connectors/:name` — detailed status (`facts`, `ministry_platform`).
- `POST /api/connectors/:name/credentials` — set credentials (encrypted at rest).
- `DELETE /api/connectors/:name/credentials` — clear credentials, disable.
- `PATCH /api/connectors/:name` — update `enabled` / `schedule`
  (one of `off`, `hourly`, `daily_2am`, `weekly_sun_2am`).
- `POST /api/connectors/:name/test` — verify credentials + endpoint reachability
  without writing.
- `POST /api/connectors/:name/sync` — trigger an immediate sync. The pipeline
  is the same one file ingest uses, so the resolver, conflicts queue, and
  audit trail behave identically. The `import_runs` row is tagged with
  `source = facts_api` or `ministry_platform_api` and `tags = [connector, manual]`
  / `[connector, scheduled]`.
- `GET /api/connector-runs` / `GET /api/connector-runs/:code` — per-run history.

A 60-second in-process scheduler triggers due syncs from `last_sync_at`.
Concurrent syncs of the same connector are blocked by a `connector_runs.status='running'`
gate; cross-connector concurrency is allowed. Set
`FAMILY_GRAPH_DISABLE_CONNECTORS=1` to disable the scheduler entirely
(parallel to `FAMILY_GRAPH_DISABLE_NOTIFY` / `FAMILY_GRAPH_DISABLE_WATCH`).

API and file ingest are co-equal — enabling a connector never disables the
matching CSV / Sheets / folder-watch path. If FACTS rotates a secret, the
operator can drop a CSV in the watch folder while they re-issue
credentials and the data flows through the same resolver.

Cross-source conflicts (a record in both FACTS and MP that's similar but
not definitive) are flagged with `metadata.cross_source = true` and the
two source tags; filter via `GET /api/conflicts?cross_source=true`.

Operator setup walkthrough lives in
[`API_ACCESS_GUIDE.md`](./API_ACCESS_GUIDE.md). PRD lives in
[`PRD_LIVE_CONNECTORS.md`](./PRD_LIVE_CONNECTORS.md).

### External-app identity API

Sibling apps (missionIQ, ParentPoint, future tools) bring in their own
domain data (donations, engagement events) and delegate the identity
decision to Family Graph. Three endpoints under `/api/identity/`:

- `POST /api/identity/match` — read-only peek. Body: `{ record: {...} }`.
  Returns `{ action, confidence, reasons, definitive, candidate, thresholds }`
  so the caller can preview what Family Graph WOULD do without committing.
- `POST /api/identity/resolve` — commit. Same input shape; runs the
  resolver and writes the outcome. Returns `{ code, action, score,
  reasons, conflict? }` — the calling app stores its domain data keyed
  by `code`.
- `POST /api/identity/feedback` — the calling app records `same` or
  `different` for a pair. `different` is "sticky": future imports will
  not re-flag that pair as a conflict. `same` merges with the supplied
  `winner_code`.

Input records accept both flat shapes (`first_name`, `last_name`,
`email`, `phone`) and structured shapes (`given_name`, `family_name`,
`emails[]`, `phones[]`, `address: {...}`) so the calling app passes
through whatever its native rows look like.

### Auto-merge vs prompt-the-user (the matching gate)

`server/identity/matching.js` ports missionIQ's scoring with one
correctness fix. The decision flow:

1. **Definitive signals** (auto-merge at 0.95 confidence):
   - Exact email (multi-value aware: comma/semicolon-separated)
   - Exact phone (multi-value, country-code stripped, concatenation split)
   - Exact name + exact DOB — promoted to definitive because child
     rosters frequently lack email/phone
   - Address line1 ≥ 0.85 similarity AND a name overlap
2. **Definitive-signal vetoes** drop confidence below auto-merge:
   - Different states on otherwise-matching addresses (catches
     inherited-mailbox / cross-generation cases)
   - Address similarity < 0.5
3. **Soft additive signals** (capped at 1.0):
   - last name suffix-aware: exact +0.30, similar +0.20
     (Smith Jr. == Smith)
   - first name compound/nickname/prefix-aware: exact +0.20, nickname
     +0.18, similar +0.10, phonetic +0.05
     (Tim == Timothy, Bob == Robert, Mary == Marie, "Timothy & Mary"
     matches each)
   - DOB exact +0.20
   - Address similar (>0.65) +0.15
   - Zip match +0.05/+0.10
   - City match +0.05
4. **The gate** (default thresholds):
   - confidence ≥ 0.85 OR definitive → auto-merge (attach)
   - ≥ 0.30 → enqueue conflict for operator
   - < 0.30 → create new person
   Thresholds are tunable per-institution via the `profiles` table.

**Sticky decisions:** when an operator (or external app) marks a pair
"different" (`reject`/`dismiss`/feedback `different`), that decision is
stored in the conflicts table with status `rejected`/`dismissed` and a
free-form `resolution_notes` field. On every subsequent import or
rescan, `conflicts.hasStickyNonMatch(left, right)` suppresses re-flagging
the pair. The decision survives forever unless the operator explicitly
clears it. The dashboard's Conflicts view shows a per-row textarea for
the operator to record the WHY ("father and son, confirmed via parish
records") before clicking merge / reject / dismiss; closed conflicts
display the stored note verbatim under the row.

**Critical correctness fix vs missionIQ:** address-only auto-merge with
unrelated names is treated as a *family* signal in Family Graph, not a
person signal. Mary Escamilla and John Torre at the same address are a
couple, not duplicates of one person. The family resolver attaches them
to the same family; the person resolver leaves them as distinct persons.

---

## Configuration (env vars)

| Variable | Default | Notes |
|---|---|---|
| `FAMILY_GRAPH_HOME` | `~/.family-graph` | Root for data, secrets, backups, watch dirs |
| `FAMILY_GRAPH_DB` | `$FAMILY_GRAPH_HOME/data/family-graph.sqlite` | |
| `FAMILY_GRAPH_SECRET` | `$FAMILY_GRAPH_HOME/secret.key` | mode 0600, holds master/data/HMAC keys |
| `FAMILY_GRAPH_WATCH_DIR` | `$FAMILY_GRAPH_HOME/watch` | folder-watch input |
| `FAMILY_GRAPH_OUT_DIR` | `$FAMILY_GRAPH_HOME/out` | folder-watch output |
| `FAMILY_GRAPH_PORT` | `3500` | |
| `FAMILY_GRAPH_BIND` | `127.0.0.1` | loopback by default |
| `FAMILY_GRAPH_AUTO_MERGE` | `0.92` | resolver auto-merge threshold |
| `FAMILY_GRAPH_REVIEW` | `0.7` | resolver conflict-queue threshold |
| `FAMILY_GRAPH_DISABLE_WATCH` | unset | set to `1` to disable the folder-watch agent |
| `FAMILY_GRAPH_WATCH_PROCESS_EXISTING` | unset | set to `1` to process files already present at startup |
| `FAMILY_GRAPH_DISABLE_NOTIFY` | unset | set to `1` to disable the notification dispatcher loop |
| `FAMILY_GRAPH_POSTMARK_TOKEN` | unset | Postmark server token for outbound email. The `from` address and stream are configured in Settings; the token is read only from the environment. |
| `FAMILY_GRAPH_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` \| `silent` |
| `FAMILY_GRAPH_LOG_FILE` | `$FAMILY_GRAPH_HOME/logs/server.log` | JSON-lines log destination (mirrored to stderr) |

The active profile (Dashboard → Profiles) overrides `FAMILY_GRAPH_AUTO_MERGE` /
`FAMILY_GRAPH_REVIEW` for imports.

---

## Logging

Every line in the log is one JSON object. Stderr always receives a copy; a
file copy goes to `$FAMILY_GRAPH_HOME/logs/server.log` by default
(override with `FAMILY_GRAPH_LOG_FILE`).

What's logged:

- `boot` / `listening` — startup events.
- `http` — one line per HTTP response with `method`, `path`, `status`,
  `ms`, `actor`, `ip`. `4xx` is logged at `warn`, `5xx` at `error`.
- `auth.reject` — every auth failure with a structured `reason` field:
  `no_bearer`, `token_mismatch`, `unknown_or_revoked_scoped_token`,
  `missing_scope`, or `non_loopback_origin`. For mismatched tokens the
  log includes a non-reversing 8-character `token_fp` fingerprint so you
  can tell whether the same wrong value is being retried versus a new
  one each time.
- `auth.ok` — debug-level success (drop `FAMILY_GRAPH_LOG_LEVEL=debug`
  to see).
- `unhandled` — any unhandled exception with `stack`.
- `notify.dispatch_failed`, `folder_watch.start_failed`, etc.

Every emitted line is run through a redactor that replaces values for
keys named `authorization`, `token`, `master`, `secret`, `password`,
`name`, `first_name`, `last_name`, `given_name`, `family_name`,
`email`, `phone`, `address`, `line1`, `line2`, `dob`, `date_of_birth`,
`plaintext`, or `value` with `[redacted]`. Logs are therefore safe to
share when debugging.

Tail it live:

```sh
tail -f ~/.family-graph/logs/server.log | jq .
```

```powershell
Get-Content $HOME\.family-graph\logs\server.log -Wait
```

When the dashboard says "Error: unauthorized", grep the log for the
matching `auth.reject` line — the `reason` field tells you exactly
which middleware refused the call and why.

---

## Dashboard

The dashboard ships built; opening <http://127.0.0.1:3500> after `npm
start` is enough. The design follows the **Institutional** theme from
the Family Graph design system (see `CLAUDE_CODE_HANDOFF.md`):

- A **status rail** is pinned to the top of every screen with
  posture indicators — loopback green, encrypted cyan, audit-live
  indigo, schema version and live counts on the right. The rail polls
  `/api/health` every 5s and turns red on loopback loss.
- The header carries a **PII ↔ Pseudonym** segmented toggle. The
  default is *pseudonym* (per the handoff). The toggle is persisted to
  `localStorage` and routes list views to `/api/safe/...` when in
  pseudonym mode, and redacts display names + addresses on detail
  pages. Posture, not just a surface.
- Every identifier is type-coloured (family indigo, person cyan,
  address green, email yellow, phone amber) via the `<IdCode>`
  component. Conflicts, imports, and audit feed use posture pills
  semantically — `external_export` reads as consented, `read_pii` as
  PII, `sanitize` as pseudonym, etc.
- Provenance dots distinguish source systems (FACTS, RenWeb, Ministry
  Platform, Sheets, CSV/Excel, other) and use a separate palette from
  posture so "where the data came from" never reads the same as "what
  state it's in."

### Client dev workflow

For interactive frontend work, run the API server and the Vite dev
server side-by-side:

```sh
# terminal 1 — API
npm start

# terminal 2 — dashboard with HMR
npm run client:dev
```

Vite serves the dashboard at <http://127.0.0.1:5173> and proxies
`/api/*` to `http://127.0.0.1:3500`. Edits to anything under
`client/src/` reload immediately.

To produce a production bundle that the Express server will serve at
`/`, run:

```sh
npm run client:build
```

The build emits to `client/dist/`. Output is roughly 240 kB JS / 15 kB
CSS uncompressed (≈ 71 kB JS / 3.5 kB CSS gzipped).

### Design tokens

The institutional theme tokens live at `client/src/styles/tokens.css`
and the shared component CSS at `client/src/styles/shared.css`. Both
are imported once from `client/src/main.jsx`; component CSS should
read tokens via `var(--…)` rather than re-declaring colors. The
`<html data-theme="institutional">` attribute is set in
`client/index.html`; v1 ships a single theme by design.

---

## Test

```sh
# server tests (206 cases via node:test — see test_suite.md)
npm test
# end-to-end browser tests (12 cases via Playwright)
npm run test:e2e:install   # one-time chromium download
npm run test:e2e
npm test

# verify the dashboard builds
npm run client:install      # first time only
npm run client:build
```

The server suite runs against `node:test` and needs no external
runner. The client doesn't ship a separate unit-test suite in v1; the
`vite build` step is a structural check that every component compiles
and that the design tokens resolve. CI should run both.

---

## Posture

- **Local-first.** Default bind is `127.0.0.1`. The safe API surface
  enforces loopback origin.
- **PII encrypted at rest.** Every PII column stores AES-256-GCM ciphertext;
  search uses HMAC-SHA256 over normalized values. The data + HMAC keys live
  in `secret.key` (mode 0600). SQLCipher is not required.
- **PII vs pseudonym is a posture, not just a surface.** AI workflows always
  receive pseudonyms. Exports default to pseudonyms. PII exports require
  explicit consent and a destination, and are logged to the tier-2 audit
  trail.
- **No telemetry, no analytics, no phone-home.**
