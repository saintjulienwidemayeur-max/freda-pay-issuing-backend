'use strict';
const supabase = require('../lib/supabase');
const { buildActivity } = require('./walletSummary');

/**
 * GET /admin/activity?mode=live&category=cartes&merchant_id=&q=&limit=300 : every movement of every merchant (the same list as the merchants'
 * "Activité" in their dashboard), newest first, each line with WHO did it and, for cards, which partner holds the card.
 * category: encaissements | paiements | cartes | wallet. q: part of a business name, email, merchant id or the line's text.
 */
async function list(ctx) {
  const q = ctx.query || {};
  const mode = q.mode === 'sandbox' ? 'sandbox' : 'live';
  const limit = Math.min(1000, Math.max(20, parseInt(q.limit || '300', 10) || 300));
  const category = ['encaissements', 'paiements', 'cartes', 'wallet'].includes(q.category) ? q.category : null;
  const merchantId = /^mch_[A-Za-z0-9_]+$/.test(String(q.merchant_id || '')) ? q.merchant_id : null;
  const needle = String(q.q || '').trim().toLowerCase().slice(0, 80);
  // The newest lines of each source are enough to fill the list; asked wider when a filter is active.
  const items = await buildActivity({ merchantId, mode, limit: (category || needle) ? Math.min(2000, limit * 4) : limit });
  const merchants = await supabase.select('merchants', {}, { limit: 20000 });
  const by = new Map(merchants.map((m) => [m.id, m]));
  let rows = items.map((i) => { const m = by.get(i.merchant_id) || {}; return { ...i, merchant_name: m.business_name || null, merchant_email: m.email || null }; });
  const counts = { all: 0, encaissements: 0, paiements: 0, cartes: 0, wallet: 0 };
  if (needle) rows = rows.filter((r) => `${r.merchant_name || ''} ${r.merchant_email || ''} ${r.merchant_id || ''} ${r.title || ''} ${r.detail || ''}`.toLowerCase().includes(needle));
  for (const r of rows) { counts.all += 1; counts[r.category] += 1; }
  if (category) rows = rows.filter((r) => r.category === category);
  return { status: 200, body: { mode, counts, items: rows.slice(0, limit) } };
}

module.exports = { list };
