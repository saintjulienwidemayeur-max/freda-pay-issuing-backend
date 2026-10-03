'use strict';
const config = require('../config');

function round2(n) {
  return Math.round(n * 100) / 100;
}

function gatewayPlan(planKey) {
  return config.gatewayPlans[planKey] || config.gatewayPlans.standard;
}
function issuingPlan(planKey) {
  return config.issuingPlans[planKey] || config.issuingPlans.startup;
}

/**
 * Merges a merchant's custom pricing override (from the `merchant_pricing`
 * table, set by an admin) onto their plan's base pricing. Any null/undefined
 * field in the override falls back to the plan's value - a merchant only
 * needs a custom value for the fees that actually differ for them.
 */
function effectiveIssuingPricing(issuingPlanKey, override) {
  const base = issuingPlan(issuingPlanKey);
  if (!override) return base;
  return {
    ...base,
    cardCreationUSD: override.card_creation_usd ?? base.cardCreationUSD,
    rechargeUSD: override.card_recharge_usd ?? base.rechargeUSD,
    withdrawalUSD: override.card_withdrawal_usd ?? base.withdrawalUSD,
    declineUSD: override.card_decline_usd ?? base.declineUSD,
    walletFundingPct: override.wallet_funding_pct ?? base.walletFundingPct,
  };
}

function effectiveGatewayPricing(gatewayPlanKey, override) {
  const base = gatewayPlan(gatewayPlanKey);
  if (!override) return base;
  return {
    ...base,
    pct: override.gateway_pct ?? base.pct,
    fixedHTG: override.gateway_fixed_htg ?? base.fixedHTG,
  };
}

/**
 * Compute Freda Pay's Gateway transaction fee for a payment, based on the
 * merchant's chosen Gateway plan (same fee regardless of MonCash/Natcash/
 * carte), or their custom pricing override if an admin set one.
 * Returns { fee, net } in the same currency as the amount (HTG).
 */
function computeGatewayFee(gatewayPlanKey, amount, override) {
  const cfg = effectiveGatewayPricing(gatewayPlanKey, override);
  const fee = round2(amount * cfg.pct + cfg.fixedHTG);
  return { fee, net: round2(amount - fee) };
}

/** Converts an HTG amount to USD at the platform's fixed rate. */
function htgToUsd(amountHtg) {
  return round2(amountHtg / config.exchangeRateHtgPerUsd);
}

/**
 * Compute the Master Wallet funding fee (topping up via MonCash/Natcash),
 * based on the merchant's Issuing plan or custom override. Returns the fee
 * in HTG, the net HTG after the fee, and the resulting USD credit.
 */
function computeWalletFundingFee(issuingPlanKey, amountHtg, override) {
  const cfg = effectiveIssuingPricing(issuingPlanKey, override);
  const fee = round2(amountHtg * cfg.walletFundingPct);
  const netHtg = round2(amountHtg - fee);
  return { fee, netHtg, creditedUsd: htgToUsd(netHtg) };
}

/** Flat per-card creation fee (USD) for the merchant's Issuing plan or override. */
function cardCreationFee(issuingPlanKey, override) {
  return effectiveIssuingPricing(issuingPlanKey, override).cardCreationUSD;
}
/** Flat per-recharge fee (USD) for the merchant's Issuing plan or override. */
function cardRechargeFee(issuingPlanKey, override) {
  return effectiveIssuingPricing(issuingPlanKey, override).rechargeUSD;
}
/** Flat per-withdrawal fee (USD) for the merchant's Issuing plan or override. */
function cardWithdrawalFee(issuingPlanKey, override) {
  return effectiveIssuingPricing(issuingPlanKey, override).withdrawalUSD;
}
/** Flat per-decline fee (USD) for the merchant's Issuing plan or override. */
function cardDeclineFee(issuingPlanKey, override) {
  return effectiveIssuingPricing(issuingPlanKey, override).declineUSD;
}
/** Card limit for the merchant's Issuing plan (null = unlimited). Not overridable per merchant. */
function cardLimitFor(issuingPlanKey) {
  return issuingPlan(issuingPlanKey).cardLimit;
}

/**
 * Our own profit on one transaction: what we charged (price) minus what the
 * provider charged us (config.issuingProviderCostsUSD). Gateway/MonCash-
 * Natcash has no confirmed provider cost yet, so there is no Gateway
 * equivalent - only Issuing margin can be computed today.
 */
function issuingProfitUSD(kind, priceUSD) {
  const cost = config.issuingProviderCostsUSD[kind];
  if (cost == null) return null;
  return round2(priceUSD - cost);
}

module.exports = {
  round2,
  gatewayPlan,
  issuingPlan,
  effectiveIssuingPricing,
  effectiveGatewayPricing,
  computeGatewayFee,
  computeWalletFundingFee,
  htgToUsd,
  cardCreationFee,
  cardRechargeFee,
  cardWithdrawalFee,
  cardDeclineFee,
  cardLimitFor,
  issuingProfitUSD,
};
