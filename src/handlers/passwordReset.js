'use strict';
const crypto = require('crypto');
const config = require('../config');
const siteUrl = require('../services/siteUrl');
const supabase = require('../lib/supabase');
const rateLimit = require('../utils/rateLimit');
const notify = require('../services/notify');
const session = require('../middleware/session');
const { randomHex } = require('../utils/ids');
const { hashPassword } = require('../utils/password');
const { maskEmail } = require('../services/loginOtp');

const RESET_MINUTES = 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');

/** Who owns this email and may reset it: a verified, non-suspended account owner, else an active team member. */
async function findSubject(email) {
  const owner = await supabase.selectOne('merchants', { email });
  if (owner && owner.email_verified && !owner.deleted_at) {
    return { type: 'merchant', id: owner.id, email: owner.email, name: owner.business_name };
  }
  const member = await supabase.selectOne('team_members', { email });
  if (member && member.status === 'active') {
    const account = await supabase.selectOne('merchants', { id: member.merchant_id });
    if (account && !account.deleted_at) return { type: 'member', id: member.id, email: member.email, name: account.business_name };
  }
  return null;
}

/**
 * Always answers the same thing, whether or not the address has an account: the page must never reveal
 * which emails are registered. The email only goes out when there really is an account to reset.
 */
async function forgot(ctx) {
  const email = String((ctx.body && ctx.body.email) || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw httpError(400, 'INVALID_EMAIL', 'Entrez une adresse email valide.');

  // A third party cannot flood someone's inbox with reset mails.
  if (rateLimit.hit(`forgot:${email}`, 3, 60 * 60 * 1000).limited) return { status: 200, body: { sent: true } };

  const subject = await findSubject(email);
  if (subject) {
    // Only the newest link works.
    await supabase.update('password_resets', { subject_type: subject.type, subject_id: subject.id, used_at: 'is.null' }, { used_at: new Date().toISOString() });
    const token = crypto.randomBytes(32).toString('hex');
    await supabase.insert('password_resets', {
      id: `prr_${randomHex(10)}`,
      subject_type: subject.type,
      subject_id: subject.id,
      email: subject.email,
      token_hash: sha256(token),
      expires_at: new Date(Date.now() + RESET_MINUTES * 60 * 1000).toISOString(),
    });
    const sent = await notify.passwordReset(subject.email, subject.name, `${siteUrl.get()}/signup?reset=${token}`, RESET_MINUTES);
    // eslint-disable-next-line no-console
    if (!sent) console.error(`Password-reset email for ${subject.type} ${subject.id} could NOT be sent (mail provider error).`);
  }
  return { status: 200, body: { sent: true } };
}

async function findValid(token) {
  if (!token || typeof token !== 'string' || token.length < 32) return null;
  const row = await supabase.selectOne('password_resets', { token_hash: sha256(token) });
  if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

/** Lets the page decide between "choose a new password" and "this link is no longer valid". */
async function info(ctx) {
  const row = await findValid(ctx.query && ctx.query.token);
  if (!row) throw httpError(400, 'RESET_LINK_INVALID', "Ce lien est invalide ou a expiré. Demandez-en un nouveau.");
  return { status: 200, body: { email_hint: maskEmail(row.email) } };
}

async function reset(ctx) {
  const { token, password } = ctx.body || {};
  if (!password || String(password).length < 8) throw httpError(400, 'WEAK_PASSWORD', 'Le mot de passe doit contenir au moins 8 caractères.');
  const row = await findValid(token);
  if (!row) throw httpError(400, 'RESET_LINK_INVALID', "Ce lien est invalide ou a expiré. Demandez-en un nouveau.");

  // Claim first: a link can be used exactly once, even if two requests race.
  const claimed = await supabase.update('password_resets', { id: row.id, used_at: 'is.null' }, { used_at: new Date().toISOString() });
  if (!claimed || !claimed.length) throw httpError(400, 'RESET_LINK_INVALID', "Ce lien est invalide ou a expiré. Demandez-en un nouveau.");

  const table = row.subject_type === 'member' ? 'team_members' : 'merchants';
  const subject = await supabase.selectOne(table, { id: row.subject_id });
  if (!subject) throw httpError(400, 'RESET_LINK_INVALID', 'Ce compte est introuvable.');

  await supabase.update(table, { id: row.subject_id }, {
    password_hash: hashPassword(password),
    sessions_valid_after: new Date().toISOString(), // every session opened before now stops working
  });
  if (row.subject_type === 'member') session.forgetMember(row.subject_id); else session.forgetMerchant(row.subject_id);

  const account = row.subject_type === 'member' ? await supabase.selectOne('merchants', { id: subject.merchant_id }) : subject;
  await notify.passwordChanged(row.email, account && account.business_name);
  return { status: 200, body: { reset: true } };
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { forgot, info, reset };
