'use strict';
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const { randomHex } = require('../utils/ids');
const urlSafety = require('../utils/urlSafety');

function generateSecret() {
  return `whsec_${crypto.randomBytes(24).toString('base64url')}`;
}

/** Registers (or replaces) the merchant's single webhook endpoint. Returns the signing secret ONCE. */
async function register(ctx) {
  const { url } = ctx.body || {};
  if (!url || typeof url !== 'string') throw httpError(400, 'INVALID_URL', 'url est requis et doit commencer par https://.');
  try {
    await urlSafety.assertPublicUrl(url);
  } catch (err) {
    throw httpError(400, 'INVALID_URL', `${err.message[0].toUpperCase()}${err.message.slice(1)}`);
  }

  const existing = await supabase.selectOne('webhook_endpoints', { merchant_id: ctx.merchantId });
  const secret = generateSecret();

  const row = existing
    ? (await supabase.update('webhook_endpoints', { merchant_id: ctx.merchantId }, { url, secret, active: true }))[0]
    : await supabase.insert('webhook_endpoints', {
        id: `whe_${randomHex(8)}`,
        merchant_id: ctx.merchantId,
        url,
        secret,
        active: true,
      });

  return { status: existing ? 200 : 201, body: toPublicWithSecret(row) };
}

async function get(ctx) {
  const row = await supabase.selectOne('webhook_endpoints', { merchant_id: ctx.merchantId });
  return { status: 200, body: { endpoint: row ? toPublic(row) : null } };
}

async function remove(ctx) {
  const row = await supabase.selectOne('webhook_endpoints', { merchant_id: ctx.merchantId });
  if (!row) throw httpError(404, 'NOT_FOUND', 'Aucun webhook enregistré.');
  await supabase.update('webhook_endpoints', { merchant_id: ctx.merchantId }, { active: false });
  return { status: 200, body: { deleted: true } };
}

/** Generates a new signing secret for the existing endpoint (old one stops working immediately). */
async function rotateSecret(ctx) {
  const row = await supabase.selectOne('webhook_endpoints', { merchant_id: ctx.merchantId });
  if (!row) throw httpError(404, 'NOT_FOUND', 'Aucun webhook enregistré.');
  const secret = generateSecret();
  const [updated] = await supabase.update('webhook_endpoints', { merchant_id: ctx.merchantId }, { secret });
  return { status: 200, body: toPublicWithSecret(updated) };
}

function toPublic(row) {
  return { id: row.id, url: row.url, active: !!row.active, created_at: row.created_at };
}
function toPublicWithSecret(row) {
  return Object.assign(toPublic(row), { secret: row.secret });
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { register, get, remove, rotateSecret };
