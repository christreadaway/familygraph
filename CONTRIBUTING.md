# Contributing to Family Graph

Thanks for considering a contribution. Family Graph is a local-first family
registry that handles real PII, so a few of the rules below are stricter than a
typical Node project. Please read them before opening a pull request.

## Prerequisites

- **Node.js 20 or newer.**
- **Socket Firewall (`sfw`)** - required for every dependency install (see
  below). Install it once, globally.

## Dependency installs MUST go through Socket Firewall

This is a hard rule, not a preference. Plain `npm install` is **blocked** by a
`preinstall` guard in `package.json` (and `client/package.json`). The guard
exists so a typosquatted or compromised package can't land on disk before you
ever import it.

```sh
# one time
npm install -g sfw

# install dependencies (the SFW=1 marker satisfies the guard)
SFW=1 sfw npm install
SFW=1 sfw npm run client:install

# build the dashboard and run
npm run client:build
npm start
```

Putting `export SFW=1` in your shell rc is fine. **Never** set `SFW_BYPASS=1`
to force an install for convenience; the bypass exists only for a genuine `sfw`
outage, and every use must be recorded in `session_notes.md` with a one-line
reason.

## Running the tests

```sh
npm test          # server suite, via node:test (no extra runner)
npm run test:e2e  # optional Playwright browser tests
```

A change should keep the suite green. New tests live under `tests/` and follow
the `<area>.test.js` naming pattern and the `node --test` style already in the
tree.

## Code conventions

- **No new plaintext PII columns.** Encrypted PII columns end in `_ct`;
  searchable HMAC columns end in `_hash`.
- **Migrations** live in `server/db/migrations/` numbered `NNNN_*.js` with an
  `up(db)` export. Bump `SCHEMA_VERSION` in `server/db/index.js` and add a
  one-line comment describing the new version.
- **Auth surfaces** follow the existing `bearerImport` / `bearerRead` /
  `bearerMaster` / `bearerIntegration` scope pattern. Don't invent a new auth
  surface without saying why in `session_notes.md`.
- **Build logging in.** Runtime events should be logged so a few lines of
  `server.log` are enough to start debugging. The log redactor must strip
  credentials, tokens, and PII before anything lands on disk.

## PII and privacy rules (always on)

- No real institution names, people, addresses, phones, or emails in code,
  tests, examples, or docs. Use bracketed placeholders (`[Parish Name]`,
  `[Staff Name]`, `[admin@example.org]`) or the reserved `example.org` /
  `example.com` domains.
- No machine-specific local paths in user-facing docs (use `~/`).
- No API keys, tokens, or credentials in any committed file. If a credential
  must appear in an example, write `[redacted]` or a placeholder shape like
  `sk_xxxxxxxx`.

## Pull requests

- Branch off the default branch and keep commits descriptive.
- Describe what changed and why, and note any schema or contract changes.
- Run `npm test` before pushing.

## Reporting security issues

Do not open a public issue for a vulnerability. See
[`SECURITY.md`](./SECURITY.md) for private disclosure.
