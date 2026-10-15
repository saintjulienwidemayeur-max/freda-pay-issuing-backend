'use strict';
const ledger = require('../services/ledger');
const { resolveMode } = require('../utils/mode');

/** Balances for the mode the caller is in (dashboard toggle, or the API key's own mode). Sandbox and Live balances are completely separate wallets. */
async function getBalance(ctx) {
  const mode = await resolveMode(ctx);
  const [gateway, gatewayUsd, masterWallet] = await Promise.all([
    ledger.getBalance(ctx.merchantId, 'gateway', 'HTG', mode),
    ledger.getBalance(ctx.merchantId, 'gateway', 'USD', mode),
    ledger.getBalance(ctx.merchantId, 'master_wallet', 'USD', mode),
  ]);
  return {
    status: 200,
    body: {
      mode,
      // `gateway` stays the HTG balance (MonCash / Natcash); card payments (USD) credit `gateway_usd`.
      gateway: { available: gateway, currency: 'HTG' },
      gateway_usd: { available: gatewayUsd, currency: 'USD' },
      gateway_balances: { HTG: gateway, USD: gatewayUsd },
      master_wallet: { available: masterWallet, currency: 'USD' },
    },
  };
}

module.exports = { getBalance };
