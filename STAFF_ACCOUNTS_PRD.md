# PRD: Staff accounts with domain-verified login

2026-06-10. Written from the operator conversation recorded in
`IDENTITY_MODEL_SUMMARY.md`.

## 1. What this is

Named, passwordless staff accounts for FamilyGraph, where account
eligibility is proven by the parish or school's own web domain. Staff
sign in with a magic link sent to their institutional email and edit
records in the same dashboard the operator uses today, with every
change attributed to them personally.

## 2. Who it's for

- **Parish/school office staff** (secretary, business manager, DRE) who
  need to correct records day-to-day without going through the operator.
- **The operator**, who provisions accounts, verifies the domain, and
  retains the master token for administration.

## 3. User stories / jobs to be done

1. As the operator, I verify once that `[parish-domain.org]` belongs to
   our parish, so accounts on that domain can be trusted.
2. As the operator, I invite `[staff-name]@[parish-domain.org]` with
   read or read+write permission, so the office can work directly.
3. As a staff member, I enter my email, click the link it sends me, and
   I'm in — no password to remember or leak.
4. As a staff member, I fix a family's address/phone/membership and the
   change is recorded under my name.
5. As a staff member, I review the conflicts queue and make the final
   judgment call on whether two records are duplicates or genuinely
   different people. **That decision is mine, never the system's.**
6. As any of the people who might actually know — the parish secretary,
   the pastor, the business manager, the principal, or a member of
   school staff — I can be the one who answers a duplicate question.
   Knowledge of "is this the same family?" lives in different chairs
   for different families, so a conflict can be assigned to whichever
   staff account would know (the existing per-conflict assignment +
   TTL machinery), and any account with write permission can resolve.
7. As the operator, I revoke one departing staff member's access
   without touching anyone else's.

## 4. Core features

- **Domain verification** on the organization record: operator sets the
  domain, FamilyGraph issues a verification token, the parish proves
  control via a DNS TXT record (`familygraph-verify=<token>`) or a
  well-known file (`https://<domain>/.well-known/familygraph-verify.txt`).
- **Invited accounts only.** No self-signup. The operator (master
  token) invites an email address; the invite is refused unless the
  address's domain matches a verified, active organization domain.
- **Magic-link login.** Staff POST their email; if an active account
  exists, a single-use link (15-minute expiry) is emailed through the
  existing notifications queue. The response never reveals whether the
  account exists.
- **Sessions.** Redeeming the link issues a `st_…` session token
  (12-hour expiry) that the dashboard sends as a Bearer token. Same
  middleware, same scope checks as every other caller.
- **Per-person audit attribution.** The session's actor is the staff
  account, so `audit_events` and `entity_changes` rows say who.
- **Revocation.** Disabling an account kills its sessions immediately.

## 5. Business rules and logic

- An account's email domain MUST match a verified domain on an active
  organization at invite time. If the domain is later removed or the
  organization archived, login requests for its accounts are refused.
- Magic-link tokens: single-use, 15-minute expiry, stored only as
  SHA-256 hashes. Sessions: 12-hour expiry, hash-stored, sliding
  inactivity timeout out of scope for v1.
- At most 3 outstanding (unredeemed, unexpired) links per account;
  further requests are throttled silently.
- Account scopes come from the existing vocabulary (`pii.read`,
  `pii.write`, `audit.read`, ...). No new scope grammar. `*` is not
  grantable to a staff account — master stays with the operator.
- **Duplicate resolution is a human judgment call.** The resolver may
  auto-link an incoming import row to an existing record only on
  definitive signals (unchanged from today); collapsing two existing
  person/family records always requires an explicit human decision in
  the conflicts queue. No staff-account feature, batch tool, or future
  automation may merge existing records without a named human actor.
- **The right human varies per conflict.** Parish secretary, pastor,
  business manager, principal, school staff — whoever knows the family.
  Accounts on either a parish domain or a school domain are
  first-class; resolution is not restricted to a single role, and the
  conflicts assignment feature routes a question to the person who
  would know.
- Every write by a staff session lands `audit_events` +
  `entity_changes` rows with the account as actor (hard rule: any
  change must have an audit trail).

## 6. Data requirements

- `organizations` gains: `domain`, `domain_verification_token`,
  `domain_verified_at`, `domain_verification_method` (`dns` | `http`).
