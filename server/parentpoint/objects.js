'use strict';

// Convert FamilyGraph internal records into the ParentPoint contract
// shapes documented in §6.1 (person), §6.2 (household), §6.3 (consent).
// One concept lives in one place: callers that need a PP-shaped object
// import from here rather than re-walking the schema.

const enc = require('../crypto/encryption');
const aliases = require('../identity/aliases');
const consentsMod = require('./consents');

// Map FG memberships.relation_label → PP household role. Returns the
// literal label when set; falls back through legacy role/custody when the
// label is null (pre-contract memberships).
function relationLabelFor(membership) {
  if (membership.relation_label) return membership.relation_label;
  switch (membership.role) {
    case 'parent':
    case 'spouse':
    case 'head':
      return 'other';
    case 'child':
      return 'child';
    case 'guardian':
      return 'guardian';
    case 'grandparent':
      return 'grandparent';
    case 'member':
    case 'other_adult':
    default:
      return 'other';
  }
}

// Map FG memberships.custody → PP custodial boolean (§6.2). 'sole' and
// 'joint' both grant custody; 'other_guardian'/'unspecified'/null are
// false. The contract field is a bool, not a tri-state.
function custodialFor(custody) {
  if (custody === 'sole' || custody === 'joint') return true;
  return false;
}

// Translate a PP role label into the FG memberships.role bucket.
// "mother"/"father"/"step_parent" all map to the existing 'parent' role;
// "child" maps to 'child'; the rest pass through. We never invent a new
// role bucket — callers that need finer detail consult relation_label.
function ppRoleToInternal(label) {
  switch (label) {
    case 'mother':
    case 'father':
    case 'step_parent':
      return 'parent';
    case 'guardian':
      return 'guardian';
    case 'grandparent':
      return 'grandparent';
    case 'child':
      return 'child';
    case 'other':
      return 'other_adult';
    default:
      return null;
  }
}

function _primaryEmail(rows) {
  if (!rows.length) return null;
  const primary = rows.find(r => r.is_primary);
  return primary || rows[0];
}

// Decode an emails / phones bundle for a single person.
function _contactsForPerson(db, secrets, personCode) {
  const emails = db.prepare(
    `SELECT e.code, e.value_ct, e.is_verified, pe.is_primary
       FROM person_emails pe
       JOIN emails e ON e.code = pe.email_code
      WHERE pe.person_code = ?`
  ).all(personCode);
  const phones = db.prepare(
    `SELECT p.code, p.value_ct, p.kind, p.e164, p.sms_consent, pp.is_primary
       FROM person_phones pp
       JOIN phones p ON p.code = pp.phone_code
      WHERE pp.person_code = ?`
  ).all(personCode);
  return {
    emails: emails.map(r => ({
      code: r.code,
      value: enc.decrypt(secrets, r.value_ct),
      is_primary: !!r.is_primary,
      is_verified: !!r.is_verified,
    })),
    phones: phones.map(r => ({
      code: r.code,
      value: enc.decrypt(secrets, r.value_ct),
      kind: r.kind || 'other',
      e164: r.e164 || null,
      sms_consent: !!r.sms_consent,
      is_primary: !!r.is_primary,
    })),
  };
}

