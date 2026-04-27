# Sanctus — Session Notes

**Working journal. Decisions made, paths abandoned, reasoning preserved.**

---

| | |
|---|---|
| **Author** | Chris Treadaway, with Claude (web chat) |
| **Purpose** | Capture the reasoning behind v6 of the spec so future sessions don't re-litigate settled decisions |
| **Companion docs** | `business_spec.md`, `PRODUCT_SPEC.md` (v6), `ARCHITECTURE_MEMO_FAMILY_MANAGEMENT.md` |

---

## The arc, briefly

This project went through six full PRD revisions before landing. The spec started as "an anonymizer agent that runs locally and sanitizes data for AI" and ended as "a family registry that serves PII or pseudonyms on request, with anonymization as one feature." The path between those two points is worth preserving because every revision encoded a real decision, and reverting any of them would be a step backwards.

This is not a record of indecision. Every revision sharpened the product. The sequence reads like incremental clarity, not floundering.

---

## v1 — The original anonymizer concept

**What was speced.** A desktop app that ingests files, detects PII via regex + NER + optional LLM, replaces names with semantic pseudonyms (FAM_001-A, Person_A), routes sanitized payloads to public AIs, and de-tokenizes responses. Ships with multi-party sharing for owners and viewers. Tauri + Rust + Python sidecar.

**What we got right.** The three-layer detection model (regex, NER, optional LLM). The pre-send review screen as a security mechanism. The folder-watch agent pattern. The audit log requirement.

**What was wrong.** Architectural ambition outran the actual problem. Tauri + Rust meant a language boundary that complicated debugging. Multi-party sharing was a v2 feature dragged into v1. Semantic pseudonyms (FAM_001-A) were vulnerable to ordering attacks (a bad actor could derive family size and chronological order from the IDs).

**What we kept.** Three-layer detection. Pre-send review. Folder-watch. Audit log.

---

## v2 — Adding family grouping and PII configurability

**What changed.** Family grouping with shared family codes plus per-member suffixes. Configurable PII handling per type (tokenize, redact, partial-reveal, pass-through). Profile system (Catholic school, parish donor, medical, HR). Splink for entity resolution. Family review screen before tokenization.

**What we got right.** Family grouping is essential. Per-PII-type handling is essential. Profiles are the market-expansion lever.

**What was wrong.** Splink is overkill for v1 and adds a Python dependency. The "family code with member suffix" idea was still leaking ordering and family size. Tauri + Python sidecar deployment was getting heavier, not lighter.

**What we kept.** Family grouping concept. Profiles. Per-PII-type handling.

---

## v3 — Discovery of MissionIQ and the Node.js pivot

**The unlock.** Reading the MissionIQ repo revealed an existing, mature, modularized identity-resolution system written in Node.js + Express + SQLite. The whole architecture pivoted: the new project should match MissionIQ's stack, vendor MissionIQ's identity module, and use compromise + winkNLP for NER (pure JavaScript, no Python).

**What changed.** Stack swapped from Tauri + Rust + Python to Node.js + Express + SQLite + React. NER moved to pure JS (Presidio became optional). Family resolver vendored from MissionIQ. The desktop app shell was replaced with a folder-watch agent + small web dashboard at localhost:3500. Multi-party sharing pushed to v2.

**What we got right.** Matching MissionIQ's stack. Vendoring rather than re-implementing identity. The folder-watch + dashboard model. Pushing sharing to v2.

**What was wrong.** Family codes were still semantic (FAM_001-A pattern). Sessions were still treated as the primary unit, which doesn't fit a long-lived registry. The product was framed as "anonymizer with a registry" rather than "registry that anonymizes."

**What we kept.** All of the stack decisions. Folder-watch. Vendored identity module.

---

## v4 — The persistent identity store

**The shift.** The user said: "I don't really want to resolve the families every time I use an app. I want to resolve them once, then be able to revisit them if needed / make edits."

That single sentence flipped the architecture. The identity store became the spine of the product. Sessions became transient events that touch the store. Families and people live forever once added.

**What changed.** Persistent SQLite identity store as the core. Hex codes (originally still semantic). Edit, merge, split, alias operations. Dashboard became the primary interface. Backup and restore added because the store is now a long-lived asset.

**What we got right.** Persistence as the spine. The alias table for handling merges. Provenance tracking. Backup/restore as a v1 requirement.

