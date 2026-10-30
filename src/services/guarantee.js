'use strict';
const config = require('../config');
const supabase = require('../lib/supabase');

/**
 * The guarantee deposit of a merchant: the part of the Master Wallet that always stays locked (never spendable on cards, recharges
 * or plans). The platform default is config.masterWallet.minimumBalanceUsd (50 $); the team can raise or lower it for one merchant.
 * The custom amount lives in platform_settings under "guarantee_usd:<merchantId>" (no new table), read with a short cache.
 */
const CACHE_MS = 20 * 1000;
const cache = new Map(); // merchantId -> { value, at }
const keyOf = (merchantId) => `guarantee_usd:${merchantId}`;
const MAX_USD = 10000;

async function get(merchantId) {
  const hit = cache.get(merchantId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let value = config.masterWallet.minimumBalanceUsd;
  try {
    const row = await supabase.selectOne('platform_settings', { key: keyOf(merchantId) });
    const v = row && row.value != null && String(row.value).trim() !== '' ? Number(row.value) : NaN; // an empty value is not a 0 $ guarantee
    if (Number.isFinite(v) && v >= 0 && v <= MAX_USD) value = v;
  } catch (err) { /* the table is unreachable: the default applies */ }
  cache.set(merchantId, { value, at: Date.now() });
  return value;
}

/** Saves the new amount (the caller validated it). Returns { previous, value }. */
async function set(merchantId, value, adminId) {
  const previous = await get(merchantId);
  const key = keyOf(merchantId);
  const patch = { value: String(value), updated_by: adminId || null, updated_at: new Date().toISOString() };
  const existing = await supabase.selectOne('platform_settings', { key });
  if (existing) await supabase.update('platform_settings', { key }, patch);
  else await supabase.insert('platform_settings', Object.assign({ key }, patch));
  cache.set(merchantId, { value, at: Date.now() });
  return { previous, value };
}

function clearCache() { cache.clear(); }

/** From this balance down the merchant gets low-balance reminders: the guarantee plus the usual margin (100 $ by default). */
function alertLevelFor(guaranteeUsd) {
  return guaranteeUsd + Math.max(0, config.masterWallet.alertBalanceUsd - config.masterWallet.minimumBalanceUsd);
}

module.exports = { get, set, clearCache, alertLevelFor, MAX_USD };
