# Family Graph — Claude Code Handoff
**Theme:** Institutional · **Chrome:** native per OS (macOS traffic lights on Mac, Windows controls on Windows) · **Surface:** local desktop app (Tauri or Electron) on macOS + Windows.

This document is the contract between design and engineering. Read it once end-to-end before touching the dashboard. The companion design system PDF (`Family Graph — Institutional Design System.pdf`) is the visual reference; this file is the build instructions.

---

## 0 · The one rule

> **The dashboard is a posture indicator first, a CRUD UI second.**
> If a feature breaks "operator can see PII vs pseudonym vs consented at a glance," push back before merging. Posture is the product.

Everything below serves that rule.

---

## 1 · Stack & runtime

| | Choice | Notes |
|---|---|---|
| Shell | **Tauri 2.x** (preferred) or Electron 30+ | Frameless window — we draw our own chrome |
| UI | **React 18 + TypeScript** | Vite for dev, no SSR |
| Styling | **CSS variables** (`tokens.css`) + plain CSS modules | No Tailwind, no CSS-in-JS runtime |
| Fonts | Bundled WOFF2: Inter, Inter Tight, JetBrains Mono | **Do not** use CDN; do not rely on system Inter on Windows |
| State | React state + Zustand for global (PII/pseudonym toggle, theme) | No Redux |
| API | Local HTTP, `127.0.0.1:3500` | Loopback bind enforced server-side |
| Min window | 1280×800 · default 1440×900 | Below 1280, render a "resize" message |

**Why native chrome:** the *content* of Family Graph is identical on macOS and Windows — same tokens, same components, same status rail, same posture vocabulary, pixel-for-pixel. The *window controls* defer to the OS so the app feels at home on each. Mac users get traffic lights on the left, Windows users get min/max/close on the right. Everything below the title bar is identical.

---

## 2 · Files in this handoff

This entire package lives in **`/design-handoff/`** at the repo root. Drop the folder in as a single unit and work from there.

```
/design-handoff/
├── CLAUDE_CODE_HANDOFF.md                            ← you are here — read first
├── tokens.css                                         ← copy → client/src/styles/tokens.css
├── shared.css                                         ← copy → client/src/styles/shared.css
├── overview.jsx                                       ← reference Home/Overview screen
├── fg-data.js                                         ← fixture data shape (mirrors API)
├── Home Overview.html                                 ← rendered prototype, open in browser
└── Family Graph - Institutional Design System.html   ← print-ready visual spec (open & ⌘P → Save as PDF)
```

Engineering should:
1. Copy `design-handoff/tokens.css` → `client/src/styles/tokens.css` and import it from your root stylesheet.
2. Copy `design-handoff/shared.css` → `client/src/styles/shared.css` and import it.
3. Set `<html data-theme="institutional">` in the document shell. **Do not ship the theme switcher** — that was a design exploration tool. Institutional is the only shipping theme for v1.
4. Use `design-handoff/overview.jsx` as the reference for component structure + DOM shape — copy patterns into your component files, don't import from `/design-handoff/` directly.
5. Open `design-handoff/Home Overview.html` in a browser whenever a screen needs visual reference; open `Family Graph - Institutional Design System.html` and print to PDF if you need a shareable spec.

> **`/design-handoff/` is read-only reference material.** Nothing in production should import from it. Once migration is complete (see §12), the entire folder can be archived or deleted — see the cleanup checklist there.

---

## 3 · Design tokens (read these once, then use the variables)

All tokens live in `tokens.css`. Engineering should never re-declare colors, fonts, or radii in component CSS — pull from variables.

### 3.1 Surfaces (institutional)
```
--bg-sunken    oklch(97%  0.004 250)   subtle gray, page background
--bg           oklch(99%  0.002 250)   default surface
--bg-elev      oklch(100% 0     0  )   cards, elevated panels
--rule         oklch(92%  0.006 250)   0.5px hairlines
--rule-strong  oklch(85%  0.008 250)   1px emphasis lines
```

### 3.2 Ink
```
--ink          oklch(18% 0.01 250)   primary text
--ink-mute     oklch(46% 0.01 250)   secondary
--ink-faint    oklch(68% 0.008 250)  metadata, mono labels
--accent       oklch(48% 0.14 250)   indigo — buttons, links, focus
--accent-soft  oklch(95% 0.025 250)  hover, selected row tint
```

