'use strict';
const ledger = require('../services/ledger');
const { resolveMode } = require('../utils/mode');

/** Balances for the mode the caller is in (dashboard toggle, or the API key's own mode). Sandbox and Live balances are completely separate wallets. */
async function getBalance(ctx) {
  const mode = await resolveMode(ctx);
  const [gateway, masterWallet] = await Promise.all([
    ledger.getBalance(ctx.merchantId, 'gateway', 'HTG', mode),
    ledger.getBalance(ctx.merchantId, 'master_wallet', 'USD', mode),
  ]);
  return {
    status: 200,
    body: {
      mode,
      gateway: { available: gateway, currency: 'HTG' },
      master_wallet: { available: masterWallet, currency: 'USD' },
    },
  };
}

module.exports = { getBalance };
