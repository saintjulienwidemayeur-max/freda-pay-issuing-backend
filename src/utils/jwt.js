'use strict';
const crypto = require('crypto');

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

/**
 * Sign a small, dependency-free HS256 JWT.
 * payload should NOT contain sensitive secrets - it is base64-encoded, not encrypted.
 */
function sign(payload, secret, expiresInSeconds) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = Object.assign({ iat: now }, payload);
  if (expiresInSeconds) body.exp = now + expiresInSeconds;

  const encHeader = base64url(JSON.stringify(header));
  const encPayload = base64url(JSON.stringify(body));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${encHeader}.${encPayload}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${encHeader}.${encPayload}.${signature}`;
}

/**
 * Verify and decode a token. Throws on invalid signature or expiry.
 */
function verify(token, secret) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('MALFORMED_TOKEN');
  const [encHeader, encPayload, signature] = parts;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${encHeader}.${encPayload}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new Error('INVALID_SIGNATURE');
  }

  const payload = JSON.parse(base64urlDecode(encPayload));
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
    throw new Error('TOKEN_EXPIRED');
  }
  return payload;
}

module.exports = { sign, verify };
