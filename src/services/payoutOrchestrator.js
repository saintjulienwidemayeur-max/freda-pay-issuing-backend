'use strict';
const config = require('../config');
const supabase = require('../lib/supabase');
const plopplop = require('./plopplop');
const ledger = require('./ledger');
const { signWithdrawal } = require('../utils/hmac');
const webhookDispatcher = require('./webhookDispatcher');
const revenue = require('./revenue');
const pricing = require('./pricing');

// ---- Single-lane queue: PlopPlop enforces a 120s cooldown PER IP, and all
// Freda merchants share one outbound IP, so payouts must run one at a time
// with at least `config.payoutCooldownMs` between each attempt. ----
let queue = Promise.resolve();
let lastAttemptAt = 0;

function enqueue(job) {
  const run = queue.then(async () => {
    const waitFor = lastAttemptAt + config.payoutCooldownMs - Date.now();
    if (waitFor > 0) await sleep(waitFor);
    lastAttemptAt = Date.now();
    return job();
  });
  queue = run.catch(() => {}); // one failed job must not wedge the queue
  return run;
}

// One merchant's withdrawals are checked and held one at a time (this instance); the after-hold balance check below
// is the safety net if the backend ever runs on several instances.
const locks = new Map();
function withMerchantLock(merchantId, fn) {
  const prev = locks.get(merchantId) || Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(merchantId, run.catch(() => {}));
  return run;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Creates a withdrawal. The money (amount + the fee Freda Pay charges) is HELD from the Gateway balance immediately,
 * so two requests can never spend the same money while the first waits in the queue; if the withdrawal does not
 * happen, the hold is given back. Methods:
 *   - moncash / natcash: queued, then sent through the payment partner (its 120 s cooldown makes it one at a time);
 *   - bank: waits for the team, who send the transfer by hand and mark it done (Admin > Retraits bancaires).
 *     In Sandbox there is no team: it completes at once, with no real transfer.
 * Callers poll GET /payouts/:id for the final status.
 */
async function createPayout(args) {
  const payout = await withMerchantLock(args.merchantId, () => createPayoutLocked(args));
  if (payout.method === 'bank') return payout;
  const { merchantId, id, plopplopReference, amount, method, recipient } = args;
  enqueue(() => executePayoutFlow({ merchantId, id, plopplopReference, amount, method, recipient, mode: args.mode || 'sandbox' })).catch(
    async (err) => {
      try {
        await markFailed(merchantId, id, `INTERNAL_ERROR: ${err.message}`);
      } catch (_) {}
    }
  );
  return payout;
}

async function createPayoutLocked({ merchantId, id, ownReference, plopplopReference, amount, method, recipient, mode, bankDetails }) {
  const override = await supabase.selectOne('merchant_pricing', { merchant_id: merchantId });
  const { fee } = pricing.computePayoutFee(method, amount, override);
  const theMode = mode || 'sandbox';

  const available = await ledger.getBalance(merchantId, 'gateway', 'HTG', theMode);
  if (available < amount + fee) {
    const err = new Error(`Solde disponible insuffisant (${available} HTG).`);
    err.httpStatus = 400;
    err.code = 'INSUFFICIENT_BALANCE';
    throw err;
  }

  const payout = await supabase.insert('payouts', {
    id,
    merchant_id: merchantId,
    own_reference: ownReference,
    plopplop_reference: plopplopReference,
    amount,
    method,
    recipient,
    status: 'pending',
    fee,
    bank_details: bankDetails || null,
    mode: theMode,
  });

  await ledger.debitGatewayForPayout(merchantId, amount, 'HTG', `${plopplopReference}:hold`, id, theMode);
  if (fee > 0) await ledger.debitGatewayForPayout(merchantId, fee, 'HTG', `${plopplopReference}:hold-fee`, id, theMode);
  if ((await ledger.getBalance(merchantId, 'gateway', 'HTG', theMode)) < 0) {
    // Another request took the money between the balance check and the hold: undo this one.
    await ledger.refundGatewayPayout(merchantId, amount, 'HTG', `${plopplopReference}:release`, id, theMode);
    if (fee > 0) await ledger.refundGatewayPayout(merchantId, fee, 'HTG', `${plopplopReference}:release-fee`, id, theMode);
    await supabase.delete('payouts', { id });
    const err = new Error('Solde disponible insuffisant.');
    err.httpStatus = 400;
    err.code = 'INSUFFICIENT_BALANCE';
    throw err;
  }

  if (method === 'bank') {
    if (theMode !== 'live') await completeBankPayout({ id, bankReference: 'SANDBOX (aucun virement réel)', note: null, adminId: null });
    return supabase.selectOne('payouts', { id });
  }

  return payout;
}

async function executePayoutFlow({ merchantId, id, plopplopReference, amount, method, recipient, mode }) {
  try {
    // The queue can hold a payout for minutes: check the account again at the moment of sending.
    // The money is only on hold, so failing it here gives it all back.
    const owner = await supabase.selectOne('merchants', { id: merchantId });
    if (!owner || owner.deleted_at) return markFailed(merchantId, id, 'ACCOUNT_SUSPENDED: ce compte est suspendu, le retrait n\'a pas été envoyé.');

    // Step 1: authenticate as the Freda merchant on PlopPlop.
    const authRes = await plopplop.authMerchant();
    if (!authRes.data || !authRes.data.success) {
      return markFailed(merchantId, id, `AUTH_FAILED: ${(authRes.data && authRes.data.message) || authRes.httpStatus}`);
    }
    const marchandToken = authRes.data.token;

    // Step 2: request a withdrawal token, signed with our client_secret.
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signWithdrawal(
      { amount, method, recipient, reference: plopplopReference, timestamp },
      config.plopplop.clientSecret
    );
    const tokenRes = await plopplop.getWithdrawalToken({
      marchandToken,
      amount,
      method,
      recipient,
      reference: plopplopReference,
      timestamp,
      signature,
    });
    if (!tokenRes.data || !tokenRes.data.success) {
      return markFailed(merchantId, id, `WITHDRAWAL_TOKEN_FAILED: ${(tokenRes.data && tokenRes.data.message) || tokenRes.httpStatus}`);
    }
    const withdrawalToken = tokenRes.data.withdrawal_token;

    // Step 3: execute the withdrawal.
    const execRes = await plopplop.executeWithdrawal({
      withdrawalToken,
      amount,
      method,
      recipient,
      reference: plopplopReference,
    });

    if (execRes.data && execRes.data.success && execRes.data.data && execRes.data.data.status === 'success') {
      const { fee: partnerFee, transaction_id, api_reference } = execRes.data.data;
      const [done] = await supabase.update(
        'payouts',
        { id, status: 'pending' },
        {
          status: 'success',
          partner_fee_htg: partnerFee != null ? partnerFee : null,
          api_reference,
          plopplop_transaction_id: transaction_id,
          updated_at: new Date().toISOString(),
        }
      );
      if (!done) return; // already settled elsewhere
      // The merchant already paid amount + Freda Pay's fee (held). What the payment partner charged to SEND it is our cost.
      await revenue.log(merchantId, 'payout', Number(done.fee || 0), 'HTG', id, mode, partnerFee != null ? pricing.htgToUsd(Number(partnerFee)) : 0);
      webhookDispatcher.dispatch(merchantId, 'payout.succeeded', {
        id, amount, currency: 'HTG', method, recipient, fee: Number(done.fee || 0), transaction_id,
      });
      return;
    }

    const reason = (execRes.data && execRes.data.message) || `HTTP_${execRes.httpStatus}`;
    return markFailed(merchantId, id, reason);
  } catch (err) {
    return markFailed(merchantId, id, `NETWORK_ERROR: ${err.message}`);
  }
}

/** Settles a pending withdrawal as failed ONCE, and gives the held money back (amount + fee). */
async function markFailed(merchantId, id, reason, extra) {
  const [row] = await supabase.update('payouts', { id, status: 'pending' }, { status: 'failed', failure_reason: reason, updated_at: new Date().toISOString(), ...(extra || {}) });
  if (!row) return null; // already settled: never refund twice
  const mode = row.mode || 'sandbox';
  await ledger.refundGatewayPayout(merchantId, Number(row.amount), 'HTG', `${row.plopplop_reference}:release`, id, mode);
  if (Number(row.fee) > 0) await ledger.refundGatewayPayout(merchantId, Number(row.fee), 'HTG', `${row.plopplop_reference}:release-fee`, id, mode);
  webhookDispatcher.dispatch(merchantId, 'payout.failed', { id, failure_reason: reason });
  return row;
}

/** The team sent the bank transfer: settle it. The held amount + fee stay spent; the fee is Freda Pay's income. */
async function completeBankPayout({ id, bankReference, note, adminId }) {
  const [row] = await supabase.update(
    'payouts',
    { id, method: 'bank', status: 'pending' },
    { status: 'success', bank_reference: bankReference || null, admin_note: note || null, reviewed_by: adminId || null, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() }
  );
  if (!row) return null;
  await revenue.log(row.merchant_id, 'payout', Number(row.fee || 0), 'HTG', id, row.mode, 0);
  webhookDispatcher.dispatch(row.merchant_id, 'payout.succeeded', { id, amount: Number(row.amount), currency: 'HTG', method: 'bank', recipient: row.recipient, fee: Number(row.fee || 0) });
  return row;
}

async function rejectBankPayout({ id, reason, adminId }) {
  const current = await supabase.selectOne('payouts', { id, method: 'bank' });
  if (!current) return null;
  return markFailed(current.merchant_id, id, reason, { admin_note: reason, reviewed_by: adminId || null, reviewed_at: new Date().toISOString() });
}

async function getById(merchantId, id) {
  return supabase.selectOne('payouts', { id, merchant_id: merchantId });
}

async function getByOwnReference(merchantId, ownReference) {
  return supabase.selectOne('payouts', { merchant_id: merchantId, own_reference: ownReference });
}

async function list(merchantId, limit, offset, mode) {
  const filters = { merchant_id: merchantId };
  if (mode) filters.mode = mode;
  return supabase.select(
    'payouts',
    filters,
    { order: 'created_at.desc', limit: limit || 50, offset: offset || 0 }
  );
}

module.exports = { createPayout, completeBankPayout, rejectBankPayout, getById, getByOwnReference, list };
