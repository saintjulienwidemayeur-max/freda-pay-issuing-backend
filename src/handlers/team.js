'use strict';
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const brevo = require('../services/brevo');
const config = require('../config');
const { randomHex } = require('../utils/ids');
const { hashPassword } = require('../utils/password');
const { teamInviteEmail } = require('../templates/teamInviteEmail');
const { publicMerchant, issueSession } = require('./auth');
const session = require('../middleware/session');

const ROLES = ['admin', 'viewer'];
const INVITE_DAYS = 7;
const MAX_MEMBERS = 20;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function toPublic(m) {
  return { id: m.id, email: m.email, role: m.role, status: m.status, created_at: m.created_at };
}

async function list(ctx) {
  const owner = await supabase.selectOne('merchants', { id: ctx.merchantId });
  const members = await supabase.select('team_members', { merchant_id: ctx.merchantId }, { order: 'created_at.asc' });
  return { status: 200, body: { owner: { email: owner.email }, members: members.map(toPublic) } };
}

async function sendInvite(member, businessName) {
  const token = crypto.randomBytes(32).toString('hex');
  await supabase.update('team_members', { id: member.id }, {
    invite_token_hash: sha256(token),
    invite_expires_at: new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  });
  const link = `${config.siteUrl}/freda-pay-signup.html?invite=${token}`;
  const { subject, html, text } = teamInviteEmail({ businessName, role: member.role, link, expiryDays: INVITE_DAYS });
  await brevo.sendEmail({ to: member.email, toName: member.email, subject, html, text });
}

async function invite(ctx) {
  const email = String((ctx.body && ctx.body.email) || '').trim().toLowerCase();
  const role = ctx.body && ctx.body.role;
  if (!EMAIL_RE.test(email)) throw httpError(400, 'INVALID_EMAIL', 'Entrez une adresse email valide.');
  if (!ROLES.includes(role)) throw httpError(400, 'INVALID_ROLE', 'Choisissez un rôle : Administrateur ou Lecture seule.');

  const [ownerWithEmail, memberWithEmail, existing] = await Promise.all([
    supabase.selectOne('merchants', { email }),
    supabase.selectOne('team_members', { email }),
    supabase.select('team_members', { merchant_id: ctx.merchantId }),
  ]);
  if (ownerWithEmail || memberWithEmail) throw httpError(409, 'EMAIL_TAKEN', 'Cette adresse email est déjà utilisée.');
  if (existing.length >= MAX_MEMBERS) throw httpError(400, 'TEAM_FULL', `Vous pouvez inviter ${MAX_MEMBERS} membres au maximum.`);

  const merchant = await supabase.selectOne('merchants', { id: ctx.merchantId });
  const member = await supabase.insert('team_members', {
    id: `usr_${randomHex(8)}`,
    merchant_id: ctx.merchantId,
    email,
    role,
    status: 'invited',
  });

  try {
    await sendInvite(member, merchant.business_name);
  } catch (err) {
    await supabase.delete('team_members', { id: member.id });
    throw httpError(502, 'INVITE_NOT_SENT', "L'invitation n'a pas pu être envoyée. Réessayez dans un instant.");
  }
  return { status: 201, body: { member: toPublic(member) } };
}

async function resend(ctx) {
  const member = await supabase.selectOne('team_members', { id: ctx.params.id, merchant_id: ctx.merchantId });
  if (!member) throw httpError(404, 'NOT_FOUND', 'Membre introuvable.');
  if (member.status !== 'invited') throw httpError(409, 'ALREADY_ACTIVE', 'Ce membre a déjà activé son accès.');
  const merchant = await supabase.selectOne('merchants', { id: ctx.merchantId });
  try {
    await sendInvite(member, merchant.business_name);
  } catch (err) {
    throw httpError(502, 'INVITE_NOT_SENT', "L'invitation n'a pas pu être envoyée. Réessayez dans un instant.");
  }
  return { status: 200, body: { sent: true } };
}

async function remove(ctx) {
  const member = await supabase.selectOne('team_members', { id: ctx.params.id, merchant_id: ctx.merchantId });
  if (!member) throw httpError(404, 'NOT_FOUND', 'Membre introuvable.');
  await supabase.delete('team_members', { id: member.id });
  session.forgetMember(member.id); // their open sessions stop working immediately
  return { status: 200, body: { removed: true } };
}

/** Public: what the "create your password" page shows before the invitee submits. */
async function inviteInfo(ctx) {
  const member = await findValidInvite(ctx.query && ctx.query.token);
  const merchant = await supabase.selectOne('merchants', { id: member.merchant_id });
  return { status: 200, body: { email: member.email, role: member.role, business_name: merchant.business_name } };
}

/** Public: the invitee sets a password, which activates the account and signs them in. */
async function acceptInvite(ctx) {
  const { token, password } = ctx.body || {};
  if (!password || String(password).length < 8) {
    throw httpError(400, 'WEAK_PASSWORD', 'Le mot de passe doit contenir au moins 8 caractères.');
  }
  const member = await findValidInvite(token);
  const [updated] = await supabase.update('team_members', { id: member.id }, {
    status: 'active',
    password_hash: hashPassword(password),
    invite_token_hash: null,
    invite_expires_at: null,
  });
  const merchant = await supabase.selectOne('merchants', { id: member.merchant_id });
  return {
    status: 200,
    body: { merchant: publicMerchant(merchant), session_token: issueSession(merchant.id, updated.role, updated.id), role: updated.role },
  };
}

async function findValidInvite(token) {
  if (!token || typeof token !== 'string') throw httpError(400, 'INVALID_INVITE', 'Ce lien d\'invitation est invalide.');
  const member = await supabase.selectOne('team_members', { invite_token_hash: sha256(token), status: 'invited' });
  if (!member) throw httpError(400, 'INVALID_INVITE', "Ce lien d'invitation est invalide ou a déjà été utilisé.");
  if (member.invite_expires_at && new Date(member.invite_expires_at).getTime() < Date.now()) {
    throw httpError(400, 'INVITE_EXPIRED', "Ce lien d'invitation a expiré. Demandez-en un nouveau au propriétaire du compte.");
  }
  return member;
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { list, invite, resend, remove, inviteInfo, acceptInvite };
