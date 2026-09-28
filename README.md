# Family Graph

**Local family registry for Catholic institutions.** Open source under the Apache-2.0 license.

Family Graph is the source of truth for family identity in an institution's data
ecosystem. It accepts any list of people - whether it comes from a school
information system, a parish management platform, a Google Sheet, an Excel
workbook, or a hand-typed CSV - and reconciles it against a persistent ledger.
Shipped handlers cover common formats and systems (FACTS, RenWeb, Ministry
Platform, Google Sheets, Excel, generic CSV), but the product is
platform-agnostic: if you have a list, Family Graph can ingest it. The ledger is
exposed to the institution's other tools through a local HTTP API. PII at rest is encrypted; AI workflows always see
pseudonyms; PII exports require explicit consent and land in a tier-2 audit
trail.

The "why" lives in [`business_spec.md`](./business_spec.md). The "how" lives
in [`product_spec.md`](./product_spec.md). The decision history lives in
[`session_notes.md`](./session_notes.md), and the decisions still outstanding
live in [`OPEN_DECISIONS.md`](./OPEN_DECISIONS.md). The cross-app integration
plan lives in
[`ARCHITECTURE_MEMO_FAMILY_MANAGEMENT.md`](./ARCHITECTURE_MEMO_FAMILY_MANAGEMENT.md).

**Scope.** Family Graph is a source of identity, not a school information
system. It holds identity, relationships, and access decisions; grades,
classrooms, attendance, and coursework live in the school's own apps.
Enrollment is in scope - it is a relationship, not an education record. The
full boundary is in [`CLAUDE.md`](./CLAUDE.md).

## Provenance note: CDCF submission baseline

The codebase as of commit `d4b5306` is exactly what was submitted to
the Catholic Digital Commons Foundation (CDCF). Everything after that
commit — organizations and dated affiliations, rolling verification,
alumni transitions and departure classes, staff accounts with
domain-verified login, the dashboard UI for all of it, and the
2026-06-10 code-review fixes — postdates the initial submission and is
NOT part of what the CDCF reviewed. If the CDCF copy ever needs to be
reproduced, `git checkout d4b5306` is that snapshot; the decision
history for everything since lives in `session_notes.md`,
`IDENTITY_MODEL_SUMMARY.md`, `STAFF_ACCOUNTS_PRD.md`, and
`CODE_REVIEW_2026-06-10.md`.

---

## Security requirement: Socket Firewall

**Every `npm install` for this project MUST run through Socket Firewall
(`sfw`).** This is a hard requirement, not a recommendation. Plain
`npm install` is blocked by a `preinstall` guard in `package.json` and
will refuse to run.

Why: npm pulls hundreds of transitive packages on a fresh install. Any
one of them can ship a typosquatted or compromised version that
exfiltrates credentials or modifies code on disk before you ever import
it. Socket Firewall sits between npm and the registry, checks every
fetched tarball against Socket's risk database, and refuses known-bad
installs at the network layer. The cost is one extra word on the command
line; the benefit is one fewer way the supply chain can ruin your week.

Install `sfw` once, globally:

```sh
npm install -g sfw
```

Then run every install in this repo through `sfw` with the marker env
var set:

```sh
cd ~/familygraph
SFW=1 sfw npm ci
SFW=1 sfw npm run client:install
```

Putting `export SFW=1` in your shell rc (`~/.zshrc` / `~/.bashrc`) is
fine; the guard only needs the marker, not a re-export per command.

**Emergency bypass.** If `sfw` is genuinely unavailable (offline, broken
registry mirror, etc.) you can bypass with `SFW_BYPASS=1 npm install`.
Every bypass must be recorded in `session_notes.md` with a one-line
reason. Do not bypass for convenience.

---

## Run it (macOS / Linux)

```sh
cd ~/familygraph
SFW=1 sfw npm ci
SFW=1 sfw npm run client:install
npm run client:build
npm start
```

Family Graph listens on `http://127.0.0.1:3500` and serves the React dashboard at
`/`. On first boot it creates `~/.family-graph/` (mode 0700), writes
`secret.key` (mode 0600), initialises the SQLite database, seeds the
built-in profiles, and starts the folder-watch agent on `~/.family-graph/watch`.

Print the master Bearer token (paste into the dashboard the first time):

```sh
cd ~/familygraph
node bin/family-graph.js show-token
```

---

## Run it (Docker, or the Spark server)

The `Dockerfile` builds one image that serves the API and the dashboard on
port 3500, with every dependency install inside it going through `sfw`.
All state lives in the `/data` volume.

```sh
cd ~/familygraph
docker build -t familygraph .
docker run -v fgdata:/data -p 127.0.0.1:3500:3500 familygraph
```

Inside the container Family Graph binds `0.0.0.0` (it has to, to be
reachable on the container interface). The `-p 127.0.0.1:3500:3500` is what
keeps it on the host only. Never publish it as plain `-p 3500:3500`.

**On the managed Spark servers** this image runs in Kubernetes, deployed
from HQ ArgoCD out of the `ClaritasEDU/edge-ops` repo. Nothing is installed
by hand there:

- The version is an image pin in `sites/familygraph/<site>.values.yaml`, and
  all state lives on the pod's volume at `/data`.
- Apps inside the cluster (MissionIQ, beacon) call
  `http://familygraph.familygraph.svc:80` and never touch the site network.
- The site also publishes port `30500` on the school network (owner request,
  2026-09-28) for the dashboard and for Doc Anonymizer running on a Mac. That
  port is plain HTTP behind API keys, so keep it on a staff-only network.
- CLI commands run inside the pod:
  `k3s kubectl -n familygraph exec -it deploy/familygraph -- node bin/family-graph.js <command>`.
