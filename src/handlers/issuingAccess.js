'use strict';
const supabase = require('../lib/supabase');
const { randomHex } = require('../utils/ids');

/** Merchant requests Issuing Live access - always reviewed by an admin, never automatic. */
async function request(ctx) {
  const merchant = await supabase.selectOne('merchants', { id: ctx.merchantId });
  if (!merchant) throw httpError(404, 'NOT_FOUND', 'Marchand introuvable.');
  if (merchant.issuing_live_enabled) throw httpError(409, 'ALREADY_LIVE', "L'accès Issuing Live est déjà actif sur ce compte.");

  const existing = await supabase.selectOne('issuing_access_requests', { merchant_id: ctx.merchantId, status: 'pending' });
  if (existing) throw httpError(409, 'ALREADY_PENDING', 'Une demande est déjà en attente de revue.');

  const row = await supabase.insert('issuing_access_requests', {
    id: `iar_${randomHex(8)}`,
    merchant_id: ctx.merchantId,
    status: 'pending',
    note: (ctx.body && ctx.body.note) || null,
  });
  return { status: 201, body: { request: toPublic(row) } };
}

async function mine(ctx) {
  const rows = await supabase.select('issuing_access_requests', { merchant_id: ctx.merchantId }, { order: 'created_at.desc' });
  return { status: 200, body: { requests: rows.map(toPublic) } };
}

function toPublic(r) {
  return { id: r.id, status: r.status, note: r.note, created_at: r.created_at, reviewed_at: r.reviewed_at };
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { request, mine };
