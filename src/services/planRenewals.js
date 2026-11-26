'use strict';
const supabase = require('../lib/supabase');
const config = require('../config');
const ledger = require('./ledger');
const masterWallet = require('./masterWallet');
const pricing = require('./pricing');
const revenue = require('./revenue');
const notify = require('./notify');

/**
 * Monthly renewal of paid plans, for the LIVE environment only (Sandbox is play money: its plans never renew).
 *
 *   - changing to a paid plan charges the first month at once and sets the next date one calendar month later;
 *   - on that date the price is taken again from the Master Wallet (idempotent: the same period is never charged twice);
 *   - the price is always taken in full: if the wallet holds less, all of it is taken and the balance goes negative by the rest (the debt is
 *     cleared by the next deposits). Only a wallet that is ALREADY negative cannot pay: the merchant is warned once, the charge is retried every
 *     hour for `graceDays` days, and after that the account goes back to the entry plan (Gateway: Standard, Issuing: Startup);
 *   - complimentary plans (granted by the team), free plans and suspended accounts are never charged.
 */
const PRODUCTS = {
  gateway: { plan: 'live_gateway_plan', renews: 'live_gateway_renews_at', unpaid: 'live_gateway_unpaid_since', plans: () => config.gatewayPlans, entry: 'standard', priceUsd: (p) => pricing.htgToUsd(p.monthlyFeeHTG) },
  issuing: { plan: 'live_issuing_plan', renews: 'live_issuing_renews_at', unpaid: 'live_issuing_unpaid_since', plans: () => config.issuingPlans, entry: 'startup', priceUsd: (p) => p.monthlyFeeUSD },
};

/** One calendar month later, in UTC, staying inside shorter months (31 Jan + 1 month = 28/29 Feb). */
function addMonths(date, n = 1) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/** What this plan costs per month in USD (0 for free and complimentary plans). */
function monthlyPriceUsd(product, planKey) {
  const cfg = PRODUCTS[product].plans()[planKey];
  if (!cfg || cfg.grantedOnly) return 0;
  return Math.round(PRODUCTS[product].priceUsd(cfg) * 100) / 100;
}

const blockedNotified = new Set();

/**
 * Is this merchant's live API blocked for a product because its subscription stayed unpaid longer than the grace period?
 * (live_<product>_unpaid_since is set by the renewal pass when a renewal could not be paid, and cleared when it is.)
 */
function isBlocked(merchant, product, now = Date.now()) {
  const P = PRODUCTS[product];
  const since = merchant && merchant[P.unpaid];
  return !!since && now - new Date(since).getTime() >= config.billing.graceDays * 86400000;
}