- The upgrade, the MissionIQ import, and the MissionIQ connection are laid
  out step by step in edge-ops `familygraph-missioniq-connect.md`.

**On a hand-built box** (Family Graph and Doc Anonymizer side by side, no
Kubernetes), both services listen on `127.0.0.1`. Reach them from your
laptop through an SSH tunnel. Doc Anonymizer talks to Family Graph at
`http://127.0.0.1:3500` on the same box.

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

3. **Install Socket Firewall (required).** Every `npm install` in this
   repo must route through `sfw`; plain `npm install` is blocked by the
   `preinstall` guard. See the "Security requirement: Socket Firewall"
   section above for the full rationale.
   ```powershell
   npm install -g sfw
   ```

4. **(Probably not needed)** `better-sqlite3` ships prebuilt Windows
   binaries for Node 20+, so `sfw npm ci` should succeed without a
   C++ toolchain. If you ever see a `node-gyp` failure, install the
   build tools once:
   ```powershell
   winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --quiet"
   winget install Python.Python.3.12
   ```

### Clone and start

```powershell
git clone https://github.com/christreadaway/familygraph.git
cd familygraph
$env:SFW = "1"
sfw npm ci
sfw npm run client:install
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
| `node bin/family-graph.js issue-key <name> [scopes]` | Provisions a scoped API key for a consuming app and prints the `sk_…` token once (only its hash is stored). Default scopes: `pii.read,pii.write,sanitize,audit.write`. Doc Anonymizer: `issue-key docanonymizer roster` (the `roster` scope only). MissionIQ: `issue-key missioniq` with default scopes - the name must be exactly `missioniq`, because `/api/identity/resolve` honors a source's crosswalk links only for the key named after that source or the master token. |
| `node bin/family-graph.js import-missioniq <missioniq.db> [--dry-run] [--category church\|school\|other] [--include-deceased]` | One-time (re-runnable) import of everyone MissionIQ knows, each with one lifelong id. Reads MissionIQ's database read-only, asks you about every uncertain match in the terminal, and writes nothing until you type `YES`. See "Importing MissionIQ" below. |
| `node bin/family-graph.js rotate-secret` | Regenerates the master Bearer token. The data + HMAC keys are preserved so existing ciphertext keeps decrypting. |
| `node bin/family-graph.js backup [passphrase]` | Hot snapshot. Encrypted with PBKDF2 + AES-256-GCM if a passphrase is given. |
| `node bin/family-graph.js list-backups` | Lists files in the backups directory. |
| `node bin/family-graph.js prune-backups [keep=10]` | Keeps the most recent N backups, deletes older. |
| `node bin/family-graph.js restore <passphrase> <src> <dest>` | Restores an encrypted backup to a new sqlite path. |
| `node bin/family-graph.js connector status` | Prints last-run timestamps + outcomes for FACTS / Ministry Platform connectors. |
| `node bin/family-graph.js connector test <facts\|ministry_platform>` | Runs the test-connection flow without writing data. |
| `node bin/family-graph.js connector sync <facts\|ministry_platform>` | Runs a full sync immediately (same path the scheduler uses). |
| `node bin/family-graph.js partner-pairing list` | Lists configured the partner app outbound pairings (secrets masked). |
| `node bin/family-graph.js partner-pairing set <schoolId> key=value ...` | Configures a pairing. Keys: `partner_base_url`, `partner_bearer_credential`, `shared_webhook_secret`, `envelope_key` (64 hex), `check_in_interval_s`. Secrets are stored encrypted and never echoed. |
| `node bin/family-graph.js partner-pairing enable\|disable <schoolId>` | Toggles a pairing. `enable` requires all fields set. |
| `node bin/family-graph.js partner-pairing check-in <schoolId>` | Runs one outbound check-in now (sync → outbox → process → inbox). |
| `node bin/family-graph.js partner-pairing remove <schoolId>` | Deletes a pairing and clears its secrets. |

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

The sanitizer uses three detection layers (regex patterns, registry HMAC lookup, and NER heuristics) and catches the large majority of PII, but no automated system detects every possible identifier. Operators should review sanitized output before sharing it with untrusted parties.

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

The auto-mapper is vendored from the upstream identity engine's ingestion module
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
audit the provenance later. Money lives in a consuming app, not here.

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

## Community ids (I… / F…)

Every community member a spreadsheet surfaces gets one lifelong id: `I` +
hex for the individual, `F` + hex for the family (household). The same
human never gets a second id, in any app, and two humans never share one.
Family Graph is the only place ids are minted. Doc Anonymizer and MissionIQ
ask Family Graph; they never mint their own.

The community id IS the Family Graph code, re-spelled: `p_<16 hex>` is
`I<16 HEX>`, `f_<16 hex>` is `F<16 HEX>` (legacy 8-hex codes work the same
way). Any case is accepted on input; ids are always emitted uppercase. When
two records are merged, the losing code becomes a permanent alias of the
winner, so an older anonymized file still restores. Nothing is minted until
every review item is decided and the operator confirms.

### Roster API (`/api/identity/roster`, `roster` scope)

All three routes need the `roster` scope (or the master token). Doc
Anonymizer's key carries only that scope:

```sh
cd ~/familygraph
node bin/family-graph.js issue-key docanonymizer roster
```

- `POST /api/identity/roster/plan` - dry run. Runs the real import inside a
  transaction and rolls it back, so it writes nothing. Returns every person
  and household as `matched`, `new`, `review`, or `skip`, with candidates
  and plain reasons for each review item.
- `POST /api/identity/roster/commit` - writes it in one transaction.
  Refused with `409 review_incomplete` (and the plan) while any review item
  is undecided or any decision has gone stale. Success is `201`. An optional
  `idempotency_key` makes retries safe: the same key and request replays the
  stored result (`200`, `replayed: true`, nothing written); the same key with
  a different request is `409 idempotency_conflict`. Keys are kept 7 days.
- `GET /api/identity/roster/lookup/:id` - an `I…`/`F…` id (or `p_`/`f_`
  code) to the current record, following merges.

Body for plan and commit: `{ sheets: [{ name?, headers, rows, mapping? }] }`
or `{ households: [...] }`, plus `decisions?`, `source?`, `source_ref?`,
`category?` (`church` / `school` / `other`), and `tags?`. A `source_ref`
names one upload; never reuse it. Limits: 20 MB body, 25 sheets, 20,000
rows, 300 columns, 4,000 characters per cell. Plan and commit share their
own rate bucket (burst 20, then 30/min). A scoped key may not send
crosswalk refs or code hints, or use another app's source name once that
source has crosswalk links (`403 roster_forbidden`).

Plan and commit run on the request thread. A 2,000-row roster takes about
9 seconds to plan and holds other Family Graph requests for that long.

The full contract is in [`INTEGRATION_GUIDE.md`](./INTEGRATION_GUIDE.md).

### Strict matching (roster imports and the MissionIQ import)

Obvious cases are automatic in both directions; anything the rules can't
settle goes to a person.

- **Same person, automatically:** exact email or phone AND a first name that
  lines up (exact, or a nickname that stands for one full name); same first
  + last name AND same birthdate; same first + last name AND the same home
  address; a name-only row in a household already known with exactly that
  name; a MissionIQ record imported before (unless it has since changed into
  someone else).
- **Different person, automatically:** a shared inbox or phone with a first
  name that doesn't line up (a spouse, a child - same household); Jr vs Sr,
  II vs III; different birthdates with nothing else shared; an adult row
  against a child record with no matching birthdate, email, or phone; two
  adults whose emails, phones, and addresses all differ. (Different house or
  unit numbers are different addresses, so they never confirm a match.)
- **Asked:** same name with nothing to confirm or rule out; same name and
  inbox but a different birthdate; several strong candidates; a stored link
  that no longer fits; placeholder names (TBD, Mom), a lone initial, or a
  business in a name column.

Only an exact name or a nickname-table pair proves a first name. Near
spellings (Luis/Luisa, Daniel/Daniela) and cross-language pairs (John/Sean,
Joseph/Jose) can send a pair to review, never auto-match. The nickname
table covers common English short forms and Spanish forms (Lupe/Guadalupe,
Paco/Francisco, Nacho/Ignacio).

### Importing MissionIQ

Run this once before any roster is anonymized, so Family Graph already
knows everyone MissionIQ knows:

```sh
cd ~/familygraph
node bin/family-graph.js import-missioniq ~/missionIQ/data/missioniq.db --dry-run
node bin/family-graph.js import-missioniq ~/missionIQ/data/missioniq.db --category church
```

It opens MissionIQ's SQLite file read-only (one consistent snapshot) and
reads its families, contacts, and children through the same strict engine.
Each uncertain item is asked in the terminal: a number means "same as that
candidate", `n` new, `s` not a person (people only), `q` stop. Nothing is
written until you type `YES`.

- `--dry-run` shows the plan and how many items would need a decision, then
  stops. Nothing written.
- `--category church|school|other` tags the import run.
- `--include-deceased` imports households MissionIQ marks deceased. Left out
  by default, along with the "Unmatched Donations" holding family, empty
  households, and emergency contacts.

Every imported MissionIQ record is linked in the crosswalk (`contact:<id>`,
`child:<id>`, `family:<id>`), so a re-run recognizes them by their MissionIQ
id and only asks about new or changed records. A do-not-contact flag carries
over (set, never cleared). A Family Graph code MissionIQ already stored is
honored only while the record still agrees with it. If one of your answers
went stale mid-run, it is dropped and re-asked; a contradictory answer is
re-asked without losing the others.

At the end it lists MissionIQ records that still carry an old Family Graph
id, with the correct one. MissionIQ's "Sync now" keeps a stored id, so
correct those ids in MissionIQ itself. Until MissionIQ can re-check or
re-stamp everything, re-run `import-missioniq` to link new records strictly.

**Before you run it:** if MissionIQ talks to Family Graph with a scoped key,
that key must be named `missioniq` (`issue-key missioniq`, then put the
token in MissionIQ's `FAMILYGRAPH_TOKEN` and restart MissionIQ). A key under
any other name gets `403 crosswalk_forbidden` on "Sync now" once the import
has linked MissionIQ's records. The master token also works.

Logs for the run go to `~/.family-graph/logs/cli.log` (counts only, never
names), not into the prompts. Paste its tail into a chat when something
goes wrong.

**On a fresh connection, import first.** Run `import-missioniq` before
MissionIQ's first "Sync now", so every MissionIQ record is linked by its own
id instead of matched by name. MissionIQ only talks to Family Graph on a new
upload or when someone presses "Sync now", so connecting it early is
harmless as long as nobody syncs.

**On the managed Spark servers** MissionIQ's database lives on its own pod's
volume. Take a read-only snapshot inside the MissionIQ pod, stream it into
the Family Graph pod, and run the import there. The exact commands are in
edge-ops `familygraph-missioniq-connect.md` (step 4).

---

## API (summary)

- `GET /api/health` — open. Returns schema version (currently 20), watch state, audit count, and a capabilities block (`capabilities_version` 3; flags include `community_ids` and `identity_crosswalk`) so consuming apps can tell what this Family Graph supports.
- `GET /api/safe/...` — loopback only, no PII ever.
- Everything else under `/api/` requires a Bearer token.

The Bearer can be the master token (full access) or a per-app `sk_…` scoped
token issued via `POST /api/keys` with one or more of the scopes
`pii.read`, `pii.write`, `sanitize`, `audit.read`, `audit.write`, `import`,
`roster`, `rules.write`, `integration`, or `*`. `roster` reaches only the
roster plan / commit / lookup routes (see "Community ids" above).

Consuming apps SHOULD set the `X-Family-Graph-Actor` header to a short
stable identifier (e.g. `donor_app`, `engagement_app`). It is recorded on
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
existing `dataKey`; neither the dashboard nor `/api/settings` ever
displays plaintext (the settings endpoint reduces each ciphertext field
to a `_set: true` flag).

Configure from the dashboard at **Settings → Connectors** (or
`/settings/connectors`). Each connector has a card with status pill +
last-run timestamp, and a detail page where the operator pastes
credentials, picks a schedule, runs Test connection, and triggers
manual syncs. The status rail at the top of every screen shows a
colored dot per configured connector — green/blue/red for ok / untested
/ error.

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

### EIM certification + volunteer ministries

Family Graph tracks Ethics and Integrity in Ministry (EIM) status
per person and ministry / volunteer rosters either per person or per
family. Both surface together because most parishes need to ask "is
this Lector still EIM-current?" on the same screen as the roster.

Per-person EIM fields (returned on every `/api/people/:code` and
editable via PATCH):

- `eim_status` — `pending` / `certified` / `expired` / null.
- `eim_completed_on` — ISO date the cert was issued.
- `eim_expires_on` — ISO date the cert lapses. Auto-derived from
  the completion date using the diocesan renewal cycle when the
  caller doesn't provide it. Explicit values always win.
- `eim_notes` — encrypted free-form notes (waiver, vendor, diocese).

Renewal cycle is configurable. Set `eim.renewal_years` (default `3`)
and `eim.expiring_soon_days` (default `60`) under `/api/settings`
or in the dashboard Settings page.

A daily sweep runs at boot and every 24h, flipping `certified` rows
whose `eim_expires_on` has passed into `expired`. The operator can
also force a sweep via the dashboard or
`POST /api/ministries/eim/recompute`.

- `GET /api/ministries` / `?status=archived|all` — catalog list.
- `POST /api/ministries` — create (name, description, requires_eim).
- `GET /api/ministries/:code` — ministry + its active assignments.
- `PATCH /api/ministries/:code` — edit catalog row.
- `DELETE /api/ministries/:code` — archive.
- `POST /api/ministries/:code/assignments` — assign a person OR a
  family (exactly one of `person_code`, `family_code`).
- `DELETE /api/ministries/assignments/:code` — end an assignment.
- `GET /api/ministries/by-person/:code` / `by-family/:code` —
  rosters this person/family is on.
- `GET /api/ministries/eim/expiring?window_days=N` — codes whose
  certs lapse inside the window. Response is intentionally PII-free.
- `POST /api/ministries/eim/recompute` — manual sweep trigger.

Whole-family rosters (Coffee & Donuts: the Smith family) are a
first-class shape — assignments toggle between person-level and
family-level on a per-row basis instead of forcing one mode for
the whole ministry. Person merges and family merges carry active
assignments onto the winning code.

Notes on the catalog:

- Ministry names are unique among **active** rows only. Archive
  one and you can later re-introduce a roster with the same name;
  the historical row keeps its assignments untouched.
- Archived ministries reject new assignments (the roster is
  retired). Existing assignments stay on the archived row so the
  audit trail survives.
- `eim_status` accepts only `pending` / `certified` / `expired` /
  empty (clears). `eim_completed_on` and `eim_expires_on` must be
  ISO-8601 dates (`YYYY-MM-DD`). Bad input gets a 400 with a
  message naming the offending field.

### Organizations + affiliations (parish / school membership)

Community membership is temporal — kids graduate, families move, people
die or stop attending. So "is this family at the parish, the school, or
both?" is never a stored flag in Family Graph. It's a query over dated
affiliation rows, the same way household composition works: leaving a
community is an end-date with a reason, not a delete.

Organizations are first-class entities with their own `org_` codes
(`kind` = `parish` / `school` / `other`, optional `diocese_code`). An
affiliation links a person OR a family (exactly one) to an organization
with a role and a lifespan. Parish registration is family-level by
convention (default role `registered` for a family at a parish); school
enrollment is person-level (`student` requires a person).

Every affiliation carries a rolling `last_verified_at` marker plus an
append-only verification trail. Verification refreshes confidence — it
never gates existence. Each piece of observed activity (a registration
form, a sacrament, liturgy or ministry participation, giving, mail and
email still landing, a connector sync returning the record, an explicit
operator attestation) appends a row and bumps the marker. A family that
goes quiet simply stops accruing rows and surfaces on the staleness
report for a human to confirm; nothing auto-expires.

- `GET /api/organizations` / `?kind=parish|school` / `?status=all` — catalog.
- `POST /api/organizations` — create (`name`, `kind`, optional `diocese_code`).
- `GET /api/organizations/:code` — organization + active affiliations.
- `PATCH /api/organizations/:code` — edit. `DELETE` — archive.
- `POST /api/organizations/:code/affiliations` — affiliate a person OR a
  family (exactly one of `person_code`, `family_code`; optional `role`).
- `DELETE /api/organizations/affiliations/:code` — end an affiliation.
  `reason` is a high-level class (`graduated` / `transferred` / `moved`
  / `deceased` / `withdrew` / `inactive` / `other`); the story behind it
  goes in `reason_detail`, and `ended_at` may be approximate (`2025`,
  `2025-08`, or a full date) for departures noticed after the fact.
  Nothing is ever removed — leaving is always an end-date.
- `POST /api/organizations/affiliations/:code/transition` — end the
  current role and open a successor in one transaction. The canonical
  case is student → alumni at graduation or transfer (default
  `to_role: "alumni"`, default reason `graduated`): leaving the student
  role doesn't mean leaving the community.
- `POST /api/organizations/affiliations/:code/verify` — record observed
  activity (`method` = `registration` / `sacrament` / `liturgy` /
  `ministry` / `giving` / `communication` / `connector_sync` /
  `attestation` / `other`, optional `source`, optional backdated
  `verified_at` — the marker only moves forward, and an optional
  `period` label like `2025-2026` or `2026` notes the participation
  year).
- `GET /api/organizations/affiliations/:code/verifications` — the
  trail, plus `periods`: the distinct years a student attended or a
  family participated on the parish roster.
- `GET /api/organizations/:code/stale?days=N` — the rolling-verification
  work queue: active affiliations nothing has confirmed in N days
  (default 365).
- `GET /api/organizations/by-person/:code` / `by-family/:code` — the
  computed "parish, school, or both" answer for one person or family.
  Affiliation rows carry joined `org_name` / `org_kind` so consumers
  don't need the organization catalog to label them.

Re-affiliating someone already active updates the row in place instead
of stacking duplicates (only the fields you actually send are touched —
a bare re-confirm never downgrades a role or clears notes); leaving and
returning produces a second dated row so history survives; re-ending an
already-ended affiliation is a 409 and the row keeps its original
reason and date. Person and family merges carry affiliations onto the
winning code, ending duplicates rather than colliding, with
entity_changes snapshots for every row the merge touches.

The dashboard surfaces all of this under **Parishes & schools**:
catalog + create, per-organization detail with the affiliation roster
(verify / transition / end inline), the verification trail with years
of participation, the stale report, and domain management. Person and
family detail pages each gain a read-only **Communities** panel, and
**Staff accounts** + **/login** cover account administration and staff
sign-in.

### Staff accounts (domain-verified login)

Named, passwordless accounts for parish and school staff. Eligibility
is proven by the institution's own web domain: an account can only be
invited on a domain the organization has verified. Staff sign in with
a magic link sent to their institutional email; redeeming it issues a
`st_…` bearer token that rides the same scope system as every other
caller. Every staff write lands in both audit logs (`audit_events` +
`entity_changes`) attributed to the person, not a shared key.

Domain verification lives on the organization record. The operator
sets the org's domain, FamilyGraph issues a token, and the parish or
school proves control either with a DNS TXT record
(`familygraph-verify=<token>`) or a well-known file at
`https://<domain>/.well-known/familygraph-verify.txt`. Changing the
domain always requires re-verification. Un-verifying or changing the
domain, or archiving the organization, doesn't just stop new logins —
it revokes the org's live staff sessions and pending links in the same
transaction, because that's the moment the operator means "stop
trusting this domain NOW".