### 3.3 Posture (the heart of the system)
| Token | Hue | Meaning | Where it appears |
|---|---|---|---|
| `--c-loopback` | 142 (green) | bind is 127.0.0.1 | status rail, health endpoint |
| `--c-encrypted` | 200 (cyan) | column ciphertext at rest | field sigil, backups |
| `--c-pseudonym` | 250 (indigo) | identifiers, AI-safe | sanitize output, safe API |
| `--c-pii` | 30 (amber) | real names visible | dashboard, families/:code |
| `--c-consented` | 350 (rose) | PII left the machine | exports |

Each posture has `-bg` companion (95% lightness tint) for filled pills.

### 3.4 Identifier hues (memorize these — they are global muscle memory)
```
.fg-code.family    → indigo (250)
.fg-code.person    → cyan   (200)
.fg-code.address   → green  (142)
.fg-code.email     → yellow (90)
.fg-code.phone     → amber  (30)
```

### 3.5 Type
```
--font-display  Inter Tight 500/600   institution names, section titles
--font-text     Inter 400/500          body, forms
--font-mono     JetBrains Mono 500     identifiers, paths, log lines
```

Roles + sizes (line height in parens):
- `--t-display` 44px (1.1) · h1 cover
- `--t-h1` 26px (1.15) · screen titles
- `--t-h2` 20px (1.3) · card titles
- `--t-body` 14px (1.5) · body
- `--t-mono-data` 13px (1.45) · ids, paths
- `--t-micro` 11px (1.4, +2% letterspace) · micro labels in mono

### 3.6 Spacing (4-pt scale)
`4 · 8 · 12 · 16 · 20 · 24 · 32 · 40` — gap, padding, margin all draw from this.

### 3.7 Radius
`--radius-sm 4px` · `--radius-md 6px` · `--radius-lg 10px` · pill `999px`

### 3.8 Shadow
```
--shadow-card: 0 1px 2px oklch(80% 0.01 250 / 0.4), 0 0 0 0.5px oklch(88% 0.008 250);
```

---

## 4 · Component contracts

Components live in `client/src/components/`. Each is a thin wrapper around `shared.css` classes; logic stays in the page, presentation stays in CSS.

### 4.1 `<StatusRail />` — pinned, top of every screen, **never collapsed**

```tsx
<div class="fg-rail">
  <RailItem dot="loopback" label="LOOPBACK" value="127.0.0.1:3500" />
  <RailDivider />
  <RailItem dot="encrypted" label="ENCRYPTED" value="AES-256-GCM" />
  <RailDivider />
  <RailItem dot="pseudonym" label="AUDIT LIVE" value="actor=operator" />
  <span class="fg-rail-trailing">schema 17</span>
</div>
```

Contract:
- Height **32px**, padding `0 14px`, font `var(--t-micro)`.
- Background `var(--bg-sunken)`, border-bottom `0.5px solid var(--rule)`.
- The dot is 6px, exact posture color, no border.
- This component subscribes to `/api/health` every 5s. If loopback is lost (impossibly), turn the rail red and stop everything. There is no offline mode for unsafe binds.

### 4.2 `<Header />` — institution + PII/Pseudonym toggle

DOM shape (do not deviate — the title block must be `flex-direction: column` with `gap: 6px`, see `overview.jsx`):
```tsx
<header style="display:flex; justify-content:space-between; align-items:flex-end; gap:16px; padding:22px 28px 18px; border-bottom:0.5px solid var(--rule)">
  <div style="display:flex; flex-direction:column; gap:6px; min-width:0">
    <Eyebrow>FAMILY GRAPH · LOCAL REGISTRY</Eyebrow>
    <h1 class="fg-h-display" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis">{institution.name}</h1>
    <Meta>profile={institution.profile} · operator={institution.operator}</Meta>
  </div>
  <ToggleGroup options={['PII', 'Pseudonym']} value={view} onChange={setView} />
</header>
```

The `view` state is global (Zustand). All routes read it. Pseudonym mode swaps every name for its identifier; PII mode shows real names. Persist to localStorage; default = pseudonym.

### 4.3 `<Pill state="loopback|encrypted|pseudonym|pii|consented|muted" />`

```css
.fg-pill { /* in shared.css */ }
.fg-pill.loopback { color: var(--c-loopback); background: var(--c-loopback-bg); }
/* ...etc */
```

Contract:
- 11px JetBrains Mono 500, uppercase, 0.04em letter-spacing, padding 3px 8px, radius 999px.
- Always semantic. Never use a posture pill for a non-posture state.
- For arbitrary tags (e.g. "school", "parish"), use `.fg-pill.muted` — gray, not a posture color.

### 4.4 `<IdCode type="family|person|address|email|phone" code="a7b3c91d" />`

```tsx
<span class={`fg-code ${type}`}>{prefix(type)}_{code}</span>
```

