'use strict';

/**
 * Subscription plans are chosen PER ENVIRONMENT. A plan picked while playing in
 * Sandbox must not follow the merchant into Live: Live starts on the default
 * plans and is paid for with real money from the Live wallet.
 *   sandbox -> merchants.gateway_plan / issuing_plan         (the original columns)
 *   live    -> merchants.live_gateway_plan / live_issuing_plan
 */
const DEFAULTS = { gateway: 'standard', issuing: 'startup' };

function columnFor(product, mode) {
  const live = mode === 'live';
  if (product === 'gateway') return live ? 'live_gateway_plan' : 'gateway_plan';
  return live ? 'live_issuing_plan' : 'issuing_plan';
}

/** The plan key a merchant is on for one product in one environment. */
function planKeyFor(merchant, product, mode) {
  const value = merchant && merchant[columnFor(product, mode)];
  return value || DEFAULTS[product];
}

module.exports = { DEFAULTS, columnFor, planKeyFor };