Login is invite-only — no self-signup; the master token provisions
accounts. Staff POST their email; if an active account exists, a
single-use 15-minute link goes out through the notifications queue,
and the response never reveals whether the account exists. Redeeming
the link yields a 12-hour session. Disabling an account kills its
sessions immediately. Magic-link and session tokens are stored only as
SHA-256 hashes and never logged.

- `POST /api/organizations/:code/domain` — master only; body
  `{domain}` (null clears); returns the verification token plus
  instructions.
- `POST /api/organizations/:code/domain/verify` — master only; body
  `{method: "dns" | "http"}`.
- `GET /api/accounts` / `POST /api/accounts` /
  `PATCH /api/accounts/:code` / `DELETE /api/accounts/:code` — master
  only. POST body `{email, display_name, scopes?, org_code?}` (scopes
  from the existing vocabulary, `*` not grantable; default
  `["pii.read"]`; `org_code` disambiguates when a parish and its school
  legitimately share one verified domain). DELETE disables the account
  (revokes sessions immediately).
- `POST /api/auth/request-link` — open + rate-limited; body `{email}`;
  always returns `{ok: true}`.
- `POST /api/auth/redeem` — body `{token}`; returns
  `{token, expires_at, account}` or 401.
- `GET /api/auth/me` — session bearer; returns the account context.
- `POST /api/auth/logout` — session bearer; revokes the session.

