'use strict';
const config = require('../config');
const supabase = require('../lib/supabase');
const plopplop = require('./plopplop');
const tranzak = require('./tranzak');
const ledger = require('./ledger');
const pricing = require('./pricing');
const webhookDispatcher = require('./webhookDispatcher');
const revenue = require('./revenue');
const { planKeyFor } = require('./plans');
const { randomHex } = require('../utils/ids');

/** What we keep about who is paying (shown to the merchant): trimmed and bounded, never trusted as markup. */
function payerFields(customer, phone) {
  const clean = (v, n) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, n));
  return { customer_name: clean(customer && customer.name, 120), customer_email: clean(customer && customer.email, 160), customer_phone: clean(phone, 30) };
}

const VALID_METHODS = ['moncash', 'moncash_ussd', 'natcash', 'carte', 'all'];

async function createPayment({ merchantId, id, ownReference, plopplopReference, amount, currency, method, phoneNumber, mode, customer, description, returnUrl }) {
  if (method === 'card') method = 'carte';
  if (method === 'carte') {
    return createCardPayment({ merchantId, id, ownReference, reference: plopplopReference, amount, currency, mode: mode || 'sandbox', customer, description, returnUrl });
  }
  if (currency && currency !== 'HTG') {
    const err = new Error('MonCash et Natcash se paient en HTG. Le paiement par carte se fait en USD.');
    err.code = 'INVALID_CURRENCY';
    throw err;
  }
  if (!VALID_METHODS.includes(method)) {
    const err = new Error(`Méthode de paiement invalide : ${method}`);
    err.code = 'INVALID_METHOD';
    throw err;
  }
  if (!(amount >= 20)) {
    const err = new Error('Le montant minimum est de 20 HTG.');
    err.code = 'INVALID_AMOUNT';
    throw err;
  }

  const res = await plopplop.createPayment({
    refferenceId: plopplopReference,
    montant: amount,
    paymentMethod: method,
    phoneNumber,
  });

  if (!res.data || !res.data.status) {
    const err = new Error((res.data && res.data.message) || 'Le service de paiement est momentanément indisponible. Réessayez dans un instant.');
    err.code = 'PROVIDER_ERROR';
    throw err;
  }

  const payment = await supabase.insert('payments', {
    id,
    merchant_id: merchantId,
    own_reference: ownReference,
    plopplop_reference: plopplopReference,
    plopplop_transaction_id: res.data.transaction_id || null,
    amount,
    currency: currency || 'HTG',
    method,
    checkout_url: res.data.url || null,
    ...payerFields(customer, phoneNumber),
    status: 'pending',
    mode: mode || 'sandbox',
  });

  return payment;
}

/**
 * Card payment (USD), processed by the card partner. The customer enters the card in the partner's embedded widget on
 * OUR checkout page; the response carries the two values the page needs to mount it (never stored).
 * The partner has no idempotency key: before creating, we look for a payment already made under this reference,
 * and if one exists (a lost answer, a retry) the new one gets its own reference so it can never be confused with it.
 */
async function createCardPayment({ merchantId, id, ownReference, reference, amount, currency, mode, customer, description, returnUrl }) {
  if (currency !== 'USD') {
    const err = new Error('Le paiement par carte se fait en USD (currency: "USD").');
    err.code = 'INVALID_CURRENCY';
    throw err;
  }
  const min = config.tranzak.minimumUSD;
  if (!(amount >= min)) {
    const err = new Error(`Le montant minimum d'un paiement par carte est de ${min} USD.`);
    err.code = 'AMOUNT_TOO_LOW';
    throw err;
  }
  if (!tranzak.isConfigured(mode)) {
    const err = new Error("Le paiement par carte n'est pas encore disponible. Réessayez plus tard.");
    err.code = 'PROVIDER_ERROR';
    throw err;
  }
  const checkoutToken = randomHex(16);
  let providerReference = reference;
  const orphan = await tranzak.findByReference(mode, reference);
  if (orphan) {
    providerReference = `${reference}.${Date.now().toString(36)}`;
    // eslint-disable-next-line no-console
    console.warn(`Card payment: a provider payment already exists under ${reference} (${orphan.transaction_id}, ${orphan.status}); using ${providerReference}.`);
  }
  const created = await tranzak.createCardPayment(mode, {
    amount,
    reference: providerReference,
    customerName: customer && customer.name,
    customerEmail: customer && customer.email,
    customerPhone: customer && customer.phone,
    description,
    metadata: { freda_payment_id: id },
  });
  const payment = await supabase.insert('payments', {
    id,
    merchant_id: merchantId,
    own_reference: ownReference,
    plopplop_reference: providerReference, // our unique reference, also the one sent to the card partner
    provider: 'tranzak',
    provider_transaction_id: created.transactionId,
    amount,
    currency: 'USD',
    method: 'carte',
    // The hosted page (our checkout) shows the card form: any integration can simply send the customer there.
    checkout_token: checkoutToken,
    checkout_url: `${config.siteUrl}/checkout?payment=${id}&t=${checkoutToken}`,
    card_client_secret: created.clientSecret,
    card_publishable_key: created.publishableKey,
    return_url: returnUrl || null,
    ...payerFields(customer, customer && customer.phone),
    status: 'pending',
    mode,
  });
  return Object.assign({}, payment, { _card: { client_secret: created.clientSecret, publishable_key: created.publishableKey } });
}

