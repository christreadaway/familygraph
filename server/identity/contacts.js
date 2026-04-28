'use strict';

const enc = require('../crypto/encryption');
const { newCode, isValidCode } = require('../crypto/identifiers');
const aliases = require('./aliases');

// Email
function upsertEmail(db, secrets, value, { isVerified = false } = {}) {
  const norm = enc.normalizeEmail(value);
  if (!norm) return null;
  const hash = enc.hmac(secrets, norm);
  const existing = db.prepare('SELECT code FROM emails WHERE norm_hash = ?').get(hash);
  if (existing) return existing.code;
  const code = newCode('email');
  db.prepare(
    `INSERT INTO emails (code, value_ct, norm_hash, is_verified) VALUES (?, ?, ?, ?)`
  ).run(code, enc.encrypt(secrets, value), hash, isVerified ? 1 : 0);
  return code;
}

function getEmail(db, secrets, code, { includePii = false } = {}) {
  if (!isValidCode(code, 'email')) return null;
  const target = aliases.resolveAlias(db, code);
  const row = db.prepare('SELECT * FROM emails WHERE code = ?').get(target);
  if (!row) return null;
  return {
    code: row.code,
    is_verified: !!row.is_verified,
    created_at: row.created_at,
    value: includePii ? enc.decrypt(secrets, row.value_ct) : null,
  };
}

function attachEmailToPerson(db, personCode, emailCode, { isPrimary = false } = {}) {
  const p = aliases.resolveAlias(db, personCode);
  const e = aliases.resolveAlias(db, emailCode);
  db.prepare(
    `INSERT OR IGNORE INTO person_emails (person_code, email_code, is_primary) VALUES (?, ?, ?)`
  ).run(p, e, isPrimary ? 1 : 0);
}

// Phone
function upsertPhone(db, secrets, value, { kind = 'other' } = {}) {
  const norm = enc.normalizePhone(value);
  if (!norm) return null;
  const hash = enc.hmac(secrets, norm);
  const existing = db.prepare('SELECT code FROM phones WHERE norm_hash = ?').get(hash);
  if (existing) return existing.code;
  const code = newCode('phone');
  db.prepare(
    `INSERT INTO phones (code, value_ct, norm_hash, kind) VALUES (?, ?, ?, ?)`
  ).run(code, enc.encrypt(secrets, value), hash, kind);
  return code;
}

function getPhone(db, secrets, code, { includePii = false } = {}) {
  if (!isValidCode(code, 'phone')) return null;
  const target = aliases.resolveAlias(db, code);
  const row = db.prepare('SELECT * FROM phones WHERE code = ?').get(target);
  if (!row) return null;
  return {
    code: row.code,
    kind: row.kind,
    created_at: row.created_at,
    value: includePii ? enc.decrypt(secrets, row.value_ct) : null,
  };
}

function attachPhoneToPerson(db, personCode, phoneCode, { isPrimary = false } = {}) {
  const p = aliases.resolveAlias(db, personCode);
  const ph = aliases.resolveAlias(db, phoneCode);
  db.prepare(
    `INSERT OR IGNORE INTO person_phones (person_code, phone_code, is_primary) VALUES (?, ?, ?)`
  ).run(p, ph, isPrimary ? 1 : 0);
}