Duplicate/merge decisions remain a human judgment call made by whoever
actually knows the family — secretary, pastor, business manager,
principal, or school staff — via the conflicts queue and its
assignment feature; see
[`STAFF_ACCOUNTS_PRD.md`](./STAFF_ACCOUNTS_PRD.md).

### External-app identity API

Consuming apps bring in their own domain data (donations, engagement
events) and delegate the identity decision to Family Graph. The main
endpoints under `/api/identity/` (plus `POST /api/identity/resolve-batch`,
up to 1,000 records per call, and `GET /api/identity/changed`, a PII-free
feed of merges and other code changes):

- `POST /api/identity/match` — read-only peek. Body: `{ record: {...} }`.
  Returns `{ action, confidence, reasons, definitive, candidate, thresholds }`
  so the caller can preview what Family Graph WOULD do without committing.
- `POST /api/identity/resolve` — commit. Same input shape; runs the
  resolver and writes the outcome. Returns `{ code, action, score,
  reasons, conflict? }` — the calling app stores its domain data keyed
  by `code`. Optional `source`, `source_ref`, and `with_family`. When the
  caller is the master token or the key named after `source` and the record
  was linked by a deliberate import (the MissionIQ import), the linked
  person comes back directly (`via: "crosswalk"`) as long as the record
  still describes them; otherwise it goes through the normal resolver and
  says `via: "crosswalk_mismatch"`. A key under another name sending that
  source's record refs gets `403 crosswalk_forbidden`, naming the fix.
