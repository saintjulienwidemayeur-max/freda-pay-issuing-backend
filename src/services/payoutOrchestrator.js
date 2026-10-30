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
const inFlight = new Set(); // payout ids waiting in (or running through) the queue of THIS instance
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
  const { merchantId, id, plopplopReference, amount, method, recipient } = args; // moncash / natcash only (HTG)
  inFlight.add(id);
  enqueue(() => executePayoutFlow({ merchantId, id, plopplopReference, amount, method, recipient, mode: args.mode || 'sandbox' })).catch(
    async (err) => {
      try {
        await markFailed(merchantId, id, `INTERNAL_ERROR: ${err.message}`);
      } catch (_) {}
    }
  ).finally(() => inFlight.delete(id));
  return payout;
}

/** Records a ledger movement once per reference: a retry after a partial failure never moves the same money twice. */
async function once(merchantId, wallet, cur, mode, reference, move) {
  const rows = await supabase.select('ledger_entries', { merchant_id: merchantId, wallet: mode === 'live' ? `live:${wallet}` : wallet, reference }, { limit: 1 });
  if (rows && rows.length) return null;
  return move();
}
const holdOnce = (merchantId, amount, cur, mode, ref, id) => once(merchantId, 'gateway', cur, mode, ref, () => ledger.debitGatewayForPayout(merchantId, amount, cur, ref, id, mode));
const releaseOnce = (merchantId, amount, cur, mode, ref, id) => once(merchantId, 'gateway', cur, mode, ref, () => ledger.refundGatewayPayout(merchantId, amount, cur, ref, id, mode));

