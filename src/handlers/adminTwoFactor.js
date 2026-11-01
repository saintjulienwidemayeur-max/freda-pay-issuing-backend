'use strict';
const supabase = require('../lib/supabase');
const twoFactor = require('../services/twoFactor');
const notify = require('../services/notify');

/** Admin: who has activated 2FA, a reminder to everyone who has not, and a reset for someone locked out. */
function summarize(users) {
  const enabled = users.filter((u) => u.enabled).length;
  return { total: users.length, enabled, missing: users.length - enabled };
}

async function overview() {
  const { available, users } = await twoFactor.overview();
  return { status: 200, body: { available, ...summarize(users), users } };
}

/** POST /admin/security/2fa/remind { only?: [ids] } : emails everyone (owners and team members) who has not activated 2FA. */
async function remind(ctx) {
  const { available, users } = await twoFactor.overview();
  if (!available) return { status: 409, body: { error: { code: 'TWOFA_UNAVAILABLE', message: "Exécutez d'abord la migration 2026-11-05-user-2fa.sql." } } };
  const only = Array.isArray(ctx.body && ctx.body.only) ? new Set(ctx.body.only.map(String)) : null;
  const todo = users.filter((u) => !u.enabled && (!only || only.has(u.id)));
  let sent = 0;
  const failed = [];
  for (const u of todo) {
    try {
      await notify.twoFactorReminder({ id: u.merchant_id, email: u.email, business_name: u.merchant_name }, { role: u.role });
      await twoFactor.markReminded({ type: u.type, id: u.id, merchantId: u.merchant_id });
      sent += 1;
    } catch (e) {
      failed.push({ email: u.email, error: e.message });
    }
  }
  return { status: 200, body: { sent, failed, skipped_already_enabled: users.length - todo.length } };
}

/** POST /admin/security/2fa/reset { type, id } : the person lost the phone and the recovery codes; they enrol again at next login. */
async function reset(ctx) {
  const { type, id } = ctx.body || {};
  const user = (await twoFactor.overview()).users.find((u) => u.type === type && u.id === id);
  if (!user) { const e = new Error('Utilisateur introuvable.'); e.httpStatus = 404; e.code = 'NOT_FOUND'; throw e; }
  await twoFactor.reset({ type, id });
  return { status: 200, body: { reset: true, email: user.email } };
}

module.exports = { overview, remind, reset };