- `POST /api/identity/feedback` — the calling app records `same` or
  `different` for a pair. `different` is "sticky": future imports will
  not re-flag that pair as a conflict. `same` merges with the supplied
  `winner_code`.

Input records accept both flat shapes (`first_name`, `last_name`,
`email`, `phone`) and structured shapes (`given_name`, `family_name`,
`emails[]`, `phones[]`, `address: {...}`) so the calling app passes
through whatever its native rows look like.

### FamilyGraph Integration API (`/v1/...`)

A separate, versioned API surface that any app integrates against.

**Documentation map:**
- [`FAMILYGRAPH_INTEGRATION.md`](./FAMILYGRAPH_INTEGRATION.md) — the
  contract spec. Read this first. Appendices A / B / C document the
  v0.1 launch, v0.2 additions (per-school overrides, dioceses,
  restorable deletions), and the audit-pass bug fixes.
- [`INTEGRATION_GUIDE.md`](./INTEGRATION_GUIDE.md) — generic,
  app-agnostic reference for any app that wants to consume
  FamilyGraph as the identity layer. Use this when wiring a future
  app (parish faith-formation, school-events, etc.) on top of the
  same hub.

Quick sketch:

- Mount point: `/v1/...`. All routes require Bearer with the
  `integration` scope (master token also works).
