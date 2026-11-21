'use strict';
const supabase = require('../lib/supabase');

/**
 * GET /admin/holders?status=&program=&mode=&q=&limit= : the card holders of every merchant, with what the merchant sees (confirmed, pending,
 * refused) AND where each stands with the new card program (accepted, refused, pending, not sent) with the issuer's own reason.
 * status: enrolled | pending | failed.   program: accepted | refused | pending | none.
 */
async function list(ctx) {
  const q = ctx.query || {};
  const filters = {};
  if (['enrolled', 'pending', 'failed'].includes(q.status)) filters.status = q.status;
  if (q.mode === 'live' || q.mode === 'sandbox') filters.mode = q.mode;
  const limit = Math.min(1000, Math.max(20, parseInt(q.limit || '300', 10) || 300));
  const rows = await supabase.select('maplerad_customers', filters, { order: 'created_at.desc', limit: 5000 });
  const programOf = (h) => {
    const st = h.monerails_status;
    if (!h.monerails_cardholder_id && !st) return 'none';
    if (st === 'verified') return 'accepted';
    if (st === 'rejected' || st === 'failed') return 'refused';
    return 'pending';
  };
  const ids = [...new Set(rows.map((h) => h.merchant_id))];
  const merchants = ids.length ? await supabase.select('merchants', { id: supabase.inList(ids) }, { limit: 5000 }) : [];
  const by = new Map(merchants.map((m) => [m.id, m]));
  const needle = String(q.q || '').trim().toLowerCase().slice(0, 80);
  let list = rows.map((h) => {
    const m = by.get(h.merchant_id) || {};
    return {
      id: h.id, merchant_id: h.merchant_id, merchant_name: m.business_name || null, merchant_email: m.email || null,
      mode: h.mode || 'sandbox', status: h.status, failure_reason: h.failure_reason || null,
      first_name: h.first_name, last_name: h.last_name, email: h.email, country: h.country, dob: h.dob || null, created_at: h.created_at,
      program: programOf(h), program_reason: h.monerails_reason || null,
    };
  });
  const counts = { all: 0, enrolled: 0, pending: 0, failed: 0, program_accepted: 0, program_refused: 0, program_pending: 0 };
  if (needle) list = list.filter((h) => `${h.first_name || ''} ${h.last_name || ''} ${h.email || ''} ${h.id} ${h.merchant_name || ''} ${h.merchant_email || ''} ${h.merchant_id}`.toLowerCase().includes(needle));
  for (const h of list) { counts.all += 1; if (counts[h.status] != null) counts[h.status] += 1; if (h.program !== 'none') counts[`program_${h.program}`] += 1; }
  if (['accepted', 'refused', 'pending', 'none'].includes(q.program)) list = list.filter((h) => h.program === q.program);
  return { status: 200, body: { counts, total: list.length, holders: list.slice(0, limit) } };
}

module.exports = { list };
