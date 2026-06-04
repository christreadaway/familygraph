# Security Policy

Family Graph holds personally identifiable information (PII) for families at
schools and parishes. Security is the point of the project, not an
afterthought. If you find a vulnerability, please tell us privately first.

## Reporting a vulnerability

**Do not open a public GitHub issue for a security problem.**

Email **christreadaway@gmail.com** with:

- a description of the issue and the impact you believe it has,
- the steps (or a proof of concept) to reproduce it,
- the affected file(s) / endpoint(s) and the version or commit you tested.

You can expect an acknowledgement within a few days. We will work with you on a
fix and a coordinated disclosure, and we are glad to credit you unless you
prefer to stay anonymous.

## Supported versions

Family Graph is pre-1.0. Security fixes land on the default branch and the most
recent release; older snapshots are not separately patched. Run a current
checkout.

## Security model (what the design assumes)

- **Local-first.** The server binds to `127.0.0.1` by default; the "safe" API
  surface enforces a loopback origin. There is no telemetry and no phone-home.
- **PII encrypted at rest.** Every PII column stores AES-256-GCM ciphertext
  (columns end in `_ct`); search uses HMAC-SHA256 over normalized values
  (columns end in `_hash`). The data and HMAC keys live in `secret.key`
  (mode 0600). No plaintext PII column should ever be added.
- **Pseudonyms by default.** AI workflows and exports receive opaque
  identifiers, not PII. Exporting real PII requires explicit consent and a
  destination, and is recorded in a tier-2 audit trail.
- **Scoped access.** Apps authenticate with per-app Bearer keys scoped to the
  smallest capability they need (`pii.read`, `import`, `integration`, etc.)
  rather than sharing the master token.
- **Supply chain.** Every dependency install must route through Socket Firewall
  (`sfw`), which checks fetched packages against Socket's risk database before
  they touch disk. See `CONTRIBUTING.md`.

## Known issues

- **`xlsx` (SheetJS) advisories** GHSA-4r6h-8v6p-xvw6 (prototype pollution) and
  GHSA-5pgg-2g8v-p4x9 (ReDoS). There is **no fixed version on the npm
  registry** - SheetJS publishes maintained builds only from their own CDN.
  Family Graph uses `xlsx` solely to parse spreadsheets the operator
  deliberately imports from their own machine (FACTS / RenWeb / donor exports),
  not untrusted network input, which bounds the exposure to files the operator
  already chose to trust. Treat imported spreadsheets as you would any file you
  run through a parser. Migrating to the SheetJS CDN build (or a maintained
  alternative) is tracked as a follow-up.