- Every request should send `X-FG-Contract-Version: v0.2` (`v0.1` is
  still accepted for back-compat). Unknown majors get `426 Upgrade
  Required`. FG echoes `X-FG-Contract-Version: v0.2` on every response.
- Consent and school-context writes have canonical surfaces:
  `POST /v1/consents` (person-keyed, optional `schoolId` override) and
  `POST /v1/schools/:schoolId/context` (school-keyed enrichment
  snapshot). The older `POST /v1/persons/:id/photoConsent` and
  `POST /v1/persons/:id/schoolContext` routes stay mounted and write
  the same rows.
- Writes (POST / PATCH) honour `X-Request-Id` for 24-hour idempotency
  and surface `X-FG-Idempotent-Replay: true` when a duplicate is hit.
- GETs return ETag + `Cache-Control: max-age=30`. PATCHes honour
  `If-Match` and return 412 on a stale token.
- Photo + directory consent is identity-level by default; the same
  endpoint accepts a `schoolId` to set/read a per-school override.
  The effective consent for `(person, school)` is `override-or-base`
  per field. List active overrides at
  `GET /v1/persons/:id/consent/overrides`.
- Dioceses are the system of record for EIM. Catalog at `/v1/dioceses`;
  each cert references its issuing diocese via `dioceseCode` +
  `dioceseRecordId`. Per-diocese `eim_renewal_years` supersedes the
  global setting for auto-derivation.
- "Deletions" are recoverable: `POST /v1/persons/:id/archive` flips
  status to `'archived'` and writes a full row snapshot to the
  `entity_changes` log; `POST /v1/persons/:id/reinstate` reverses it.
  Same pattern for households + dioceses. The change history is
  readable at `GET /v1/persons/:id/history` and
  `GET /v1/households/:id/history`.
- Archived persons in the `/v1/persons/changed?since=` feed appear
  as tombstones (`{ personId, active: false, status, updatedAt }`),
  not as full records — the feed's job is "tell the app what to
  invalidate," not "rebroadcast PII for a removed record." Direct
  `GET /v1/persons/:id` still returns the full record for operator
  UIs that want the historical view.
- Every meaningful write (create, update, archive, reinstate, merge,
  split, consent set, EIM cert add, school context upsert) is logged
  to `entity_changes` with a full row snapshot. The write and the log
  row are wrapped in one transaction so a log failure rolls back the
  data write — there's no path that leaves data and audit out of sync.
- Webhooks fire from `POST /v1/persons`, `PATCH /v1/persons/:id`,
  `POST /v1/persons/:id/photoConsent` (with optional `schoolId` in the
  payload), `POST /v1/persons/:id/eimCertifications`, archive/reinstate,
  `POST /v1/households`, and `POST /v1/households/:id/members`. Body is
  HMAC-signed via `X-FG-Signature: sha256=...` using each
  subscription's stored secret.
- Subscriptions: `POST /v1/webhooks` / `GET /v1/webhooks` /
  `DELETE /v1/webhooks/:code`. Unsubscribe is a soft-disable that
  preserves the row + secret; pass `?status=all` to see disabled
  subscriptions and use the helper module's `resubscribe()` to bring
  one back. Disable the dispatcher with
  `FAMILY_GRAPH_DISABLE_INTEGRATION_WEBHOOKS=1`.
