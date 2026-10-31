'use strict';
const config = require('../config');
const supabase = require('../lib/supabase');
const plopplop = require('./plopplop');
const ledger = require('./ledger');
const pricing = require('./pricing');
const notify = require('./notify');
const revenue = require('./revenue');
const { planKeyFor } = require('./plans');

const AUTO_METHODS = ['moncash', 'natcash'];
const MANUAL_METHODS = ['zelle', 'bank_transfer'];

/** Computes the fee/conversion preview for an automatic (MonCash/Natcash) top-up. */
function computeAutoConversion(amountHtg, issuingPlanKey, pricingOverride) {
  const { fee, fredaFee, partnerFee, netHtg, creditedUsd } = pricing.computeWalletFundingFee(issuingPlanKey || 'startup', amountHtg, pricingOverride);
  return { fee, fredaFee, partnerFee, netHtg, creditedUsd, exchangeRate: config.exchangeRateHtgPerUsd };
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
  const confirmed = require('./paymentHealth').isConfirmed(res.data);
  if (!res.data || (!res.data.status && !confirmed)) return topup;

  if (confirmed) {
    const merchant = await supabase.selectOne('merchants', { id: merchantId });
    const pricingOverride = await supabase.selectOne('merchant_pricing', { merchant_id: merchantId });
    const { fee, fredaFee, creditedUsd } = computeAutoConversion(Number(topup.amount_htg), planKeyFor(merchant, 'issuing', topup.mode), pricingOverride);
    // Claim: only the request that flips pending -> succeeded gets the row back, so concurrent polls credit once.
    const [updated] = await supabase.update(
      'wallet_topups',
      { id: topup.id, status: 'pending' },
      { status: 'succeeded', fee_htg: fee, credited_usd: creditedUsd, updated_at: new Date().toISOString() }
    );
    if (!updated) return supabase.selectOne('wallet_topups', { id: topup.id }); // someone else settled it first
    try {
      await ledger.creditMasterWallet(merchantId, creditedUsd, 'USD', topup.plopplop_reference, topup.id, topup.mode);
    } catch (err) {
      await supabase.update('wallet_topups', { id: topup.id, status: 'succeeded' }, { status: 'pending', updated_at: new Date().toISOString() }).catch(() => {});
      throw err;
    }
    // Income = Freda Pay's own fee only. The payment partner's fee was charged to the payer and handed over, so it is neither
    // income nor cost. The card partner's 2 % on funding is a real cost of the dollars credited.
    await revenue.log(merchantId, 'wallet_funding', fredaFee, 'HTG', topup.id, topup.mode, pricing.round2(config.issuingProviderCostsUSD.walletFundingPct * creditedUsd)).catch((e) => console.error(`Revenue log failed for top-up ${topup.id}:`, e.message)); // eslint-disable-line no-console
    const newBalance = await ledger.getBalance(merchantId, 'master_wallet', 'USD', topup.mode);
    await notify.walletCredited(merchant, { amount: creditedUsd, currency: 'USD', walletLabel: 'Master Wallet', newBalance, note: 'rechargement confirmé', mode: topup.mode });
    return updated;
  }

  return topup;
}

/** Same safety net as for payments: pending MonCash/Natcash top-ups are re-read in the background (see reconcilePendingMobile). */
const lastTopupPoll = new Map();
async function reconcilePendingAutoTopups(limit) {
  const now = Date.now();
  const rows = await supabase.select('wallet_topups', { status: 'pending', plopplop_reference: supabase.notNull(), created_at: supabase.gt(new Date(now - 3 * 24 * 3600 * 1000).toISOString()) }, { order: 'created_at.desc', limit: limit || 40 });
  let settled = 0;
  let checked = 0;
  for (const t of rows) {
    if (!AUTO_METHODS.includes(t.method)) continue;
    const age = now - new Date(t.created_at).getTime();
    if (age > 15 * 60 * 1000 && now - (lastTopupPoll.get(t.id) || 0) < 10 * 60 * 1000) continue;
    lastTopupPoll.set(t.id, now);
    checked += 1;
    try {
      const after = await refreshAutoTopup(t.merchant_id, t);
      if (after && after.status !== 'pending') { settled += 1; lastTopupPoll.delete(t.id); }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Top-up reconciliation failed for ${t.id}:`, err.message);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return { checked, settled };
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
  reconcilePendingAutoTopups,
  createManualTopup,
  getById,
  getByOwnReference,
  list,
};
