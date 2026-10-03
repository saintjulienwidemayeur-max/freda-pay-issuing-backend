'use strict';
const links = require('../services/paymentLinks');
const supabase = require('../lib/supabase');
const paymentOrchestrator = require('../services/paymentOrchestrator');
const { generatePaymentLinkId, generatePaymentId, namespaceReference, randomHex } = require('../utils/ids');
const { fetchPage } = require('../utils/pagination');
const { resolveMode } = require('../utils/mode');

/* ===== Dashboard (merchant, session-authenticated) ===== */

async function create(ctx) {
  const { amount, currency, description } = ctx.body || {};
  if (amount != null && (typeof amount !== 'number' || amount <= 0)) {
    throw httpError(400, 'INVALID_AMOUNT', 'amount doit être un nombre positif, ou absent pour un montant libre.');
  }
  const id = generatePaymentLinkId();
  const mode = await resolveMode(ctx);
  const link = await links.create({ id, merchantId: ctx.merchantId, amount, currency: currency || 'HTG', description, mode });
  return { status: 201, body: toPublicDashboard(link) };
}

async function list(ctx) {
  const mode = await resolveMode(ctx);
  const { rows, pagination } = await fetchPage(ctx.query, (limit, offset) =>
    links.list(ctx.merchantId, limit, offset, mode)
  );
  return { status: 200, body: { links: rows.map(toPublicDashboard), pagination, mode } };
}

async function disable(ctx) {
  const row = await links.disable(ctx.merchantId, ctx.params.id);
  if (!row) throw httpError(404, 'NOT_FOUND', 'Lien introuvable.');
  return { status: 200, body: toPublicDashboard(row) };
}

/** Actually removes the link - it stops working and disappears from the list. The payments it already generated are untouched (they live in `payments`, not here). */
async function remove(ctx) {
  const existing = await links.getByIdForMerchant(ctx.merchantId, ctx.params.id);
  if (!existing) throw httpError(404, 'NOT_FOUND', 'Lien introuvable.');
  await supabase.delete('payment_links', { id: ctx.params.id, merchant_id: ctx.merchantId });
  return { status: 200, body: { deleted: true } };
}

/* ===== Public (no auth - anyone with the link can view/pay) ===== */

async function publicGet(ctx) {
  const link = await links.getById(ctx.params.id);
  if (!link || link.status !== 'active') throw httpError(404, 'NOT_FOUND', 'Ce lien de paiement est introuvable ou désactivé.');
  const merchant = await supabase.selectOne('merchants', { id: link.merchant_id });
  return {
    status: 200,
    body: {
      id: link.id,
      business_name: merchant ? merchant.business_name : 'Freda Pay',
      amount: num(link.amount),
      currency: link.currency,
      description: link.description,
    },
  };
}

async function publicPay(ctx) {
  const link = await links.getById(ctx.params.id);
  if (!link || link.status !== 'active') throw httpError(404, 'NOT_FOUND', 'Ce lien de paiement est introuvable ou désactivé.');

  const { method, phone, amount } = ctx.body || {};
  const finalAmount = link.amount != null ? Number(link.amount) : amount;
  if (typeof finalAmount !== 'number' || finalAmount <= 0) {
    throw httpError(400, 'INVALID_AMOUNT', 'Montant invalide.');
  }
  if (!['moncash', 'moncash_ussd', 'natcash', 'carte'].includes(method)) {
    throw httpError(400, 'INVALID_METHOD', 'method doit être moncash, moncash_ussd, natcash ou carte.');
  }

  const ownReference = `paylink_${link.id}_${randomHex(6)}`;
  const id = generatePaymentId();
  const plopplopReference = namespaceReference(link.merchant_id, ownReference);

  try {
    const payment = await paymentOrchestrator.createPayment({
      merchantId: link.merchant_id,
      id,
      ownReference,
      plopplopReference,
      amount: finalAmount,
      currency: link.currency,
      method,
      phoneNumber: phone,
      mode: link.mode || 'sandbox',
    });
    return { status: 201, body: { id: payment.id, status: payment.status, checkout_url: payment.checkout_url } };
  } catch (err) {
    throw httpError(err.code === 'PROVIDER_ERROR' ? 502 : 400, err.code || 'PAYMENT_ERROR', err.message);
  }
}

async function publicPaymentStatus(ctx) {
  const link = await links.getById(ctx.params.id);
  if (!link) throw httpError(404, 'NOT_FOUND', 'Lien introuvable.');

  let payment = await paymentOrchestrator.getById(link.merchant_id, ctx.params.paymentId);
  if (!payment) throw httpError(404, 'NOT_FOUND', 'Paiement introuvable.');
  payment = await paymentOrchestrator.refreshStatus(link.merchant_id, payment);
  return { status: 200, body: { status: payment.status } };
}

function num(v) {
  return v == null ? v : Number(v);
}

function toPublicDashboard(l) {
  return {
    id: l.id,
    amount: num(l.amount),
    currency: l.currency,
    description: l.description,
    status: l.status,
    mode: l.mode || 'sandbox',
    created_at: l.created_at,
  };
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { create, list, disable, remove, publicGet, publicPay, publicPaymentStatus };
