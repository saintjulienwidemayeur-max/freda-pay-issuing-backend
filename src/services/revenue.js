'use strict';
const supabase = require('../lib/supabase');
const { randomHex } = require('../utils/ids');

/** Records one fee-charging event. Fire-and-forget from the caller's perspective is fine to await - this is cheap and matters for accurate reporting. */
async function log(merchantId, kind, amount, currency, relatedId, mode, partnerCostUsd) {
  // A zero fee with no partner cost (e.g. a free-plan merchant) isn't worth a row; a cost with no fee is (we still paid it).
  if (!amount && !partnerCostUsd) return;
  return supabase.insert('fee_revenue', {
    id: `fee_${randomHex(8)}`,
    merchant_id: merchantId,
    kind,
    amount,
    currency,
    related_id: relatedId || null,
    mode: mode === 'live' ? 'live' : 'sandbox',
    partner_cost_usd: partnerCostUsd == null ? null : Math.round(Number(partnerCostUsd) * 100) / 100,
  });
}

module.exports = { log };
