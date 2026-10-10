'use strict';
const supabase = require('../lib/supabase');
const { resolveMode } = require('../utils/mode');

/**
 * This merchant's own Gateway summary: total money in, total fees paid, and
 * a day/week breakdown, computed from their own fee_revenue + payments rows.
 */
async function summary(ctx) {
  const mode = await resolveMode(ctx); // sandbox and live totals are never mixed
  const [feeRows, payments] = await Promise.all([
    supabase.select('fee_revenue', { merchant_id: ctx.merchantId, kind: 'gateway_payment', mode }, { order: 'created_at.desc', limit: 2000 }),
    supabase.select('payments', { merchant_id: ctx.merchantId, status: 'succeeded', mode }, { order: 'created_at.desc', limit: 2000 }),
  ]);

  const totalGrossHtg = payments.reduce((s, p) => s + Number(p.amount || 0), 0);
  const totalFeesHtg = feeRows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const round2 = (n) => Math.round(n * 100) / 100;

  const dayBuckets = {};
  const weekBuckets = {};
  for (const p of payments) {
    const d = new Date(p.created_at);
    const dayKey = d.toISOString().slice(0, 10);
    dayBuckets[dayKey] = (dayBuckets[dayKey] || 0) + Number(p.amount || 0);
    const weekKey = isoWeekKey(d);
    weekBuckets[weekKey] = (weekBuckets[weekKey] || 0) + Number(p.amount || 0);
  }

  return {
    status: 200,
    body: {
      total_in_htg: round2(totalGrossHtg),
      total_fees_htg: round2(totalFeesHtg),
      total_net_htg: round2(totalGrossHtg - totalFeesHtg),
      by_day: Object.entries(dayBuckets).sort().slice(-14).map(([date, htg]) => ({ date, htg: round2(htg) })),
      by_week: Object.entries(weekBuckets).sort().slice(-8).map(([week, htg]) => ({ week, htg: round2(htg) })),
    },
  };
}

function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

module.exports = { summary };
