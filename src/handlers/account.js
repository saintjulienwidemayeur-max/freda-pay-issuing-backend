'use strict';
const supabase = require('../lib/supabase');
const { publicMerchant } = require('./auth');
const { hashPassword, verifyPassword } = require('../utils/password');
const rateLimit = require('../utils/rateLimit');

/**
 * Updates business info. Notably supports converting an 'individual' account
 * to 'business' (e.g. once the person decides to register their business) -
 * this is a one-way upgrade; converting business -> individual is not exposed,
 * since it would let a business dodge KYB after being verified.
 */
async function update(ctx) {
  const { business_name, entity_type, account_type, phone } = ctx.body || {};
  const current = await supabase.selectOne('merchants', { id: ctx.merchantId });
  if (!current) throw httpError(404, 'NOT_FOUND', 'Marchand introuvable.');

  const patch = {};
  if (business_name) patch.business_name = business_name;
  if (phone) patch.phone = phone;

  if (account_type === 'business' && current.account_type === 'individual') {
    patch.account_type = 'business';
    if (entity_type) patch.entity_type = entity_type;
    // KYB status resets to not_started since this is now a business account
    // and hasn't gone through business verification yet.
    patch.kyb_status = 'not_started';
  } else if (entity_type && current.account_type === 'business') {
    patch.entity_type = entity_type;
  }

  if (Object.keys(patch).length === 0) {
    return { status: 200, body: { merchant: publicMerchant(current) } };
  }

  const [updated] = await supabase.update('merchants', { id: ctx.merchantId }, patch);
  return { status: 200, body: { merchant: publicMerchant(updated) } };
}

/** Changes the signed-in person's own password (owner, admin or viewer). */
async function changePassword(ctx) {
  const { current_password, new_password } = ctx.body || {};
  if (!current_password || !new_password) throw httpError(400, 'MISSING_FIELDS', 'Entrez votre mot de passe actuel et le nouveau.');
  if (String(new_password).length < 8) throw httpError(400, 'WEAK_PASSWORD', 'Le nouveau mot de passe doit contenir au moins 8 caractères.');

  const who = `pwd-change:${ctx.merchantId}:${ctx.userId || 'owner'}`;
  if (rateLimit.isLimited(who, 5).limited) throw httpError(429, 'RATE_LIMITED', 'Trop de tentatives. Réessayez dans quelques minutes.');

  const isMember = ctx.role && ctx.role !== 'owner';
  const row = isMember
    ? await supabase.selectOne('team_members', { id: ctx.userId })
    : await supabase.selectOne('merchants', { id: ctx.merchantId });
  if (!row || !verifyPassword(current_password, row.password_hash)) {
    rateLimit.hit(who, 5, 15 * 60 * 1000);
    throw httpError(400, 'WRONG_PASSWORD', 'Le mot de passe actuel est incorrect.');
  }
  if (verifyPassword(new_password, row.password_hash)) throw httpError(400, 'SAME_PASSWORD', 'Choisissez un mot de passe différent de l\'actuel.');

  await supabase.update(isMember ? 'team_members' : 'merchants', { id: row.id }, { password_hash: hashPassword(new_password) });
  rateLimit.reset(who);
  return { status: 200, body: { updated: true } };
}

/**
 * Switches which mode the dashboard currently shows/writes to. Live is only
 * reachable once Gateway Live is actually enabled (by KYC/KYB approval);
 * switching back to Sandbox is always allowed, any time, even once Live -
 * this is a view toggle, not a one-way account upgrade.
 */
async function setMode(ctx) {
  const mode = ctx.body && ctx.body.mode;
  if (mode !== 'sandbox' && mode !== 'live') throw httpError(400, 'INVALID_MODE', "mode doit être 'sandbox' ou 'live'.");
  const merchant = await supabase.selectOne('merchants', { id: ctx.merchantId });
  if (!merchant) throw httpError(404, 'NOT_FOUND', 'Marchand introuvable.');
  if (mode === 'live' && !merchant.gateway_live_enabled) {
    throw httpError(403, 'GATEWAY_NOT_LIVE', "Le mode Live n'est pas encore activé sur ce compte. Complétez la vérification KYC/KYB.");
  }
  const [updated] = await supabase.update('merchants', { id: ctx.merchantId }, { active_mode: mode });
  return { status: 200, body: { active_mode: updated.active_mode } };
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { update, changePassword, setMode };
