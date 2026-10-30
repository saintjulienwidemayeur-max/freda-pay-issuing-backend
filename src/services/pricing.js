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
  const fee = Math.min(round2(amount * cfg.pct + cfg.fixedHTG), round2(amount)); // never more than the payment: no negative credit
  return { fee, net: Math.max(0, round2(amount - fee)) };
}

/**
 * Fee on a CARD payment (USD): amount x pct + fixed, from the merchant's Gateway plan or an admin override.
 * Returns { fee, net } in USD.
 */
function computeGatewayCardFee(gatewayPlanKey, amountUsd, override) {
  const plans = config.gatewayCardPlans;
  const base = plans[gatewayPlanKey] || plans.standard;
  const pct = override && override.gateway_card_pct != null ? Number(override.gateway_card_pct) : base.pct;
  const fixed = override && override.gateway_card_fixed_usd != null ? Number(override.gateway_card_fixed_usd) : base.fixedUSD;
  const fee = Math.min(round2(Number(amountUsd) * pct + fixed), round2(Number(amountUsd))); // never more than the payment: no negative credit
  return { fee, net: Math.max(0, round2(Number(amountUsd) - fee)) };
}
/** What the card partner charges us on a card payment (USD). */
function cardPartnerCostUsd(amountUsd) {
  const c = config.tranzak.cost;
  return round2(Number(amountUsd) * c.pct / 100 + c.fixedUSD);
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
/**
 * Fee on a Master Wallet top-up paid by MonCash/Natcash. Two parts, both paid by the person topping up:
 *   - Freda Pay's own fee (their plan, or the admin's custom rate);
 *   - the payment partner's fee (4 % of the amount it collects), passed through, so a top-up never costs Freda Pay money.
 * `fee` is the total taken from the amount; `fredaFee` is the only part that is Freda Pay's income.
 */
/** The plan's percentage (as a fraction, 0.045 = 4.5 %) for adding money to the Master Wallet, honouring an admin override. */
function walletFundingPct(issuingPlanKey, override) {
  return effectiveIssuingPricing(issuingPlanKey, override).walletFundingPct;
}

function computeWalletFundingFee(issuingPlanKey, amountHtg, override) {
  const cfg = effectiveIssuingPricing(issuingPlanKey, override);
  const fredaFee = round2(amountHtg * cfg.walletFundingPct);
  const gw = require('../config').gatewayProviderCost;
  const partnerFee = round2(amountHtg * gw.pct / 100 + gw.fixedHTG);
  const fee = round2(fredaFee + partnerFee);
  const netHtg = round2(amountHtg - fee);
  return { fee, fredaFee, partnerFee, netHtg, creditedUsd: htgToUsd(Math.max(0, netHtg)) };
}

/**
 * What a merchant pays to withdraw from the Gateway balance, on top of the amount sent:
 * MonCash/Natcash = a percentage of the amount; bank transfer = a fixed amount. An admin can set custom values per merchant.
 */
function computePayoutFee(method, amountHtg, override, currency) {
  const cfg = require('../config').payoutFees;
  if (currency === 'USD') {
    const fixed = override && override.payout_bank_fee_usd != null ? Number(override.payout_bank_fee_usd) : cfg.bankFixedUSD;
    return { fee: round2(fixed), kind: 'fixed' };
  }
  if (method === 'bank') {
    const fixed = override && override.payout_bank_fee_htg != null ? Number(override.payout_bank_fee_htg) : cfg.bankFixedHTG;
    return { fee: round2(fixed), kind: 'fixed' };
  }
  const pct = override && override.payout_mobile_pct != null ? Number(override.payout_mobile_pct) : cfg.mobilePct;
  return { fee: round2(amountHtg * pct), kind: 'percent', pct };
}

/** Flat per-card creation fee (USD) for the merchant's Issuing plan or override. */
function cardCreationFee(issuingPlanKey, override) {
  return effectiveIssuingPricing(issuingPlanKey, override).cardCreationUSD;
}
/**
 * Recharge fee (USD): a flat amount up to rechargeFlatMaxUSD (100 $), then a percentage of the recharged amount.
 * A custom flat fee set by an admin replaces the plan's flat amount (the percentage above 100 $ stays the plan's).
 */
function cardRechargeFee(issuingPlanKey, override, amountUsd) {
  const cfg = effectiveIssuingPricing(issuingPlanKey, override);
  if (amountUsd != null && Number(amountUsd) > require('../config').rechargeFlatMaxUSD) {
    return round2(Number(amountUsd) * (cfg.rechargeLargePct || 0));
  }
  return cfg.rechargeUSD;
}
/** Fee per card purchase (USD) on the merchant's Issuing plan. */
function cardSpendFee(issuingPlanKey) {
  return issuingPlan(issuingPlanKey).cardSpendUSD || 0;
}
/** Cross-currency / cross-border fee (USD) for a card transaction of this amount. */
function crossBorderFee(amountUsd) {
  const cfg = require('../config').crossBorderFee;
  return round2(Number(amountUsd) * cfg.pct + cfg.fixedUSD);
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
  computeGatewayCardFee,
  cardPartnerCostUsd,
  computeWalletFundingFee,
  walletFundingPct,
  computePayoutFee,
  htgToUsd,
  cardCreationFee,
  cardRechargeFee,
  cardSpendFee,
  crossBorderFee,
  cardWithdrawalFee,
  cardDeclineFee,
  cardLimitFor,
  issuingProfitUSD,
};
