'use strict';
const supabase = require('../lib/supabase');
const pricing = require('../services/pricing');
const masterWallet = require('../services/masterWallet');
const config = require('../config');
const { randomHex } = require('../utils/ids');
const { publicMerchant } = require('./auth');
const { resolveMode } = require('../utils/mode');
const { columnFor, planKeyFor } = require('../services/plans');
const planRenewals = require('../services/planRenewals');
const revenue = require('../services/revenue');

/** Plans a merchant may pick for themselves (complimentary ones are granted by an admin only). */
function selfServe(plans) {
  return Object.fromEntries(Object.entries(plans).filter(([, p]) => !p.grantedOnly));
}

/** Returns the full plan catalog for both tracks, for the dashboard/landing page to render. */
async function getPlans() {
  return {
    status: 200,
    body: { gatewayPlans: selfServe(config.gatewayPlans), issuingPlans: selfServe(config.issuingPlans) },
  };
}

/**
 * Change the Gateway (payment acceptance) plan. Priced in HTG, but - like
 * every other subscription fee - charged from the single USD Master Wallet,
 * converted at the platform exchange rate.
 */
async function changeGatewayPlan(ctx) {
  const { plan } = ctx.body || {};
  const planConfig = config.gatewayPlans[plan];
  if (!planConfig || planConfig.grantedOnly) {
    throw httpError(400, 'INVALID_PLAN', `Plan invalide. Options : ${Object.keys(selfServe(config.gatewayPlans)).join(', ')}.`);
  }

  const merchant = await supabase.selectOne('merchants', { id: ctx.merchantId });
  if (!merchant) throw httpError(404, 'NOT_FOUND', 'Marchand introuvable.');
  const mode = await resolveMode(ctx); // the plan belongs to the environment the merchant is in

  if (planKeyFor(merchant, 'gateway', mode) === plan) {
    return { status: 200, body: { merchant: publicMerchant(merchant), charged: 0 } };
  }

  const priceUsd = pricing.htgToUsd(planConfig.monthlyFeeHTG);
  if (priceUsd > 0) {
    const reference = `gateway_plan_${plan}_${randomHex(6)}`;
    try {
      await masterWallet.debitWithFloor(ctx.merchantId, priceUsd, reference, ctx.merchantId, mode);
    } catch (err) {
      throw httpError(err.httpStatus || 400, err.code || 'INSUFFICIENT_BALANCE', err.message);
    }
  }

  const [updated] = await supabase.update('merchants', { id: ctx.merchantId }, { [columnFor('gateway', mode)]: plan, ...cycleFor('gateway', mode, priceUsd) });
  if (priceUsd > 0) await revenue.log(ctx.merchantId, 'plan_subscription', priceUsd, 'USD', `gateway_plan_${plan}`, mode, 0);
  return { status: 200, body: { merchant: publicMerchant(updated), charged: priceUsd } };
}

/** Change the Issuing (card issuance) plan. Priced in USD, charged from Master Wallet directly. */
async function changeIssuingPlan(ctx) {
  const { plan } = ctx.body || {};
  const planConfig = config.issuingPlans[plan];
  if (!planConfig || planConfig.grantedOnly) {
    throw httpError(400, 'INVALID_PLAN', `Plan invalide. Options : ${Object.keys(selfServe(config.issuingPlans)).join(', ')}.`);
  }

  const merchant = await supabase.selectOne('merchants', { id: ctx.merchantId });
  if (!merchant) throw httpError(404, 'NOT_FOUND', 'Marchand introuvable.');
  const mode = await resolveMode(ctx);

  if (planKeyFor(merchant, 'issuing', mode) === plan) {
    return { status: 200, body: { merchant: publicMerchant(merchant), charged: 0 } };
  }

  if (planConfig.monthlyFeeUSD > 0) {
    const reference = `issuing_plan_${plan}_${randomHex(6)}`;
    try {
      await masterWallet.debitWithFloor(ctx.merchantId, planConfig.monthlyFeeUSD, reference, ctx.merchantId, mode);
    } catch (err) {
      throw httpError(err.httpStatus || 400, err.code || 'INSUFFICIENT_BALANCE', err.message);
    }
  }

  const [updated] = await supabase.update('merchants', { id: ctx.merchantId }, { [columnFor('issuing', mode)]: plan, ...cycleFor('issuing', mode, planConfig.monthlyFeeUSD) });
  if (planConfig.monthlyFeeUSD > 0) await revenue.log(ctx.merchantId, 'plan_subscription', planConfig.monthlyFeeUSD, 'USD', `issuing_plan_${plan}`, mode, 0);
  return { status: 200, body: { merchant: publicMerchant(updated), charged: planConfig.monthlyFeeUSD } };
}

/**
 * The renewal cycle of a plan the merchant just chose (Live only: Sandbox plans never renew).
 * A paid plan renews one calendar month from now; a free plan has nothing to renew. Either way, a pending
 * "unpaid" mark from an earlier failed renewal is cleared.
 */
function cycleFor(product, mode, priceUsd) {
  if (mode !== 'live') return {};
  return {
    [`live_${product}_renews_at`]: priceUsd > 0 ? planRenewals.addMonths(new Date(), 1).toISOString() : null,
    [`live_${product}_unpaid_since`]: null,
  };
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { getPlans, changeGatewayPlan, changeIssuingPlan };
