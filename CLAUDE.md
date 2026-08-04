# Claude Code conventions for this repo

Standing rules for every Claude Code session in this repository.

## How to work

- **Bias toward action.** Don't argue, just do what was asked. Politely push
  back when the request seems to need more thought, but make a judgment call
  and proceed when there is enough signal.
- **Minimize questions.** Make reasonable choices and tell the user what you
  picked. Save the question for the cases where the wrong choice would mean
  rework.
- **No filler phrases.** Cut "It is worth noting," "In conclusion," "As
  previously mentioned," "I hope this helps." Get to the point.
- **Match the operator's writing style** when drafting prose:
  conversational, grounded in specifics, opens with a moment then zooms out
  to a lesson. Minimize em-dashes; when one is necessary, use a single dash
  ("-"), not two ("--"). Tone is "reflective builder" — warm, direct,
  self-aware, earned authority. Numbered lists are fine. Occasional ALL CAPS
  for emphasis is fine.
- **Don't take shortcuts when debugging.** If something is broken, find the
  actual root cause and fix it like a world-class programmer. Don't let the
  same mistake show up twice in testing. Don't waste the user's time.
- **Build logging in by default.** Every project should produce log files of
  what happens at runtime so future debugging is faster. The operator should
  be able to copy a few lines of `server.log` into a chat and have a
  fighting chance of identifying the failure. Log redaction must strip
  credentials, tokens, and PII before any line lands on disk.

## Security requirement: Socket Firewall (sfw) for every npm install

Every `npm install`, `npm ci`, or equivalent in this repo MUST run
through Socket Firewall (`sfw`). This is a hard project rule, not a
preference. A `preinstall` guard in `package.json` (and in
`client/package.json`) refuses installs that lack the `SFW=1` marker
(or an equivalent `SOCKET_FIREWALL=1` / socket user-agent signal).

Rules for Claude in any session:

- Never suggest, document, or run `npm install` without `sfw`. Always
  write `SFW=1 sfw npm install` (or `sfw npm ci`) when proposing or
  executing a dependency install, in scripts, docs, CI, or chat replies.
- Never remove the `preinstall` line from either `package.json` or
  `client/package.json` without explicit operator approval and a
  session-notes entry explaining why.
- Never set `SFW_BYPASS=1` to make a failing install go through. The
  bypass exists for genuine outages (offline, registry mirror down) and
  every use of it must be logged in `session_notes.md` with a one-line
  reason.
- If `sfw` is missing on the operator's machine, tell them to
  `npm install -g sfw` before installing project dependencies. Do not
  work around the guard.
- If a new subpackage is added (anything with its own `package.json`),
  wire the same `preinstall` guard into it.

The point is to keep a malicious or typosquatted npm package from
landing on disk in this codebase, ever. The operator has accepted the
one-word cost of typing `sfw` to get that guarantee. Don't erode it.

## Scope boundary (always on)

Owner ruling, 2026-08-04. Family Graph is a single, federated source of
IDENTITY for a church, or a church and its school. It focuses on identity
and anonymity. School-specific concerns live in the school apps
(ParentPoint / TeacherAIde), not here.

The operational line: **Family Graph holds identity, relationships, and
access decisions. It does not hold school-authored content or
school-scoped state.**

- **In scope.** People, families, memberships and custody, organizations,
  dated affiliations, opaque codes, encrypted contact PII, the conflicts
  queue and merge machinery, the audit trail, and the pseudonym layer that
  keeps AI workflows from ever seeing a real name.
- **Enrollment is in scope.** "This person is a student at this org from
  this date to that date" is a relationship, not an education record, and
  it is what makes the federated view work at all.
- **Out of scope.** Grades, classrooms, seating, attendance, transcripts,
  coursework, participation analytics, or any other artifact a school
  authors about a student. Never add a column or table for these. If a
  feature seems to need one, it belongs in ParentPoint or TeacherAIde —
  flag it and stop.
- **No biometrics, ever.**
- Family Graph does not enforce FERPA and must not be described as doing
  so. FERPA binds the institution; Family Graph is at most a processor
  running on the institution's own hardware. The posture is to not hold
  education records in the first place, so the question never attaches
  here.
- Two known exceptions predate this ruling: `school_contexts`, and the
  document vault's `accommodation` taxonomy (`iep` / `504` / `mtss`).
  Both are open decisions — see `OPEN_DECISIONS.md`. Do not add to
  either, and never cite either as precedent for new school-scoped state.

## PII rules (always on)

- No real institution names, people, addresses, phones, or emails in
  examples or docs. Use bracketed placeholders like `[Parish Name]`,
  `[Staff Name]`, `[admin@example.org]`.
- No machine-specific local file paths in user-facing docs. Use `~/` for
  the home directory.
- No API keys, tokens, or credentials in any committed file or in any
  documentation example. If a credential needs to appear, write `[redacted]`
  or a placeholder shape like `sk_xxxxxxxx`.

