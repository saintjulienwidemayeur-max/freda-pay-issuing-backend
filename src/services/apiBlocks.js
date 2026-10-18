'use strict';
const supabase = require('../lib/supabase');

/**
 * Admin-controlled blocks on a merchant's whole API access (every key). Kept in memory and refreshed from the database
 * every 30 s, so the hot path never waits on a query and a block applies at once on this instance.
 */
const blocks = new Map(); // merchantId -> { reason, until (ms|null), blocked_at, blocked_by }
let lastWarn = 0;

function warn(err) {
  if (Date.now() - lastWarn < 10 * 60 * 1000) return;
  lastWarn = Date.now();
  // eslint-disable-next-line no-console
  console.error('API blocks could not be read (is the api_blocks table created?):', err.message);
}

async function refresh() {
  try {
    const rows = await supabase.select('api_blocks', {}, { limit: 1000 });
    blocks.clear();
    for (const r of rows) blocks.set(r.merchant_id, { reason: r.reason || null, until: r.until ? new Date(r.until).getTime() : null, blocked_at: r.blocked_at, blocked_by: r.blocked_by || null });
  } catch (err) { warn(err); }
}

/** The active block of a merchant, or null (an expired one is ignored). */
function get(merchantId) {
  const b = blocks.get(merchantId);
  if (!b) return null;
  if (b.until && b.until <= Date.now()) { blocks.delete(merchantId); return null; }
  return b;
}

async function block({ merchantId, reason, hours, adminId }) {
  const until = hours ? new Date(Date.now() + hours * 3600 * 1000).toISOString() : null;
  const row = { merchant_id: merchantId, reason: reason || null, blocked_by: adminId || null, blocked_at: new Date().toISOString(), until };
  const existing = await supabase.selectOne('api_blocks', { merchant_id: merchantId });
  if (existing) await supabase.update('api_blocks', { merchant_id: merchantId }, row); else await supabase.insert('api_blocks', row);
  blocks.set(merchantId, { reason: row.reason, until: until ? new Date(until).getTime() : null, blocked_at: row.blocked_at, blocked_by: row.blocked_by });
  return row;
}

async function unblock(merchantId) {
  await supabase.delete('api_blocks', { merchant_id: merchantId });
  blocks.delete(merchantId);
}

function start() {
  refresh();
  const t = setInterval(refresh, 30 * 1000);
  if (t.unref) t.unref();
}

function listActive() {
  const now = Date.now();
  return [...blocks.entries()].filter(([, b]) => !b.until || b.until > now).map(([merchant_id, b]) => ({ merchant_id, reason: b.reason, until: b.until ? new Date(b.until).toISOString() : null, blocked_at: b.blocked_at, blocked_by: b.blocked_by }));
}

module.exports = { start, refresh, get, block, unblock, listActive };
