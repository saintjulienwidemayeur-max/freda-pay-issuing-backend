'use strict';
const supabase = require('../lib/supabase');
const twoFactor = require('../services/twoFactor');
const auth = require('./auth');
const config = require('../config');

const httpError = twoFactor.httpError;

/** The logged-in person (owner or team member) as a 2FA subject. */
async function subjectOf(ctx) {
  if (ctx.role && ctx.role !== 'owner' && ctx.userId) {
    const m = await supabase.selectOne('team_members', { id: ctx.userId });
    return { type: 'member', id: ctx.userId, merchantId: ctx.merchantId, role: ctx.role, email: m && m.email };
  }
  const o = await supabase.selectOne('merchants', { id: ctx.merchantId });
  return { type: 'merchant', id: ctx.merchantId, merchantId: ctx.merchantId, role: 'owner', email: o && o.email };
}

const NOTE = "Ce site ne fonctionne qu'avec la 2FA, car les outils peuvent déplacer de l'argent. Votre code d'authentification est demandé à chaque connexion.";

// ---- Enrolment during login (after password + emailed code), using the short-lived setup token ----
async function loginSetup(ctx) {
  const sub = twoFactor.readToken(ctx.body && ctx.body.setup_token, 'setup');
  return { status: 200, body: await twoFactor.beginSetup(sub) };
}
async function loginEnable(ctx) {
  const sub = twoFactor.readToken(ctx.body && ctx.body.setup_token, 'setup');
  const { recovery_codes } = await twoFactor.enable(sub, ctx.body && ctx.body.code);
  const session = await auth.sessionFor({ subject_type: sub.type, subject_id: sub.id, merchant_id: sub.merchantId });
  return { status: 200, body: Object.assign({ two_factor: 'enabled', recovery_codes }, session) };
}

// ---- From the dashboard (someone already signed in, e.g. a session opened before 2FA became mandatory) ----
async function status(ctx) {
  const st = await twoFactor.status(await subjectOf(ctx));
  return { status: 200, body: { enabled: st.enabled, enabled_at: st.enabled_at, recovery_codes_left: st.recovery_codes_left, required: config.twoFactor.enforce, available: st.available, message: NOTE } };
}
async function setup(ctx) {
  return { status: 200, body: await twoFactor.beginSetup(await subjectOf(ctx)) };
}
async function enable(ctx) {
  const { recovery_codes } = await twoFactor.enable(await subjectOf(ctx), ctx.body && ctx.body.code);
  return { status: 200, body: { enabled: true, recovery_codes } };
}
async function newRecoveryCodes(ctx) {
  const sub = await subjectOf(ctx);
  await twoFactor.check(sub, ctx.body && ctx.body.code); // proves the phone is in hand
  return { status: 200, body: { recovery_codes: await twoFactor.regenerateRecovery(sub) } };
}

module.exports = { loginSetup, loginEnable, status, setup, enable, newRecoveryCodes, httpError };
