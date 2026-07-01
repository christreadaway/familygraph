'use strict';

// Document access policy — the authoritative ACCESS MATRIX.
//
// FamilyGraph is the access GATE. The partner app owns user authentication; it
// asserts (signed, inside the tenant boundary) WHO the viewer is — their
// userId, role, and relationship to the subject person. FG does NOT
// re-authenticate the partner app's users. FG's job is the POLICY DECISION on the asserted
// viewer plus the AUDIT trail. This module is PURE: same inputs → same
// decision, no I/O, no DB, fully unit-testable.
//
// `policyKey` is derived from a document's (kind, subtype) and is the stable
// handle the matrix is keyed on. It is also persisted on the row so a stored
// document carries its own policy class.
//
// relationship values:
//   'parent_of' — the viewer is a parent/guardian of the subject person.
//   'staff'     — the viewer is institutional staff; `role` further narrows.
// `assigned_teacher` is asserted by the partner app (the partner app knows the roster); FG trusts and
// LOGS it. Same for the other staff roles.
//
// THE MATRIX (source of truth — mirrored in the partner app):
//   sacramental (baptism, first_communion, confirmation, marriage):
//     staff {clergy, dre, admin}; parent_of: ALLOW.
//   accommodation (iep, 504, mtss):
//     staff {learning_team, assigned_teacher, admin}; parent_of: DENY the file
//     (the partner app shows existence/outcomes from metadata only).
//   health_plan (allergy_action_plan, health_care_plan):
//     staff {nurse, assigned_teacher, admin}; parent_of: ALLOW.
//   health_record:
//     immunization → staff {nurse, admin} + parent_of ALLOW;
//     other medical → staff {nurse, admin}; parent_of DENY.
//   safety_flags (mirrored summary, delivered via SYNC not document.fetch):
//     released to {nurse, assigned_teacher, direct_care, admin} and parent_of,
//     regardless of directory/photo consent (life-safety).

// kind/subtype → policyKey.
const SUBTYPE_TO_POLICY = {
  baptism: 'sacramental',
  first_communion: 'sacramental',
  confirmation: 'sacramental',
  marriage: 'sacramental',
  iep: 'accommodation',
  504: 'accommodation',
  mtss: 'accommodation',
  allergy_action_plan: 'health_plan',
  health_care_plan: 'health_plan',
  immunization: 'health_record_immunization',
};

// kind → fallback policyKey when subtype is 'other' or unrecognized.
const KIND_FALLBACK_POLICY = {
  sacramental: 'sacramental',
  accommodation: 'accommodation',
  health: 'health_record_other',
  other: 'other',
};

// Derive the stable policy class for a document. Subtype wins; if the subtype
// is not in the map, fall back to the kind. `health` + 'other' resolves to
// health_record_other (parent DENY), the conservative default.
function derivePolicyKey(kind, subtype) {
  const k = String(kind || '').toLowerCase();
  const s = String(subtype || '').toLowerCase();
  if (Object.prototype.hasOwnProperty.call(SUBTYPE_TO_POLICY, s)) {
    return SUBTYPE_TO_POLICY[s];
  }
  if (Object.prototype.hasOwnProperty.call(KIND_FALLBACK_POLICY, k)) {
    return KIND_FALLBACK_POLICY[k];
  }
  return 'other';
}

// Per-policy-key rules. `staff` is the set of staff roles allowed the file.
// `parent` is whether parent_of is allowed the file itself (vs metadata only).
const MATRIX = {
  sacramental: {
    staff: new Set(['clergy', 'dre', 'admin']),
    parent: true,
  },
  accommodation: {
    staff: new Set(['learning_team', 'assigned_teacher', 'admin']),
    parent: false, // the partner app shows existence/outcomes from metadata only.
  },
  health_plan: {
    staff: new Set(['nurse', 'assigned_teacher', 'admin']),
    parent: true,
  },
  health_record_immunization: {
    staff: new Set(['nurse', 'admin']),
    parent: true,
  },
  health_record_other: {
    staff: new Set(['nurse', 'admin']),
    parent: false,
  },
  other: {
    // No clean class: gate to admin + parent. Conservative.
    staff: new Set(['admin']),
    parent: true,
  },
};

// Roles allowed the life-safety summary (delivered via sync, not fetch).
// Exported for completeness/testing; the safety summary is released to the partner app in
// the sealed sync batch and the partner app applies its own per-viewer gating using this.
const SAFETY_FLAG_STAFF = new Set(['nurse', 'assigned_teacher', 'direct_care', 'admin']);

// decide({ policyKey, role, relationship }) →
//   { allow: bool, reason: '<machine reason>' }
// reason is a short machine token (NEVER PII): 'parent_allow',
// 'staff_role_allow', 'parent_denied_file', 'staff_role_not_permitted',
// 'unknown_policy', 'unknown_relationship'.
function decide({ policyKey, role, relationship } = {}) {
  const rule = MATRIX[policyKey];
  if (!rule) return { allow: false, reason: 'unknown_policy' };

  const rel = String(relationship || '').toLowerCase();
  const rl = String(role || '').toLowerCase();

  if (rel === 'parent_of') {
    return rule.parent
      ? { allow: true, reason: 'parent_allow' }
      : { allow: false, reason: 'parent_denied_file' };
  }

  if (rel === 'staff') {
    return rule.staff.has(rl)
      ? { allow: true, reason: 'staff_role_allow' }
      : { allow: false, reason: 'staff_role_not_permitted' };
  }

  return { allow: false, reason: 'unknown_relationship' };
}

// Whether a viewer is entitled to the life-safety summary. parent_of is always
// entitled; staff must hold a direct-care role. (FG ships the summary to the partner app via
// sync regardless; this helper lets either side gate per-viewer rendering.)
function safetyFlagsAllowed({ role, relationship } = {}) {
  const rel = String(relationship || '').toLowerCase();
  if (rel === 'parent_of') return true;
  if (rel === 'staff') return SAFETY_FLAG_STAFF.has(String(role || '').toLowerCase());
  return false;
}

module.exports = {
  derivePolicyKey,
  decide,
  safetyFlagsAllowed,
  SUBTYPE_TO_POLICY,
  KIND_FALLBACK_POLICY,
  SAFETY_FLAG_STAFF,
};
