'use strict';
const supabase = require('../lib/supabase');
const plopplop = require('./plopplop');
const ledger = require('./ledger');
const pricing = require('./pricing');
const webhookDispatcher = require('./webhookDispatcher');
const revenue = require('./revenue');

const VALID_METHODS = ['moncash', 'moncash_ussd', 'natcash', 'carte', 'all'];

async function createPayment({ merchantId, id, ownReference, plopplopReference, amount, currency, method, phoneNumber, mode }) {
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
    status: 'pending',
    mode: mode || 'sandbox',
  });

  return payment;
}

/**
 * Poll PlopPlop for the latest status. If the payment just transitioned to
 * confirmed ("ok"), credit the merchant's gateway ledger exactly once.
 */
async function refreshStatus(merchantId, payment) {
  if (payment.status === 'succeeded' || payment.status === 'failed') return payment;

  const res = await plopplop.verifyPayment({ refferenceId: payment.plopplop_reference });
  if (!res.data || !res.data.status) return payment; // provider hiccup - leave as pending, caller can retry

  if (res.data.trans_status === 'ok') {
    const merchant = await supabase.selectOne('merchants', { id: merchantId });
    const gatewayPlanKey = (merchant && merchant.gateway_plan) || 'standard';
    const pricingOverride = await supabase.selectOne('merchant_pricing', { merchant_id: merchantId });
    const { fee, net } = pricing.computeGatewayFee(gatewayPlanKey, payment.amount, pricingOverride);

    const [updated] = await supabase.update(
      'payments',
      { id: payment.id },
      { status: 'succeeded', fee, net_amount: net, updated_at: new Date().toISOString() }
    );
    await ledger.creditGateway(merchantId, net, payment.currency, payment.plopplop_reference, payment.id, payment.mode);
    await revenue.log(merchantId, 'gateway_payment', fee, payment.currency, payment.id, payment.mode);
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
async function list(merchantId, limit, offset, mode) {
  const filters = { merchant_id: merchantId };
  if (mode) filters.mode = mode;
  return supabase.select(
    'payments',
    filters,
    { order: 'created_at.desc', limit: limit || 50, offset: offset || 0 }
  );
}

module.exports = { createPayment, refreshStatus, getById, getByOwnReference, list, VALID_METHODS };