// Person object for §6.1. Returns null when the code resolves to nothing.
function personObject(db, secrets, personCode) {
  const target = aliases.resolveAlias(db, personCode);
  if (!target) return null;
  const row = db.prepare(`SELECT * FROM persons WHERE code = ?`).get(target);
  if (!row) return null;

  const { emails, phones } = _contactsForPerson(db, secrets, target);
  const primaryE = _primaryEmail(emails);
  const additional = emails.filter(e => e !== primaryE).map(e => e.value).filter(Boolean);

  const addrRow = db.prepare(
    `SELECT a.* FROM person_addresses pa
       JOIN addresses a ON a.code = pa.address_code
      WHERE pa.person_code = ?
      ORDER BY pa.is_primary DESC, a.created_at ASC LIMIT 1`
  ).get(target);
  // Fall back to the family-level mailing address when the person has no
  // personal one — the doc keeps mailingAddress on the person object, but
  // a household's primary mailing address is the natural source for
  // children and parents that share an address.
  let addrSource = addrRow;
  if (!addrSource) {
    const famAddr = db.prepare(
      `SELECT a.* FROM memberships m
          JOIN family_addresses fa ON fa.family_code = m.family_code
          JOIN addresses a ON a.code = fa.address_code
         WHERE m.person_code = ? AND m.ended_at IS NULL
         ORDER BY fa.is_primary DESC, a.created_at ASC LIMIT 1`
    ).get(target);
    addrSource = famAddr;
  }
  const mailingAddress = addrSource ? {
    line1: enc.decrypt(secrets, addrSource.line1_ct),
    line2: enc.decrypt(secrets, addrSource.line2_ct),
    city: enc.decrypt(secrets, addrSource.city_ct),
    state: enc.decrypt(secrets, addrSource.region_ct),
    postal: enc.decrypt(secrets, addrSource.postal_ct),
    country: enc.decrypt(secrets, addrSource.country_ct),
  } : null;

  return {
    personId: target,
    primaryEmail: primaryE ? primaryE.value : null,
    additionalEmails: additional,
    phones: phones.map(p => ({
      e164: p.e164 || null,
      raw: p.value,
      type: p.kind || 'other',
      smsConsent: !!p.sms_consent,
    })),
    displayName: enc.decrypt(secrets, row.display_name_ct),
    firstName: enc.decrypt(secrets, row.given_name_ct),
    lastName: enc.decrypt(secrets, row.family_name_ct),
    preferredName: enc.decrypt(secrets, row.preferred_name_ct),
    dateOfBirth: enc.decrypt(secrets, row.date_of_birth_ct),
    mailingAddress,
    kind: row.kind || null,
    active: row.status === 'active',
    updatedAt: row.updated_at,
  };
}

// Household object for §6.2.
function householdObject(db, secrets, familyCode) {
  const target = aliases.resolveAlias(db, familyCode);
  const fam = db.prepare(`SELECT * FROM families WHERE code = ?`).get(target);
  if (!fam) return null;

  const memberRows = db.prepare(
    `SELECT m.* FROM memberships m
      WHERE m.family_code = ? AND m.ended_at IS NULL
      ORDER BY m.started_at ASC`
  ).all(target);

  const members = memberRows.map(m => ({
    personId: m.person_code,
    role: relationLabelFor(m),
    custodial: custodialFor(m.custody),
  }));

  // Resolve primary contact: stored pointer if it still exists; otherwise
  // first active adult member; otherwise first member.
  let primary = fam.primary_contact_person_code || null;
  if (primary) {
    const ok = memberRows.some(m => m.person_code === primary);
    if (!ok) primary = null;
  }
  if (!primary) {
    const adult = memberRows.find(m => (m.role !== 'child' && m.relation_label !== 'child'));
    primary = adult ? adult.person_code : (memberRows[0] ? memberRows[0].person_code : null);
  }

  return {
    householdId: target,
    members,
    primaryContactPersonId: primary,
    communicationLanguage: fam.communication_language || 'en',
    updatedAt: fam.updated_at,
  };
}

// Consent object for §6.3. Always returns a record — a missing row reads
// as 'allow' for both fields (the doc's default).
function consentObject(db, personCode) {
  const target = aliases.resolveAlias(db, personCode);
  const row = consentsMod.get(db, target);
  return {
    personId: target,
    photoConsent: row.photo_consent,
    directoryListing: row.directory_listing,
    updatedAt: row.updated_at,
  };
}

// Look up the household that a person currently belongs to. Returns the
// active membership's family_code or null. When a person is in more than
// one active household (rare; usually a data anomaly), prefer the most
// recently created membership so the answer is deterministic.
function householdForPerson(db, personCode) {
  const target = aliases.resolveAlias(db, personCode);
  const row = db.prepare(
    `SELECT family_code FROM memberships
       WHERE person_code = ? AND ended_at IS NULL
       ORDER BY started_at DESC LIMIT 1`
  ).get(target);
  return row ? row.family_code : null;
}

// Resolve a personId from an email address — used by §6.4
// GET /v1/persons?email=. Returns the active person_code or null.
function personByEmail(db, secrets, email) {
  const norm = enc.normalizeEmail(email);
  if (!norm) return null;
  const hash = enc.hmac(secrets, norm);
  if (!hash) return null;
  const row = db.prepare(
    `SELECT pe.person_code FROM emails e
       JOIN person_emails pe ON pe.email_code = e.code
       JOIN persons p ON p.code = pe.person_code
      WHERE e.norm_hash = ? AND p.status = 'active'
      ORDER BY pe.is_primary DESC LIMIT 1`
  ).get(hash);
  return row ? row.person_code : null;
}

module.exports = {
  personObject,
  householdObject,
  consentObject,
  householdForPerson,
  personByEmail,
  ppRoleToInternal,
  relationLabelFor,
  custodialFor,
};
