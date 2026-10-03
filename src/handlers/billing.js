'use strict';
const supabase = require('../lib/supabase');
const pricing = require('../services/pricing');
const masterWallet = require('../services/masterWallet');
const config = require('../config');
const { randomHex } = require('../utils/ids');
const { publicMerchant } = require('./auth');
const { resolveMode } = require('../utils/mode');

/** Returns the full plan catalog for both tracks, for the dashboard/landing page to render. */
async function getPlans() {
  return {
    status: 200,
    body: { gatewayPlans: config.gatewayPlans, issuingPlans: config.issuingPlans },
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
  if (!planConfig) {
    throw httpError(400, 'INVALID_PLAN', `Plan invalide. Options : ${Object.keys(config.gatewayPlans).join(', ')}.`);
  }

  const merchant = await supabase.selectOne('merchants', { id: ctx.merchantId });
  if (!merchant) throw httpError(404, 'NOT_FOUND', 'Marchand introuvable.');

  if (merchant.gateway_plan === plan) {
    return { status: 200, body: { merchant: publicMerchant(merchant), charged: 0 } };
  }

  const priceUsd = pricing.htgToUsd(planConfig.monthlyFeeHTG);
  if (priceUsd > 0) {
    const reference = `gateway_plan_${plan}_${randomHex(6)}`;
    try {
      await masterWallet.debitWithFloor(ctx.merchantId, priceUsd, reference, ctx.merchantId, await resolveMode(ctx));
    } catch (err) {
      throw httpError(err.httpStatus || 400, err.code || 'INSUFFICIENT_BALANCE', err.message);
    }
  }

  const [updated] = await supabase.update('merchants', { id: ctx.merchantId }, { gateway_plan: plan });
  return { status: 200, body: { merchant: publicMerchant(updated), charged: priceUsd } };
}

/** Change the Issuing (card issuance) plan. Priced in USD, charged from Master Wallet directly. */
async function changeIssuingPlan(ctx) {
  const { plan } = ctx.body || {};
  const planConfig = config.issuingPlans[plan];
  if (!planConfig) {
    throw httpError(400, 'INVALID_PLAN', `Plan invalide. Options : ${Object.keys(config.issuingPlans).join(', ')}.`);
  }

  const merchant = await supabase.selectOne('merchants', { id: ctx.merchantId });
  if (!merchant) throw httpError(404, 'NOT_FOUND', 'Marchand introuvable.');

  if (merchant.issuing_plan === plan) {
    return { status: 200, body: { merchant: publicMerchant(merchant), charged: 0 } };
  }

  if (planConfig.monthlyFeeUSD > 0) {
    const reference = `issuing_plan_${plan}_${randomHex(6)}`;
    try {
      await masterWallet.debitWithFloor(ctx.merchantId, planConfig.monthlyFeeUSD, reference, ctx.merchantId, await resolveMode(ctx));
    } catch (err) {
      throw httpError(err.httpStatus || 400, err.code || 'INSUFFICIENT_BALANCE', err.message);
    }
  }

  const [updated] = await supabase.update('merchants', { id: ctx.merchantId }, { issuing_plan: plan });
  return { status: 200, body: { merchant: publicMerchant(updated), charged: planConfig.monthlyFeeUSD } };
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { getPlans, changeGatewayPlan, changeIssuingPlan };