async function createPayoutLocked({ merchantId, id, ownReference, plopplopReference, amount, method, recipient, mode, bankDetails, currency }) {
  const cur = currency === 'USD' ? 'USD' : 'HTG';
  const override = await supabase.selectOne('merchant_pricing', { merchant_id: merchantId });
  const { fee } = pricing.computePayoutFee(method, amount, override, cur);
  const theMode = mode || 'sandbox';

  const available = await ledger.getBalance(merchantId, 'gateway', cur, theMode);
  // Live MonCash / Natcash: the withdrawal service needs a balance of at least the threshold; above it, any amount goes.
  const minBalance = config.payoutFees.mobileMinBalanceHTG;
  if (theMode === 'live' && method !== 'bank' && cur === 'HTG' && available < minBalance) {
    const err = new Error(`Pour retirer par MonCash ou Natcash, votre solde Gateway doit être d'au moins ${minBalance.toLocaleString('fr-FR')} HTG (solde actuel : ${available.toLocaleString('fr-FR')} HTG). Une fois ce seuil atteint, vous pouvez retirer le montant que vous voulez.`);
    err.httpStatus = 400;
    err.code = 'MIN_BALANCE_FOR_WITHDRAWAL';
    throw err;
  }
  if (available < amount + fee) {
    const err = new Error(`Solde disponible insuffisant (${available} ${cur}).`);
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
    currency: cur,
    mode: theMode,
  });

  // A failure while holding the money must not leave a pending payout with no hold (the reconciler would later give back money that was never held):
  // only what was really held is released, and the payout row is removed.
  const isHeld = async (ref) => ((await supabase.select('ledger_entries', { merchant_id: merchantId, wallet: theMode === 'live' ? 'live:gateway' : 'gateway', reference: ref }, { limit: 1 }).catch(() => [])) || []).length > 0;
  const undo = async () => {
    if (await isHeld(`${plopplopReference}:hold`)) await releaseOnce(merchantId, amount, cur, theMode, `${plopplopReference}:release`, id).catch(() => {});
    if (fee > 0 && (await isHeld(`${plopplopReference}:hold-fee`))) await releaseOnce(merchantId, fee, cur, theMode, `${plopplopReference}:release-fee`, id).catch(() => {});
    await supabase.delete('payouts', { id }).catch(() => {});
  };
  let negative = false;
  try {
    await holdOnce(merchantId, amount, cur, theMode, `${plopplopReference}:hold`, id);
    if (fee > 0) await holdOnce(merchantId, fee, cur, theMode, `${plopplopReference}:hold-fee`, id);
    negative = (await ledger.getBalance(merchantId, 'gateway', cur, theMode)) < 0;
  } catch (err) {
    await undo();
    throw err;
  }
  if (negative) {
    // Another request took the money between the balance check and the hold: undo this one.
    await undo();
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
  let sending = false; // true from the moment the withdrawal request leaves: after that, an error does not prove the money was NOT sent
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
    // The token has been seen under several names across API versions: accept them, and fail clearly if none is there.
    const d = authRes.data;
    const marchandToken = d.token || d.access_token || (d.data && (d.data.token || d.data.access_token));
    if (!marchandToken) {
      return markFailed(merchantId, id, `AUTH_FAILED: jeton absent de la réponse du service de paiement (champs reçus : ${Object.keys(d).join(', ')})`);
    }

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
      // What a support person needs to tell a redirect, a wrong key and a provider outage apart: no secret is logged.
      // eslint-disable-next-line no-console
      console.error(`Withdrawal token refused for ${plopplopReference}: HTTP ${tokenRes.httpStatus}, message "${tokenRes.data && tokenRes.data.message}", sent Authorization: ${tokenRes.sentAuth} (token length ${String(marchandToken).length}), final URL ${tokenRes.finalUrl}, redirected: ${tokenRes.redirected}, auth step host: ${authRes.finalUrl && new URL(authRes.finalUrl).host}`);
      return markFailed(merchantId, id, `WITHDRAWAL_TOKEN_FAILED: ${(tokenRes.data && tokenRes.data.message) || tokenRes.httpStatus} (HTTP ${tokenRes.httpStatus})`);
    }
    const withdrawalToken = tokenRes.data.withdrawal_token;

    // Step 3: execute the withdrawal.
    sending = true;
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
      await revenue.log(merchantId, 'payout', Number(done.fee || 0), 'HTG', id, mode, partnerFee != null ? pricing.htgToUsd(Number(partnerFee)) : 0).catch(() => {});
      webhookDispatcher.dispatch(merchantId, 'payout.succeeded', {
        id, amount, currency: 'HTG', method, recipient, fee: Number(done.fee || 0), transaction_id,
      });
      return;
    }

    // No readable answer or a partner-side error: the money may have left. The payout stays pending and reconcilePendingPayouts
    // asks the partner by reference (it never acts on a timeout).
    if (!execRes.data || execRes.httpStatus >= 500) {
      console.error(`Withdrawal ${plopplopReference}: unclear answer (HTTP ${execRes.httpStatus}), left pending for reconciliation.`); // eslint-disable-line no-console
      return;
    }
    const reason = (execRes.data && execRes.data.message) || `HTTP_${execRes.httpStatus}`;
    return markFailed(merchantId, id, reason);
  } catch (err) {
    if (sending) {
      console.error(`Withdrawal ${plopplopReference}: ${err.message} while sending, left pending for reconciliation.`); // eslint-disable-line no-console
      return;
    }
    return markFailed(merchantId, id, `NETWORK_ERROR: ${err.message}`);
  }
}

/**
 * Safety net for MonCash / Natcash withdrawals. The queue lives in memory: when the server restarts (or the partner answers too slowly)
 * a withdrawal can stay "pending" for ever with its money on hold. A pending withdrawal that is no longer in this instance's queue is
 * looked up at the partner BY REFERENCE: "success" settles it, "failed" or "remboursé" gives the held money back, and "no withdrawal found"
 * (HTTP 404) means it was never sent, so the money is given back too. "pending" is left alone. Never acts on a partner error or a timeout.
 */
