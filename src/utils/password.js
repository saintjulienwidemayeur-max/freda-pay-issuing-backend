'use strict';
const crypto = require('crypto');

const KEY_LEN = 64;

/**
 * Hash a plaintext password with scrypt + a random salt.
 * Returns a single string "salt:hash" (both hex) for easy storage.
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, KEY_LEN).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verify a plaintext password against a stored "salt:hash" string.
 */
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(String(password), salt, KEY_LEN);
  const stored_ = Buffer.from(hash, 'hex');
  if (candidate.length !== stored_.length) return false;
  return crypto.timingSafeEqual(candidate, stored_);
}

module.exports = { hashPassword, verifyPassword };
