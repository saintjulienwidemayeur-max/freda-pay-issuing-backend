'use strict';
const supabase = require('../lib/supabase');
const ledger = require('./ledger');
const config = require('../config');
const { isDeposit, isReturn } = require('../handlers/walletSummary');

const round2 = (n) => Math.round(n * 100) / 100;
const toUsd = (amount, currency) => (currency === 'USD' ? Number(amount) : Number(amount) / config.exchangeRateHtgPerUsd);
const dayOf = (d) => new Date(d).toISOString().slice(0, 10);
const COUNTED_CARD = new Set(['active', 'disabled', 'terminated']);
const KNOWN_COST = { card_creation: 'cardCreation', card_recharge: 'cardRecharge', card_withdrawal: 'cardWithdrawal' };

function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return `${date.getUTCFullYear()}-W${String(Math.ceil(((date - yearStart) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}

/**
 * Fee events that REALLY happened, in USD, with what the partner charged us on each.
 * A card-creation fee only counts if that card exists (older versions logged it before the provider answered, so a
 * refused creation left a phantom fee behind: those rows are ignored here whatever is still in the table).
 */
function normalizeRevenue(rows, cardsById) {
  const out = [];
  for (const r of rows) {
    if (r.kind === 'card_creation') {
      const card = cardsById.get(r.related_id);
      if (!card || !COUNTED_CARD.has(card.status)) continue;
    }
    const revenue = toUsd(r.amount, r.currency);
    const cost = r.partner_cost_usd != null
      ? Number(r.partner_cost_usd)
      : (KNOWN_COST[r.kind] ? config.issuingProviderCostsUSD[KNOWN_COST[r.kind]] : 0); // older rows: the known price list
    out.push({ at: r.created_at, kind: r.kind, merchant_id: r.merchant_id, revenue_usd: revenue, partner_cost_usd: cost });
  }
  return out;
}

function summarizeRevenue(norm) {
  const byKind = {}; const costByKind = {}; const days = {}; const weeks = {};
  let revenue = 0; let cost = 0;
  const add = (bucket, key, r) => {
    const b = bucket[key] || (bucket[key] = { revenue_usd: 0, partner_cost_usd: 0 });
    b.revenue_usd += r.revenue_usd; b.partner_cost_usd += r.partner_cost_usd;
  };
  for (const r of norm) {
    revenue += r.revenue_usd; cost += r.partner_cost_usd;
    byKind[r.kind] = (byKind[r.kind] || 0) + r.revenue_usd;
    costByKind[r.kind] = (costByKind[r.kind] || 0) + r.partner_cost_usd;
    add(days, dayOf(r.at), r); add(weeks, isoWeekKey(new Date(r.at)), r);
  }
  const shape = ([key, b]) => ({ revenue_usd: round2(b.revenue_usd), partner_cost_usd: round2(b.partner_cost_usd), profit_usd: round2(b.revenue_usd - b.partner_cost_usd), key });
  return {
    total_revenue_usd: round2(revenue),
    total_partner_cost_usd: round2(cost),
    total_profit_usd: round2(revenue - cost),
    by_kind_usd: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, round2(v)])),
    partner_cost_by_kind_usd: Object.fromEntries(Object.entries(costByKind).map(([k, v]) => [k, round2(v)])),
    by_day: Object.entries(days).sort().slice(-14).map((e) => ({ date: e[0], ...shape(e) })).map(({ key, ...x }) => x),
    by_week: Object.entries(weeks).sort().slice(-8).map((e) => ({ week: e[0], ...shape(e) })).map(({ key, ...x }) => x),
    gateway_cost_configured: !!config.gatewayProviderCost.configured,
  };
}

/**
 * What the cards spent online, from the partner's notifications. A two-step purchase can arrive as an
 * AUTHORIZATION and then an AUTHORIZATION-SETTLEMENT for the same amount: the settlement is matched to the
 * authorization it completes, so one purchase counts once. Refunds and reversals reduce the total; declines and
 * cross-border markers are counted separately and never as spending.
 */
function summarizeCardSpend(rows) {
  const sorted = rows.slice().sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
  const open = new Map();
  const days = {};
  let spend = 0; let refunded = 0; let purchases = 0; let declines = 0;
  const bump = (d, v) => { days[d] = (days[d] || 0) + v; };
  for (const t of sorted) {
    const amount = Number(t.amount_usd || 0);
    const key = `${t.card_id}|${amount}`;
    if (t.type === 'DECLINE') { declines += 1; continue; }
    if (/FAIL|DECLIN|REJECT|ERROR/.test(t.status || '')) continue;
    if (t.type === 'AUTHORIZATION' && t.direction !== 'CREDIT') {
      open.set(key, (open.get(key) || 0) + 1);
      spend += amount; purchases += 1; bump(dayOf(t.occurred_at), amount);
    } else if (t.type === 'AUTHORIZATION-SETTLEMENT' && t.direction !== 'CREDIT') {
      if ((open.get(key) || 0) > 0) { open.set(key, open.get(key) - 1); continue; } // completes an authorization already counted
      spend += amount; purchases += 1; bump(dayOf(t.occurred_at), amount);
    } else if (t.type === 'REVERSAL' || t.type === 'REFUND') {
      refunded += amount; bump(dayOf(t.occurred_at), -amount);
    }
  }
  return { total_usd: round2(spend - refunded), purchases, refunded_usd: round2(refunded), declines, by_day: Object.fromEntries(Object.entries(days).map(([d, v]) => [d, round2(v)])) };
}

async function cardsFor(filters) {
  const cards = await supabase.select('cards', filters, { limit: 5000 });
  return { cards, byId: new Map(cards.map((c) => [c.id, c])) };
}

/** Everything about ONE merchant in one environment. */
async function merchantStats(merchantId, mode) {
  const walletKey = ledger.walletKey('master_wallet', mode);
  const [{ cards, byId }, feeRows, txRows, payments, payouts, walletEntries, gatewayBalance] = await Promise.all([
    cardsFor({ merchant_id: merchantId, mode }),
    supabase.select('fee_revenue', { merchant_id: merchantId, mode }, { limit: 5000 }),
    supabase.select('card_transactions', { merchant_id: merchantId, mode }, { limit: 5000 }),
    supabase.select('payments', { merchant_id: merchantId, mode, status: 'succeeded' }, { limit: 5000 }),
    supabase.select('payouts', { merchant_id: merchantId, mode, status: 'success' }, { limit: 5000 }),
    supabase.select('ledger_entries', { merchant_id: merchantId, wallet: walletKey }, { limit: 5000 }),
    ledger.getBalance(merchantId, 'gateway', 'HTG', mode),
  ]);
  const sum = (rows, f) => rows.reduce((t, r) => t + Number(f(r) || 0), 0);
  const count = (s) => cards.filter((c) => c.status === s).length;
  const spend = summarizeCardSpend(txRows);
  return {
    mode,
    cards: {
      issued: cards.filter((c) => COUNTED_CARD.has(c.status)).length,
      active: count('active'), disabled: count('disabled'), terminated: count('terminated'), failed: count('failed'), pending: count('pending'),
      reserved_usd: round2(sum(cards.filter((c) => c.status === 'active'), (c) => c.balance)),
    },
    wallet: {
      deposited_usd: round2(sum(walletEntries.filter(isDeposit), (e) => e.amount)),
      // Net: money that left the wallet minus what came back (a refused card creation is debited then refunded: it nets to zero).
      spent_usd: round2(sum(walletEntries.filter((e) => e.type === 'wallet_debit'), (e) => Math.abs(e.amount)) - sum(walletEntries.filter(isReturn), (e) => e.amount)),
    },
    card_spend: { total_usd: spend.total_usd, purchases: spend.purchases, refunded_usd: spend.refunded_usd, declines: spend.declines },
    gateway: {
      collected_htg: round2(sum(payments, (p) => p.amount)),
      fees_htg: round2(sum(payments, (p) => p.fee)),
      withdrawn_htg: round2(sum(payouts, (p) => p.amount)),
      balance_htg: gatewayBalance,
    },
    revenue: { ...summarizeRevenue(normalizeRevenue(feeRows, byId)) },
    card_spend_by_day: spend.by_day,
  };
}

/** The whole platform in one environment: profit and partner costs per day, card spending, and where Gateway money sits. */
async function platformStats(mode, days = 14) {
  const [merchants, { cards, byId }, feeRows, txRows, payments, payouts] = await Promise.all([
    supabase.select('merchants', {}, { limit: 1000 }),
    cardsFor({ mode }),
    supabase.select('fee_revenue', { mode }, { limit: 20000 }),
    supabase.select('card_transactions', { mode }, { limit: 20000 }),
    supabase.select('payments', { mode, status: 'succeeded' }, { limit: 20000 }),
    supabase.select('payouts', { mode, status: 'success' }, { limit: 20000 }),
  ]);
  const norm = normalizeRevenue(feeRows, byId);
  const spend = summarizeCardSpend(txRows);
  const sum = (rows, f) => rows.reduce((t, r) => t + Number(f(r) || 0), 0);

  const dayKeys = [];
  for (let i = 0; i < days; i += 1) dayKeys.push(dayOf(Date.now() - i * 86400000)); // newest first, UTC
  const collectedByDay = {};
  for (const p of payments) collectedByDay[dayOf(p.created_at)] = (collectedByDay[dayOf(p.created_at)] || 0) + Number(p.amount || 0);
  const revByDay = {};
  for (const r of norm) {
    const k = dayOf(r.at);
    const b = revByDay[k] || (revByDay[k] = { revenue_usd: 0, partner_cost_usd: 0 });
    b.revenue_usd += r.revenue_usd; b.partner_cost_usd += r.partner_cost_usd;
  }
  const row = (date) => {
    const b = revByDay[date] || { revenue_usd: 0, partner_cost_usd: 0 };
    return {
      date,
      revenue_usd: round2(b.revenue_usd), partner_cost_usd: round2(b.partner_cost_usd), profit_usd: round2(b.revenue_usd - b.partner_cost_usd),
      card_spend_usd: round2(spend.by_day[date] || 0), gateway_collected_htg: round2(collectedByDay[date] || 0),
    };
  };
  const by_day = dayKeys.map(row);
  const windowSum = (f) => round2(by_day.reduce((t, d) => t + d[f], 0));
  const all = summarizeRevenue(norm);

  // Where the Gateway money sits: one line per business that has any activity or balance.
  const names = new Map(merchants.map((m) => [m.id, m]));
  const ids = new Set([...payments.map((p) => p.merchant_id), ...payouts.map((p) => p.merchant_id)]);
  const balances = await Promise.all([...ids].map((id) => ledger.getBalance(id, 'gateway', 'HTG', mode)));
  const gateway_by_merchant = [...ids].map((id, i) => {
    const mine = payments.filter((p) => p.merchant_id === id);
    return {
      merchant_id: id,
      business_name: names.get(id) ? names.get(id).business_name : id,
      balance_htg: round2(balances[i]),
      collected_htg: round2(sum(mine, (p) => p.amount)),
      fees_htg: round2(sum(mine, (p) => p.fee)),
      withdrawn_htg: round2(sum(payouts.filter((p) => p.merchant_id === id), (p) => p.amount)),
    };
  }).sort((a, b) => b.balance_htg - a.balance_htg);

  return {
    mode,
    window_days: days,
    today: by_day[0],
    window: {
      revenue_usd: windowSum('revenue_usd'), partner_cost_usd: windowSum('partner_cost_usd'), profit_usd: windowSum('profit_usd'),
      card_spend_usd: windowSum('card_spend_usd'), gateway_collected_htg: windowSum('gateway_collected_htg'),
    },
    all_time: { revenue_usd: all.total_revenue_usd, partner_cost_usd: all.total_partner_cost_usd, profit_usd: all.total_profit_usd, card_spend_usd: spend.total_usd },
    partner_cost_by_kind_usd: all.partner_cost_by_kind_usd,
    by_day,
    cards: {
      issued: cards.filter((c) => COUNTED_CARD.has(c.status)).length,
      active: cards.filter((c) => c.status === 'active').length,
      reserved_usd: round2(sum(cards.filter((c) => c.status === 'active'), (c) => c.balance)),
    },
    card_spend: { total_usd: spend.total_usd, purchases: spend.purchases, declines: spend.declines },
    gateway: {
      balance_htg: round2(gateway_by_merchant.reduce((t, g) => t + g.balance_htg, 0)),
      collected_htg: round2(sum(payments, (p) => p.amount)),
      fees_htg: round2(sum(payments, (p) => p.fee)),
      withdrawn_htg: round2(sum(payouts, (p) => p.amount)),
      partner_cost_configured: !!config.gatewayProviderCost.configured,
      partner_cost_pct: config.gatewayProviderCost.pct,
    },
    gateway_by_merchant,
  };
}

module.exports = { merchantStats, platformStats, normalizeRevenue, summarizeRevenue, summarizeCardSpend };
