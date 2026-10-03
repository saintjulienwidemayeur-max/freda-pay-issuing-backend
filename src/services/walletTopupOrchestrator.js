'use strict';
const config = require('../config');
const supabase = require('../lib/supabase');
const plopplop = require('./plopplop');
const ledger = require('./ledger');
const pricing = require('./pricing');
const brevo = require('./brevo');
const { walletCreditedEmail } = require('../templates/walletCreditedEmail');
const revenue = require('./revenue');

/** Fire-and-forget: a failed notification email should never break the wallet credit itself. */
function notifyWalletCredited(merchant, amount, currency, walletLabel, newBalance, note) {
  if (!merchant || !merchant.email) return;
  const { subject, html, text } = walletCreditedEmail({ businessName: merchant.business_name, amount, currency, walletLabel, newBalance, note });
  brevo.sendEmail({ to: merchant.email, toName: merchant.business_name, subject, html, text }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to send wallet-credited email:', err.message);
  });
}

const AUTO_METHODS = ['moncash', 'natcash'];
const MANUAL_METHODS = ['zelle', 'bank_transfer'];

/** Computes the fee/conversion preview for an automatic (MonCash/Natcash) top-up. */
function computeAutoConversion(amountHtg, issuingPlanKey, pricingOverride) {
  const { fee, netHtg, creditedUsd } = pricing.computeWalletFundingFee(issuingPlanKey || 'startup', amountHtg, pricingOverride);
  return { fee, netHtg, creditedUsd, exchangeRate: config.exchangeRateHtgPerUsd };
}

/**
 * MonCash/Natcash path: charge the merchant in HTG via PlopPlop (same rails as
 * Gateway payments), and once PlopPlop confirms, automatically credit the
 * Master Wallet in USD - no manual review needed, since the provider itself
 * verifies the transaction.
 */
async function createAutoTopup({ merchantId, id, ownReference, plopplopReference, method, amountHtg, mode }) {
  if (!AUTO_METHODS.includes(method)) {
    const err = new Error(`Méthode invalide pour un rechargement automatique : ${method}`);
    err.code = 'INVALID_METHOD';
    throw err;
  }
  if (!(amountHtg >= 20)) {
    const err = new Error('Le montant minimum est de 20 HTG.');
    err.code = 'INVALID_AMOUNT';
    throw err;
  }

  const res = await plopplop.createPayment({ refferenceId: plopplopReference, montant: amountHtg, paymentMethod: method });
  if (!res.data || !res.data.status) {
    const err = new Error((res.data && res.data.message) || 'Le service de paiement est momentanément indisponible. Réessayez dans un instant.');
    err.code = 'PROVIDER_ERROR';
    throw err;
  }

  return supabase.insert('wallet_topups', {
    id,
    merchant_id: merchantId,
    method,
    status: 'pending',
    amount_htg: amountHtg,
    exchange_rate: config.exchangeRateHtgPerUsd,
    own_reference: ownReference,
    plopplop_reference: plopplopReference,
    plopplop_transaction_id: res.data.transaction_id || null,
    checkout_url: res.data.url || null,
    mode: mode === 'live' ? 'live' : 'sandbox',
  });
}

/** Polls PlopPlop and, on first confirmation, credits the Master Wallet exactly once. */
async function refreshAutoTopup(merchantId, topup) {
  if (topup.status === 'succeeded' || topup.status === 'failed') return topup;

  const res = await plopplop.verifyPayment({ refferenceId: topup.plopplop_reference });
  if (!res.data || !res.data.status) return topup;

  if (res.data.trans_status === 'ok') {
    const merchant = await supabase.selectOne('merchants', { id: merchantId });
    const pricingOverride = await supabase.selectOne('merchant_pricing', { merchant_id: merchantId });
    const { fee, creditedUsd } = computeAutoConversion(Number(topup.amount_htg), merchant && merchant.issuing_plan, pricingOverride);
    const [updated] = await supabase.update(
      'wallet_topups',
      { id: topup.id },
      { status: 'succeeded', fee_htg: fee, credited_usd: creditedUsd, updated_at: new Date().toISOString() }
    );
    await ledger.creditMasterWallet(merchantId, creditedUsd, 'USD', topup.plopplop_reference, topup.id, topup.mode);
    await revenue.log(merchantId, 'wallet_funding', fee, 'HTG', topup.id, topup.mode);
    const newBalance = await ledger.getBalance(merchantId, 'master_wallet', 'USD', topup.mode);
    notifyWalletCredited(merchant, creditedUsd, 'USD', 'Master Wallet', newBalance, 'rechargement confirmé');
    return updated;
  }

  return topup;
}

/**
 * Zelle / bank-transfer path: the merchant claims they sent money externally
 * and attaches a receipt. This NEVER auto-credits the wallet - it is
 * recorded as 'awaiting_review' for Freda Pay staff to confirm manually
 * after checking the real bank/Zelle statement. Self-service auto-crediting
 * here would be a straightforward way for a merchant to give themselves
 * free money, so it is intentionally not automated.
 */
async function createManualTopup({ merchantId, id, ownReference, method, amountUsd, receiptBuffer, receiptFilename, receiptContentType, mode }) {
  if (!MANUAL_METHODS.includes(method)) {
    const err = new Error(`Méthode invalide pour un rechargement manuel : ${method}`);
    err.code = 'INVALID_METHOD';
    throw err;
  }
  if (!(amountUsd > 0)) {
    const err = new Error('Le montant doit être un nombre positif.');
    err.code = 'INVALID_AMOUNT';
    throw err;
  }

  let receiptPath = null;
  if (receiptBuffer) {
    receiptPath = `${merchantId}/${id}-${receiptFilename}`;
    await supabase.uploadFile('receipts', receiptPath, receiptBuffer, receiptContentType);
  }

  return supabase.insert('wallet_topups', {
    id,
    merchant_id: merchantId,
    method,
    status: 'awaiting_review',
    amount_usd: amountUsd,
    own_reference: ownReference,
    receipt_path: receiptPath,
    receipt_filename: receiptFilename || null,
    mode: mode === 'live' ? 'live' : 'sandbox',
  });
}

async function getById(merchantId, id) {
  return supabase.selectOne('wallet_topups', { id, merchant_id: merchantId });
}
async function getByOwnReference(merchantId, ownReference) {
  return supabase.selectOne('wallet_topups', { merchant_id: merchantId, own_reference: ownReference });
}
async function list(merchantId, limit, mode) {
  const filters = { merchant_id: merchantId };
  if (mode) filters.mode = mode;
  return supabase.select('wallet_topups', filters, { order: 'created_at.desc', limit: limit || 50 });
}

module.exports = {
  AUTO_METHODS,
  MANUAL_METHODS,
  computeAutoConversion,
  createAutoTopup,
  refreshAutoTopup,
  createManualTopup,
  getById,
  getByOwnReference,
  list,
};
