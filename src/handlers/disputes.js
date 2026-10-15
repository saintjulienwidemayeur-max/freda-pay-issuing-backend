'use strict';
const supabase = require('../lib/supabase');
const { randomHex } = require('../utils/ids');

const REASONS = ['unauthorized', 'not_received', 'wrong_amount', 'duplicate', 'other'];

/** Merchant opens a dispute on one of their own payments. */
async function create(ctx) {
  const payment = await supabase.selectOne('payments', { id: ctx.params.id, merchant_id: ctx.merchantId });
  if (!payment) throw httpError(404, 'NOT_FOUND', 'Paiement introuvable.');
  if (payment.status !== 'succeeded') throw httpError(400, 'NOT_DISPUTABLE', 'Seul un paiement réussi peut faire l\'objet d\'un litige.');

  const existing = await supabase.selectOne('disputes', { payment_id: payment.id, status: 'open' });
  if (existing) throw httpError(409, 'ALREADY_OPEN', 'Un litige est déjà ouvert pour ce paiement.');

  const { reason, details } = ctx.body || {};
  if (!REASONS.includes(reason)) throw httpError(400, 'INVALID_REASON', `reason doit être l'un de : ${REASONS.join(', ')}.`);

  const row = await supabase.insert('disputes', {
    id: `dsp_${randomHex(8)}`,
    merchant_id: ctx.merchantId,
    payment_id: payment.id,
    reason,
    details: details || null,
    status: 'open',
  });
  return { status: 201, body: { dispute: toPublic(row) } };
}

async function mine(ctx) {
  const rows = await supabase.select('disputes', { merchant_id: ctx.merchantId }, { order: 'created_at.desc' });
  return { status: 200, body: { disputes: rows.map(toPublic) } };
}

function toPublic(d) {
  return {
    id: d.id, payment_id: d.payment_id, reason: d.reason, details: d.details,
    status: d.status, admin_note: d.admin_note, created_at: d.created_at, resolved_at: d.resolved_at,
  };
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { create, mine };
