'use strict';
const paymentOrchestrator = require('../services/paymentOrchestrator');
const { generatePaymentId, namespaceReference } = require('../utils/ids');
const { fetchPage } = require('../utils/pagination');
const { resolveMode } = require('../utils/mode');

async function create(ctx) {
  const { amount, currency, reference, phone } = ctx.body || {};
  const method = ctx.body && ctx.body.method === 'card' ? 'carte' : ctx.body && ctx.body.method; // 'card' is accepted as 'carte'
  const customer = ctx.body && (ctx.body.customer || {});

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
  // A card payment is in USD; MonCash / Natcash are in HTG. The currency defaults to the method's own.
  const returnUrl = cleanReturnUrl(ctx.body && ctx.body.return_url);
  const finalCurrency = currency || (method === 'carte' ? 'USD' : 'HTG');

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
      currency: finalCurrency,
      method,
      phoneNumber: phone,
      mode,
      customer: { name: customer.name || ctx.body.customer_name, email: customer.email || ctx.body.customer_email, phone: customer.phone },
      description: ctx.body.description,
      returnUrl,
    });
    return { status: 201, body: toPublic(payment) };
  } catch (err) {
    throw httpError(err.httpStatus || (err.code === 'PROVIDER_ERROR' ? 502 : 400), err.code || 'PAYMENT_ERROR', err.message);
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
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // a spreadsheet must never run a reference as a formula
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function list(ctx) {
  const mode = await resolveMode(ctx);
  // Optional filters: ?status=pending|succeeded|failed  ?method=moncash|natcash|carte  ?currency=HTG|USD
  const q = ctx.query || {};
  const extra = {
    status: ['pending', 'succeeded', 'failed'].includes(q.status) ? q.status : undefined,
    method: ['moncash', 'moncash_ussd', 'natcash', 'carte', 'all'].includes(q.method) ? q.method : undefined,
    currency: ['HTG', 'USD'].includes(q.currency) ? q.currency : undefined,
  };
  const { rows, pagination } = await fetchPage(ctx.query, (limit, offset) =>
    paymentOrchestrator.list(ctx.merchantId, limit, offset, mode, extra)
  );
  return { status: 200, body: { payments: rows.map(toPublic), pagination, mode } };
}

/** Where the hosted card page sends the customer back after paying: https only (plain http only for localhost tests). */
function cleanReturnUrl(v) {
  if (v == null || v === '') return null;
  let u;
  try { u = new URL(String(v)); } catch (_) { throw httpError(400, 'INVALID_RETURN_URL', 'return_url doit être une adresse https valide.'); }
  const local = u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname);
  if ((u.protocol !== 'https:' && !local) || String(v).length > 500) throw httpError(400, 'INVALID_RETURN_URL', 'return_url doit être une adresse https valide.');
  return u.toString();
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
    provider_transaction_id: p.provider === 'tranzak' ? p.provider_transaction_id : p.plopplop_transaction_id,
    // Card payments: the two values the checkout page needs to show the card form. Only in the answer to the creation.
    card: p._card || undefined,
    customer_name: p.customer_name || undefined,
    customer_email: p.customer_email || undefined,
    customer_phone: p.customer_phone || undefined,
    return_url: p.return_url || undefined,
    failure_reason: p.failure_reason || undefined,
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
