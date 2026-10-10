'use strict';
const config = require('../config');
const supabase = require('../lib/supabase');
const ledger = require('./ledger');
const brevo = require('./brevo');
const { lowBalanceEmail } = require('../templates/lowBalanceEmail');

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Debits the Master Wallet (USD) for a voluntary operation (card creation,
 * card recharge, plan billing, etc.), enforcing the platform-wide minimum
 * reserve balance (config.masterWallet.minimumBalanceUsd). Every debit that
 * would bring the balance below that floor is rejected outright - a
 * merchant's Master Wallet can never go below the minimum through their own
 * actions. The first time a debit brings the balance down TO the floor, a
 * low-balance alert email is sent.
 */
async function debitWithFloor(merchantId, amount, reference, relatedId, mode) {
  const minimum = config.masterWallet.minimumBalanceUsd;
  const current = await ledger.getBalance(merchantId, 'master_wallet', 'USD', mode);

  if (round2(current - amount) < minimum) {
    const err = new Error(
      `Cette opération ferait passer votre Master Wallet sous le solde minimum requis (${minimum} $). Solde actuel : ${current} $.`
    );
    err.code = 'BELOW_MINIMUM_BALANCE';
    err.httpStatus = 400;
    throw err;
  }

  await ledger.debitMasterWallet(merchantId, amount, 'USD', reference, relatedId, mode);
  const newBalance = round2(current - amount);

  if (newBalance <= minimum) {
    // Never let a notification failure break the actual financial operation.
    notifyLowBalance(merchantId, newBalance).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Failed to send low balance email:', err.message);
    });
  }

  return newBalance;
}

async function notifyLowBalance(merchantId, balance) {
  const merchant = await supabase.selectOne('merchants', { id: merchantId });
  if (!merchant) return;
  const { subject, html, text } = lowBalanceEmail({
    businessName: merchant.business_name,
    balance,
    minimumBalance: config.masterWallet.minimumBalanceUsd,
  });
  await brevo.sendEmail({ to: merchant.email, toName: merchant.business_name, subject, html, text });
}

module.exports = { debitWithFloor, notifyLowBalance };
