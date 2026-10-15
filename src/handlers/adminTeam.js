'use strict';
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const brevo = require('../services/brevo');
const config = require('../config');
const siteUrl = require('../services/siteUrl');

/** The admin panel reports its own address; only a plain https page address is accepted (no query, no credentials). */
function cleanPanelUrl(value) {
  try {
    const u = new URL(String(value || ''));
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    return `${u.origin}${u.pathname}`;
  } catch (e) { return null; }
}
const { randomHex } = require('../utils/ids');
const { hashPassword } = require('../utils/password');
const { teamInviteEmail } = require('../templates/teamInviteEmail');
const { issueAdminSession, publicAdmin } = require('./adminAuth');

const ROLES = ['owner', 'admin', 'editor'];
const INVITE_DAYS = 7;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function toPublic(a) {
  return { id: a.id, email: a.email, name: a.name, role: a.role, status: a.status, created_at: a.created_at };
}

async function list(ctx) {
  const rows = await supabase.select('admin_users', {}, { order: 'created_at.asc' });
  return { status: 200, body: { admins: rows.map(toPublic) } };
}

async function sendAdminInvite(admin, panelUrl) {
  const token = crypto.randomBytes(32).toString('hex');
  await supabase.update('admin_users', { id: admin.id }, {
    invite_token_hash: sha256(token),
    invite_expires_at: new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  });
  // The panel is not on the public site: use the address the inviting admin is actually on, else ADMIN_URL.
  const base = panelUrl || (config.adminUrl ? `${config.adminUrl}/admin.html` : `${siteUrl.get()}/admin.html`);
  const link = `${base}?invite=${token}`;
  const { subject, html, text } = teamInviteEmail({ businessName: 'Freda Pay (équipe admin)', role: admin.role, link, expiryDays: INVITE_DAYS });
  await brevo.sendEmail({ to: admin.email, toName: admin.name, subject, html, text });
}

async function invite(ctx) {
  const email = String((ctx.body && ctx.body.email) || '').trim().toLowerCase();
  const name = String((ctx.body && ctx.body.name) || '').trim();
  const role = ctx.body && ctx.body.role;
  if (!EMAIL_RE.test(email)) throw httpError(400, 'INVALID_EMAIL', 'Entrez une adresse email valide.');
  if (!name) throw httpError(400, 'MISSING_FIELDS', 'Le nom est requis.');
  if (!ROLES.includes(role)) throw httpError(400, 'INVALID_ROLE', 'Rôle invalide.');

  const existing = await supabase.selectOne('admin_users', { email });
  if (existing) throw httpError(409, 'EMAIL_TAKEN', 'Cette adresse email est déjà utilisée.');

  const admin = await supabase.insert('admin_users', {
    id: `adm_${randomHex(8)}`,
    email, name, role, status: 'invited', password_hash: null,
  });

  try {
    await sendAdminInvite(admin, cleanPanelUrl(ctx.body && ctx.body.panel_url));
  } catch (err) {
    await supabase.delete('admin_users', { id: admin.id });
    throw httpError(502, 'INVITE_NOT_SENT', "L'invitation n'a pas pu être envoyée. Réessayez dans un instant.");
  }
  return { status: 201, body: { admin: toPublic(admin) } };
}

async function resend(ctx) {
  const admin = await supabase.selectOne('admin_users', { id: ctx.params.id });
  if (!admin) throw httpError(404, 'NOT_FOUND', 'Administrateur introuvable.');
  if (admin.status !== 'invited') throw httpError(409, 'ALREADY_ACTIVE', 'Ce compte a déjà été activé.');
  try {
    await sendAdminInvite(admin, cleanPanelUrl(ctx.body && ctx.body.panel_url));
  } catch (err) {
    throw httpError(502, 'INVITE_NOT_SENT', "L'invitation n'a pas pu être envoyée. Réessayez dans un instant.");
  }
  return { status: 200, body: { sent: true } };
}

async function remove(ctx) {
  const admin = await supabase.selectOne('admin_users', { id: ctx.params.id });
  if (!admin) throw httpError(404, 'NOT_FOUND', 'Administrateur introuvable.');
  if (admin.id === ctx.adminId) throw httpError(400, 'CANNOT_REMOVE_SELF', 'Vous ne pouvez pas retirer votre propre accès.');
  await supabase.delete('admin_users', { id: admin.id });
  require('../middleware/adminSession').forgetAdmin(admin.id);
  return { status: 200, body: { removed: true } };
}

/** Public: info shown on the "create your password" page before the invitee submits. */
async function inviteInfo(ctx) {
  const admin = await findValidInvite(ctx.query && ctx.query.token);
  return { status: 200, body: { email: admin.email, name: admin.name, role: admin.role } };
}

/** Public: the invited admin sets a password, activating the account and signing them in. */
async function acceptInvite(ctx) {
  const { token, password } = ctx.body || {};
  if (!password || String(password).length < 8) {
    throw httpError(400, 'WEAK_PASSWORD', 'Le mot de passe doit contenir au moins 8 caractères.');
  }
  const admin = await findValidInvite(token);
  const [updated] = await supabase.update('admin_users', { id: admin.id }, {
    status: 'active',
    password_hash: hashPassword(password),
    invite_token_hash: null,
    invite_expires_at: null,
  });
  return { status: 200, body: { admin: publicAdmin(updated), session_token: issueAdminSession(updated.id) } };
}

async function findValidInvite(token) {
  if (!token || typeof token !== 'string') throw httpError(400, 'INVALID_INVITE', 'Ce lien d\'invitation est invalide.');
  const admin = await supabase.selectOne('admin_users', { invite_token_hash: sha256(token), status: 'invited' });
  if (!admin) throw httpError(400, 'INVALID_INVITE', "Ce lien d'invitation est invalide ou a déjà été utilisé.");
  if (admin.invite_expires_at && new Date(admin.invite_expires_at).getTime() < Date.now()) {
    throw httpError(400, 'INVITE_EXPIRED', "Ce lien d'invitation a expiré. Demandez-en un nouveau au propriétaire.");
  }
  return admin;
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { list, invite, resend, remove, inviteInfo, acceptInvite };