const lastPoll = new Map(); // payment id -> time of the last status read (the partner limits calls per IP)

/**
 * Applies what the card partner says about a payment (from a webhook, a poll or the reconciliation). Safe to call any
 * number of times and from several places at once: the status change is a claim (only one caller wins it), and only
 * the winner credits the balance, so a payment is credited exactly once.
 */
async function applyCardResult(payment, remote) {
  if (!payment || payment.provider !== 'tranzak') return payment;
  if (payment.status === 'succeeded' || payment.status === 'failed') return payment;
  const state = tranzak.mapStatus(remote && remote.status);
  if (state === 'pending') return payment;

  if (state === 'failed') {
    const [failed] = await supabase.update('payments', { id: payment.id, status: 'pending' },
      { status: 'failed', failure_reason: String((remote && remote.failure_reason) || 'declined').slice(0, 200), updated_at: new Date().toISOString() });
    if (!failed) return supabase.selectOne('payments', { id: payment.id });
    webhookDispatcher.dispatch(payment.merchant_id, 'payment.failed', {
      id: failed.id, reference: failed.own_reference, amount: Number(failed.amount), currency: failed.currency, method: failed.method,
      failure_reason: failed.failure_reason,
    });
    return failed;
  }

  // Never credit money that does not match what we asked for.
  if (Number(remote.amount) !== Number(payment.amount) || String(remote.currency).toUpperCase() !== 'USD') {
    // eslint-disable-next-line no-console
    console.error(`Card payment ${payment.id}: provider says ${remote.amount} ${remote.currency}, expected ${payment.amount} USD. NOT credited.`);
    return payment;
  }

  const merchant = await supabase.selectOne('merchants', { id: payment.merchant_id });
  const planKey = planKeyFor(merchant, 'gateway', payment.mode);
  const pricingOverride = await supabase.selectOne('merchant_pricing', { merchant_id: payment.merchant_id });
  const { fee, net } = pricing.computeGatewayCardFee(planKey, payment.amount, pricingOverride);

  const [won] = await supabase.update('payments', { id: payment.id, status: 'pending' },
    { status: 'succeeded', fee, net_amount: net, updated_at: new Date().toISOString() });
  if (!won) return supabase.selectOne('payments', { id: payment.id }); // someone else settled it first
  await ledger.creditGateway(payment.merchant_id, net, 'USD', payment.plopplop_reference, payment.id, payment.mode);
  await revenue.log(payment.merchant_id, 'gateway_payment', fee, 'USD', payment.id, payment.mode, pricing.cardPartnerCostUsd(payment.amount));
  webhookDispatcher.dispatch(payment.merchant_id, 'payment.succeeded', {
    id: won.id, reference: won.own_reference, amount: Number(won.amount), currency: 'USD', method: 'carte',
    fee: Number(won.fee), net_amount: Number(won.net_amount),
  });
  return won;
}

/** Reads the payment at the card partner (throttled) and applies the result. */
async function refreshCardStatus(payment) {
  const last = lastPoll.get(payment.id) || 0;
  if (Date.now() - last < config.tranzak.pollMinGapMs) return payment;
  lastPoll.set(payment.id, Date.now());
  if (lastPoll.size > 5000) lastPoll.clear();
  try {
    const remote = await tranzak.retrievePayment(payment.mode, payment.provider_transaction_id);
    if (!remote) return payment;
    return await applyCardResult(payment, remote);
  } catch (_) {
    return payment; // provider hiccup: stay pending, the caller can ask again
  }
}

