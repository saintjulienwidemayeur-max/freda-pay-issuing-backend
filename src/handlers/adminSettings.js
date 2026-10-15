'use strict';
const supabase = require('../lib/supabase');
const settings = require('../services/settings');
const { randomHex } = require('../utils/ids');

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

async function history() {
  const rows = await supabase.select('admin_audit_log', { action: 'exchange_rate_changed' }, { order: 'created_at.desc', limit: 10 });
  return rows.map((r) => ({ at: r.created_at, by: r.admin_email, from: r.details && r.details.from, to: r.details && r.details.to }));
}

/** GET /admin/settings/exchange-rate */
async function getExchangeRate() {
  return { status: 200, body: Object.assign(await settings.getRateInfo(), { history: await history() }) };
}

/**
 * PUT /admin/settings/exchange-rate  { rate, confirm_large_change? }
 * Applies at once to every conversion made from now on (payments already created keep the amount they were created with).
 */
async function setExchangeRate(ctx) {
  const raw = ctx.body && ctx.body.rate;
  const value = Math.round(Number(raw) * 100) / 100;
  if (raw === '' || raw == null || !Number.isFinite(value) || value < settings.MIN_RATE || value > settings.MAX_RATE) {
    throw httpError(400, 'INVALID_RATE', `Le taux doit être un nombre entre ${settings.MIN_RATE} et ${settings.MAX_RATE} (HTG pour 1 USD).`);
  }
  await settings.load();
  const current = settings.rate();
  if (value === current) return { status: 200, body: Object.assign(await settings.getRateInfo(), { changed: false, history: await history() }) };
  // A typo (1330 instead of 133) must not go through silently.
  if (Math.abs(value - current) / current > 0.3 && !(ctx.body && ctx.body.confirm_large_change === true)) {
    throw httpError(409, 'LARGE_CHANGE', `Ce taux diffère de plus de 30 % du taux actuel (${current}). Confirmez pour l'appliquer.`);
  }
  const email = (ctx.admin && ctx.admin.email) || null;
  const { previous } = await settings.setRate(value, email);
  try {
    await supabase.insert('admin_audit_log', {
      id: 'aud_' + randomHex(8), admin_id: ctx.adminId, admin_email: email, action: 'exchange_rate_changed',
      target_type: 'setting', target_id: 'exchange_rate_htg_per_usd', merchant_id: null, details: { from: previous, to: value },
    });
  } catch (_) { /* the change itself is saved; a missing log line must not undo it */ }
  return { status: 200, body: Object.assign(await settings.getRateInfo(), { changed: true, history: await history() }) };
}

module.exports = { getExchangeRate, setExchangeRate };
