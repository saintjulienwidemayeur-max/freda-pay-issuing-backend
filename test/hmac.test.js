'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWithdrawalPayload, signWithdrawal } = require('../src/utils/hmac');
const crypto = require('crypto');

test('buildWithdrawalPayload joins fields in exact documented order', () => {
  const payload = buildWithdrawalPayload({
    amount: 500,
    method: 'natcash',
    recipient: '50912345678',
    reference: 'CMD-2026-001',
    timestamp: 1715691234,
  });
  assert.equal(payload, '500|natcash|50912345678|CMD-2026-001|1715691234');
});

test('signWithdrawal matches manual HMAC-SHA256 computation', () => {
  const params = {
    amount: 500,
    method: 'natcash',
    recipient: '50912345678',
    reference: 'CMD-2026-001',
    timestamp: 1715691234,
  };
  const secret = 'votre_secret_64_caracteres';
  const expected = crypto
    .createHmac('sha256', secret)
    .update('500|natcash|50912345678|CMD-2026-001|1715691234')
    .digest('hex');
  assert.equal(signWithdrawal(params, secret), expected);
});

test('signWithdrawal changes if any field changes (tamper detection)', () => {
  const base = { amount: 500, method: 'natcash', recipient: '50912345678', reference: 'CMD-001', timestamp: 111 };
  const secret = 'secret';
  const sig1 = signWithdrawal(base, secret);
  const sig2 = signWithdrawal({ ...base, amount: 501 }, secret);
  assert.notEqual(sig1, sig2);
});
