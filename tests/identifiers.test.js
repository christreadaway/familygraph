'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { newCode, kindOf, isValidCode } = require('../server/crypto/identifiers');

test('identifiers > newCode produces correct prefix and length', () => {
  for (const kind of ['family', 'person', 'email', 'phone', 'address', 'relationship', 'membership', 'source', 'conflict', 'token_set', 'audit']) {
    const c = newCode(kind);
    assert.equal(kindOf(c), kind, `kindOf(${c}) should be ${kind}`);
    assert.ok(isValidCode(c, kind), `${c} should validate as ${kind}`);
  }
});

test('identifiers > kindOf disambiguates addr_ from a_', () => {
  const a = newCode('address');
  assert.equal(kindOf(a), 'address');
  assert.match(a, /^addr_[0-9a-f]{16}$/);
});

test('identifiers > newCode rejects unknown kinds', () => {
  assert.throws(() => newCode('nope'), /Unknown identifier kind/);
});

test('identifiers > isValidCode rejects malformed codes', () => {
  assert.equal(isValidCode('f_xyz'), false);
  assert.equal(isValidCode('p_12345678901'), false);
  assert.equal(isValidCode(''), false);
  assert.equal(isValidCode(null), false);
});

test('identifiers > legacy 8-hex codes still validate', () => {
  assert.equal(isValidCode('f_3fa9c2d1', 'family'), true);
  assert.equal(isValidCode('p_0123abcd'), true);
});

test('identifiers > isValidCode mismatched kind', () => {
  const f = newCode('family');
  assert.equal(isValidCode(f, 'family'), true);
  assert.equal(isValidCode(f, 'person'), false);
});

test('identifiers > codes are non-semantic (no person initials leaked)', () => {
  const codes = new Set();
  for (let i = 0; i < 200; i++) codes.add(newCode('person'));
  assert.ok(codes.size > 195, 'codes should be effectively unique');
  for (const c of codes) {
    assert.match(c, /^p_[0-9a-f]{16}$/);
  }
});