/** Background safety net: webhooks are not guaranteed (e.g. expired payments), so old pending card payments are re-read. */
async function reconcilePendingCards(limit) {
  const cutoff = new Date(Date.now() - config.tranzak.reconcileAfterMs).toISOString();
  const rows = await supabase.select('payments', { provider: 'tranzak', status: 'pending', created_at: `lt.${cutoff}` }, { order: 'created_at.asc', limit: limit || 20 });
  let settled = 0;
  for (const p of rows) {
    const after = await refreshCardStatus(p);
    if (after.status !== 'pending') settled += 1;
    await new Promise((r) => setTimeout(r, 1200)); // stay far below the partner's per-IP limit
  }
  return { checked: rows.length, settled };
}

/**
 * Poll PlopPlop for the latest status. If the payment just transitioned to
 * confirmed ("ok"), credit the merchant's gateway ledger exactly once.
 */
async function refreshStatus(merchantId, payment) {
  if (payment.status === 'succeeded' || payment.status === 'failed') return payment;
  if (payment.provider === 'tranzak') return refreshCardStatus(payment);

  const res = await plopplop.verifyPayment({ refferenceId: payment.plopplop_reference });
  if (!res.data || !res.data.status) return payment; // provider hiccup - leave as pending, caller can retry

  if (res.data.trans_status === 'ok') {
    const merchant = await supabase.selectOne('merchants', { id: merchantId });
    const gatewayPlanKey = planKeyFor(merchant, 'gateway', payment.mode);
    const pricingOverride = await supabase.selectOne('merchant_pricing', { merchant_id: merchantId });
    const { fee, net } = pricing.computeGatewayFee(gatewayPlanKey, payment.amount, pricingOverride);

    // Claim: only the request that flips pending -> succeeded gets the row back, so concurrent polls credit once.
    const [updated] = await supabase.update(
      'payments',
      { id: payment.id, status: 'pending' },
      { status: 'succeeded', fee, net_amount: net, updated_at: new Date().toISOString() }
    );
    if (!updated) return supabase.selectOne('payments', { id: payment.id }); // someone else settled it first
    try {
      await ledger.creditGateway(merchantId, net, payment.currency, payment.plopplop_reference, payment.id, payment.mode);
    } catch (err) {
      // Not credited: reopen the payment so the next poll tries again instead of losing the money.
      await supabase.update('payments', { id: payment.id, status: 'succeeded' }, { status: 'pending', updated_at: new Date().toISOString() }).catch(() => {});
      throw err;
    }
    const gwCost = config.gatewayProviderCost;
    const partnerCostHtg = gwCost.pct / 100 * Number(payment.amount) + gwCost.fixedHTG;
    await revenue.log(merchantId, 'gateway_payment', fee, payment.currency, payment.id, payment.mode, pricing.htgToUsd(partnerCostHtg));
    webhookDispatcher.dispatch(merchantId, 'payment.succeeded', {
      id: updated.id,
      reference: updated.own_reference,
      amount: Number(updated.amount),
      currency: updated.currency,
      method: updated.method,
      fee: Number(updated.fee),
      net_amount: Number(updated.net_amount),
    });
    return updated;
  }

  return payment; // still "no" (pending)
}

async function getById(merchantId, id) {
  return supabase.selectOne('payments', { id, merchant_id: merchantId });
}
async function getByOwnReference(merchantId, ownReference) {
  return supabase.selectOne('payments', { merchant_id: merchantId, own_reference: ownReference });
}
async function list(merchantId, limit, offset, mode, extra) {
  const filters = { merchant_id: merchantId };
  if (mode) filters.mode = mode;
  if (extra && extra.status) filters.status = extra.status;
  if (extra && extra.method) filters.method = extra.method;
  if (extra && extra.currency) filters.currency = extra.currency;
  return supabase.select(
    'payments',
    filters,
    { order: 'created_at.desc', limit: limit || 50, offset: offset || 0 }
  );
}

module.exports = { createPayment, refreshStatus, applyCardResult, reconcilePendingCards, getById, getByOwnReference, list, VALID_METHODS };
