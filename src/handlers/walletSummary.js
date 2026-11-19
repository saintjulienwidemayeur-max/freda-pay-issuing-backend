'use strict';
const supabase = require('../lib/supabase');
const ledger = require('../services/ledger');
const { resolveMode } = require('../utils/mode');

/** Every row, not just the first page: totals for a busy merchant must not stop at a fixed limit (pages of 1000, up to 100 000 rows). */
async function selectAll(table, filters, order) {
  const all = [];
  for (let page = 0; page < 100; page += 1) {
    const rows = await supabase.select(table, filters, { order, limit: 1000, offset: page * 1000 });
    all.push(...rows);
    if (rows.length < 1000) break;
  }
  return all;
}

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
      if (ref.startsWith('admin-credit:')) return "Crédit par l'équipe Freda Pay Issuing";
      if (ref.startsWith('crypto-convert:')) return 'Conversion crypto → USD';
      if (ref.startsWith('card-withdraw:')) return 'Retrait depuis une carte';
      if (ref.startsWith('card-terminate-refund:')) return 'Carte clôturée : solde restitué';
      if (/^(refund|fund-refund):/.test(ref)) return 'Remboursement';
      return 'Rechargement';
    case 'wallet_debit':
      if (ref.startsWith('card-decline-fee:')) return 'Frais de refus de carte';
      if (ref.startsWith('fund:')) return 'Recharge de carte';
      if (ref.startsWith('card-spend-fee:')) return 'Commission sur un achat par carte';
      if (ref.startsWith('card-program-join:')) return 'Entrée au nouveau programme de cartes';
      if (ref.startsWith('admin-debit:')) return "Débit par l'équipe Freda Pay Issuing";
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
    selectAll('payments', { merchant_id: ctx.merchantId, mode }, 'created_at.desc,id.desc'),
    selectAll('cards', { merchant_id: ctx.merchantId, mode, status: 'active' }, 'created_at.desc,id.desc'),
    selectAll('ledger_entries', { merchant_id: ctx.merchantId, wallet: walletKey }, 'created_at.desc,id.desc'),
    selectAll('ledger_entries', { merchant_id: ctx.merchantId, wallet: gatewayKey }, 'created_at.desc,id.desc'),
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
        pending_htg: round2(sum(payments.filter((p) => p.status === 'pending' && p.currency !== 'USD'), (p) => p.amount)),
        total_in_htg: round2(sum(payments.filter((p) => p.status === 'succeeded' && p.currency !== 'USD'), (p) => p.amount)),
        pending_usd: round2(sum(payments.filter((p) => p.status === 'pending' && p.currency === 'USD'), (p) => p.amount)),
        total_in_usd: round2(sum(payments.filter((p) => p.status === 'succeeded' && p.currency === 'USD'), (p) => p.amount)),
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


/**
 * GET /dashboard/activity : every movement of the account in one list, newest first, for the mode the merchant is in:
 * payments received (encaissements), withdrawals and their fees (paiements), card operations and card purchases (cartes),
 * deposits and subscriptions (wallet). Settled money comes from the ledger; payments not (yet) succeeded and card purchases are added.
 */
/**
 * The list itself. merchantId given: one account (the dashboard). merchantId absent: the whole platform (the admin panel), each line tagged
 * with its merchant, and card lines with the card's partner.
 */
