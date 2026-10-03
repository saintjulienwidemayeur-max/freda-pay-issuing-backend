'use strict';
const config = require('../config');
const supabase = require('../lib/supabase');
const plopplop = require('./plopplop');
const ledger = require('./ledger');
const { signWithdrawal } = require('../utils/hmac');
const webhookDispatcher = require('./webhookDispatcher');
const revenue = require('./revenue');

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create the payout record immediately (status 'pending') and enqueue the
 * actual PlopPlop 3-step flow to run respecting the cooldown. Callers should
 * poll GET /v1/payouts/:id for the final status rather than blocking on this call.
 */
async function createPayout({ merchantId, id, ownReference, plopplopReference, amount, method, recipient, mode }) {
  const payout = await supabase.insert('payouts', {
    id,
    merchant_id: merchantId,
    own_reference: ownReference,
    plopplop_reference: plopplopReference,
    amount,
    method,
    recipient,
    status: 'pending',
    mode: mode || 'sandbox',
  });

  enqueue(() => executePayoutFlow({ merchantId, id, plopplopReference, amount, method, recipient, mode })).catch(
    async (err) => {
      try {
        await markFailed(merchantId, id, `INTERNAL_ERROR: ${err.message}`);
      } catch (_) {}
    }
  );

  return payout;
}

async function executePayoutFlow({ merchantId, id, plopplopReference, amount, method, recipient, mode }) {
  try {
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
      const { fee, total, transaction_id, api_reference } = execRes.data.data;
      await supabase.update(
        'payouts',
        { id },
        {
          status: 'success',
          fee,
          api_reference,
          plopplop_transaction_id: transaction_id,
          updated_at: new Date().toISOString(),
        }
      );
      // Debit the merchant's internal gateway ledger by the TRUE cost (amount + PlopPlop fee).
      await ledger.debitGatewayForPayout(merchantId, total != null ? total : amount, 'HTG', plopplopReference, id, mode);
      // On top of PlopPlop's own cost (above), charge Freda Pay's own payout
      // fee ONLY if an admin set one for this merchant (none by default).
      const pricingOverride = await supabase.selectOne('merchant_pricing', { merchant_id: merchantId });
      const ownFee = pricingOverride && Number(pricingOverride.payout_fee_htg || 0);
      if (ownFee > 0) {
        await ledger.debitGatewayForPayout(merchantId, ownFee, 'HTG', `${plopplopReference}:freda-fee`, id, mode);
        await revenue.log(merchantId, 'payout', ownFee, 'HTG', id, mode);
      }
      webhookDispatcher.dispatch(merchantId, 'payout.succeeded', {
        id, amount, currency: 'HTG', method, recipient, fee, transaction_id,
      });
      return;
    }

    const reason = (execRes.data && execRes.data.message) || `HTTP_${execRes.httpStatus}`;
    return markFailed(merchantId, id, reason);
  } catch (err) {
    return markFailed(merchantId, id, `NETWORK_ERROR: ${err.message}`);
  }
}

async function markFailed(merchantId, id, reason) {
  await supabase.update('payouts', { id }, { status: 'failed', failure_reason: reason, updated_at: new Date().toISOString() });
  webhookDispatcher.dispatch(merchantId, 'payout.failed', { id, failure_reason: reason });
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

module.exports = { createPayout, getById, getByOwnReference, list };