- `admin_accounts`: `acct_` code, `email_ct` (encrypted) +
  `email_hash` (HMAC, lookup), `display_name`, `org_code`, `scopes`
  (JSON), `status` (`active` | `disabled`), timestamps, `last_login_at`.
  Never a plaintext email column (PII rule).
- `admin_login_tokens`: `mlt_` code, `account_code`, `token_hash`,
  `expires_at`, `used_at`.
- `admin_sessions`: `asn_` code, `account_code`, `token_hash`,
  `expires_at`, `revoked_at`, `created_at`, `last_used_at`.

## 7. Integrations and dependencies

- Magic-link delivery rides the existing notifications queue
  (Postmark transport or log transport in dev). If notifications are
  disabled, the operator can read the link from the pending queue —
  login is degraded, not broken.
- Domain verification uses `node:dns` TXT lookup or an HTTPS fetch of
  the well-known path. Both are injectable for tests.
- Auth middleware extension: `st_` tokens resolve through
  `admin_sessions` exactly where `sk_` keys resolve through `api_keys`.

## 8. Out of scope (v1)

- OIDC / Google Workspace / Microsoft 365 sign-in (preferred long-term
  path; magic links are the v1 floor, and the account model is the
  same either way).
- Self-service signup, password auth, MFA.
- A request/approval workflow for staff edits.
- Dashboard UI for any of this (API-first, same as connectors v1; the
  operator drives via curl/dashboard token screen until the UI lands).
- Per-organization data scoping (a staff account currently sees the
  whole graph; FamilyGraph deployments are single-institution today).

## 9. Open questions

1. Session length: 12h chosen to cover a workday; should idle timeout
   shorten it?
2. Should `pii.write` staff be allowed to resolve conflicts, or should
   that be a distinct `conflicts.resolve` scope? v1: `pii.write`
   suffices; revisit when more than ~5 accounts exist.
3. When OIDC lands, do magic links remain as fallback or get retired?

## 10. Success criteria

- The operator can verify a domain, invite an account, and the staff
  member can log in and PATCH a person — all via API — in under ten
  minutes.
- A revoked account's session is dead on the next request.
- Every staff write shows the staff actor in both audit logs.
- An email on an unverified domain cannot be invited; a deleted domain
  stops logins for its accounts.
- No plaintext email, token, or session secret appears in any table,
  log line, or error message.

## Logging infrastructure

All auth events log at WARN (rejections) or INFO (grants) to the
standard structured log, with redaction:

- Emails are never logged in full — only the account code and the
  HMAC-derived `email_hash` prefix (8 chars).
- Raw tokens are never logged — only `token_fp` (sha256 fingerprint,
  8 chars), matching the existing middleware convention.
- Events: `auth.link_requested` (account_code | 'unknown_email'),
  `auth.link_throttled`, `auth.login_success` (account_code,
  session code), `auth.login_failed` (reason: expired | used |
  unknown), `auth.session_revoked`, `auth.account_invited`,
  `auth.account_disabled`, `domain.verify_attempt` (org code, method,
  outcome). Failures carry a stable `reason` field so the operator can
  paste log lines into a chat and the failure is identifiable.

---

## Appendix — as-built deviations (2026-06-10, same day)

The PRD above is the record of intent; this appendix records where the
shipped system deliberately went further.

1. **Dashboard UI shipped same-day** (§8 listed it out of scope).
   `/login` (magic-link request + redeem), **Staff accounts**
   (invite / scopes / disable / re-enable), and domain management on
   the organization detail page all landed in the same branch, plus
   **Parishes & schools** and the Communities panels for the
   organizations feature this PRD builds on.
2. **Trust breaks revoke sessions, not just logins.** §5 promised only
   that login *requests* are refused after a domain is removed or an
   org archived. As built, clearing/changing a domain and archiving an
   organization revoke the org's live sessions and outstanding links in
   the same transaction — the same immediacy account-disable always
   had. The PRD's weaker wording was a reviewed-and-rejected gap (see
   `CODE_REVIEW_2026-06-10.md`, finding 8).
3. **Shared domains are first-class.** A parish and its school can both
   verify the same domain (shared campus and staff is a real,
   documented case). Invites against an ambiguous domain require
   `org_code`; login trust is checked against the account's own
   organization, so co-domained orgs cannot lock each other's staff
   out. §6's data model is unchanged.
4. **A 403 does not end a staff session.** The dashboard treats
   `missing_scope` as "this surface isn't yours," not "your credential
   is dead" — only a 401 clears the stored session.
