'use strict';
const crypto = require('crypto');

/**
 * Maplerad signs webhooks using the Svix scheme:
 *   headers: svix-id, svix-timestamp, svix-signature
 *   signed content: "{svix-id}.{svix-timestamp}.{raw body}"
 *   signature: HMAC-SHA256(signed content, base64-decode(secret after "whsec_")), base64-encoded
 *   svix-signature header: space-separated "v1,<base64sig>" values (secret rotation support)
 *
 * See https://maplerad.dev/docs/verifying-webhooks
 */
function verify({ svixId, svixTimestamp, rawBody, signatureHeader, signingSecret, toleranceSeconds }) {
  if (!svixId || !svixTimestamp || !signatureHeader || !signingSecret) {
    return { valid: false, reason: 'MISSING_HEADERS' };
  }

  const tolerance = toleranceSeconds || 300; // 5 minutes, guards against replay
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(svixTimestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > tolerance) {
    return { valid: false, reason: 'TIMESTAMP_OUT_OF_RANGE' };
  }

  const secretB64 = signingSecret.startsWith('whsec_') ? signingSecret.slice('whsec_'.length) : signingSecret;
  const secretBytes = Buffer.from(secretB64, 'base64');
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  const expectedBuf = Buffer.from(expected, 'base64');

  const candidates = signatureHeader
    .split(' ')
    .map((part) => (part.includes(',') ? part.split(',')[1] : part))
    .filter(Boolean);

  const matched = candidates.some((candidate) => {
    let candidateBuf;
    try {
      candidateBuf = Buffer.from(candidate, 'base64');
    } catch (e) {
      return false;
    }
    return candidateBuf.length === expectedBuf.length && crypto.timingSafeEqual(candidateBuf, expectedBuf);
  });

  return matched ? { valid: true } : { valid: false, reason: 'SIGNATURE_MISMATCH' };
}

module.exports = { verify };
