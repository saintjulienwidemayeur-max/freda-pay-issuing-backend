'use strict';
const crypto = require('crypto');
const config = require('../config');
const supabase = require('../lib/supabase');
const brevo = require('./brevo');
const otp = require('../utils/otp');
const rateLimit = require('../utils/rateLimit');
const { buildEmail } = require('../templates/notificationEmail');
const { randomHex } = require('../utils/ids');

/**
 * Email code at EVERY login (merchant owners, team members, admin staff).
 * Correct credentials never yield a session by themselves: they yield a
 * short-lived challenge, and the session is only issued once the emailed code
 * is entered. No "remember this device".
 */

const SEND_LIMIT = 5; // codes per account per window, so nobody can be email-bombed
const SEND_WINDOW_MS = 15 * 60 * 1000;

/** Salted with the challenge id and a server secret, so a leaked table can't be reversed in one pass. */
function hashFor(challengeId, code) {
  return crypto.createHmac('sha256', config.sessionSecret).update(`${challengeId}:${String(code)}`).digest('hex');
}

function maskEmail(email) {
  const [user, domain] = String(email).split('@');
  if (!domain) return '***';
  return `${user.slice(0, 2)}${'*'.repeat(Math.max(1, user.length - 2))}@${domain}`;
}

async function create({ subjectType, subjectId, merchantId, role, email }) {
  const sendKey = `login-otp-send:${subjectType}:${subjectId}`;
  if (rateLimit.hit(sendKey, SEND_LIMIT, SEND_WINDOW_MS).limited) {
    throw httpError(429, 'OTP_SEND_LIMIT', 'Trop de codes demandés. Réessayez dans quelques minutes.');
  }

  // Only the newest code is ever valid.
  await supabase.update('login_challenges', { subject_type: subjectType, subject_id: subjectId, consumed_at: 'is.null' }, { consumed_at: new Date().toISOString() });

  const id = `lch_${randomHex(12)}`;
  const code = otp.generateCode(config.otp.codeLength);
  await supabase.insert('login_challenges', {
    id,
    subject_type: subjectType,
    subject_id: subjectId,
    merchant_id: merchantId || null,
    role: role || null,
    email,
    code_hash: hashFor(id, code),
    expires_at: new Date(Date.now() + config.otp.expiryMinutes * 60 * 1000).toISOString(),
    attempts: 0,
  });

  const built = buildEmail({
    subject: `${code} : Votre code de connexion Freda Pay`,
    eyebrow: 'Connexion',
    heading: 'Confirmez votre connexion',
    paragraphs: [
      'Bonjour,',
      `Utilisez le code ci-dessous pour terminer votre connexion. Il expire dans **${config.otp.expiryMinutes} minutes**.`,
    ],
    code,
    notice: "Freda Pay ne vous demandera jamais ce code par téléphone, WhatsApp ou email. Si vous n'êtes pas à l'origine de cette connexion, ignorez ce message et changez votre mot de passe.",
  });
  // Make the plain-text alternative carry the code in a stable, greppable form.
  built.text = `Confirmez votre connexion\n\nVotre code de connexion : ${code}\n\nIl expire dans ${config.otp.expiryMinutes} minutes. Si vous n'êtes pas à l'origine de cette connexion, ignorez ce message et changez votre mot de passe.`;

  try {
    await brevo.sendEmail({ to: email, toName: email, subject: built.subject, html: built.html, text: built.text });
  } catch (err) {
    await supabase.update('login_challenges', { id }, { consumed_at: new Date().toISOString() });
    throw httpError(502, 'OTP_EMAIL_FAILED', "Impossible d'envoyer le code de connexion pour le moment. Réessayez dans un instant.");
  }
  return { challenge_id: id, email_hint: maskEmail(email), expires_in_minutes: config.otp.expiryMinutes };
}

/** Checks the code. One-time: a correct code consumes the challenge. Returns the challenge row (who is logging in). */
async function verify(challengeId, code) {
  if (!challengeId || !code) throw httpError(400, 'MISSING_FIELDS', 'challenge_id et code sont requis.');
  const row = await supabase.selectOne('login_challenges', { id: String(challengeId) });
  if (!row || row.consumed_at) throw httpError(400, 'LOGIN_CHALLENGE_INVALID', 'Cette demande de connexion est invalide ou déjà utilisée. Reconnectez-vous.');
  if (new Date(row.expires_at).getTime() < Date.now()) throw httpError(400, 'OTP_EXPIRED', 'Ce code a expiré. Demandez-en un nouveau.');
  if (row.attempts >= config.otp.maxAttempts) throw httpError(429, 'OTP_LOCKED', 'Trop de tentatives incorrectes. Demandez un nouveau code.');

  const expected = Buffer.from(hashFor(row.id, String(code).trim()));
  const stored = Buffer.from(String(row.code_hash));
  const ok = expected.length === stored.length && crypto.timingSafeEqual(expected, stored);
  if (!ok) {
    await supabase.update('login_challenges', { id: row.id }, { attempts: row.attempts + 1 });
    const remaining = config.otp.maxAttempts - (row.attempts + 1);
    throw httpError(400, 'OTP_INCORRECT', remaining > 0 ? `Code incorrect. ${remaining} tentative${remaining > 1 ? 's' : ''} restante${remaining > 1 ? 's' : ''}.` : 'Code incorrect. Demandez un nouveau code.');
  }

  // Atomic claim: if two requests race with the right code, only one wins.
  const claimed = await supabase.update('login_challenges', { id: row.id, consumed_at: 'is.null' }, { consumed_at: new Date().toISOString() });
  if (!claimed || !claimed.length) throw httpError(400, 'LOGIN_CHALLENGE_INVALID', 'Cette demande de connexion est invalide ou déjà utilisée. Reconnectez-vous.');
  return row;
}

/** New code for the same login attempt, with a cooldown. */
async function resend(challengeId) {
  const row = challengeId ? await supabase.selectOne('login_challenges', { id: String(challengeId) }) : null;
  if (!row || row.consumed_at) throw httpError(400, 'LOGIN_CHALLENGE_INVALID', 'Cette demande de connexion est invalide ou déjà utilisée. Reconnectez-vous.');
  // Keyed by the ACCOUNT, not the challenge: every resend creates a new challenge id, so a per-challenge key would never block anything.
  if (rateLimit.hit(`login-otp-resend:${row.subject_type}:${row.subject_id}`, 1, config.otp.resendCooldownSeconds * 1000).limited) {
    throw httpError(429, 'OTP_RESEND_COOLDOWN', `Patientez ${config.otp.resendCooldownSeconds} secondes avant de redemander un code.`);
  }
  return create({ subjectType: row.subject_type, subjectId: row.subject_id, merchantId: row.merchant_id, role: row.role, email: row.email });
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { create, verify, resend, maskEmail };
