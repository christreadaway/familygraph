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
enqueued, conflicts opened, addresses/emails/phones attached. The
dashboard's **Imports log** lists every run; click into one to see
exactly which families and people that file produced.

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

The full route table is in [`product_spec.md`](./product_spec.md#api-contract).

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

## Test

```sh
npm test
```

Runs the full `node:test` suite (>100 cases). No external test runner is
required.

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