**What was wrong.** Codes were still semantic (FAM_001-A). Person codes weren't yet first-class. The relationship to MissionIQ was still ambiguous (peer? source of truth? consumer?).

**What we kept.** Everything about persistence and the store.

---

## v5 — Stable non-semantic codes, source-specific handlers

**The corrections.** Two important user clarifications:

1. "Family codes should be assigned once and that's it. and they shouldn't start with FAM-001-A... just use a unique hexadecimal for them that does not identify them (for example, it should not use their first initials for example as that would give a clue to a bad actor)."
2. Source handlers should support FACTS, RenWeb, Ministry Platform (not ParishSOFT — different segment), Google Sheets, Excel, plus generic CSV.
3. Closed source for v1. Ship to St. Theresa first. Decide later.

**What changed.** Codes became fully non-semantic 8-character hex with type prefixes (`f_a7b3c91d`, `p_e4d2f8a1`). Ordering and family-size leaks eliminated. Source-specific handlers became their own subsystem in `server/sources/`. Bulk seed import wizard added as a v1 feature. Closed-source posture reflected throughout (no CONTRIBUTING, no CODE_OF_CONDUCT, README marked internal).

**What we got right.** The hex code design is the privacy fix that survived. Source handlers as a clean module. Closed-source for v1.

**What was wrong, but only in retrospect.** Person codes were still framed as "tokens generated during processing" rather than first-class registry citizens. The product was still framed as "anonymizer that happens to have a registry" rather than "registry that anonymizes." MissionIQ was still positioned as an upstream source rather than a downstream consumer.

**What we kept.** Hex code design. Source handlers. Closed source.

---

## v6 — The repositioning

**The realization.** Mid-conversation, the user clarified the intended usage: "this product is simply about creating the most accurate registry of information we can on the families itself. who is related to who, family composition, where they live, etc. we will leave any donor analysis and whatnot to missioniq."

Followed by: "I want to be clear that missionIQ and parentpoint MAY expose the PII inside those apps. those should be settings in those apps specifically. this code should expose BOTH PII and fully anonymized information but the app pulls what it needs."

**What changed.** Sanctus was repositioned. It's now the family registry, full stop. Anonymization is one consumer of the registry. MissionIQ and ParentPoint are downstream consumers. Family management is being extracted *out* of those apps and *into* Sanctus.

The API got a dual surface: PII endpoints (require Bearer token from OS keychain) and pseudonym endpoints (`/safe` suffix, loopback only). Two-tier audit logging: the registry logs its own events; consuming apps log external-export consent events back to the registry.

Custody and household complexity became first-class data, not afterthought. Multiple addresses per family. Custody designations (sole, joint, other guardian, unspecified). Full relationship taxonomy including godparents (Catholic-specific). Family-to-family links for divorced parents.

Person codes became first-class permanent identifiers. Family-membership history table added so person codes can stay stable when kids emancipate, families merge, or households split.

**What we got right.** Everything. v6 is the spec.

**What still needs to be settled in the build.**
- Final repo name (Sanctus is the working name; user said "I don't really care")
- Ministry Platform header signatures (need a real export to design auto-detection)
- Quasi-identifier detection aggressiveness
- Conflict queue SLA
- Backup encryption mechanism
- Family membership history retention policy
- Token rotation cadence

---

## Decisions that survived every revision

A few principles were present from the first conversation and never wavered:

- **Local-first.** Never hosted, never cloud, never SaaS in v1.
- **Open-source dependencies.** All MIT, Apache 2.0, BSD. No GPL or AGPL.
- **No telemetry, no analytics, no phone-home.** Period.
- **Audit log auto-redacts PII.** Logs never contain raw values.
- **Mappings encrypted at rest.** SQLCipher with OS-account-derived key.
- **Pseudonyms never re-issued.** Merged entries become aliases.
- **Family resolver inherits MissionIQ's existing rules.** Don't re-derive what already works.

---

## Decisions we revisited and changed our minds about