Contract:
- Always JetBrains Mono.
- No underline, no link unless the row is hoverable.
- Color from `--code-{type}` — never override.
- Click → navigate to detail page if applicable; otherwise no interaction.

### 4.5 `<ProvDot source="facts|renweb|mp|sheets|other" />`

5px dot, fixed colors:
```
.fg-prov.facts   → oklch(58% 0.16 30)
.fg-prov.renweb  → oklch(58% 0.16 250)
.fg-prov.mp      → oklch(58% 0.16 350)
.fg-prov.sheets  → oklch(58% 0.16 142)
.fg-prov.other   → oklch(58% 0.01 250)  /* gray */
```

These do **not** match posture colors — provenance has its own palette so the operator never confuses "where the data came from" with "what state it's in."

### 4.6 `<CounterCard eyebrow value delta sparkline />`

See section 9 of the design PDF for visuals. Layout:
- Eyebrow (`fg-eyebrow`) top-left.
- Delta (mono, faint) top-right.
- Big number (28px mono 500) bottom-left.
- Sparkline (110×32 SVG) bottom-right, accent fill 18% opacity.
- Footer label (mono 10px faint).
- Padding `14px 16px`, `--shadow-card`, radius `--radius-md`.

### 4.7 `<ConflictRow />` — keyboard-first

Grid: `auto 1fr auto auto` · gap 14px · padding `10px 14px`.
- Column 1: stacked identifier pair with `↕ vs` between.
- Column 2: similarity narrative + provenance line.
- Column 3: status pill.
- Column 4: three buttons `←` `→` `✕` (merge left, merge right, dismiss). Bind to `H J L` on the focused row.

### 4.8 `<AuditFeedItem />`

Grid: `auto auto 1fr` · gap 12px.
- Timestamp (mono 10px, faint) — local time HH:mm:ss.
- Action pill — color matches the posture this action affects (`external_export` = consented).
- Body: `actor → target` in mono 13px; details on second line in mono 10px faint.
- Tier-2 events get a `tier-2` pill on the right.

---

## 5 · Window chrome — native per OS, identical content below

**The rule:** the OS draws the title bar and window controls. Family Graph draws everything below it. The status rail (loopback / encrypted / audit) is the *first* thing the user sees inside the window — that is the brand surface, not the chrome.

### 5.1 Tauri config (`src-tauri/tauri.conf.json`)
```json
{
  "windows": [{
    "decorations": true,
    "titleBarStyle": "Visible",
    "transparent": false,
    "minWidth": 1280,
    "minHeight": 800,
    "width": 1440,
    "height": 900,
    "title": "Family Graph",
    "resizable": true
  }]
}
```

`decorations: true` is the key — this gives macOS its traffic lights and Windows its min/max/close. No custom title bar, no `-webkit-app-region: drag`, no platform-specific HTML to maintain.

### 5.2 macOS-only refinement: unified toolbar look
On macOS only, set the title bar style to "transparent" so the rail appears flush against the traffic lights (no double-bar effect):

```rust
// src-tauri/src/main.rs
#[cfg(target_os = "macos")]
{
  use tauri::TitleBarStyle;
  window.set_title_bar_style(TitleBarStyle::Transparent)?;
}
```

Then add 24px of left padding to `<StatusRail />` *only on macOS* so the loopback dot doesn't sit underneath the traffic lights:

```css
.fg-rail { padding-left: 14px; }
:root[data-platform="mac"] .fg-rail { padding-left: 84px; }
```

Set `data-platform` on `<html>` once at app boot via Tauri's platform API:
```ts
import { platform } from '@tauri-apps/plugin-os';
document.documentElement.dataset.platform = (await platform()) === 'macos' ? 'mac' : 'win';
```

### 5.3 Windows-only refinement: title bar tint
Windows 11 supports tinting the OS title bar to match the app. On Windows, set the immersive dark/light mode + caption color so the OS-drawn bar matches `--bg-sunken`:

```rust
#[cfg(target_os = "windows")]
{
  use windows::Win32::UI::WindowsAndMessaging::*;
  // Apply DWMWA_CAPTION_COLOR = oklch(97% 0.004 250) ≈ #f5f6f8
  window.set_decorations_color(Some(Color::from_hex("#f5f6f8")))?;
}
```

If your Tauri version doesn't expose this, leave it as default Windows white — acceptable.

### 5.4 What stays identical, edge to edge

Everything below the OS title bar:
- 32px status rail (`<StatusRail />`)
- Header with PII ↔ Pseudonym toggle
- All grid layouts, spacing, type, posture pills, identifier hues, provenance dots
- Scrollbars (custom 8px, see 5.5)
- Modal/popover treatments

