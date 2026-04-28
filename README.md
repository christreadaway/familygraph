# Custos

**Local family registry for Catholic institutions.** Closed source for v1.

Custos is the source of truth for family identity in an institution's data
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

Custos listens on `http://127.0.0.1:3500` and serves the React dashboard at
`/`. On first boot it creates `~/.custos/` (mode 0700), writes
`secret.key` (mode 0600), initialises the SQLite database, seeds the
built-in profiles, and starts the folder-watch agent on `~/.custos/watch`.

Print the master Bearer token (paste into the dashboard the first time):

```sh
node bin/custos.js show-token
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
git clone https://github.com/christreadaway/custos.git
cd custos
npm install
npm run client:install
npm run client:build
npm start
```

The first boot creates `$HOME\.custos\` (i.e. `C:\Users\<you>\.custos\`)
with `secret.key`, the SQLite database, the watch and backups
directories, and seeds the built-in profiles. Open
<http://127.0.0.1:3500> in a browser. To get the Bearer token to paste
into the dashboard:

```powershell
node bin/custos.js show-token
```

Stop the server with `Ctrl+C` in the PowerShell window.

### Setting environment variables in PowerShell

Per-session (only affects the current PowerShell window):

```powershell
$env:CUSTOS_POSTMARK_TOKEN = "your-server-token-here"
$env:CUSTOS_HOME           = "D:\custos-data"   # if you don't want it under your profile
npm start
```

Persistent (user-level, applies to every new PowerShell window from now on):

```powershell
[Environment]::SetEnvironmentVariable('CUSTOS_POSTMARK_TOKEN', 'your-server-token-here', 'User')
```

Reopen PowerShell after running that command for the new value to be
visible.

### Running as a Windows service (optional)

For an always-on deployment, the easiest path is **NSSM** (Non-Sucking
Service Manager):

```powershell
winget install NSSM.NSSM
# In an *Administrator* PowerShell:
nssm install Custos "C:\Program Files\nodejs\node.exe" "$PWD\server\index.js"
nssm set     Custos AppDirectory "$PWD"
nssm set     Custos AppEnvironmentExtra "CUSTOS_POSTMARK_TOKEN=your-token"
nssm start   Custos
# To stop:    nssm stop Custos
# To remove:  nssm remove Custos confirm
```

Alternatively, register a Scheduled Task that runs at logon with
`At log on of <user>` triggering `pwsh.exe -Command "cd C:\path\to\custos; npm start"`.

### Windows-specific caveats

- **File permissions.** Node's `fs.mkdirSync(p, { mode: 0o700 })` and
  `fs.writeFileSync(p, data, { mode: 0o600 })` are silently ignored on
  Windows; the secret key file inherits the user-profile NTFS ACL.
  That's acceptable on a single-operator workstation. Treat
  `$HOME\.custos\` as you would any folder containing credentials —
  don't share it. v2 will move the master/data/HMAC keys to the
  Windows Credential Manager.
- **Long paths.** If `$env:CUSTOS_HOME` is on a deeply nested path,
  enable Windows long-path support (`Group Policy → Computer
  Configuration → Administrative Templates → System → Filesystem →
  Enable Win32 long paths`) before installing — otherwise some
  `node_modules` extraction may fail.
- **Antivirus.** SQLite write-ahead-log files (`*.sqlite-wal`,
  `*.sqlite-shm`) are excluded from Defender by Microsoft's standard
  exclusions. If you use a third-party AV, exclude `$HOME\.custos\`
  to avoid intermittent locks.
- **Folder watch.** `chokidar` uses Windows native file events, which
  is reliable on local drives but can be flaky on network shares.
  Keep `$env:CUSTOS_WATCH_DIR` on a local disk.

---

## CLI

| Command | What it does |
|---|---|
| `node bin/custos.js start` | Default. Runs the API server + folder-watch agent. |
| `node bin/custos.js status` | Prints schema version, profile, audit count, backup count, key + watch dir paths. |
| `node bin/custos.js show-token` | Prints the master Bearer token. |
| `node bin/custos.js rotate-secret` | Regenerates the master Bearer token. The data + HMAC keys are preserved so existing ciphertext keeps decrypting. |
| `node bin/custos.js backup [passphrase]` | Hot snapshot. Encrypted with PBKDF2 + AES-256-GCM if a passphrase is given. |
| `node bin/custos.js list-backups` | Lists files in the backups directory. |
| `node bin/custos.js prune-backups [keep=10]` | Keeps the most recent N backups, deletes older. |
| `node bin/custos.js restore <passphrase> <src> <dest>` | Restores an encrypted backup to a new sqlite path. |

`npm run start`, `npm run dev`, `npm run status`, `npm run backup`,
`npm run rotate-secret`, and `npm test` are equivalent shortcuts and
work identically on macOS, Linux, and Windows PowerShell.

---

## Folder-watch agent

Drop a file in `~/.custos/watch`:

| Extension | Behaviour | Output in `~/.custos/out` |
|---|---|---|
| `.csv`, `.tsv` | Source-handler import | `<file>.import-summary.json`, source moved to `processed/` |
| `.xlsx`, `.xls`, `.xlsm` | Excel import (first sheet) | same |
| `.txt`, `.md`, `.eml`, `.json` | Text sanitization | `<stem>.sanitized.<ext>` + `<stem>.token-set.json` |
| anything else | Error | moved to `errors/` with a `.error.txt` sidecar |

Set `CUSTOS_WATCH_PROCESS_EXISTING=1` to process whatever is already in the
watch dir at startup (default: only new files are picked up).

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
| `CUSTOS_HOME` | `~/.custos` | Root for data, secrets, backups, watch dirs |
| `CUSTOS_DB` | `$CUSTOS_HOME/data/custos.sqlite` | |
| `CUSTOS_SECRET` | `$CUSTOS_HOME/secret.key` | mode 0600, holds master/data/HMAC keys |
| `CUSTOS_WATCH_DIR` | `$CUSTOS_HOME/watch` | folder-watch input |
| `CUSTOS_OUT_DIR` | `$CUSTOS_HOME/out` | folder-watch output |
| `CUSTOS_PORT` | `3500` | |
| `CUSTOS_BIND` | `127.0.0.1` | loopback by default |
| `CUSTOS_AUTO_MERGE` | `0.92` | resolver auto-merge threshold |
| `CUSTOS_REVIEW` | `0.7` | resolver conflict-queue threshold |
| `CUSTOS_DISABLE_WATCH` | unset | set to `1` to disable the folder-watch agent |
| `CUSTOS_WATCH_PROCESS_EXISTING` | unset | set to `1` to process files already present at startup |
| `CUSTOS_DISABLE_NOTIFY` | unset | set to `1` to disable the notification dispatcher loop |
| `CUSTOS_POSTMARK_TOKEN` | unset | Postmark server token for outbound email. The `from` address and stream are configured in Settings; the token is read only from the environment. |

The active profile (Dashboard → Profiles) overrides `CUSTOS_AUTO_MERGE` /
`CUSTOS_REVIEW` for imports.

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
