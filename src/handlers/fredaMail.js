'use strict';
const crypto = require('crypto');
const config = require('../config');
const fredaMail = require('../services/fredaMail');
const emailAgent = require('../services/agent/emailAgent');

/**
 * POST /webhooks/freda-mail : Freda Mail tells us a new email arrived in one of its mailboxes (event "message.received", see
 * https://fredaworkspace.com/api/v1/docs). The request is signed: X-Freda-Signature = sha256=HMAC("<X-Freda-Timestamp>.<raw body>", whsec_...).
 * The message (same shape as GET /api/v1/messages/{id}) is stored in the admin inbox and the agent answers it.
 */
function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}
const safeEqual = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

async function receive(ctx) {
  const headers = ctx.req.headers;
  const signed = !!headers['x-freda-signature'];
  if (signed) {
    if (!fredaMail.verifySignature(headers, ctx.rawBody || '', config.fredaMail.webhookSecret)) throw httpError(401, 'INVALID_SIGNATURE', 'Signature invalide.');
  } else {
    // Older form kept for tests and manual calls: a shared token in the URL.
    const token = (ctx.query && ctx.query.token) || '';
    if (!config.fredaMail.legacyToken || !safeEqual(token, config.fredaMail.legacyToken)) throw httpError(401, 'INVALID_TOKEN', 'Jeton invalide.');
  }
  const b = ctx.body || {};
  if (b.event && b.event !== 'message.received') return { status: 200, body: { received: 0, ignored: b.event } };
  const list = b.message ? [b.message] : Array.isArray(b.messages) ? b.messages : [b];
  let stored = 0; let duplicates = 0;
  for (const m of list.slice(0, 50)) {
    const row = await fredaMail.storeMessage(m, b.mailbox || (Array.isArray(m.to) ? m.to[0] : m.to));
    if (row) { stored += 1; emailAgent.enqueue(row.id); } else duplicates += 1;
  }
  return { status: 200, body: { received: stored, duplicates } };
}

module.exports = { receive };
