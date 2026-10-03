'use strict';
const supabase = require('../lib/supabase');
const { randomHex } = require('../utils/ids');

/** Records one fee-charging event. Fire-and-forget from the caller's perspective is fine to await - this is cheap and matters for accurate reporting. */
async function log(merchantId, kind, amount, currency, relatedId, mode) {
  if (!amount) return; // a zero fee (e.g. a free-plan merchant) isn't worth a row
  return supabase.insert('fee_revenue', {
    id: `fee_${randomHex(8)}`,
    merchant_id: merchantId,
    kind,
    amount,
    currency,
    related_id: relatedId || null,
    mode: mode === 'live' ? 'live' : 'sandbox',
  });
}

module.exports = { log };