async function renewOne(merchant, product, now) {
  const P = PRODUCTS[product];
  const planKey = merchant[P.plan] || P.entry;
  const cfg = P.plans()[planKey];
  const price = monthlyPriceUsd(product, planKey);

  if (!cfg || price <= 0) { // nothing to renew: make sure no stale date or unpaid mark stays behind
    if (merchant[P.renews] || merchant[P.unpaid]) await supabase.update('merchants', { id: merchant.id }, { [P.renews]: null, [P.unpaid]: null });
    return 'free';
  }
  if (!merchant[P.renews]) { // a paid plan taken before renewals existed: it was paid at that time, the cycle starts now
    await supabase.update('merchants', { id: merchant.id, [P.renews]: supabase.isNull() }, { [P.renews]: addMonths(now, 1).toISOString() });
    return 'scheduled';
  }
  const due = new Date(merchant[P.renews]);
  if (due > now) return 'not-due';

  const reference = `plan-renewal:${product}:${planKey}:${due.toISOString().slice(0, 10)}`;
  const alreadyCharged = await supabase.selectOne('ledger_entries', { merchant_id: merchant.id, reference });
  let taken = null;
  try {
    // The subscription is taken in full whatever the balance (see masterWallet.debitSubscription): what is missing becomes a negative balance.
    if (!alreadyCharged) taken = await masterWallet.debitSubscription(merchant.id, price, reference, merchant.id, 'live');
  } catch (err) {
    if (err.code !== 'WALLET_IN_DEBT' && err.code !== 'BELOW_MINIMUM_BALANCE' && err.code !== 'INSUFFICIENT_BALANCE') throw err;
    const since = merchant[P.unpaid] ? new Date(merchant[P.unpaid]) : null;
    if (!since) {
      await supabase.update('merchants', { id: merchant.id }, { [P.unpaid]: now.toISOString() });
      await notify.planPaymentFailed(merchant, { product, planLabel: cfg.label, amountUsd: price, until: new Date(now.getTime() + config.billing.graceDays * 86400000) });
      return 'unpaid-warned';
    }
    if (now - since >= config.billing.graceDays * 86400000) {
      // Grace period over: the plan is NOT changed, the merchant's API (live keys) is refused until the subscription is paid (see isBlocked,
      // used by the API-key middleware). The merchant is told once per unpaid period (in memory: a restart can repeat it once).
      const mark = `${merchant.id}:${product}:${since.toISOString()}`;
      if (!blockedNotified.has(mark)) { blockedNotified.add(mark); await notify.planBlocked(merchant, { product, planLabel: cfg.label, amountUsd: price }); }
      return 'blocked';
    }
    return 'unpaid-waiting';
  }

  // Paid on time: the next period follows the previous one. Paid late (after a failed attempt): it restarts today.
  const next = merchant[P.unpaid] ? addMonths(now, 1) : addMonths(due, 1);
  const [claimed] = await supabase.update('merchants', { id: merchant.id, [P.renews]: merchant[P.renews] }, { [P.renews]: next.toISOString(), [P.unpaid]: null });
  if (claimed && !alreadyCharged) {
    await revenue.log(merchant.id, 'plan_subscription', price, 'USD', reference, 'live', 0);
    if (taken && taken.debt > 0) await notify.planRenewedOnCredit(merchant, { product, planLabel: cfg.label, amountUsd: price, paidUsd: taken.paid, debtUsd: taken.debt, nextDate: next });
    else await notify.planRenewed(merchant, { product, planLabel: cfg.label, amountUsd: price, nextDate: next });
  }
  return 'renewed';
}

/** Looks at every live merchant once. Safe to run often and on several instances. */
async function run(now = new Date()) {
  const merchants = await supabase.select('merchants', { deleted_at: supabase.isNull() }, { limit: 5000 });
  const done = { renewed: 0, unpaid: 0, blocked: 0 };
  for (const m of merchants) {
    for (const product of Object.keys(PRODUCTS)) {
      try {
        const r = await renewOne(m, product, now);
        if (r === 'renewed') done.renewed += 1;
        else if (r === 'unpaid-warned') done.unpaid += 1;
        else if (r === 'blocked') done.blocked += 1;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`Plan renewal failed for ${m.id} (${product}): ${err.message}`);
      }
    }
  }
  return done;
}

/** The team's button: runs one merchant's renewal now (only if it is due). Returns the outcome word. */
async function renewMerchant(merchantId, product, now = new Date()) {
  if (!PRODUCTS[product]) throw Object.assign(new Error('Produit inconnu.'), { httpStatus: 400, code: 'INVALID_PRODUCT' });
  const merchant = await supabase.selectOne('merchants', { id: merchantId });
  if (!merchant) throw Object.assign(new Error('Marchand introuvable.'), { httpStatus: 404, code: 'NOT_FOUND' });
  if (merchant.deleted_at) throw Object.assign(new Error('Compte suspendu : aucun abonnement n\'est prélevé.'), { httpStatus: 400, code: 'SUSPENDED' });
  return renewOne(merchant, product, now);
}

function start() {
  const tick = () => run().catch((err) => console.error('Plan renewals run failed:', err.message)); // eslint-disable-line no-console
  setTimeout(tick, 90 * 1000).unref();
  setInterval(tick, config.billing.checkEveryMs).unref();
}

/** Right after money reaches a live Master Wallet: a merchant with an unpaid subscription is settled at once instead of waiting for the hourly pass. */
async function settleAfterCredit(merchantId) {
  const merchant = await supabase.selectOne('merchants', { id: merchantId });
  if (!merchant || merchant.deleted_at) return;
  for (const product of Object.keys(PRODUCTS)) {
    if (merchant[PRODUCTS[product].unpaid]) await renewOne(merchant, product, new Date()).catch((err) => console.error(`Settling ${product} for ${merchantId} failed: ${err.message}`)); // eslint-disable-line no-console
  }
  require('../middleware/apiKey').clearAuthCache();
}

module.exports = { run, renewMerchant, settleAfterCredit, isBlocked, start, addMonths, monthlyPriceUsd, PRODUCTS };
