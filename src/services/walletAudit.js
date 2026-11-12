'use strict';
const supabase = require('../lib/supabase');
const ledger = require('./ledger');

/**
 * Explains a wallet balance: every movement with its cause, what pushed the balance up and what pulled it down, and - for the Master
 * Wallet - whether every credit is BACKED by a real source (a confirmed deposit, an admin credit written in the admin log, a crypto
 * conversion, a refund of an earlier debit, a card refund). A credit without a source, or the same credit twice, is flagged.
 * Nothing here changes any balance: it only reads.
 */
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;
const WALLETS = { master_wallet: 'USD', gateway: 'HTG', crypto: 'USDT' };

async function selectAll(table, filters, order) {
  const all = [];
  for (let page = 0; page < 100; page += 1) {
    const rows = await supabase.select(table, filters, { order, limit: 1000, offset: page * 1000 });
    all.push(...rows);
    if (rows.length < 1000) break;
  }
  return all;
}

/** { category, label, effect } for one ledger row (the cause, in words an admin can read to a merchant). */
function explain(e, wallet) {
  const ref = String(e.reference || '');
  const up = Number(e.amount) > 0;
  const effect = up ? 'up' : 'down';
  const c = (category, label) => ({ category, label, effect });
  if (wallet === 'gateway') {
    if (e.type === 'payment_credit') return c('payment', 'Paiement reçu d\'un client');
    if (e.type === 'payout_debit') return /:hold-fee$|:freda-fee$/.test(ref) ? c('payout_fee', 'Frais de retrait') : c('payout', 'Retrait');
    if (e.type === 'payout_refund') return c('payout_refund', 'Retrait annulé : remboursé');
    if (/^admin-credit:/.test(ref)) return c('admin_credit', "Crédit par l'équipe Freda Pay");
    if (/^admin-debit:/.test(ref)) return c('admin_debit', "Débit par l'équipe Freda Pay");
    return c('other', e.type);
  }
  if (wallet === 'crypto') {
    if (/^crypto-deposit:/.test(ref)) return c('crypto_deposit', 'Dépôt crypto reçu');
    if (/^crypto-convert:/.test(ref)) return c('crypto_convert', 'Converti en USD (Master Wallet)');
    if (/:hold$/.test(ref)) return c('crypto_send', 'Envoi crypto');
    if (/:release$/.test(ref)) return c('crypto_release', 'Envoi annulé : remboursé');
    return c('other', e.type);
  }
  // Master Wallet
  if (up) {
    if (ref === 'sandbox-welcome-bonus') return c('welcome_bonus', 'Bonus de bienvenue (argent de test)');
    if (/^manual-topup:/.test(ref)) return c('deposit_manual', 'Dépôt Zelle / virement confirmé par l\'équipe');
    if (/^admin-credit:/.test(ref)) return c('admin_credit', "Crédit par l'équipe Freda Pay");
    if (/^crypto-convert:/.test(ref)) return c('crypto_convert', 'Conversion crypto → USD');
    if (/^card-withdraw:/.test(ref)) return c('card_withdraw', 'Retrait depuis une carte vers le Master Wallet');
    if (/^card-terminate-refund:/.test(ref)) return c('card_close_refund', 'Carte clôturée : solde restitué');
    if (/^(refund|fund-refund|debit-rollback):/.test(ref)) return c('refund', 'Remboursement d\'une opération qui n\'a pas abouti');
    return c('deposit_auto', 'Rechargement automatique (MonCash / Natcash)');
  }
  if (/^card-decline-fee:/.test(ref)) return c('card_decline_fee', 'Frais de refus de carte');
  if (/^card-spend-fee:/.test(ref)) return c('card_spend_fee', 'Frais sur un achat par carte');
  if (/^fund:/.test(ref)) return c('card_fund', 'Recharge d\'une carte');
  if (/^(gateway_plan_|issuing_plan_)/.test(ref)) return c('plan_change', 'Abonnement (changement de plan)');
  if (/^plan-renewal:/.test(ref)) return c('plan_renewal', 'Abonnement (renouvellement mensuel)');
  if (/^admin-debit:/.test(ref)) return c('admin_debit', "Débit par l'équipe Freda Pay");
  return c('card_create', 'Création de carte');
}

