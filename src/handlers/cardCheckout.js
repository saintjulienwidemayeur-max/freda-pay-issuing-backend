'use strict';
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const paymentOrchestrator = require('../services/paymentOrchestrator');

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

/** The payment this page is for: found by id AND the secret token in the address (constant-time compare). */
async function find(ctx) {
  const token = String((ctx.query && ctx.query.t) || '');
  const payment = await supabase.selectOne('payments', { id: ctx.params.id, method: 'carte' });
  const expected = payment && payment.checkout_token ? String(payment.checkout_token) : '';
  const ok = expected && token.length === expected.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  if (!payment || !ok) throw httpError(404, 'NOT_FOUND', 'Ce lien de paiement est introuvable ou a expiré.');
  const merchant = await supabase.selectOne('merchants', { id: payment.merchant_id });
  if (!merchant || merchant.deleted_at) throw httpError(404, 'NOT_FOUND', 'Ce lien de paiement est introuvable ou a expiré.');
  return { payment, merchant };
}

/** GET /public/card-checkout/:id?t=...  What the hosted card page needs (the card form values only while the payment is open). */
async function get(ctx) {
  let { payment, merchant } = await find(ctx);
  payment = await paymentOrchestrator.refreshStatus(payment.merchant_id, payment);
  return {
    status: 200,
    body: {
      business_name: merchant.business_name,
      amount: Number(payment.amount),
      currency: payment.currency,
      status: payment.status,
      mode: payment.mode || 'sandbox',
      reference: payment.own_reference,
      return_url: payment.return_url || null,
      card: payment.status === 'pending' ? { client_secret: payment.card_client_secret, publishable_key: payment.card_publishable_key } : undefined,
    },
  };
}

/** GET /public/card-checkout/:id/status?t=... */
async function status(ctx) {
  let { payment } = await find(ctx);
  payment = await paymentOrchestrator.refreshStatus(payment.merchant_id, payment);
  return { status: 200, body: { status: payment.status, return_url: payment.return_url || null } };
}

module.exports = { get, status };
