'use strict';
const supabase = require('../lib/supabase');

/**
 * Record a ledger movement. `amount` should be signed: positive = credit,
 * negative = debit. This is the single source of truth for balances -
 * we never store a running balance column, we always derive it by summing
 * (see get_balance() Postgres function in supabase-schema.sql).
 *
 * SANDBOX AND LIVE NEVER SHARE A BALANCE. Sandbox play money must not be able
 * to fund a real card, so the two modes are kept in separate wallets:
 *   sandbox -> 'gateway' / 'master_wallet'            (unchanged, so every existing row stays valid)
 *   live    -> 'live:gateway' / 'live:master_wallet'
 * Every function below takes `mode` last and defaults to 'sandbox': forgetting
 * to pass it can only ever touch play money, never real money.
 */
function walletKey(wallet, mode) {
  return mode === 'live' ? `live:${wallet}` : wallet;
}

async function record({ merchantId, wallet, type, amount, currency, reference, relatedId, mode }) {
  return supabase.insert('ledger_entries', {
    merchant_id: merchantId,
    wallet: walletKey(wallet, mode),
    type,
    amount,
    currency: currency || 'HTG',
    reference: reference || null,
    related_id: relatedId || null,
  });
}

async function getBalance(merchantId, wallet, currency, mode) {
  const balance = await supabase.rpc('get_balance', {
    p_merchant_id: merchantId,
    p_wallet: walletKey(wallet, mode),
    p_currency: currency || 'HTG',
  });
  return Number(balance) || 0;
}

async function creditGateway(merchantId, amount, currency, reference, relatedId, mode) {
  return record({ merchantId, wallet: 'gateway', type: 'payment_credit', amount, currency, reference, relatedId, mode });
}

async function debitGatewayForPayout(merchantId, amount, currency, reference, relatedId, mode) {
  return record({
    merchantId,
    wallet: 'gateway',
    type: 'payout_debit',
    amount: -Math.abs(amount),
    currency,
    reference,
    relatedId,
    mode,
  });
}

async function creditMasterWallet(merchantId, amount, currency, reference, relatedId, mode) {
  return record({ merchantId, wallet: 'master_wallet', type: 'wallet_topup', amount, currency, reference, relatedId, mode });
}

async function debitMasterWallet(merchantId, amount, currency, reference, relatedId, mode) {
  return record({
    merchantId,
    wallet: 'master_wallet',
    type: 'wallet_debit',
    amount: -Math.abs(amount),
    currency,
    reference,
    relatedId,
    mode,
  });
}

module.exports = {
  walletKey,
  record,
  getBalance,
  creditGateway,
  debitGatewayForPayout,
  creditMasterWallet,
  debitMasterWallet,
};
