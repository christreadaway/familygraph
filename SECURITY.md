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

- **`uuid` (transitive via `exceljs`)** GHSA-w5hq-g745-h8pq (moderate -
  missing buffer bounds check in v3/v5/v6 when the caller passes an explicit
  `buf` argument). Family Graph does not call uuid directly and exceljs does not
  pass a buffer argument, so the vulnerable code path is not exercised. The fix
  (`uuid >=11.1.1`) would require downgrading exceljs to a breaking-change
  release. Tracked as a follow-up; no practical exposure in current usage.
