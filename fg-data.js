// Family Graph — fixture data for the Home / Overview screen.
// Realistic-looking but deliberately fake. PII strings are clearly placeholder
// so an operator never confuses screenshot data with their own ledger.

const FG_DATA = {
  institution: {
    name: "St. Theresa Catholic School & Parish",
    operator: "operator@st-theresa.org",
    profile: "catholic_school",
    boot_at: "2026-04-12T08:14:22-05:00",
    schema: 17,
  },
  posture: {
    bind: "127.0.0.1:3500",
    cipher: "AES-256-GCM",
    keyfile_mode: "0600",
    secret_path: "~/.family-graph/secret.key",
    audit_live: true,
    actor: "operator",
    consumers: [
      { name: "missioniq",   scopes: ["pii.read","sanitize"], last_seen: "12s ago", state: "live" },
      { name: "parentpoint", scopes: ["pii.read","import"],   last_seen: "4m ago",  state: "live" },
      { name: "audioscribe", scopes: ["sanitize"],            last_seen: "2h ago",  state: "idle" },
    ],
  },
  counters: {
    families:   { value: 1284, delta: "+14",  series: [12,14,11,13,18,22,17,15,19,21,24,28,26,31,29,33,36,38] },
    persons:    { value: 4127, delta: "+38",  series: [22,24,21,28,31,29,33,38,41,44,47,51,55,58,62,65,68,71] },
    addresses:  { value:  998, delta:  "+9",  series: [4,5,3,6,4,7,5,8,6,9,7,10,8,11,9,12,11,14] },
    conflicts:  { value:   17, delta: "+2",   series: [9,11,8,10,13,15,12,14,16,14,17,15,18,16,19,17,20,17] },
  },
  conflicts_open: [
    { code: "conf_b1c2d3e4", left: "p_e4d2f8a1", right: "p_9a3b1c7d", reason: "name + dob within 0.86", file: "facts_q1_2026.csv", age: "2h",  assignee: null },
    { code: "conf_4a8d2f91", left: "p_71f8a2c3", right: "p_a4d3e2f1", reason: "name match, addr differs", file: "donor-list-mar.xlsx", age: "5h",  assignee: "fr.mike@…" },
    { code: "conf_d92e1c4a", left: "p_38c91da7", right: "p_5b2f73e8", reason: "phone match, name 0.74", file: "ministryplatform.csv", age: "1d",  assignee: null },
    { code: "conf_77abf3e2", left: "p_c8a1d29f", right: "p_3e4f1a8c", reason: "addr + family-name 0.91", file: "renweb_apr.xlsx", age: "1d",  assignee: "principal@…" },
    { code: "conf_2f3a91dc", left: "p_b71fa2c3", right: "p_91c4ad28", reason: "household co-residence", file: "facts_q1_2026.csv", age: "2d",  assignee: null },
  ],
  imports_recent: [
    { code: "imp_2026_04_28a", file: "facts_q1_2026.csv",         source: "FACTS",            cat: "school", ran_at: "today 09:14",  rows: 312, created: 14, attached: 281, conflicts: 4,  actor: "operator" },
    { code: "imp_2026_04_27b", file: "donor-list-mar.xlsx",       source: "Excel",            cat: "church", ran_at: "yest. 16:02",  rows:  87, created:  3, attached:  82, conflicts: 1,  actor: "operator" },
    { code: "imp_2026_04_27a", file: "ministryplatform.csv",      source: "Ministry Platform",cat: "church", ran_at: "yest. 14:38",  rows: 421, created:  8, attached: 409, conflicts: 2,  actor: "operator" },
    { code: "imp_2026_04_25a", file: "renweb_apr.xlsx",           source: "RenWeb",           cat: "school", ran_at: "Apr 25",       rows: 198, created:  6, attached: 190, conflicts: 1,  actor: "operator" },
    { code: "imp_2026_04_22a", file: "ladies-guild-roster.csv",   source: "CSV",              cat: "other",  ran_at: "Apr 22",       rows:  41, created:  2, attached:  39, conflicts: 0,  actor: "operator" },
  ],
  audit_recent: [
    { t: "09:42:11", actor: "missioniq",   action: "read_pii",        target: "f_a7b3c91d", note: "donor-detail panel" },
    { t: "09:41:58", actor: "operator",   action: "conflict_merged", target: "conf_8a1f...", note: "→ p_e4d2f8a1" },
    { t: "09:39:02", actor: "missioniq",   action: "sanitize",        target: "tk_a1b2c3d4", note: "238 tokens, board-summary draft" },
    { t: "09:37:44", actor: "parentpoint", action: "read_pii",        target: "p_71f8a2c3", note: "preferred-contact lookup" },
    { t: "09:30:15", actor: "operator",   action: "external_export", target: "9 families",  note: "→ board-report.csv (PII consented)", tier: 2 },
    { t: "09:28:01", actor: "operator",   action: "bulk_import",     target: "imp_2026_04_28a", note: "facts_q1_2026.csv · 312 rows" },
    { t: "09:14:33", actor: "system",     action: "boot",            target: "schema=17",  note: "audit count carries forward" },
  ],
  notify: [
    { kind: "conflict_assigned", to: "fr.mike@…",   subject: "1 conflict awaiting review", state: "delivered", t: "08:11" },
    { kind: "import_summary",    to: "principal@…", subject: "RenWeb import — 1 conflict", state: "delivered", t: "yest." },
  ],
};

window.FG_DATA = FG_DATA;