## Session journal

- **Always update `session_notes.md` at the end of every session.** Append a
  new entry under the most recent "vN" or follow-up heading describing:
  what shipped, what bugs were caught and fixed, why specific design
  trade-offs were made, and (when the test count moved) the new total.
  Match the existing prose voice — short paragraphs, blunt,
  decision-oriented, no bullet-list-only entries.
- The journal is the institutional memory for the project. Future sessions
  read it before changing direction. If a decision is made and not written
  down, it will get re-litigated in a later session.
- New entries go at the bottom, just above the `*End of session notes*`
  marker. Update the marker line so it stays at the bottom.

## Other doc conventions

- `README.md` is the operator-facing landing surface. Update it whenever a
  user-visible workflow changes (CLI commands, dashboard routes, new env
  vars).
- PRD-style documents get an Appendix when the as-built deviates from the
  spec, rather than rewriting the original PRD prose. The PRD is a
  historical record of intent; the Appendix records what shipped.
- `business_spec.md` and `product_spec.md` are slower-moving and only
  updated when the actual product contract changes. Don't churn them for
  implementation-only changes.

## When writing requirements / PRDs

Use this section order, every time:

1. **What this is** (1-2 sentence product description)
2. **Who it's for** (primary users)
3. **User stories / jobs to be done**
4. **Core features** (what the user sees and does)
5. **Business rules and logic** (if/then conditions, constraints)
6. **Data requirements** (what's stored, pulled, connected)
7. **Integrations and dependencies**
8. **Out of scope** (what we're NOT building yet)
9. **Open questions**
10. **Success criteria** (how we know it works)

Plus, every PRD intended for Claude Code execution must include a section
on **logging infrastructure**: what events get logged, at what level, with
what fields, and how the redactor handles secrets. Future debugging in
this project depends on the operator being able to paste a few log lines
into a chat and have us narrow the failure quickly.

Write requirements so a developer — or Claude Code in a future session —
could build from them without the original conversation.

## When auditing UI / UX

Activate the design-auditor mode only on explicit request. The
non-negotiables when you do:

- Read every existing context (design system, frontend guidelines, app
  flow, PRD, live app) before forming an opinion. You are elevating, not
  starting from scratch.
- Walk every screen at mobile, tablet, and desktop in that order.
- Audit against: visual hierarchy, spacing & rhythm, typography, color,
  alignment & grid, components, iconography, motion & transitions, empty
  states, loading & error states, density, responsiveness,
  accessibility (keyboard, focus, ARIA, contrast).
- Apply the Jobs filter: would the user need to be told this exists? Can
  this be removed without losing meaning? Does this feel inevitable?
- Deliver findings as a phased plan (Critical / Refinement / Polish), with
  exact file + exact property + exact old value → exact new value. "Make
  the cards feel softer" is not an instruction.
- Touch only visual / layout / interaction concerns. If a design
  improvement requires a functionality change, flag it and stop.
- After each phase ships, present the result for review before moving on.

## When designing executive summaries / PDFs

Activate this mode only on explicit request. Defaults:

- One page unless explicitly told otherwise.
- Modern typefaces only — Inter / Lato for body, Montserrat / Playfair
  Display for headers, loaded via Google Fonts CDN. Never Arial, Times,
  Helvetica.
- ASCII-safe punctuation only. Em-dashes / en-dashes / ellipses as HTML
  entities (`&mdash;` / `&ndash;` / `&hellip;`).
- Explicit padding, margins, line-heights, and column widths — never rely
  on renderer defaults. Text never overruns its container.
- Numbers lead results: "$1.2M saved" not "We saved $1.2M."
- Section order: Header → At-a-Glance metrics → Situation → What We Did →
  Results → What's Next → Footer.
- Quality check before delivering: senior leader understands the point in
  10 seconds of scanning, most important number appears in the first
  third, no Unicode artifacts, no clipping, proud to hand to a board
  chair.

## When delivering terminal commands

- Always start with `cd` to the correct directory. Never assume the user is
  already there.
- Default to macOS paths (e.g. `/Users/<user>/`) unless the user has
  signalled a different OS.
- Provide foolproof install + run instructions. Don't make the user debug
  the steps.

## Code conventions

- Tests under `tests/` use `node --test` (no Jest, no Mocha). New test files
  follow the `<area>.test.js` naming pattern.
- Migrations under `server/db/migrations/` are numbered `NNNN_*.js` with an
  `up(db)` export. Bump `SCHEMA_VERSION` in `server/db/index.js` and add a
  one-line comment describing the new version.
- New API routes follow the existing `bearerImport` / `bearerRead` /
  `bearerMaster` scope pattern; never invent a new auth surface without
  noting it in `session_notes.md`.
- Encrypted PII columns end in `_ct`. Searchable HMAC columns end in
  `_hash`. Never add a plaintext PII column.