async function buildActivity({ merchantId, mode, limit }) {
  const scope = merchantId ? { merchant_id: merchantId } : {};
  const gatewayKey = ledger.walletKey('gateway', mode);
  const walletKey = ledger.walletKey('master_wallet', mode);
  const [walletEntries, gatewayEntries, payments, cards, cardTx] = await Promise.all([
    supabase.select('ledger_entries', { ...scope, wallet: walletKey }, { order: 'created_at.desc,id.desc', limit }),
    supabase.select('ledger_entries', { ...scope, wallet: gatewayKey }, { order: 'created_at.desc,id.desc', limit }),
    supabase.select('payments', { ...scope, mode, status: supabase.neq('succeeded') }, { order: 'created_at.desc', limit: 100 }),
    supabase.select('cards', { ...scope, mode }, { limit: merchantId ? 2000 : 20000 }),
    supabase.select('card_transactions', { ...scope, mode }, { order: 'occurred_at.desc', limit }).catch(() => []),
  ]);
  const provider = new Map(cards.map((c) => [c.id, c.provider === 'monerails' ? 'monerails' : 'maplerad']));
  const last4 = new Map(cards.map((c) => [c.id, String(c.masked_pan || '').replace(/\D/g, '').slice(-4)]));
  const cardTag = (id) => (id && last4.get(id) ? ` •••• ${last4.get(id)}` : '');
  const isCardEntry = (e) => (e.related_id && last4.has(e.related_id)) || /^(fund:|card-|create:|card_)/.test(e.reference || '');
  const items = [];
  // One line per row in each loop below: tag the lines with their merchant (and, for cards, the card's partner).
  const tag = (from, rows, cardOf) => rows.forEach((r, k) => { const it = items[from + k]; if (!it) return; it.merchant_id = r.merchant_id; const cid = cardOf ? cardOf(r) : null; if (cid && provider.has(cid)) it.provider = provider.get(cid); });
  let from = items.length;
  for (const e of gatewayEntries) {
    const cat = e.type === 'payment_credit' ? 'encaissements' : 'paiements';
    items.push({ id: `l${e.id}`, at: e.created_at, category: cat, title: labelFor(e), detail: 'Solde Gateway', amount: Number(e.amount), currency: e.currency, status: 'succeeded' });
  }
  tag(from, gatewayEntries); from = items.length;
  for (const e of walletEntries) {
    const card = isCardEntry(e);
    const cat = card ? 'cartes' : 'wallet';
    items.push({ id: `l${e.id}`, at: e.created_at, category: cat, title: `${labelFor(e)}${card ? cardTag(e.related_id) : ''}`, detail: 'Master Wallet', amount: Number(e.amount), currency: e.currency, status: 'succeeded' });
  }
  tag(from, walletEntries, (e) => e.related_id); from = items.length;
  const METHOD = { moncash: 'MonCash', natcash: 'Natcash', card: 'carte', carte: 'carte' };
  for (const p of payments) {
    items.push({ id: `p${p.id}`, at: p.created_at, category: 'encaissements', title: `Paiement ${METHOD[p.method] || p.method || ''}`.trim(), detail: p.own_reference || p.id, amount: Number(p.amount), currency: p.currency, status: p.status === 'pending' ? 'pending' : 'failed' });
  }
  tag(from, payments); from = items.length;
  for (const t of cardTx) {
    const declined = /DECLINE/i.test(t.type || '') || /declin|fail/i.test(t.status || '');
    const credit = /CREDIT/i.test(t.direction || '') || /REFUND|REVERSAL/i.test(t.type || '');
    const where = t.merchant_name || t.description || '';
    items.push({
      id: `c${t.id}`, at: t.occurred_at || t.created_at, category: 'cartes',
      title: `${declined ? 'Paiement refusé' : credit ? 'Remboursement' : 'Achat'}${where ? ` · ${where}` : ''}${cardTag(t.card_id)}`,
      detail: 'Sur la carte', amount: declined ? 0 : (credit ? 1 : -1) * Math.abs(Number(t.amount_usd || 0)), currency: 'USD', status: declined ? 'failed' : 'succeeded',
    });
  }
  tag(from, cardTx, (t) => t.card_id);
  items.sort((a, b) => new Date(b.at) - new Date(a.at));
  return items;
}

async function activity(ctx) {
  const mode = await resolveMode(ctx);
  const limit = Math.min(500, Math.max(20, parseInt((ctx.query && ctx.query.limit) || '300', 10) || 300));
  const list = (await buildActivity({ merchantId: ctx.merchantId, mode, limit })).slice(0, limit);
  const counts = { all: list.length, encaissements: 0, paiements: 0, cartes: 0, wallet: 0 };
  for (const i of list) counts[i.category] += 1;
  return { status: 200, body: { mode, counts, items: list } };
}

module.exports = { labelFor, summary, activity, buildActivity, isDeposit, isReturn };