| Topic | Early decision | Final decision | Why we changed |
|---|---|---|---|
| Stack | Tauri + Rust + Python | Node.js + Express + SQLite + React | Discovered MissionIQ's stack; matching it removes a language boundary and lets us vendor identity logic |
| Pseudonym format | Semantic (`FAM_001-A`) | Non-semantic hex (`f_a7b3c91d`) | Semantic codes leak ordering and family size to bad actors |
| Multi-party sharing | v1 feature | v2 feature | Too much scope for v1; not blocking the core use case |
| Sessions vs persistent store | Session-scoped tokens | Persistent registry | User said "resolve families once, revisit as needed"; sessions don't fit that mental model |
| Relationship to MissionIQ | Peer / consumer of MissionIQ | Upstream of MissionIQ | The hub model is architecturally better; identity belongs in one place |
| Person identity | "Token" | First-class registry citizen with stable code and membership history | User explicitly asked for this in v6 conversation |
| License | Apache 2.0 from day one | Closed source for v1, decide later | Avoiding the obligations of open-source while validating the product |
| NER engine | Microsoft Presidio (Python) | compromise + winkNLP (JS), Presidio optional | Pure-JS deployment is meaningfully simpler |
| Name pattern within families | Family code with semantic suffix (FAM_001-A) | Family code AND independent person code; relationships in the data model | Cleaner separation; survives family changes |

---

## Decisions we walked back from completely

| Topic | Considered | Rejected because |
|---|---|---|
| Building a generic person registry as the headline | Spent meaningful conversation on this | User clarified the registration data comes from existing systems; Sanctus consumes, doesn't create |
| Time-aware logic (grade rollover, age computation, alumni transitions) | Almost speced into v5 | The systems Sanctus consumes from already do this; Sanctus shouldn't duplicate |
| Sacrament eligibility windows | Considered as a registry feature | Same reason; sacramental register is the system of record |
| Bitemporal event sourcing | Almost adopted in v5 | Overkill for the actual use case; family-membership history is enough |
| Point-in-time queries ("who was in grade 5 in 2024") | Considered as v1 feature | Same; out of scope |
| Sanctus as MissionIQ's database backend | Briefly considered | Tight coupling; failures cascade; chose API contract instead |
| Per-app scoped API keys | Discussed | Overkill for single-operator desktop; v2 evolution if threat model expands |

---

## What v6 is

A local-first family registry. Source of truth for who lives in what household, who is related to whom, and where they live. Serves PII to authenticated local apps. Serves pseudonyms to AI workflows and external recipients. Built on Node.js + Express + SQLite (encrypted via SQLCipher) + React. Vendors MissionIQ's identity module. Reuses MissionIQ's resolution rules. Closed source for v1, shipping to St. Theresa first.

The product is small enough to build well and ambitious enough to be foundational infrastructure for Chris's portfolio of Catholic institutional software.

---

## What's next, in order

1. **Build v6.** Use Claude Code. Build order is documented in v6 PRD (logging first, then store schema, then folder watch, then de-tokenization round-trip, then identity module, then conflict queue, then edits, then source handlers, then NER, then backup/restore, then bulk import wizard, then profiles).

2. **Deploy to St. Theresa.** One operator, real data, real workflow. Run for at least 30 days without data-integrity issues.

3. **Open-source decision.** Based on field experience. Default deferred until experience justifies a decision either way.

4. **MissionIQ migration PRD.** Per the architectural memo. Phased rollout starting with read-through cache, then new data authoritative, then backfill, then drop legacy tables.

5. **ParentPoint migration PRD.** Same phased pattern. Less work because ParentPoint's family management is less mature.

6. **Future apps.** Build on Sanctus from day one. No new app should re-implement family resolution.

---

## Things to remember when this comes back up

- Sanctus is the registry. Anonymization is a feature, not the headline.
- PII vs pseudonym is a posture, not just a technical surface. Every consuming app must respect it.
- Person codes are stable across family changes. Family-membership history is queryable, not just an audit-log entry.
- Pseudonyms are non-semantic hex. They leak nothing.
- The dual API surface (`/api/families/:id` vs `/api/families/:id/safe`) is implemented as separate route files in code, not a query parameter. Make the security boundary visible.
- The audit log captures both internal events (Tier 1) and external-export consent events from consuming apps (Tier 2).
- Bearer token auth is shared local secret in v1. Per-app scoped keys are a known v2 evolution.
- Ministry Platform is the parish system to support, not ParishSOFT. Different segment.
- Sanctus is closed source for v1. The decision to open-source comes after field experience.
- Claude Code, not me, builds this. The PRD is detailed enough that Claude Code can execute against it.

---

*End of session notes*
