'use strict';
const supabase = require('../lib/supabase');

/**
 * The banner shown at the top of every merchant dashboard (platform_settings "dashboard_notice"), switched on/off and worded by an admin.
 * Default: "physical cards coming soon". (The old default, a maintenance notice, is replaced wherever it was still the saved text.)
 */
const KEY = 'dashboard_notice';
const MAINTENANCE_MESSAGE = 'Maintenance en cours : nous améliorons la plateforme. Toutes les opérations (paiements, retraits, cartes, wallet) continuent de fonctionner normalement.';
const DEFAULT = {
  enabled: true,
  tone: 'info',
  message: 'Cartes physiques : bientôt disponibles sur Freda Pay Issuing. Restez connecté, nous vous préviendrons dès l\'ouverture.',
};
let cache = null; let at = 0;

async function get() {
  if (cache && Date.now() - at < 30 * 1000) return cache;
  let saved = {};
  try { const row = await supabase.selectOne('platform_settings', { key: KEY }); if (row) saved = JSON.parse(row.value) || {}; } catch (e) { /* default */ }
  if (saved.message === MAINTENANCE_MESSAGE) delete saved.message; // the retired maintenance banner never comes back by itself
  cache = Object.assign({}, DEFAULT, saved); at = Date.now();
  return cache;
}

async function save(patch, adminEmail) {
  const next = Object.assign({}, await get());
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.message !== undefined) next.message = String(patch.message || '').trim().slice(0, 400) || DEFAULT.message;
  if (patch.tone !== undefined) next.tone = ['info', 'warning'].includes(patch.tone) ? patch.tone : 'info';
  const row = { value: JSON.stringify(next), updated_by: adminEmail || null, updated_at: new Date().toISOString() };
  if (await supabase.selectOne('platform_settings', { key: KEY })) await supabase.update('platform_settings', { key: KEY }, row);
  else await supabase.insert('platform_settings', Object.assign({ key: KEY }, row));
  cache = next; at = Date.now();
  return next;
}

module.exports = { get, save, DEFAULT };