/** Maps used to check that a Master Wallet credit has a real source. Loaded once per audit. */
async function loadSources(merchantId) {
  const f = merchantId ? { merchant_id: merchantId } : {};
  const [topups, adminCredits, cryptoTx, cards] = await Promise.all([
    selectAll('wallet_topups', f, 'created_at.asc'),
    selectAll('admin_wallet_credits', f, 'created_at.asc'),
    selectAll('crypto_transactions', f, 'created_at.asc').catch(() => []),
    selectAll('cards', f, 'created_at.asc'),
  ]);
  return {
    topupById: new Map(topups.map((t) => [t.id, t])),
    topupByRef: new Map(topups.filter((t) => t.plopplop_reference).map((t) => [t.plopplop_reference, t])),
    adminCredits: adminCredits.filter((a) => a.wallet === 'master_wallet'),
    cryptoById: new Map(cryptoTx.map((t) => [t.id, t])),
    cardIds: new Set(cards.map((c) => c.id)),
    cardMerchant: new Map(cards.map((c) => [c.id, c.merchant_id])),
  };
}

/**
 * Status of one Master Wallet credit: 'ok' (a source was found), 'warning' (plausible but not provable from here) or 'anomaly'
 * (no source, or contradicts it). `debitRefs` = references of the merchant's debits, `seen` = credit references already met.
 */
function verifyCredit(e, cat, src, debitRefs, seen) {
  const ref = String(e.reference || '');
  const amt = Number(e.amount);
  const key = `${e.merchant_id}|${e.wallet}|${ref}`;
  if (ref && seen.has(key) && cat !== 'admin_credit') return { status: 'anomaly', note: 'Le même crédit (même référence) apparaît plusieurs fois.' };
  seen.add(key);
  switch (cat) {
    case 'welcome_bonus':
      return String(e.wallet).startsWith('live:') ? { status: 'anomaly', note: "Bonus de test dans le portefeuille LIVE : de l'argent de test ne doit jamais s'y trouver." } : { status: 'ok' };
    case 'deposit_manual': {
      const t = src.topupById.get(ref.slice('manual-topup:'.length));
      if (!t || t.merchant_id !== e.merchant_id) return { status: 'anomaly', note: 'Aucun dépôt manuel correspondant à ce crédit.' };
      if (t.status !== 'succeeded') return { status: 'anomaly', note: `Le dépôt lié est en statut « ${t.status} » mais le wallet a été crédité.` };
      return near(t.credited_usd, amt) ? { status: 'ok', note: `Dépôt ${t.method} de ${t.amount_usd || ''} $ confirmé` } : { status: 'anomaly', note: `Montant crédité (${amt} $) différent du dépôt (${t.credited_usd} $).` };
    }
    case 'deposit_auto': {
      const t = src.topupByRef.get(ref);
      if (!t || t.merchant_id !== e.merchant_id) return { status: 'anomaly', note: 'Aucun rechargement MonCash / Natcash correspondant à ce crédit.' };
      if (t.status !== 'succeeded') return { status: 'anomaly', note: `Le rechargement lié est en statut « ${t.status} » mais le wallet a été crédité.` };
      return near(t.credited_usd, amt) ? { status: 'ok', note: `${t.method} : ${t.amount_htg} HTG confirmés par le partenaire` } : { status: 'anomaly', note: `Montant crédité (${amt} $) différent du rechargement (${t.credited_usd} $).` };
    }
    case 'admin_credit': {
      const adminId = ref.slice('admin-credit:'.length);
      const hit = src.adminCredits.find((a) => a.merchant_id === e.merchant_id && a.admin_id === adminId && near(a.amount, amt));
      return hit ? { status: 'ok', note: `Crédit manuel inscrit au journal admin${hit.note ? ` : ${hit.note}` : ''}` } : { status: 'anomaly', note: "Crédit « admin » sans trace dans le journal des crédits manuels." };
    }
    case 'crypto_convert': {
      const t = src.cryptoById.get(ref.slice('crypto-convert:'.length));
      if (!t || t.merchant_id !== e.merchant_id || t.type !== 'convert') return { status: 'anomaly', note: 'Aucune conversion crypto correspondante.' };
      if (t.status !== 'completed') return { status: 'anomaly', note: `La conversion liée est en statut « ${t.status} ».` };
      return near(t.usd_credited, amt) ? { status: 'ok', note: `${t.amount} ${t.coin} convertis` } : { status: 'anomaly', note: `Montant crédité (${amt} $) différent de la conversion (${t.usd_credited} $).` };
    }
    case 'refund': {
      const orig = ref.replace(/^(refund|fund-refund|debit-rollback):(debit-rollback:)?/, '');
      return debitRefs.has(orig) || debitRefs.has(ref.replace(/^[a-z-]+:/, '')) ? { status: 'ok', note: 'Remboursement d\'un débit existant' } : { status: 'warning', note: "Remboursement dont le débit d'origine n'a pas été retrouvé." };
    }
    case 'card_withdraw':
    case 'card_close_refund':
      return e.related_id && src.cardIds.has(e.related_id) && src.cardMerchant.get(e.related_id) === e.merchant_id ? { status: 'ok', note: 'Argent revenu d\'une carte de ce marchand' } : { status: 'anomaly', note: "Crédit « carte » mais la carte n'appartient pas à ce marchand." };
    default:
      return { status: 'anomaly', note: "Origine inconnue : ce crédit ne correspond à aucune source connue." };
  }
}

