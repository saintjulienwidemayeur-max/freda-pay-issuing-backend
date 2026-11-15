'use strict';
const supabase = require('../../lib/supabase');
const ledger = require('../ledger');
const walletAudit = require('../walletAudit');

/** Platform-wide reads for the admin agent (never used by the merchant-scoped tools). Everything here only reads. */
const round2 = (n) => Math.round(Number(n) * 100) / 100;
async function selectAll(table, filters, order) {
  const all = [];
  for (let page = 0; page < 60; page += 1) {
    const rows = await supabase.select(table, filters, { order, limit: 1000, offset: page * 1000 });
    all.push(...rows);
    if (rows.length < 1000) break;
  }
  return all;
}

/** Balance of one wallet per merchant, summed from the ledger in one pass. */
async function balancesOf(wallet, currency, mode) {
  const rows = await selectAll('ledger_entries', { wallet: ledger.walletKey(wallet, mode), currency }, 'id.asc');
  const by = new Map();
  for (const e of rows) by.set(e.merchant_id, (by.get(e.merchant_id) || 0) + Number(e.amount));
  return by;
}

const SORTS = {
  master_wallet_usd: (m) => m.master_wallet_usd, gateway_htg: (m) => m.gateway_htg, created_at: (m) => new Date(m.created_at).getTime(),
  cards: (m) => m.cards, payments: (m) => m.payments_30d,
};

async function listMerchants({ sortBy = 'master_wallet_usd', order = 'desc', limit = 15, mode = 'live', kycStatus, search } = {}) {
  const [merchants, mw, gw, cards, payments] = await Promise.all([
    selectAll('merchants', {}, 'created_at.desc'),
    balancesOf('master_wallet', 'USD', mode), balancesOf('gateway', 'HTG', mode),
    supabase.select('cards', { mode }, { select: 'merchant_id,status', limit: 20000 }),
    supabase.select('payments', { mode, created_at: supabase.gt(new Date(Date.now() - 30 * 86400000).toISOString()) }, { select: 'merchant_id,status', limit: 20000 }),
  ]);
  const cardCount = new Map(); const payCount = new Map();
  for (const c of cards) if (['active', 'disabled'].includes(c.status)) cardCount.set(c.merchant_id, (cardCount.get(c.merchant_id) || 0) + 1);
  for (const p of payments) if (p.status === 'succeeded') payCount.set(p.merchant_id, (payCount.get(p.merchant_id) || 0) + 1);
  const q = String(search || '').toLowerCase().trim();
  let rows = merchants.filter((m) => !m.deleted_at).map((m) => ({
    id: m.id, business_name: m.business_name, email: m.email, type: m.account_type, kyc: m.kyc_status, kyb: m.kyb_status, live: !!m.gateway_live_enabled,
    master_wallet_usd: round2(mw.get(m.id) || 0), gateway_htg: round2(gw.get(m.id) || 0), cards: cardCount.get(m.id) || 0, payments_30d: payCount.get(m.id) || 0, created_at: m.created_at,
  }));
  if (kycStatus) rows = rows.filter((m) => m.kyc === kycStatus || m.kyb === kycStatus);
  if (q) rows = rows.filter((m) => [m.id, m.email, m.business_name].some((v) => v && String(v).toLowerCase().includes(q)));
  const key = SORTS[sortBy] || SORTS.master_wallet_usd;
  rows.sort((a, b) => (order === 'asc' ? key(a) - key(b) : key(b) - key(a)));
  const totals = { merchants: rows.length, master_wallet_usd: round2(rows.reduce((t, m) => t + m.master_wallet_usd, 0)), gateway_htg: round2(rows.reduce((t, m) => t + m.gateway_htg, 0)) };
  return { mode, sorted_by: sortBy, order, totals, merchants: rows.slice(0, Math.min(50, limit)) };
}