async function reconcilePendingPayouts(limit) {
  const now = Date.now();
  const rows = (await supabase.select('payouts', { status: 'pending', created_at: supabase.gt(new Date(now - 7 * 24 * 3600 * 1000).toISOString()) }, { order: 'created_at.asc', limit: 200 }))
    .filter((p) => p.method !== 'bank' && !inFlight.has(p.id) && p.plopplop_reference && now - new Date(p.created_at).getTime() > 10 * 60 * 1000)
    .slice(0, limit || 10);
  if (!rows.length) return { checked: 0, settled: 0 };
  const auth = await plopplop.authMerchant();
  const d = auth.data || {};
  const token = d.token || d.access_token || (d.data && (d.data.token || d.data.access_token));
  if (!token) return { checked: 0, settled: 0, error: 'auth' };
  let settled = 0;
  let checked = 0;
  for (const p of rows) {
    checked += 1;
    try {
      const res = await plopplop.verifyWithdrawal({ authToken: token, reference: p.plopplop_reference });
      const data = res.data || {};
      const status = String((data.data && data.data.status) || '').toLowerCase();
      if (res.httpStatus === 404 && /aucun|introuvable|not found/i.test(String(data.message || ''))) {
        if (await markFailed(p.merchant_id, p.id, "NOT_SENT: le retrait n'a pas été envoyé (interruption du service). Les fonds ont été rendus à votre solde.")) settled += 1;
      } else if (data.success && status === 'success') {
        const partnerFee = data.data && data.data.fee;
        const [done] = await supabase.update('payouts', { id: p.id, status: 'pending' }, { status: 'success', partner_fee_htg: partnerFee != null ? partnerFee : null, api_reference: (data.data && data.data.api_reference) || null, plopplop_transaction_id: (data.data && data.data.transaction_id) || null, updated_at: new Date().toISOString() });
        if (done) {
          settled += 1;
          await revenue.log(p.merchant_id, 'payout', Number(done.fee || 0), 'HTG', p.id, p.mode || 'sandbox', partnerFee != null ? pricing.htgToUsd(Number(partnerFee)) : 0).catch(() => {});
          webhookDispatcher.dispatch(p.merchant_id, 'payout.succeeded', { id: p.id, amount: Number(p.amount), currency: 'HTG', method: p.method, recipient: p.recipient, fee: Number(done.fee || 0), transaction_id: (data.data && data.data.transaction_id) || null });
        }
      } else if (data.success && (status === 'failed' || status === 'remboursé' || status === 'rembourse')) {
        if (await markFailed(p.merchant_id, p.id, `PARTNER_${status.toUpperCase()}: le service de paiement n'a pas pu envoyer ce retrait.`)) settled += 1;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Payout reconciliation failed for ${p.id}:`, err.message);
    }
    await sleep(1500);
  }
  return { checked, settled };
}

/** Settles a pending withdrawal as failed ONCE, and gives the held money back (amount + fee). */
async function markFailed(merchantId, id, reason, extra) {
  // Claim first (failure_reason set while still pending), give the money back, and only then show "failed": a client that sees "failed"
  // always finds the money already back, and a refund error leaves the payout pending and retryable.
  const [claimed] = await supabase.update('payouts', { id, status: 'pending', failure_reason: supabase.isNull() }, { failure_reason: reason, updated_at: new Date().toISOString() });
  if (!claimed) return null; // already settled or being settled: never refund twice
  const mode = claimed.mode || 'sandbox';
  const cur = claimed.currency || 'HTG';
  try {
    await releaseOnce(merchantId, Number(claimed.amount), cur, mode, `${claimed.plopplop_reference}:release`, id);
    if (Number(claimed.fee) > 0) await releaseOnce(merchantId, Number(claimed.fee), cur, mode, `${claimed.plopplop_reference}:release-fee`, id);
  } catch (err) {
    // What was already given back is not given twice (releaseOnce); the next attempt finishes the rest.
    await supabase.update('payouts', { id, status: 'pending' }, { failure_reason: null, updated_at: new Date().toISOString() }).catch(() => {});
    throw err;
  }
  const [row] = await supabase.update('payouts', { id, status: 'pending' }, { status: 'failed', updated_at: new Date().toISOString(), ...(extra || {}) });
  webhookDispatcher.dispatch(merchantId, 'payout.failed', { id, failure_reason: reason });
  return row || claimed;
}

/** The team sent the bank transfer: settle it. The held amount + fee stay spent; the fee is Freda Pay's income. */
async function completeBankPayout({ id, bankReference, note, adminId }) {
  const [row] = await supabase.update(
    'payouts',
    { id, method: 'bank', status: 'pending' },
    { status: 'success', bank_reference: bankReference || null, admin_note: note || null, reviewed_by: adminId || null, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() }
  );
  if (!row) return null;
  await revenue.log(row.merchant_id, 'payout', Number(row.fee || 0), row.currency || 'HTG', id, row.mode, 0);
  webhookDispatcher.dispatch(row.merchant_id, 'payout.succeeded', { id, amount: Number(row.amount), currency: row.currency || 'HTG', method: 'bank', recipient: row.recipient, fee: Number(row.fee || 0) });
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

module.exports = { createPayout, completeBankPayout, rejectBankPayout, getById, getByOwnReference, list, reconcilePendingPayouts };
