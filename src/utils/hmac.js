'use strict';
const crypto = require('crypto');

/**
 * Builds the exact payload string PlopPlop expects for withdrawal signing:
 *   "amount|method|recipient|reference|timestamp"
 * IMPORTANT: order matters and must match the docs exactly.
 */
function buildWithdrawalPayload({ amount, method, recipient, reference, timestamp }) {
  return [amount, method, recipient, reference, timestamp].join('|');
}

/**
 * HMAC-SHA256(payload, client_secret) -> lowercase hex string.
 */
function signWithdrawal(params, clientSecret) {
  const payload = buildWithdrawalPayload(params);
  return crypto.createHmac('sha256', clientSecret).update(payload).digest('hex');
}

/**
 * Timing-safe comparison for signatures (defense in depth, useful if we ever
 * need to verify a signature ourselves rather than just generate one).
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { buildWithdrawalPayload, signWithdrawal, safeEqual };
