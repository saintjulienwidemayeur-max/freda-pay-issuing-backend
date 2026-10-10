'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('../src/utils/jwt');

test('sign/verify round-trip returns the original payload', () => {
  const token = jwt.sign({ merchantId: 'mch_abc123' }, 'secret', 3600);
  const decoded = jwt.verify(token, 'secret');
  assert.equal(decoded.merchantId, 'mch_abc123');
  assert.ok(decoded.iat);
  assert.ok(decoded.exp);
});

test('verify rejects a token signed with a different secret', () => {
  const token = jwt.sign({ merchantId: 'x' }, 'secret-a', 3600);
  assert.throws(() => jwt.verify(token, 'secret-b'), /INVALID_SIGNATURE/);
});

test('verify rejects a tampered payload', () => {
  const token = jwt.sign({ merchantId: 'x' }, 'secret', 3600);
  const [h, p, s] = token.split('.');
  const tamperedPayload = Buffer.from(JSON.stringify({ merchantId: 'y' })).toString('base64url');
  const tampered = `${h}.${tamperedPayload}.${s}`;
  assert.throws(() => jwt.verify(tampered, 'secret'), /INVALID_SIGNATURE/);
});

test('verify rejects an expired token', async () => {
  const token = jwt.sign({ merchantId: 'x' }, 'secret', -1); // already expired
  assert.throws(() => jwt.verify(token, 'secret'), /TOKEN_EXPIRED/);
});
