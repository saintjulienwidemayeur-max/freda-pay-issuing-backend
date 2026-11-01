'use strict';
const crypto = require('crypto');

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) - what Google Authenticator, Authy, 1Password... all speak. No dependency. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20)); // 160 bits
}

function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 1000000).padStart(6, '0');
}

const currentStep = (now) => Math.floor((now === undefined ? Date.now() : now) / 1000 / STEP_SECONDS);

function code(secret, now) {
  return hotp(secret, currentStep(now));
}

/** Returns the matching time step (so the caller can refuse a replay of the same code) or null. Accepts one step of clock drift each way. */
function verify(secret, token, now) {
  const t = String(token || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(t)) return null;
  const step = currentStep(now);
  for (const s of [step, step - 1, step + 1]) {
    const expected = Buffer.from(hotp(secret, s));
    if (crypto.timingSafeEqual(expected, Buffer.from(t))) return s;
  }
  return null;
}

function otpauthUri({ secret, account, issuer }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

/** The secret is stored encrypted (AES-256-GCM), so a leaked table alone is not enough to generate codes. */
function keyFrom(secretMaterial) {
  return crypto.createHash('sha256').update(`2fa-secret-key:${secretMaterial}`).digest();
}
function encrypt(plain, secretMaterial) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(secretMaterial), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
function decrypt(blob, secretMaterial) {
  const [iv, tag, enc] = String(blob).split('.').map((p) => Buffer.from(p, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(secretMaterial), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

module.exports = { generateSecret, code, verify, otpauthUri, encrypt, decrypt, base32Encode, base32Decode, STEP_SECONDS };
