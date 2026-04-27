# Sanctus — Business Specification

**Working name. Family registry for Catholic institutions.**

---

| | |
|---|---|
| **Author** | Chris Treadaway |
| **Status** | Draft |
| **Document type** | Business spec (the "why," not the "how") |
| **Companion docs** | `PRODUCT_SPEC.md` (the "how"), `ARCHITECTURE_MEMO_FAMILY_MANAGEMENT.md` (the integration plan) |

---

## What this is

Sanctus is a local desktop application that serves as the source of truth for family identity in a Catholic institution's data ecosystem. It accepts files from any source (school enrollment systems, parish management systems, donor lists, sacramental registers), reconciles them against a persistent identity ledger, and exposes that ledger to the institution's other tools through a local API.

Every family and every person in the ledger has a stable, opaque identifier. Other apps in the institution's portfolio (MissionIQ for donor intelligence, ParentPoint for parent engagement, future tools) consume those identifiers instead of maintaining their own family records. AI workflows always receive pseudonyms; PII is served only to authenticated local apps; data exports default to pseudonyms with explicit consent required for real names.

Sanctus is not an analytics tool. It does not score donors, track enrollment trends, or report on engagement. It does one thing: it knows who is who, with the highest accuracy possible, kept up to date by an operator who reconciles new information into it.

---

## The problem

Catholic institutions run on family data. A parish knows its members through the parish management system. A school knows its students through the enrollment system. A development office knows its donors through CRM. The same family appears in all three systems, often with different spellings, different addresses, different points of contact.

Today, every app the institution uses solves the identity problem on its own. Each maintains its own families table. Each runs its own resolution logic. Each builds its own conflict review UI. The result:

- **Duplicated work.** The same identity-resolution problem is solved three or four times in three or four codebases.
- **Drift.** An operator merges two families in the donor system. The school system still has them as separate. The parish directory has both. Within a month, the three systems disagree about who is in the family.
- **Unsafe AI.** When the operator wants to use AI on family data, every app has to invent its own anonymization. Most don't. PII flows freely to public LLMs because there's no shared infrastructure to prevent it.
- **Privacy risk on exports.** When a board member asks for a report and someone exports a CSV, real names go out by default because that's what the system shows. There's no architectural mechanism to enforce "pseudonyms unless you explicitly consent."

These problems compound as the institution adopts more software. Every new tool is another copy of the family graph. Every new tool is another place where AI integration risks PII leakage. Every new tool is another export channel without a unified privacy posture.

---

## The solution

A single, local source of truth for family identity, used by every other tool the institution runs.

### What Sanctus does

- **Ingests data from existing systems.** FACTS, RenWeb, Ministry Platform, MissionIQ, Google Sheets, Excel. Whatever the institution already has.
- **Reconciles incoming records against the persistent ledger.** Auto-merges high-confidence matches. Surfaces ambiguous pairs to the operator for review. Creates new entries for genuinely new people.
- **Builds household and relationship structure.** Multiple addresses per family. Custody designations. Family-to-family links for divorced parents and connected households. Free-form notes for the situations real people don't fit into clean schemas.
- **Serves identity to authorized local apps.** Other tools query Sanctus instead of maintaining their own family records. PII to authenticated callers, pseudonyms to AI workflows and external recipients.
- **Anonymizes files for AI consumption.** Drop a file in a folder, get a sanitized version out, where every name is replaced with a stable identifier. The AI sees identifiers; the operator sees real names when they get the response back.
- **Logs every PII access and every export consent event.** One place for the operator to see what data has left the machine.

### What Sanctus does NOT do

- Donor analysis, giving history, engagement scoring (MissionIQ does that)
- Parent communication, school engagement (ParentPoint does that)
- Sacramental records, parish accounting (Ministry Platform does that)
- School enrollment management (FACTS or RenWeb does that)
- Time-aware logic like grade rollover or sacrament eligibility (those belong to the systems that own the underlying processes)

Sanctus is deliberately narrow. It does the one thing the existing ecosystem doesn't do: maintain a unified, accurate, privacy-conscious identity ledger.

---

## Who it's for

### Primary user: the institutional operator

Business managers, advancement directors, principals, COOs of Catholic schools and parishes. They juggle multiple systems. They handle sensitive family data daily. They want to use AI to make their work easier but cannot legally or ethically expose family information to public LLMs. They have no IT department.

This person is already running MissionIQ. They already understand the identity-resolution problem because MissionIQ surfaces it through its conflict queue. Sanctus is the natural extension of that work, applied across the entire data ecosystem rather than just donor intelligence.

### Secondary users

- **The institution's other apps.** MissionIQ, ParentPoint, future tools. They consume identity from Sanctus instead of building their own.
- **AI workflows.** Local LLM agents, public LLM integrations, anything that needs family data but should not see PII.
- **Pastors, principals, board members.** They consume reports built on Sanctus-anonymized data. They don't operate Sanctus directly.

---

## Why now

Three things are true that weren't true five years ago.