/** Every movement of one wallet of one merchant, with its cause, a running balance and (Master Wallet) the backing check. */
async function ledgerFor(merchantId, { wallet = 'master_wallet', mode = 'live', currency, limit = 100, offset = 0, sources } = {}) {
  if (!WALLETS[wallet]) wallet = 'master_wallet';
  const cur = currency || WALLETS[wallet];
  const key = ledger.walletKey(wallet, mode === 'live' ? 'live' : 'sandbox');
  const entries = await selectAll('ledger_entries', { merchant_id: merchantId, wallet: key, currency: cur }, 'created_at.asc,id.asc');
  const src = wallet === 'master_wallet' ? (sources || await loadSources(merchantId)) : null;
  const debitRefs = new Set(entries.filter((e) => Number(e.amount) < 0).map((e) => String(e.reference || '')));
  const seen = new Set();
  let running = 0;
  const all = entries.map((e) => {
    const x = explain(e, wallet);
    running = round2(running + Number(e.amount));
    let verdict = { status: 'ok' };
    if (src && Number(e.amount) > 0) verdict = verifyCredit(e, x.category, src, debitRefs, seen);
    return {
      id: e.id, at: e.created_at, amount: round2(e.amount), currency: e.currency, reference: e.reference, related_id: e.related_id,
      category: x.category, label: x.label, effect: x.effect, status: verdict.status, note: verdict.note || null, balance_after: running,
    };
  });
  const cats = {};
  for (const e of all) {
    const k = `${e.effect}:${e.category}`;
    const b = cats[k] || (cats[k] = { category: e.category, label: e.label, effect: e.effect, count: 0, total: 0, anomalies: 0 });
    b.count += 1; b.total = round2(b.total + e.amount); if (e.status === 'anomaly') b.anomalies += 1;
  }
  const list = Object.values(cats);
  const up = list.filter((c) => c.effect === 'up').sort((a, b) => b.total - a.total);
  const down = list.filter((c) => c.effect === 'down').sort((a, b) => a.total - b.total);
  const rpc = await ledger.getBalance(merchantId, wallet, cur, mode === 'live' ? 'live' : 'sandbox');
  return {
    wallet, mode: mode === 'live' ? 'live' : 'sandbox', currency: cur,
    balance: round2(rpc), computed_balance: running, matches: near(rpc, running),
    total_up: round2(up.reduce((t, c) => t + c.total, 0)), total_down: round2(down.reduce((t, c) => t + c.total, 0)),
    up, down, anomalies: all.filter((e) => e.status === 'anomaly').length, warnings: all.filter((e) => e.status === 'warning').length,
    total_entries: all.length, entries: all.slice().reverse().slice(offset, offset + limit),
  };
}

