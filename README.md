# Sanctus

**Local family registry for Catholic institutions.** Closed source for v1.

Sanctus is the source of truth for family identity in an institution's data
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

## Run it

```sh
npm install
npm run client:install
npm run client:build
npm start
```

Sanctus listens on `http://127.0.0.1:3500` and serves the React dashboard at
`/`. On first boot it creates `~/.sanctus/` (mode 0700), writes
`secret.key` (mode 0600), initialises the SQLite database, seeds the
built-in profiles, and starts the folder-watch agent on `~/.sanctus/watch`.

Print the master Bearer token (paste into the dashboard the first time):

```sh
node bin/sanctus.js show-token
```

---

## CLI

| Command | What it does |
|---|---|
| `node bin/sanctus.js start` | Default. Runs the API server + folder-watch agent. |
| `node bin/sanctus.js status` | Prints schema version, profile, audit count, backup count, key + watch dir paths. |
| `node bin/sanctus.js show-token` | Prints the master Bearer token. |
| `node bin/sanctus.js rotate-secret` | Regenerates the master Bearer token. The data + HMAC keys are preserved so existing ciphertext keeps decrypting. |
| `node bin/sanctus.js backup [passphrase]` | Hot snapshot. Encrypted with PBKDF2 + AES-256-GCM if a passphrase is given. |
| `node bin/sanctus.js list-backups` | Lists files in the backups directory. |
| `node bin/sanctus.js prune-backups [keep=10]` | Keeps the most recent N backups, deletes older. |
| `node bin/sanctus.js restore <passphrase> <src> <dest>` | Restores an encrypted backup to a new sqlite path. |

---

## Folder-watch agent

Drop a file in `~/.sanctus/watch`:

| Extension | Behaviour | Output in `~/.sanctus/out` |
|---|---|---|
| `.csv`, `.tsv` | Source-handler import | `<file>.import-summary.json`, source moved to `processed/` |
| `.xlsx`, `.xls`, `.xlsm` | Excel import (first sheet) | same |
| `.txt`, `.md`, `.eml`, `.json` | Text sanitization | `<stem>.sanitized.<ext>` + `<stem>.token-set.json` |
| anything else | Error | moved to `errors/` with a `.error.txt` sidecar |

Set `SANCTUS_WATCH_PROCESS_EXISTING=1` to process whatever is already in the
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
| `SANCTUS_HOME` | `~/.sanctus` | Root for data, secrets, backups, watch dirs |
| `SANCTUS_DB` | `$SANCTUS_HOME/data/sanctus.sqlite` | |
| `SANCTUS_SECRET` | `$SANCTUS_HOME/secret.key` | mode 0600, holds master/data/HMAC keys |
| `SANCTUS_WATCH_DIR` | `$SANCTUS_HOME/watch` | folder-watch input |
| `SANCTUS_OUT_DIR` | `$SANCTUS_HOME/out` | folder-watch output |
| `SANCTUS_PORT` | `3500` | |
| `SANCTUS_BIND` | `127.0.0.1` | loopback by default |
| `SANCTUS_AUTO_MERGE` | `0.92` | resolver auto-merge threshold |
| `SANCTUS_REVIEW` | `0.7` | resolver conflict-queue threshold |
| `SANCTUS_DISABLE_WATCH` | unset | set to `1` to disable the folder-watch agent |
| `SANCTUS_WATCH_PROCESS_EXISTING` | unset | set to `1` to process files already present at startup |
| `SANCTUS_DISABLE_NOTIFY` | unset | set to `1` to disable the notification dispatcher loop |
| `SANCTUS_POSTMARK_TOKEN` | unset | Postmark server token for outbound email. The `from` address and stream are configured in Settings; the token is read only from the environment. |

The active profile (Dashboard → Profiles) overrides `SANCTUS_AUTO_MERGE` /
`SANCTUS_REVIEW` for imports.

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
