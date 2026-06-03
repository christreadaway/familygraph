# Family Graph - Project Summary

**What it is.** Family Graph is a local-first family-identity registry for
Catholic schools and parishes. It ingests files from existing systems (FACTS,
RenWeb, Ministry Platform, Google Sheets, Excel, CSV), reconciles people and
households into one encrypted ledger, and serves that identity to the
institution's other apps over a local HTTP API at `127.0.0.1:3500`. PII is
AES-256-GCM encrypted at rest; AI workflows and exports default to pseudonyms;
PII exports require explicit consent and land in a tier-2 audit trail. It runs
entirely on the operator's machine - no telemetry, no cloud. Apache-2.0.

**Local install (macOS / Linux, Node.js 20+).** Dependency installs must route
through Socket Firewall (`sfw`):

```
npm install -g sfw
SFW=1 sfw npm install
SFW=1 sfw npm run client:install
npm run client:build
npm start
```

First boot creates `~/.family-graph/` (mode 0700), writes `secret.key` (0600),
initializes the SQLite database, and starts the folder-watch agent. Print the
admin Bearer token with `node bin/family-graph.js show-token`, then open
`http://127.0.0.1:3500`.

**Admin settings (environment variables).**

- `FAMILY_GRAPH_HOME` - data, secret, and backup root (default `~/.family-graph`)
- `FAMILY_GRAPH_BIND` / `FAMILY_GRAPH_PORT` - listen address / port (default `127.0.0.1` / `3500`)
- `FAMILY_GRAPH_DB` / `FAMILY_GRAPH_SECRET` - database and key-file paths
- `FAMILY_GRAPH_AUTO_MERGE` / `FAMILY_GRAPH_REVIEW` - identity match thresholds (default `0.92` / `0.7`)
- `FAMILY_GRAPH_WATCH_DIR` / `FAMILY_GRAPH_OUT_DIR` - folder-watch input / output
- `FAMILY_GRAPH_POSTMARK_TOKEN` - token for outbound email
- `FAMILY_GRAPH_LOG_LEVEL` / `FAMILY_GRAPH_LOG_FILE` - log level and file (default `info`, `<home>/logs/server.log`)
- Disable toggles (set to `1`): `FAMILY_GRAPH_DISABLE_WATCH`, `FAMILY_GRAPH_DISABLE_NOTIFY`, `FAMILY_GRAPH_DISABLE_INTEGRATION_WEBHOOKS`, `FAMILY_GRAPH_DISABLE_RATE_LIMIT`

**Integrating other apps.** Apps authenticate to the `/v1` Integration API with
a scoped Bearer key (issued via the dashboard or `POST /api/keys`) and plug into
the same identity, household, consent, and webhook contract. See
`INTEGRATION_GUIDE.md`.