/** Across every merchant: the Master Wallet credits that have no real source (or that appear twice). */
async function masterWalletAnomalies(mode) {
  const key = ledger.walletKey('master_wallet', mode === 'live' ? 'live' : 'sandbox');
  const [entries, src, merchants] = await Promise.all([
    selectAll('ledger_entries', { wallet: key, currency: 'USD' }, 'created_at.asc,id.asc'),
    loadSources(null),
    supabase.select('merchants', {}, { limit: 5000 }),
  ]);
  const names = new Map(merchants.map((m) => [m.id, m.business_name || m.email]));
  const debitRefsBy = new Map();
  for (const e of entries) if (Number(e.amount) < 0) { const s = debitRefsBy.get(e.merchant_id) || new Set(); s.add(String(e.reference || '')); debitRefsBy.set(e.merchant_id, s); }
  const seen = new Set();
  const flagged = [];
  let credits = 0;
  for (const e of entries) {
    if (Number(e.amount) <= 0) continue;
    credits += 1;
    const x = explain(e, 'master_wallet');
    const v = verifyCredit(e, x.category, src, debitRefsBy.get(e.merchant_id) || new Set(), seen);
    if (v.status === 'anomaly') flagged.push({ id: e.id, at: e.created_at, merchant_id: e.merchant_id, merchant_name: names.get(e.merchant_id) || e.merchant_id, amount: round2(e.amount), reference: e.reference, label: x.label, note: v.note });
  }
  return { mode: mode === 'live' ? 'live' : 'sandbox', credits_checked: credits, anomalies: flagged.length, total_usd: round2(flagged.reduce((t, f) => t + f.amount, 0)), flagged: flagged.reverse().slice(0, 300) };
}

/**
 * Merchants whose Master Wallet is under their guarantee deposit (50 $ unless the team changed it), and WHAT took them there: the movement that
 * first crossed the floor, and the latest debits. Computed from the ledger with the guarantee as it is now.
 */
async function belowFloor(mode) {
  const guarantee = require('./guarantee');
  const key = ledger.walletKey('master_wallet', mode === 'live' ? 'live' : 'sandbox');
  const [entries, merchants] = await Promise.all([
    selectAll('ledger_entries', { wallet: key, currency: 'USD' }, 'created_at.asc,id.asc'),
    supabase.select('merchants', {}, { limit: 5000 }),
  ]);
  const names = new Map(merchants.map((m) => [m.id, m]));
  const byMerchant = new Map();
  for (const e of entries) { const l = byMerchant.get(e.merchant_id) || []; l.push(e); byMerchant.set(e.merchant_id, l); }
  const out = [];
  for (const [merchantId, list] of byMerchant) {
    const m = names.get(merchantId);
    if (!m || m.deleted_at) continue;
    const floor = await guarantee.get(merchantId);
    let balance = 0;
    let crossing = null;
    for (const e of list) {
      const before = balance;
      balance = round2(balance + Number(e.amount));
      if (before >= floor && balance < floor) crossing = e;       // went from OK to under
      else if (balance >= floor) crossing = null;                   // back above: the earlier crossing no longer matters
    }
    if (balance >= floor || balance <= 0 && list.length === 0) continue;
    const x = crossing ? explain(crossing, 'master_wallet') : null;
    out.push({
      merchant_id: merchantId, merchant_name: m.business_name || m.email, email: m.email, balance, guarantee: floor, below_by: round2(floor - balance),
      crossed_at: crossing ? crossing.created_at : null,
      cause: crossing ? { label: x.label, amount: round2(crossing.amount), reference: crossing.reference } : { label: 'Jamais atteint : le solde est resté sous le dépôt de garantie depuis le début', amount: null, reference: null },
      last_debits: list.filter((e) => Number(e.amount) < 0).slice(-4).reverse().map((e) => ({ at: e.created_at, amount: round2(e.amount), label: explain(e, 'master_wallet').label, reference: e.reference })),
    });
  }
  out.sort((a, b) => b.below_by - a.below_by);
  return { mode: mode === 'live' ? 'live' : 'sandbox', merchants_checked: byMerchant.size, below: out.length, list: out };
}

module.exports = { belowFloor, ledgerFor, masterWalletAnomalies, explain, WALLETS };