**AI is becoming the operator's most useful tool.** A small Catholic institution can, today, summarize meeting notes, draft donor correspondence, identify giving patterns, and triage parent communications using an off-the-shelf LLM. The productivity gain is enormous. But the privacy risk is also enormous, and there's no shared infrastructure to manage it.

**Catholic institutions are accumulating software.** Five years ago, a parish might have had a single management system. Today, that same parish runs FACTS for the school, Ministry Platform for sacramental records, MissionIQ for donor intelligence, ParentPoint for parent engagement, and a half-dozen spreadsheets for everything else. The integration problem is real and getting worse.

**The Catholic Digital Commons is real.** There is a growing ecosystem of mission-aligned software being built for Catholic institutions. Sanctus is foundational infrastructure for that ecosystem. Every Catholic Digital Commons app that handles families benefits from a shared identity layer.

---

## How it makes money (or doesn't)

Closed-source for v1. Decision deferred on whether to open-source later.

Three plausible commercial paths, in increasing order of ambition:

1. **Internal infrastructure only.** Sanctus exists to make Chris's other products (MissionIQ, ParentPoint, future) better. It is never sold or licensed. It runs at every institution that adopts the rest of the portfolio.
2. **Modest licensing to peer Catholic institutions.** Sanctus is licensed for a low annual fee (think $200-$500/year per institution) to other Catholic schools and parishes. The price is calibrated to be invisible in their budget and to make adoption frictionless.
3. **Open source through the Catholic Digital Commons Foundation.** Sanctus becomes free, foundational infrastructure for the entire Catholic software ecosystem. Revenue comes from companion services, integrations, or hosted variants — not from the core product.

The decision among these doesn't need to be made until Sanctus is running in production. Field experience will inform it.

---

## What success looks like

### v1 ships when

- St. Theresa is running Sanctus in production for at least one weekly workflow.
- The operator has migrated their MissionIQ identity data into Sanctus and is using Sanctus as the master record.
- AI workflows at St. Theresa receive pseudonyms only; no PII has reached a public LLM.
- The audit log shows every PII access and every export consent event.

### Adoption is working when

- Sanctus is in continuous use at St. Theresa for at least 30 days without data-integrity issues.
- The operator can demonstrate the dashboard to a peer at another Catholic institution and that peer immediately understands the value.
- At least one second institution begins piloting Sanctus within 90 days of St. Theresa's deployment.
- The MissionIQ migration begins (per the architectural memo) within 90 days of v1 stability.

### The architecture is working when

- A new app the institution adopts can be wired to Sanctus in under a day.
- A bug in identity resolution is fixed once, in Sanctus, and propagates to every consuming app on the next deploy.
- An operator who edits a family in Sanctus sees the change reflected in MissionIQ on the next refresh.
- Zero confirmed PII leakage incidents in the first six months across all consuming apps.

---

## What could go wrong

**The identity resolution is harder than expected and the conflict queue overwhelms the operator.** Mitigation: the resolver thresholds are tunable. Auto-merge can be made more aggressive. Resolution rules accumulate over time and reduce queue depth.

**Consuming apps don't get migrated and Sanctus stays an island.** Mitigation: the architectural memo is the contract. MissionIQ and ParentPoint are committed to migrating once Sanctus is stable. The migration is phased so it doesn't have to happen all at once.

**The shared local secret authentication model is too primitive and a security incident occurs.** Mitigation: the threat model assumes a trusted single-operator desktop. If that assumption fails, per-app scoped keys are a known v2 evolution.

**A consuming app silently violates the PII posture (exports without consent, logs PII to its own files).** Mitigation: the architectural memo restates the posture in stark terms. Each migration PRD is required to do the same. The audit log catches what it can; the rest is discipline.

**Sanctus becomes a bottleneck and consuming apps suffer when it's down.** Mitigation: read-through caching pattern in the migration plan. Apps degrade gracefully with stale data and clear UI warnings. Sanctus's own code is kept simple and dependable specifically because so much depends on it.

**The closed-source decision turns out to be wrong and the project would have benefited from community contributions.** Mitigation: the open-source decision is reversible. The codebase is being built clean enough that opening it later is straightforward.

---

## Strategic context

Sanctus is part of a larger thesis: **Catholic institutions deserve software built specifically for them, not generic SaaS shoehorned into Catholic contexts.** The portfolio of tools (MissionIQ, ParentPoint, AudioScribe, future) is the practical expression of that thesis. Sanctus is the foundational layer that makes the portfolio coherent rather than a collection of independent apps.

If Sanctus works at St. Theresa, the portfolio becomes more powerful at St. Theresa. If Sanctus works across multiple institutions, the portfolio becomes a real product line for Catholic institutions broadly. If Sanctus is eventually open-sourced through the Catholic Digital Commons Foundation, it becomes infrastructure that any Catholic-aligned developer can build on, multiplying the impact beyond what one builder could achieve alone.

The order matters. Ship to St. Theresa. Make it work. Decide what's next based on what's true, not what's hoped.

---

*End of business specification*
