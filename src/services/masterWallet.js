'use strict';
const config = require('../config');
const supabase = require('../lib/supabase');
const ledger = require('./ledger');
const brevo = require('./brevo');
const { lowBalanceEmail } = require('../templates/lowBalanceEmail');

function round2(n) {
  return Math.round(n * 100) / 100;
}

// One merchant's wallet is checked and debited one operation at a time on this instance.
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

function belowMinimum(minimum, current) {
  const err = new Error(
    `Cette opération ferait passer votre Master Wallet sous le solde minimum requis (${minimum} $). Solde actuel : ${current} $.`
  );
  err.code = 'BELOW_MINIMUM_BALANCE';
  err.httpStatus = 400;
  return err;
}

// The atomic path is the Postgres function debit_master_wallet (migrations/2026-10-21-atomic-wallet-debit.sql). While it
// is not installed, the check + debit run under the per-merchant lock above, followed by a re-check that undoes the debit
// if another instance went below the floor in the meantime.
let atomicMissing = false;
function isMissingFunction(err) {
  const d = err && err.details;
  return !!(d && (d.code === 'PGRST202' || /Could not find the function|Unknown rpc function/i.test(String(d.message || ''))));
}

async function debitAtomic(merchantId, amount, reference, relatedId, mode, minimum) {
  const res = await supabase.rpc('debit_master_wallet', {
    p_merchant_id: merchantId,
    p_wallet: ledger.walletKey('master_wallet', mode),
    p_amount: Math.abs(amount),
    p_minimum: minimum,
    p_reference: reference || null,
    p_related_id: relatedId || null,
  });
  if (!res || typeof res.ok !== 'boolean') return null;
  if (!res.ok) throw belowMinimum(minimum, Number(res.balance) || 0);
  return round2(Number(res.balance));
}

async function debitChecked(merchantId, amount, reference, relatedId, mode, minimum) {
  const current = await ledger.getBalance(merchantId, 'master_wallet', 'USD', mode);
  if (round2(current - amount) < minimum) throw belowMinimum(minimum, current);
  await ledger.debitMasterWallet(merchantId, amount, 'USD', reference, relatedId, mode);
  const after = await ledger.getBalance(merchantId, 'master_wallet', 'USD', mode);
  if (round2(after) < minimum) {
    // Another instance debited at the same time: give this debit back rather than leave the wallet under its floor.
    await ledger.creditMasterWallet(merchantId, amount, 'USD', `debit-rollback:${reference}`, relatedId, mode);
    throw belowMinimum(minimum, round2(after + amount));
  }
  return round2(current - amount);
}

/**
 * Debits the Master Wallet (USD) for a voluntary operation (card creation,
 * card recharge, plan billing, etc.), enforcing the platform-wide minimum
 * reserve balance (config.masterWallet.minimumBalanceUsd). Every debit that
 * would bring the balance below that floor is rejected outright - a
 * merchant's Master Wallet can never go below the minimum through their own
 * actions, even when several requests arrive at the same time. From the alert balance
 * (150 $ by default) down, throttled low-balance emails are sent.
 */
async function debitWithFloor(merchantId, amount, reference, relatedId, mode) {
  const minimum = config.masterWallet.minimumBalanceUsd;
  const newBalance = await withLock(`${mode === 'live' ? 'live' : 'sandbox'}:${merchantId}`, async () => {
    if (!atomicMissing) {
      try {
        const done = await debitAtomic(merchantId, amount, reference, relatedId, mode, minimum);
        if (done !== null) return done;
        atomicMissing = true;
      } catch (err) {
        if (!isMissingFunction(err)) throw err;
        atomicMissing = true;
      }
    }
    return debitChecked(merchantId, amount, reference, relatedId, mode, minimum);
  });

  if (newBalance <= config.masterWallet.alertBalanceUsd) {
    // Never let a notification failure break the actual financial operation.
    notifyLowBalanceThrottled(merchantId, newBalance, mode).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Failed to send low balance email:', err.message);
    });
  }

  return newBalance;
}

// Reminder emails from the alert balance down to the floor, at most one per interval per merchant and mode. A merchant who just
// reached the floor always gets that (more urgent) email once, even if a softer reminder was sent shortly before.
const lastAlert = new Map();
async function notifyLowBalanceThrottled(merchantId, balance, mode) {
  const level = balance <= config.masterWallet.minimumBalanceUsd ? 'floor' : 'warn';
  const key = `${mode === 'live' ? 'live' : 'sandbox'}:${merchantId}:${level}`;
  const now = Date.now();
  if (now - (lastAlert.get(key) || 0) < config.masterWallet.alertIntervalMs) return;
  lastAlert.set(key, now);
  await notifyLowBalance(merchantId, balance);
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

module.exports = { debitWithFloor, notifyLowBalance, notifyLowBalanceThrottled };