// Address
function upsertAddress(db, secrets, parts) {
  const norm = enc.normalizeAddress(parts);
  if (!norm) return null;
  const hash = enc.hmac(secrets, norm);
  const existing = db.prepare('SELECT code FROM addresses WHERE norm_hash = ?').get(hash);
  if (existing) return existing.code;
  const code = newCode('address');
  db.prepare(
    `INSERT INTO addresses (code, line1_ct, line2_ct, city_ct, region_ct, postal_ct, country_ct, norm_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    code,
    enc.encrypt(secrets, parts.line1),
    enc.encrypt(secrets, parts.line2),
    enc.encrypt(secrets, parts.city),
    enc.encrypt(secrets, parts.region),
    enc.encrypt(secrets, parts.postal),
    enc.encrypt(secrets, parts.country),
    hash
  );
  return code;
}

function getAddress(db, secrets, code, { includePii = false } = {}) {
  if (!isValidCode(code, 'address')) return null;
  const target = aliases.resolveAlias(db, code);
  const row = db.prepare('SELECT * FROM addresses WHERE code = ?').get(target);
  if (!row) return null;
  if (!includePii) {
    return { code: row.code, created_at: row.created_at, updated_at: row.updated_at };
  }
  return {
    code: row.code,
    line1: enc.decrypt(secrets, row.line1_ct),
    line2: enc.decrypt(secrets, row.line2_ct),
    city: enc.decrypt(secrets, row.city_ct),
    region: enc.decrypt(secrets, row.region_ct),
    postal: enc.decrypt(secrets, row.postal_ct),
    country: enc.decrypt(secrets, row.country_ct),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function attachAddressToFamily(db, familyCode, addressCode, { label = 'home', isPrimary = false } = {}) {
  const f = aliases.resolveAlias(db, familyCode);
  const a = aliases.resolveAlias(db, addressCode);
  db.prepare(
    `INSERT OR REPLACE INTO family_addresses (family_code, address_code, label, is_primary) VALUES (?, ?, ?, ?)`
  ).run(f, a, label, isPrimary ? 1 : 0);
}

function attachAddressToPerson(db, personCode, addressCode, { label = 'home', isPrimary = false } = {}) {
  const p = aliases.resolveAlias(db, personCode);
  const a = aliases.resolveAlias(db, addressCode);
  db.prepare(
    `INSERT OR REPLACE INTO person_addresses (person_code, address_code, label, is_primary) VALUES (?, ?, ?, ?)`
  ).run(p, a, label, isPrimary ? 1 : 0);
}

function familyContacts(db, secrets, familyCode, { includePii = false } = {}) {
  const f = aliases.resolveAlias(db, familyCode);
  const addressRows = db
    .prepare(
      `SELECT a.*, fa.label, fa.is_primary
         FROM family_addresses fa JOIN addresses a ON a.code = fa.address_code
        WHERE fa.family_code = ?`
    )
    .all(f);
  const persons = db
    .prepare(
      `SELECT person_code FROM memberships WHERE family_code = ? AND ended_at IS NULL`
    )
    .all(f);
  const emails = [];
  const phones = [];
  for (const { person_code } of persons) {
    const eRows = db
      .prepare(
        `SELECT e.*, pe.is_primary, pe.person_code FROM person_emails pe JOIN emails e ON e.code = pe.email_code WHERE pe.person_code = ?`
      )
      .all(person_code);
    emails.push(...eRows);
    const pRows = db
      .prepare(
        `SELECT ph.*, pp.is_primary, pp.person_code FROM person_phones pp JOIN phones ph ON ph.code = pp.phone_code WHERE pp.person_code = ?`
      )
      .all(person_code);
    phones.push(...pRows);
  }
  return {
    addresses: addressRows.map(r => ({
      code: r.code,
      label: r.label,
      is_primary: !!r.is_primary,
      ...(includePii
        ? {
            line1: enc.decrypt(secrets, r.line1_ct),
            line2: enc.decrypt(secrets, r.line2_ct),
            city: enc.decrypt(secrets, r.city_ct),
            region: enc.decrypt(secrets, r.region_ct),
            postal: enc.decrypt(secrets, r.postal_ct),
            country: enc.decrypt(secrets, r.country_ct),
          }
        : {}),
    })),
    emails: emails.map(r => ({
      code: r.code,
      person_code: r.person_code,
      is_primary: !!r.is_primary,
      is_verified: !!r.is_verified,
      ...(includePii ? { value: enc.decrypt(secrets, r.value_ct) } : {}),
    })),
    phones: phones.map(r => ({
      code: r.code,
      person_code: r.person_code,
      is_primary: !!r.is_primary,
      kind: r.kind,
      ...(includePii ? { value: enc.decrypt(secrets, r.value_ct) } : {}),
    })),
  };
}

module.exports = {
  upsertEmail,
  getEmail,
  attachEmailToPerson,
  upsertPhone,
  getPhone,
  attachPhoneToPerson,
  upsertAddress,
  getAddress,
  attachAddressToFamily,
  attachAddressToPerson,
  familyContacts,
};