Pixel-diff a Mac and Windows screenshot of the Conflicts page; everything from `y=titleBarHeight` down should match within 1px. If it doesn't, that's a bug.

### 5.5 Critical Windows-specific fixes
- **Bundle the fonts.** Ship Inter, Inter Tight, JetBrains Mono as WOFF2 files in the app bundle. Reference them with `@font-face` and `font-display: block`. The "Inter" installed on a Windows machine (if any) lacks the alternates we use.
- **Custom scrollbars on every scroll surface:**
  ```css
  * { scrollbar-width: thin; scrollbar-color: var(--rule-strong) transparent; }
  *::-webkit-scrollbar { width: 8px; height: 8px; }
  *::-webkit-scrollbar-thumb { background: var(--rule-strong); border-radius: 4px; }
  *::-webkit-scrollbar-track { background: transparent; }
  ```
  Without this, Windows renders a 17px chunky scrollbar that breaks every layout.
- **Font smoothing for parity:**
  ```css
  html { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
  ```
- **DPI testing:** Windows defaults differ from macOS. Verify the dashboard at 100%, 125%, and 150% DPI. The 0.5px borders are the most likely casualty — fall back to 1px on `@media (-webkit-max-device-pixel-ratio: 1)` if needed.
- **No `system-ui`** as primary stack. Use it only as the final fallback after the bundled font.

---

## 6 · State management

Two pieces of global state, both Zustand:

```ts
// store.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const useFG = create(persist(
  (set) => ({
    view: 'pseudonym' as 'pseudonym' | 'pii',
    setView: (v) => set({ view: v }),
    // theme deliberately omitted — institutional only in v1
  }),
  { name: 'fg-state' }
));
```

That's it for global. Everything else (route data, form state, modal state) is local React state or React Query.

---

## 7 · API contracts

Existing routes, do not change. Document of record is `product_spec.md`. Selected ones the dashboard needs:

```
GET  /api/health                    → { loopback: true, encrypted: true, schema: 17 }
GET  /api/families                  → Family[]
GET  /api/families/:code            → FamilyDetail
GET  /api/families/:code/people     → Person[]
GET  /api/people                    → Person[]
GET  /api/conflicts?status=open     → Conflict[]
POST /api/conflicts/:id/resolve     → { winner_code, action: 'merge'|'reject'|'dismiss' }
GET  /api/imports                   → Import[]
POST /api/imports                   → multipart/form-data → Import
GET  /api/audit?tier=1|2&since=ISO  → AuditEntry[]
POST /api/exports                   → { entity_codes[], consent_token } → Export
GET  /api/safe/families             → pseudonymized; no PII; AI-safe
```

The PII ↔ pseudonym toggle in the header chooses between `/api/families` and `/api/safe/families`. The dashboard never tries to pseudonymize on the client.

---

## 8 · Migration plan

If retrofitting an existing dashboard:

| Step | What | Done when |
|---|---|---|
| 1 | Add `tokens.css` + `shared.css`, set `data-theme="institutional"` on `<html>` | Body uses indigo accent, JetBrains Mono on `code` |
| 2 | Render `<TitleBar />` + `<StatusRail />` shell on every route | Loopback dot is visible top-left of every page |
| 3 | Migrate `/conflicts` route to new components first | Highest-ROI screen: identifiers + pills land instantly |
| 4 | Migrate `/imports`, `/audit`, `/families`, `/people` | All routes use new shell |
| 5 | Configure Tauri with native decorations; apply per-OS refinements (5.2, 5.3) | macOS shows traffic lights; Windows shows native controls; status rail aligns correctly on each |
| 6 | Bundle fonts; remove CDN links | Audit network tab — zero font requests |
| 7 | Cross-platform pixel review | Side-by-side screenshots match within 1px |

---

## 9 · Non-goals — do not build these

- **No new API routes.** Use existing.
- **No new top-level routes.** Same URLs.
- **No icon library.** Identifiers + sigils + dots replace icons. If you genuinely need one, use a single text glyph (`←` `→` `✕` `↕`).
- **No animation framework.** CSS transitions only — `150ms ease` for color, `200ms ease` for layout.
- **No dark mode.** Forensic theme exists in the design system but is post-v1.
- **No icon-driven empty states.** Empty state = one sentence in `--ink-mute`.
- **No theme switcher in product.** The Tweaks panel was a design tool; do not ship it.
- **No tooltips on the status rail.** It's already self-describing.

---

## 10 · Acceptance checklist (engineering signs off)

