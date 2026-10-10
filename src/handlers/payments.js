'use strict';
const paymentOrchestrator = require('../services/paymentOrchestrator');
const { generatePaymentId, namespaceReference } = require('../utils/ids');
const { fetchPage } = require('../utils/pagination');
const { resolveMode } = require('../utils/mode');

async function create(ctx) {
  const { amount, currency, method, reference, phone } = ctx.body || {};

  if (amount == null || !method || !reference) {
    throw httpError(400, 'MISSING_FIELDS', 'amount, method et reference sont requis.');
  }
  if (typeof amount !== 'number' || amount <= 0) {
    throw httpError(400, 'INVALID_AMOUNT', 'amount doit être un nombre positif.');
  }

  const existing = await paymentOrchestrator.getByOwnReference(ctx.merchantId, reference);
  if (existing) {
    // Idempotency: replaying the same reference returns the original payment.
    return { status: 200, body: toPublic(existing) };
  }

  const id = generatePaymentId();
  const plopplopReference = namespaceReference(ctx.merchantId, reference);
  const mode = await resolveMode(ctx);

  try {
    const payment = await paymentOrchestrator.createPayment({
      merchantId: ctx.merchantId,
      id,
      ownReference: reference,
      plopplopReference,
      amount,
      currency: currency || 'HTG',
      method,
      phoneNumber: phone,
      mode,
    });
    return { status: 201, body: toPublic(payment) };
  } catch (err) {
    throw httpError(err.code === 'PROVIDER_ERROR' ? 502 : 400, err.code || 'PAYMENT_ERROR', err.message);
  }
}

async function get(ctx) {
  let payment = await paymentOrchestrator.getById(ctx.merchantId, ctx.params.id);
  if (!payment) throw httpError(404, 'NOT_FOUND', 'Paiement introuvable.');
  payment = await paymentOrchestrator.refreshStatus(ctx.merchantId, payment);
  return { status: 200, body: toPublic(payment) };
}

/** CSV export of this merchant's own payments - the "automatic downloadable report" for the Gateway. */
async function exportCsv(ctx) {
  const mode = await resolveMode(ctx);
  const paymentOrchestratorFull = await paymentOrchestrator.list(ctx.merchantId, 5000, 0, mode);
  const header = 'id,reference,date,method,amount,currency,fee,net_amount,status\n';
  const rows = paymentOrchestratorFull.map((p) => [
    p.id, csvEscape(p.own_reference), p.created_at, p.method,
    num(p.amount), p.currency, p.fee != null ? num(p.fee) : '', p.net_amount != null ? num(p.net_amount) : '', p.status,
  ].join(',')).join('\n');
  const csv = header + rows + '\n';

  ctx.res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="freda-pay-paiements-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
  ctx.res.end(csv);
}

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function list(ctx) {
  const mode = await resolveMode(ctx);
  const { rows, pagination } = await fetchPage(ctx.query, (limit, offset) =>
    paymentOrchestrator.list(ctx.merchantId, limit, offset, mode)
  );
  return { status: 200, body: { payments: rows.map(toPublic), pagination, mode } };
}

function num(v) {
  return v == null ? v : Number(v);
}

function toPublic(p) {
  return {
    id: p.id,
    reference: p.own_reference,
    amount: num(p.amount),
    currency: p.currency,
    method: p.method,
    status: p.status,
    fee: num(p.fee),
    net_amount: num(p.net_amount),
    checkout_url: p.checkout_url,
    provider_transaction_id: p.plopplop_transaction_id,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { create, get, list, exportCsv };
