'use strict';
const ledger = require('../services/ledger');
const { resolveMode } = require('../utils/mode');
const guarantee = require('../services/guarantee');

/** Balances for the mode the caller is in (dashboard toggle, or the API key's own mode). Sandbox and Live balances are completely separate wallets. */
async function getBalance(ctx) {
  const mode = await resolveMode(ctx);
  const [gateway, gatewayUsd, masterWallet, locked] = await Promise.all([
    ledger.getBalance(ctx.merchantId, 'gateway', 'HTG', mode),
    ledger.getBalance(ctx.merchantId, 'gateway', 'USD', mode),
    ledger.getBalance(ctx.merchantId, 'master_wallet', 'USD', mode),
    guarantee.get(ctx.merchantId),
  ]);
  return {
    status: 200,
    body: {
      mode,
      // `gateway` stays the HTG balance (MonCash / Natcash); card payments (USD) credit `gateway_usd`.
      gateway: { available: gateway, currency: 'HTG' },
      gateway_usd: { available: gatewayUsd, currency: 'USD' },
      gateway_balances: { HTG: gateway, USD: gatewayUsd },
      // `available` is the whole balance; `guarantee_usd` stays locked, `spendable_usd` is what cards, recharges and plans can use.
      master_wallet: { available: masterWallet, guarantee_usd: locked, spendable_usd: Math.max(0, Math.round((masterWallet - locked) * 100) / 100), currency: 'USD' },
    },
  };
}

/**
 * The Master Wallet of an issuer, for the Issuing API: the whole balance, the locked guarantee deposit, what can be spent, and what is
 * already on the cards. `GET /v1/master-wallet` (API key; Live key for the real money, test key for the play money).
 */
async function getMasterWallet(ctx) {
  const mode = await resolveMode(ctx);
  const supabase = require('../lib/supabase');
  const [balance, locked, cards] = await Promise.all([
    ledger.getBalance(ctx.merchantId, 'master_wallet', 'USD', mode),
    guarantee.get(ctx.merchantId),
    supabase.select('cards', { merchant_id: ctx.merchantId, mode, status: supabase.inList(['active', 'disabled']), deleted_at: supabase.isNull() }, { limit: 2000 }),
  ]);
  const round2 = (n) => Math.round(n * 100) / 100;
  return {
    status: 200,
    body: {
      mode,
      currency: 'USD',
      balance: round2(balance),
      guarantee_usd: locked,
      spendable_usd: Math.max(0, round2(balance - locked)),
      reserved_on_cards_usd: round2(cards.reduce((sum, c) => sum + Number(c.balance || 0), 0)),
      active_cards: cards.length,
      low_balance: balance <= guarantee.alertLevelFor(locked),
    },
  };
}

module.exports = { getBalance, getMasterWallet };
