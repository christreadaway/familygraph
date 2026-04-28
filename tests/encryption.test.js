'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const enc = require('../server/crypto/encryption');
const { newSecrets } = require('./_helpers');

test('encryption > round trip', () => {
  const s = newSecrets();
  const ct = enc.encrypt(s, 'Padre Pio');
  assert.ok(Buffer.isBuffer(ct));
  assert.notEqual(ct.toString('utf8'), 'Padre Pio');
  assert.equal(enc.decrypt(s, ct), 'Padre Pio');
});

test('encryption > null/undefined pass through', () => {
  const s = newSecrets();
  assert.equal(enc.encrypt(s, null), null);
  assert.equal(enc.encrypt(s, undefined), null);
  assert.equal(enc.decrypt(s, null), null);
});

test('encryption > tamper detection via auth tag', () => {
  const s = newSecrets();
  const ct = Buffer.from(enc.encrypt(s, 'secret'));
  // Flip a byte in the ciphertext.
  ct[ct.length - 1] ^= 0xff;
  assert.throws(() => enc.decrypt(s, ct));
});

test('encryption > different keys do not decrypt', () => {
  const a = newSecrets();
  const b = newSecrets();
  const ct = enc.encrypt(a, 'family secret');
  assert.throws(() => enc.decrypt(b, ct));
});

test('encryption > hmac is deterministic and key-bound', () => {
  const s1 = newSecrets();
  const s2 = newSecrets();
  const h1 = enc.hmac(s1, 'mary smith');
  const h2 = enc.hmac(s1, 'mary smith');
  const h3 = enc.hmac(s2, 'mary smith');
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
});

test('encryption > normalize helpers', () => {
  assert.equal(enc.normalizeName('  Doe '), 'doe');
  assert.equal(enc.normalizeName('María-José'), 'maria jose'); // accents stripped, hyphens to spaces
  assert.equal(enc.normalizeEmail(' Mary@Example.ORG '), 'mary@example.org');
  assert.equal(enc.normalizePhone('+1 (415) 555-0100'), '4155550100');
  assert.equal(enc.normalizePhone('14155550100'), '4155550100');
  assert.equal(enc.normalizePhone(''), null);
});

test('encryption > IVs are random (different ciphertext for same plaintext)', () => {
  const s = newSecrets();
  const a = enc.encrypt(s, 'hello');
  const b = enc.encrypt(s, 'hello');
  assert.notEqual(a.toString('hex'), b.toString('hex'));
  assert.equal(enc.decrypt(s, a), 'hello');
  assert.equal(enc.decrypt(s, b), 'hello');
});
