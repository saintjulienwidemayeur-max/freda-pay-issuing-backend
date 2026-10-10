'use strict';
const supabase = require('../lib/supabase');
const ledger = require('../services/ledger');
const { resolveMode } = require('../utils/mode');

const sum = (rows, f) => rows.reduce((t, r) => t + Number(f(r) || 0), 0);
const round2 = (n) => Math.round(n * 100) / 100;

/** Ledger references that are money coming BACK from a card or a refund, not a deposit by the merchant. */
const NOT_A_DEPOSIT = /^(refund:|fund-refund:|card-withdraw:|card-terminate-refund:)/;

function labelFor(e) {
  const ref = e.reference || '';
  switch (e.type) {
    case 'payment_credit': return 'Encaissement';
    case 'payout_debit': return /:hold-fee$|:freda-fee$/.test(ref) ? 'Frais de retrait' : 'Retrait';
    case 'payout_refund': return /:release-fee$/.test(ref) ? 'Frais de retrait remboursés' : 'Retrait annulé : remboursé';
    case 'wallet_topup':
      if (ref === 'sandbox-welcome-bonus') return 'Bonus de bienvenue (Sandbox)';
      if (ref.startsWith('manual-topup:')) return 'Dépôt confirmé';
      if (ref.startsWith('admin-credit:')) return "Crédit par l'équipe Freda Pay";
      if (ref.startsWith('card-withdraw:')) return 'Retrait depuis une carte';
      if (ref.startsWith('card-terminate-refund:')) return 'Carte clôturée : solde restitué';
      if (/^(refund|fund-refund):/.test(ref)) return 'Remboursement';
      return 'Rechargement';
    case 'wallet_debit':
      if (ref.startsWith('card-decline-fee:')) return 'Frais de refus de carte';
      if (ref.startsWith('fund:')) return 'Recharge de carte';
      if (/^(gateway_plan_|issuing_plan_)/.test(ref)) return 'Abonnement (changement de plan)';
      if (ref.startsWith('plan-renewal:')) return 'Abonnement (renouvellement mensuel)';
      return 'Création de carte';
    default: return e.type;
  }
}

/**
 * Real figures for the Soldes & Wallet page, for the mode the merchant is in:
 * what is pending, what came in, what is locked on cards, and the latest movements.
 * (The page used to ship hard-coded demo numbers; nothing on it is invented any more.)
 */
async function summary(ctx) {
  const mode = await resolveMode(ctx);
  const gatewayKey = ledger.walletKey('gateway', mode);
  const walletKey = ledger.walletKey('master_wallet', mode);

  const [payments, cards, walletEntries, gatewayEntries] = await Promise.all([
    supabase.select('payments', { merchant_id: ctx.merchantId, mode }, { limit: 2000 }),
    supabase.select('cards', { merchant_id: ctx.merchantId, mode, status: 'active' }, { limit: 500 }),
    supabase.select('ledger_entries', { merchant_id: ctx.merchantId, wallet: walletKey }, { order: 'created_at.desc', limit: 1000 }),
    supabase.select('ledger_entries', { merchant_id: ctx.merchantId, wallet: gatewayKey }, { order: 'created_at.desc', limit: 1000 }),
  ]);

  const deposits = walletEntries.filter((e) => e.type === 'wallet_topup' && !NOT_A_DEPOSIT.test(e.reference || '') && Number(e.amount) > 0);
  const movements = [
    ...walletEntries.map((e) => ({ e, wallet: 'Master Wallet' })),
    ...gatewayEntries.map((e) => ({ e, wallet: 'Gateway' })),
  ]
    .sort((a, b) => new Date(b.e.created_at) - new Date(a.e.created_at))
    .slice(0, 25)
    .map(({ e, wallet }) => ({ date: e.created_at, label: labelFor(e), wallet, amount: Number(e.amount), currency: e.currency }));

  return {
    status: 200,
    body: {
      mode,
      gateway: {
        pending_htg: round2(sum(payments.filter((p) => p.status === 'pending'), (p) => p.amount)),
        total_in_htg: round2(sum(payments.filter((p) => p.status === 'succeeded'), (p) => p.amount)),
      },
      master_wallet: {
        added_total_usd: round2(sum(deposits, (e) => e.amount)),
        reserved_on_cards_usd: round2(sum(cards, (c) => c.balance)),
      },
      movements,
    },
  };
}

/** A credit that is money the merchant put in (not a refund or a card giving money back). */
const isDeposit = (e) => e.type === 'wallet_topup' && !NOT_A_DEPOSIT.test(e.reference || '') && Number(e.amount) > 0;

/** A credit that is money coming BACK to the wallet (refund, card closed, withdrawal from a card), not a deposit. */
const isReturn = (e) => e.type === 'wallet_topup' && NOT_A_DEPOSIT.test(e.reference || '') && Number(e.amount) > 0;

module.exports = { summary, isDeposit, isReturn };
