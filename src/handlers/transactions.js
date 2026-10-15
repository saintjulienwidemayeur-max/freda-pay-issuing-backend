'use strict';
const supabase = require('../lib/supabase');
const { resolveMode } = require('../utils/mode');

const round2 = (n) => Math.round(n * 100) / 100;
const monthKey = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/** Totals for one set of succeeded payments, per currency (HTG and USD are never added together). */
function totals(rows, feeRows) {
  const out = { HTG: { volume: 0, count: 0, fees: 0, net: 0 }, USD: { volume: 0, count: 0, fees: 0, net: 0 } };
  for (const p of rows) {
    const c = out[p.currency === 'USD' ? 'USD' : 'HTG'];
    c.volume += Number(p.amount || 0);
    c.count += 1;
    c.fees += Number(p.fee || 0);
    c.net += Number(p.net_amount || 0);
  }
  for (const k of ['HTG', 'USD']) {
    const c = out[k];
    c.volume = round2(c.volume); c.fees = round2(c.fees); c.net = round2(c.net);
    c.average = c.count ? round2(c.volume / c.count) : 0;
  }
  return out;
}

/**
 * GET /dashboard/transactions/summary
 * The four counters of the Transactions page (total / succeeded / in progress / failed) and the "Performance du mois"
 * figures: this month against last month, per currency, with a per-day series. Only the mode the merchant is in.
 */
async function summary(ctx) {
  const mode = await resolveMode(ctx);
  const payments = await supabase.select('payments', { merchant_id: ctx.merchantId, mode }, { order: 'created_at.desc', limit: 5000 });

  const counts = { total: payments.length, succeeded: 0, pending: 0, failed: 0 };
  for (const p of payments) counts[p.status] = (counts[p.status] || 0) + 1;

  const now = new Date();
  const thisKey = monthKey(now);
  const prevKey = monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
  const inMonth = (p, key) => monthKey(new Date(p.created_at)) === key;
  const thisMonth = payments.filter((p) => inMonth(p, thisKey));
  const prevMonth = payments.filter((p) => inMonth(p, prevKey));

  const succeeded = (rows) => rows.filter((p) => p.status === 'succeeded');
  const attempts = thisMonth.length;
  const ok = succeeded(thisMonth).length;

  const days = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const byDay = Array.from({ length: days }, (_, i) => ({ day: i + 1, HTG: 0, USD: 0 }));
  for (const p of succeeded(thisMonth)) byDay[new Date(p.created_at).getUTCDate() - 1][p.currency === 'USD' ? 'USD' : 'HTG'] += Number(p.amount || 0);
  byDay.forEach((d) => { d.HTG = round2(d.HTG); d.USD = round2(d.USD); });

  const byMethod = {};
  for (const p of succeeded(thisMonth)) {
    const k = p.method;
    byMethod[k] = byMethod[k] || { method: k, currency: p.currency, count: 0, volume: 0 };
    byMethod[k].count += 1;
    byMethod[k].volume = round2(byMethod[k].volume + Number(p.amount || 0));
  }

  return {
    status: 200,
    body: {
      mode,
      counts,
      month: {
        key: thisKey,
        previous_key: prevKey,
        attempts,
        success_rate: attempts ? Math.round((ok / attempts) * 1000) / 10 : null, // percent, one decimal
        current: totals(succeeded(thisMonth)),
        previous: totals(succeeded(prevMonth)),
        by_day: byDay,
        by_method: Object.values(byMethod).sort((a, b) => b.count - a.count),
      },
    },
  };
}

module.exports = { summary };
