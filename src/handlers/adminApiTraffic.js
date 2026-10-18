'use strict';
const supabase = require('../lib/supabase');
const apiTraffic = require('../services/apiTraffic');
const { API_RATE_LIMIT } = require('../router');

/** Who is calling the public API right now, and how many requests per second (last five minutes, this instance). */
async function snapshot() {
  const snap = apiTraffic.snapshot();
  const ids = snap.merchants.map((m) => m.merchant_id);
  const names = {};
  if (ids.length) {
    const rows = await supabase.select('merchants', { id: supabase.inList(ids) }, { select: 'id,business_name,email', limit: 200 });
    for (const r of rows) names[r.id] = r;
  }
  return {
    status: 200,
    body: Object.assign(snap, {
      limit_per_minute: API_RATE_LIMIT,
      merchants: snap.merchants.map((m) => Object.assign({}, m, {
        business_name: (names[m.merchant_id] && names[m.merchant_id].business_name) || null,
        email: (names[m.merchant_id] && names[m.merchant_id].email) || null,
        pct_of_limit: Math.round((m.req_60s / API_RATE_LIMIT) * 100),
      })),
    }),
  };
}

module.exports = { snapshot };
