'use strict';
const supabase = require('../lib/supabase');
const jwt = require('../utils/jwt');
const config = require('../config');
const { verifyPassword, hashPassword } = require('../utils/password');
const rateLimit = require('../utils/rateLimit');
const loginOtp = require('../services/loginOtp');

const LOGIN_FAIL_LIMIT = 8;
const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;

function issueAdminSession(adminId) {
  return jwt.sign({ adminId }, config.sessionSecret + ':admin', 60 * 60 * 24 * 3); // 3 days - shorter than merchant sessions
}

function publicAdmin(a) {
  return { id: a.id, email: a.email, name: a.name, role: a.role };
}

async function login(ctx) {
  const { email, password } = ctx.body || {};
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !password) {
    throw httpError(400, 'MISSING_FIELDS', 'Email et mot de passe requis.');
  }

  const lockKey = `admin-login:${normalizedEmail}`;
  const limited = rateLimit.isLimited(lockKey, LOGIN_FAIL_LIMIT);
  if (limited.limited) {
    throw httpError(429, 'TOO_MANY_ATTEMPTS', `Trop de tentatives. Réessayez dans ${Math.ceil(limited.retryAfterMs / 60000)} minute(s).`);
  }

  const admin = await supabase.selectOne('admin_users', { email: normalizedEmail });
  if (!admin || !verifyPassword(password, admin.password_hash)) {
    rateLimit.hit(lockKey, LOGIN_FAIL_LIMIT, LOGIN_FAIL_WINDOW_MS);
    throw httpError(401, 'INVALID_CREDENTIALS', 'Email ou mot de passe incorrect.');
  }

  rateLimit.reset(lockKey);
  if (admin.status === 'invited') throw httpError(403, 'INVITE_PENDING', "Activez d'abord votre accès avec le lien d'invitation reçu par email.");
  // Same rule as merchants: a verified password alone never opens the panel.
  const challenge = await loginOtp.create({ subjectType: 'admin', subjectId: admin.id, email: admin.email });
  return { status: 200, body: { otp_required: true, ...challenge } };
}

async function verifyLogin(ctx) {
  const { challenge_id, code } = ctx.body || {};
  const row = await loginOtp.verify(challenge_id, code);
  const admin = row.subject_type === 'admin' ? await supabase.selectOne('admin_users', { id: row.subject_id }) : null;
  if (!admin) throw httpError(401, 'INVALID_CREDENTIALS', "Ce compte administrateur n'existe plus.");
  return { status: 200, body: { admin: publicAdmin(admin), session_token: issueAdminSession(admin.id) } };
}

async function resendLoginOtp(ctx) {
  const challenge = await loginOtp.resend(ctx.body && ctx.body.challenge_id);
  return { status: 200, body: { otp_required: true, ...challenge } };
}

async function me(ctx) {
  return { status: 200, body: { admin: publicAdmin(ctx.admin) } };
}

/** Change the signed-in admin's own password. */
async function changePassword(ctx) {
  const { current_password, new_password } = ctx.body || {};
  if (!current_password || !new_password) throw httpError(400, 'MISSING_FIELDS', 'Mot de passe actuel et nouveau requis.');
  if (String(new_password).length < 8) throw httpError(400, 'WEAK_PASSWORD', 'Le nouveau mot de passe doit contenir au moins 8 caractères.');
  if (!verifyPassword(current_password, ctx.admin.password_hash)) {
    throw httpError(400, 'WRONG_PASSWORD', 'Le mot de passe actuel est incorrect.');
  }
  await supabase.update('admin_users', { id: ctx.adminId }, { password_hash: hashPassword(new_password) });
  return { status: 200, body: { updated: true } };
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { login, verifyLogin, resendLoginOtp, me, changePassword, publicAdmin, issueAdminSession };
