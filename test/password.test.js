'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword } = require('../src/utils/password');

test('hashPassword produces a salt:hash string, and verifyPassword accepts the right password', () => {
  const stored = hashPassword('S3cur3Pass!');
  assert.match(stored, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
  assert.equal(verifyPassword('S3cur3Pass!', stored), true);
});

test('verifyPassword rejects a wrong password', () => {
  const stored = hashPassword('correct-horse-battery-staple');
  assert.equal(verifyPassword('wrong-password', stored), false);
});

test('two hashes of the same password are different (random salt)', () => {
  const a = hashPassword('same-password');
  const b = hashPassword('same-password');
  assert.notEqual(a, b);
  assert.equal(verifyPassword('same-password', a), true);
  assert.equal(verifyPassword('same-password', b), true);
});
