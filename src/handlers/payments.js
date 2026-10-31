'use strict';
const supabase = require('../lib/supabase');
const paymentOrchestrator = require('../services/paymentOrchestrator');
const { generatePaymentId, namespaceReference } = require('../utils/ids');
const { fetchPage } = require('../utils/pagination');
const { resolveMode } = require('../utils/mode');
const { parseAmount } = require('../utils/money');

async function create(ctx) {
  const { amount, currency, reference, phone } = ctx.body || {};
  const method = ctx.body && ctx.body.method === 'card' ? 'carte' : ctx.body && ctx.body.method; // 'card' is accepted as 'carte'
  const customer = ctx.body && (ctx.body.customer || {});

  if (amount == null || !method || !reference) {
    throw httpError(400, 'MISSING_FIELDS', 'amount, method et reference sont requis.');
  }
  parseAmount(amount);

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

/**
 * GET /pay/return : where the customer lands after paying at the MonCash / Natcash partner. The partner is given this address as the
 * return URL of our merchant account, and adds ?statut=...&id_transaction=...&refference_id=... . The payment is read again at the partner
 * at once (so it is credited without waiting for the next background pass), then the customer is sent back to the merchant's own page
 * (the return_url given when the payment was created, with payment_id, reference and status added) or sees a short confirmation page.
 */
async function paymentReturn(ctx) {
  const q = ctx.query || {};
  const ref = String(q.refference_id || q.reference_id || '').slice(0, 200);
  const tx = String(q.id_transaction || q.transaction_id || '').slice(0, 100);
  let payment = null;
  if (ref) payment = await supabase.selectOne('payments', { plopplop_reference: ref });
  if (!payment && tx) payment = await supabase.selectOne('payments', { plopplop_transaction_id: tx });
  if (payment && payment.status === 'pending') {
    try { payment = (await paymentOrchestrator.refreshStatus(payment.merchant_id, payment)) || payment; } catch (e) { /* the background pass will settle it */ }
  }
  const status = payment ? payment.status : 'unknown';
  if (payment && payment.return_url) {
    try {
      const u = new URL(payment.return_url);
      if (u.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(u.hostname)) {
        u.searchParams.set('payment_id', payment.id);
        u.searchParams.set('reference', payment.own_reference);
        u.searchParams.set('status', status);
        ctx.res.writeHead(302, { Location: u.toString() });
        return ctx.res.end();
      }
    } catch (e) { /* not a valid address: the confirmation page below */ }
  }
  const text = { succeeded: ['Paiement reçu', 'Merci ! Votre paiement a été confirmé.'], failed: ['Paiement non abouti', "Votre paiement n'a pas abouti. Vous pouvez réessayer."], pending: ['Paiement en cours de confirmation', "Nous n'avons pas encore reçu la confirmation. Elle arrive en général en quelques instants : vous pouvez fermer cette page."], unknown: ['Paiement', 'Vous pouvez fermer cette page et retourner sur le site du marchand.'] }[status] || ['Paiement', 'Vous pouvez fermer cette page.'];
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(text[0])}</title><style>body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f7f7f8;color:#1a1216;display:grid;place-items:center;min-height:100vh;margin:0}.c{background:#fff;border-radius:16px;padding:32px;max-width:420px;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.08)}h1{font-size:1.3rem;margin:0 0 10px}p{color:#6b5f66;margin:0}</style></head><body><div class="c"><h1>${esc(text[0])}</h1><p>${esc(text[1])}</p></div></body></html>`;
  ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  return ctx.res.end(html);
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

module.exports = {
  paymentReturn, create, get, list, exportCsv };