- [ ] `tokens.css` + `shared.css` imported, `data-theme="institutional"` set on `<html>`
- [ ] Native window decorations on each OS (traffic lights on Mac, min/max/close on Windows)
- [ ] Status rail leading-padding adjusted on macOS so loopback dot clears the traffic lights
- [ ] Pixel-diff: everything below the title bar is identical on Mac and Windows (within 1px)
- [ ] Status rail visible on every route; loopback/encrypted/audit-live dots present
- [ ] PII ↔ Pseudonym toggle in header; default = pseudonym; persisted to localStorage
- [ ] All identifiers use `<IdCode>`; never plain text
- [ ] All posture badges use `<Pill state="...">`; never custom colors
- [ ] Provenance dots (`<ProvDot>`) appear on every imported row
- [ ] Fonts bundled as WOFF2; zero font requests in network tab
- [ ] Custom 8px scrollbar everywhere (Windows parity)
- [ ] Verified at 100% / 125% / 150% DPI on Windows
- [ ] Audit feed groups tier-1 vs tier-2 visibly; tier-2 events get `tier-2` pill
- [ ] No console errors at any route on cold load

---

## 11 · Questions during build

If a screen isn't covered by this doc:
1. Open `design-handoff/Home Overview.html` in a browser and inspect the DOM shape for the closest analogous component.
2. Read `design-handoff/shared.css` — most patterns are already classed.
3. Open `design-handoff/Family Graph - Institutional Design System.html` and check sections 8–9 (atoms + composites).
4. If still ambiguous: **ask before improvising.** A new component must be added to `shared.css` and documented in this file before it ships. Posture-as-ambient-signal degrades fast if every dev invents their own affordance.

---

## 12 · Cleanup — after implementation is done

`/design-handoff/` is a one-time reference package. Once the dashboard is migrated and the §10 acceptance checklist passes, the folder is dead weight in the repo. Clean it up.

### 12.1 Pre-cleanup checklist (do not delete until all of these are true)

- [ ] All items in §10 (acceptance checklist) are checked off.
- [ ] `tokens.css` and `shared.css` live at `client/src/styles/` and are imported from the root stylesheet — `/design-handoff/` is no longer referenced anywhere in the build.
- [ ] Search the repo: `grep -r "design-handoff" .` returns zero hits in `src/`, `public/`, build configs, and CI scripts. (Hits inside the folder itself are fine — they're about to be deleted.)
- [ ] No imports of `overview.jsx` or `fg-data.js` from `/design-handoff/`. Production code uses its own components and its own data layer; the handoff files were patterns to copy, not modules to import.
- [ ] The design system PDF has been exported and stored somewhere durable (team wiki, Notion, `/docs/`, Figma — wherever your team keeps reference). The HTML source in `/design-handoff/` will go away.
- [ ] At least one engineer who didn't do the migration has reviewed the dashboard against the design system PDF and signed off on parity.

### 12.2 Two cleanup options

**Option A — Archive (recommended for v1).** Move the folder out of the active tree but keep it in git history for reference:

```bash
git mv design-handoff docs/archive/family-graph-handoff-v1
git commit -m "Archive Family Graph design handoff (v1 implementation complete)"
```

This keeps the package findable if a v2 redesign starts, without cluttering the active source tree.

**Option B — Delete.** If your team treats git history as the archive:

```bash
git rm -r design-handoff
git commit -m "Remove Family Graph design handoff package (v1 implementation complete)"
```

The files remain recoverable via `git log -- design-handoff/`. Pick this if your repo policy is "if it's not active, it's not in the tree."

### 12.3 What to keep in the active repo, forever

Even after `/design-handoff/` is gone, these stay:

| File | Final home | Why |
|---|---|---|
| `tokens.css` | `client/src/styles/tokens.css` | Imported by every component |
| `shared.css` | `client/src/styles/shared.css` | Imported by every component |
| The Institutional theme | `<html data-theme="institutional">` | Set once in the shell |
| Bundled fonts (WOFF2) | `client/public/fonts/` | Referenced by `@font-face` in `tokens.css` |

Everything else in `/design-handoff/` (the `.md`, the `.jsx` reference, the `.html` prototype, the design system spec) is build-time or onboarding material — not runtime code.

### 12.4 If a future redesign starts

Don't edit the archived/deleted handoff. Spin up a new `/design-handoff-v2/` package with its own `CLAUDE_CODE_HANDOFF.md` and start the cycle over. Layered handoff packages get out of sync; clean slates don't.

---

*End of handoff. The design system spec is the visual reference; this file is the build instructions; `overview.jsx` is the worked example. All three together = ship-ready. After §10 passes, follow §12 and remove the package.*
