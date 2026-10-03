'use strict';
const crypto = require('crypto');

/** Generates a random numeric code of the given length (e.g. "483920"). */
function generateCode(length) {
  const max = 10 ** length;
  const n = crypto.randomInt(0, max);
  return String(n).padStart(length, '0');
}

/** SHA-256 hash of a code - we never store the plaintext code. */
function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

/** Timing-safe comparison of a submitted code against the stored hash. */
function verifyCode(code, storedHash) {
  const candidate = Buffer.from(hashCode(code));
  const stored = Buffer.from(String(storedHash));
  if (candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}

module.exports = { generateCode, hashCode, verifyCode };