- **Federation push** (for consumers that can't pull): subscribe with
  `"federationPush": true` and FamilyGraph sends FAT, hex-keyed batches
  — the full person/household objects, not just ids — so a cloud app
  reaching an on-prem FamilyGraph only over outbound POSTs can
  hydrate + reconcile without ever calling back in. The first batch is
  a full snapshot (`"hydration": true`), later batches are
  changed-since deltas, archived records arrive as `active:false`
  tombstones, and every record is keyed by the canonical `personId` /
  `householdId` hex. `POST /v1/webhooks/:code/resync` resets the
  cursors to force a re-hydrate. Federation subscriptions are excluded
  from thin per-change webhooks (the fat batch is the only channel).
  Batches are materialized at send time — no PII is persisted in
  `webhook_deliveries`. Pusher runs every ~60s; disable with
  `FAMILY_GRAPH_DISABLE_FEDERATION_PUSH=1`. See INTEGRATION_GUIDE.md §8.7.

### the partner app outbound agent (Option A — "no open doors")

the partner app is a public cloud app. FamilyGraph opens **no inbound
internet port** (it binds loopback by default) — all FG↔partner traffic is
initiated by FG as outbound HTTPS to the partner app's public endpoints. The partner app never
calls FG. Once an operator pairs and **enables** the partner app tenant, an
in-process scheduler dials the partner app on a per-tenant interval (default 20s) and
runs four calls per tick: `POST /familygraph-sync` (push the
reconciliation batch since the partner app's last-acked cursor), `GET
/familygraph-outbox` (fetch parked work items), process each item
locally with FG's existing sanitize / identity-resolver / school-context
engines, then `POST /familygraph-inbox` (return results keyed by item id
for idempotent ack). Item kinds: `sanitize`, `desanitize`,
`identity.resolve`, `schoolContext`, plus the Document Vault kinds
`document.store` and `document.fetch` (see below). Every call carries a
bearer credential plus an `X-FG-Signature`
HMAC over the raw body. Any payload carrying PII / de-anonymized text /
resolved names is **envelope-encrypted** with a shared key on top of TLS
(`server/integration/envelope.js`); codes, cursors, request ids and acks
travel cleartext inside the TLS+HMAC envelope. Real-time webhooks
(above) remain the low-latency FG→partner path; the sync batch is the
catch-up backstop.

The scheduler is dormant unless a pairing is enabled — with zero enabled
pairings it makes no outbound call. Configure pairings via the
`partner-pairing` CLI, the operator-only `/api/partner-pairings` API (master
bearer), or the **the partner app** settings tab. Disable the agent entirely
with `FAMILY_GRAPH_DISABLE_PARTNER_OUTBOUND=1`.

### Document Vault (FG is the authoritative access gate)

Sensitive child documents (sacramental, learning-accommodation,
health/allergy records) live **encrypted in FG's vault** and surface to
the partner app **just-in-time** over the same outbound spine — no new endpoints, no
inbound ports. The file bytes and title are encrypted **at rest** with
the local `dataKey` (AES-256-GCM); on an **authorized** fetch the bytes
are re-sealed with the pairing envelope key for transport. The partner app holds no
document bytes at rest — it asks FG per fetch and **FG makes the access
decision and audits it** (Tier-2). The partner app parks two outbox kinds: `document.store` (FG persists the bytes,
returns an opaque `doc_…` ref) and `document.fetch` (FG applies the
access matrix to the partner app's asserted viewer, enforces a 10 MB cap, and returns
the sealed bytes on ALLOW or `{ ok:false, error }` on DENY). Document and
health-safety-flag changes also flow to the partner app as **metadata-only**
ChangeEvents inside the sealed sync batch (`document.updated/deleted`,
`health.safetyFlags.updated/cleared`) — bytes never ride the sync batch.
The access matrix (who can see what) lives in
`server/integration/documentPolicy.js`; the full table is in
`FAMILYGRAPH_INTEGRATION.md` §7.

Operator surface: `/api/documents` (master bearer, operator-only — opens
no inbound surface to the partner app). `POST /api/documents` stores a document
(JSON, base64 body); `GET /api/documents/person/:code` lists a person's
documents; `GET /api/documents/:docRef` returns metadata + title; `GET
/api/documents/:docRef/content` downloads decrypted bytes; `DELETE
/api/documents/:docRef` archives; `PUT|GET|DELETE
/api/documents/safety/:code` sets, reads, or clears a person's health
safety flags (allergens, severity, medication, emergency contact).

### Auto-merge vs prompt-the-user (the matching gate)

`server/identity/matching.js` ports the upstream identity engine's scoring with one
correctness fix. The decision flow:

1. **Definitive signals** (auto-merge at 0.95 confidence):
   - Exact email (multi-value aware: comma/semicolon-separated)
   - Exact phone (multi-value, country-code stripped, concatenation split)
   - Exact name + exact DOB — promoted to definitive because child
     rosters frequently lack email/phone
   - Address line1 > 0.85 similarity AND both first and last name line
     up (fixed 2026-09-28: a shared surname at one address used to be
     enough, which fused spouses)
2. **Definitive-signal vetoes** drop confidence below auto-merge:
   - Different states on otherwise-matching addresses (catches
     inherited-mailbox / cross-generation cases)
   - Address similarity < 0.5
   - A birthdate conflict (or a possible day/month or century misreading)
   - A Jr/Sr (generational suffix) conflict
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

**Critical correctness fix vs the upstream identity engine:** address-only auto-merge with
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
| `FAMILY_GRAPH_AUTO_MERGE` | `0.85` | resolver auto-merge threshold |
| `FAMILY_GRAPH_REVIEW` | `0.30` | resolver conflict-queue threshold |
| `FAMILY_GRAPH_DISABLE_WATCH` | unset | set to `1` to disable the folder-watch agent |
| `FAMILY_GRAPH_WATCH_PROCESS_EXISTING` | unset | set to `1` to process files already present at startup |
| `FAMILY_GRAPH_DISABLE_NOTIFY` | unset | set to `1` to disable the notification dispatcher loop |
| `FAMILY_GRAPH_DISABLE_INTEGRATION_WEBHOOKS` | unset | set to `1` to disable the integration webhook dispatcher (pending rows accumulate until re-enabled) |
| `FAMILY_GRAPH_DISABLE_FEDERATION_PUSH` | unset | set to `1` to disable the federation pusher (fat hex-keyed hydration/reconciliation batches to `federationPush` subscriptions) |
| `FAMILY_GRAPH_DISABLE_PARTNER_OUTBOUND` | unset | set to `1` to disable the partner app outbound check-in scheduler entirely. Dormant anyway when no pairing is enabled. |
| `FAMILY_GRAPH_DISABLE_RATE_LIMIT` | unset | set to `1` to disable per-Bearer-token rate limiting on `/api` and `/v1`. Defaults: 600/min for `/api`, 1200/min for `/v1`, 60/min for `/api/sanitize`, 30/min for `/api/import`, 30/min (burst 20) for roster plan/commit. Disable only for diagnostics; the limits are deliberately generous and shouldn't trip legitimate integration traffic. |
| `FAMILY_GRAPH_POSTMARK_TOKEN` | unset | Postmark server token for outbound email. The `from` address and stream are configured in Settings; the token is read only from the environment. |
| `FAMILY_GRAPH_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` \| `silent` |
| `FAMILY_GRAPH_LOG_FILE` | `$FAMILY_GRAPH_HOME/logs/server.log` | JSON-lines log destination (mirrored to stderr). `import-missioniq` writes to `$FAMILY_GRAPH_HOME/logs/cli.log` instead, unless this is set. |
| `FAMILY_GRAPH_LOG_MAX_BYTES` | `10485760` (10 MB) | rotation cap: past this size the file is renamed to `server.log.1` (one prior generation kept) and a fresh file starts |

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
- `uncaught_exception` / `unhandled_rejection` — process-level crash
  capture. An uncaught exception logs its stack and exits(1); an
  unhandled promise rejection logs and the server keeps running. Either
  way the tail of `server.log` says why a process died instead of the
  file just ending mid-flight.
- `db.migration_applied` / `db.schema_version_bumped` — one line per
  schema migration applied at startup.
- `*.sweep_failed` — background sweep failures (conflict assignments,
  reminders, idempotency keys, token sets) at `warn`; sweeps stay
  non-fatal.
- `roster.plan.*` / `roster.commit.*` - roster imports: counts, timings,
  and refusal reasons, never names or contact details.
- `identity.resolve.crosswalk_forbidden` / `crosswalk_mismatch` - a
  MissionIQ-linked record was refused or no longer fit its link.
- `notify.dispatch_failed`, `folder_watch.start_failed`, etc.

`import-missioniq` logs to its own file, `~/.family-graph/logs/cli.log`
(counts only), so log lines never land in the middle of its prompts.

The file rotates when it exceeds `FAMILY_GRAPH_LOG_MAX_BYTES` (default
10 MB): `server.log` becomes `server.log.1` (replacing any previous
`.1`) and a fresh file starts, so disk usage stays bounded at roughly
twice the cap.

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

The dashboard keeps its own client-side log: a rolling in-memory buffer
(cap 1,000 entries, redacted with the same key list before buffering,
persisted to `sessionStorage`, never sent anywhere) that records every
API call, window error, unhandled rejection, and render crash. Open
**Dashboard → Diagnostics** to download or copy it — paste those lines
next to the matching `server.log` lines when reporting a bug. A render
crash shows a fallback screen with the same Download log button.

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

Some features are API-only in v1 and do not have dashboard pages yet:
the dioceses catalog, per-school consent overrides, and webhook
subscription management. See [`INTEGRATION_GUIDE.md`](./INTEGRATION_GUIDE.md)
and [`FAMILYGRAPH_INTEGRATION.md`](./FAMILYGRAPH_INTEGRATION.md) for those
endpoints.

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
cd ~/familygraph
# server tests (772 cases via node:test; 1 skips when run as root)
npm test
# end-to-end browser tests (12 cases via Playwright)
npm run test:e2e:install   # one-time chromium download
npm run test:e2e

# verify the dashboard builds
SFW=1 sfw npm run client:install   # first time only
npm run client:build
```

The server suite runs against `node:test` and needs no external
runner. The client doesn't ship a separate unit-test suite in v1; the
`vite build` step is a structural check that every component compiles
and that the design tokens resolve. CI should run both.

---

## Posture

- **Local-first.** Default bind is `127.0.0.1`. The safe API surface
  enforces loopback origin. In Docker, publish as `-p 127.0.0.1:3500:3500`.
- **Logs carry counts, codes, and timings.** Never names, emails, phones,
  addresses, birthdates, document text, or keys.
- **PII encrypted at rest.** Every PII column stores AES-256-GCM ciphertext;
  search uses HMAC-SHA256 over normalized values. The data + HMAC keys live
  in `secret.key` (mode 0600). SQLCipher is not required.
- **PII vs pseudonym is a posture, not just a surface.** AI workflows always
  receive pseudonyms. Exports default to pseudonyms. PII exports require
  explicit consent and a destination, and are logged to the tier-2 audit
  trail.
- **No telemetry, no analytics, no phone-home.**

---

## Contributing & security

Contributions are welcome - see [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the
dev setup (including the required Socket Firewall install), how to run the
tests, and the code conventions. To report a vulnerability, please disclose it
privately per [`SECURITY.md`](./SECURITY.md) rather than opening a public issue.

---

## Author & license

Family Graph was created by **Chris Treadaway**
([christreadaway@gmail.com](mailto:christreadaway@gmail.com)).

Licensed under the **Apache License 2.0**. See [`LICENSE`](./LICENSE) and
[`NOTICE`](./NOTICE). You are free to use, modify, and distribute this
software; please keep the attribution above.

### Support the project

If Family Graph saved you time and you want to say thanks:

- **Venmo tips:** [@ctreada](https://venmo.com/u/ctreada)
- **Donations:** to **St. Theresa Catholic School**, which this work
  supports.

### Dedication

Built in service to **Pope Leo XIV**, and for the **glory of God**.