async function overview(mode) {
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const [merchants, payments, cards, subs, topups, disputes, payouts] = await Promise.all([
    selectAll('merchants', {}, 'created_at.desc'),
    supabase.select('payments', { mode, created_at: supabase.gt(since) }, { select: 'status,method,currency,amount', limit: 20000 }),
    supabase.select('cards', { mode }, { select: 'status', limit: 20000 }),
    supabase.select('verification_submissions', { status: 'submitted' }, { select: 'id', limit: 1000 }).catch(() => []),
    supabase.select('wallet_topups', { status: 'awaiting_review' }, { select: 'id', limit: 1000 }).catch(() => []),
    supabase.select('disputes', { status: 'open' }, { select: 'id', limit: 1000 }).catch(() => []),
    supabase.select('bank_payouts', { status: 'pending' }, { select: 'id', limit: 1000 }).catch(() => []),
  ]);
  const count = (rows, key) => rows.reduce((o, r) => { o[r[key]] = (o[r[key]] || 0) + 1; return o; }, {});
  const live = merchants.filter((m) => !m.deleted_at);
  return {
    mode, merchants: { total: live.length, live_enabled: live.filter((m) => m.gateway_live_enabled).length, issuing_live: live.filter((m) => m.issuing_live_enabled).length, kyc_not_started: live.filter((m) => m.kyc_status === 'not_started').length, kyc_submitted: live.filter((m) => m.kyc_status === 'submitted').length },
    payments_7d: { by_status: count(payments, 'status'), by_method: count(payments.filter((p) => p.status === 'succeeded'), 'method') },
    cards: count(cards, 'status'),
    waiting_for_the_team: { kyc_files: subs.length, manual_deposits: topups.length, open_disputes: disputes.length, bank_payouts: payouts.length },
  };
}

/**
 * Integrity checks of the platform's arithmetic. ok = true means nothing was found wrong; every check says what it looked at.
 * (Card balances are aligned with the card partner automatically: they are not re-read here.)
 */
async function checkCalculations(mode) {
  const checks = [];
  const add = (name, ok, detail, items) => checks.push({ name, ok, detail, ...(items && items.length ? { items: items.slice(0, 10) } : {}) });
  const m = mode === 'sandbox' ? 'sandbox' : 'live';

  const anomalies = await walletAudit.masterWalletAnomalies(m);
  add('Crédits du Master Wallet : chaque crédit a une vraie source (dépôt confirmé, journal admin, conversion crypto, remboursement), sans doublon', anomalies.anomalies === 0,
    `${anomalies.credits_checked} crédits vérifiés, ${anomalies.anomalies} sans source ou en double (${anomalies.total_usd} $)`, anomalies.flagged.map((f) => `${f.merchant_name} : ${f.amount} $ ${f.reference || ''} : ${f.note}`));

  const floor = await walletAudit.belowFloor(m);
  add('Master Wallets au-dessus du dépôt de garantie', floor.below === 0, `${floor.merchants_checked} marchands vérifiés, ${floor.below} sous leur dépôt de garantie`, floor.list.map((x) => `${x.merchant_name} : ${x.balance} $ (garantie ${x.guarantee} $), cause : ${x.cause.label}`));

  const [mw, gw, gwUsd] = await Promise.all([balancesOf('master_wallet', 'USD', m), balancesOf('gateway', 'HTG', m), balancesOf('gateway', 'USD', m)]);
  const negative = [];
  for (const [id, v] of mw) if (v < -0.005) negative.push(`${id} : Master Wallet ${round2(v)} $`);
  for (const [id, v] of gw) if (v < -0.005) negative.push(`${id} : Gateway ${round2(v)} HTG`);
  for (const [id, v] of gwUsd) if (v < -0.005) negative.push(`${id} : Gateway ${round2(v)} $`);
  add('Aucun solde négatif (Master Wallet, Gateway)', negative.length === 0, `${mw.size + gw.size + gwUsd.size} soldes vérifiés, ${negative.length} négatifs`, negative);

  // The fees written on succeeded payments against the fees recorded as revenue, last 30 days.
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const [pays, fees] = await Promise.all([
    supabase.select('payments', { mode: m, status: 'succeeded', created_at: supabase.gt(since) }, { select: 'id,fee,currency', limit: 20000 }),
    supabase.select('fee_revenue', { mode: m, kind: 'gateway_payment', created_at: supabase.gt(since) }, { select: 'amount,currency,related_id', limit: 20000 }),
  ]);
  const sumBy = (rows, f) => rows.reduce((o, r) => { const c = r.currency || 'HTG'; o[c] = round2((o[c] || 0) + Number(f(r) || 0)); return o; }, {});
  const payFees = sumBy(pays, (p) => p.fee); const revFees = sumBy(fees, (r) => r.amount);
  const diffs = [];
  for (const c of new Set([...Object.keys(payFees), ...Object.keys(revFees)])) { const d = round2((payFees[c] || 0) - (revFees[c] || 0)); if (Math.abs(d) > Math.max(1, (payFees[c] || 0) * 0.01)) diffs.push(`${c} : frais des paiements ${payFees[c] || 0} contre revenus enregistrés ${revFees[c] || 0} (écart ${d})`); }
  add('Frais des paiements réussis (30 jours) = revenus de frais enregistrés', diffs.length === 0, `${pays.length} paiements, ${fees.length} lignes de revenu`, diffs);

  return { mode: m, ok: checks.every((c) => c.ok), checks };
}

module.exports = { listMerchants, overview, checkCalculations, balancesOf, selectAll };
