'use strict';
const config = require('../config');
const supabase = require('../lib/supabase');
const brevo = require('./brevo');
const otp = require('../utils/otp');
const { otpEmail } = require('../templates/otpEmail');
const { randomHex } = require('../utils/ids');

/** Generates a fresh OTP, stores its hash, and emails it. */
async function createAndSendOtp(merchant, purpose) {
  const code = otp.generateCode(config.otp.codeLength);
  const expiresAt = new Date(Date.now() + config.otp.expiryMinutes * 60 * 1000).toISOString();

  await supabase.insert('email_otps', {
    id: `otp_${randomHex(8)}`,
    merchant_id: merchant.id,
    code_hash: otp.hashCode(code),
    purpose: purpose || 'signup',
    expires_at: expiresAt,
    attempts: 0,
  });

  const { subject, html, text } = otpEmail({
    businessName: merchant.business_name,
    code,
    expiryMinutes: config.otp.expiryMinutes,
  });

  await brevo.sendEmail({ to: merchant.email, toName: merchant.business_name, subject, html, text });
}

/** Fetches the most recent, not-yet-consumed OTP for a merchant. */
async function getLatestActiveOtp(merchantId, purpose) {
  const rows = await supabase.select(
    'email_otps',
    { merchant_id: merchantId, purpose: purpose || 'signup', consumed_at: 'is.null' },
    { order: 'created_at.desc', limit: 1 }
  );
  return rows && rows.length ? rows[0] : null;
}

/**
 * Verifies a submitted code against the merchant's latest active OTP.
 * Throws a descriptive, French, non-generic error on every failure path.
 */
async function verifyOtp(merchantId, code, purpose) {
  const record = await getLatestActiveOtp(merchantId, purpose);
  if (!record) {
    throw httpError(400, 'OTP_NOT_FOUND', "Aucun code de vérification actif. Demandez-en un nouveau.");
  }

  if (new Date(record.expires_at).getTime() < Date.now()) {
    throw httpError(400, 'OTP_EXPIRED', 'Ce code a expiré. Demandez-en un nouveau.');
  }

  if (record.attempts >= config.otp.maxAttempts) {
    throw httpError(429, 'OTP_LOCKED', 'Trop de tentatives incorrectes. Demandez un nouveau code.');
  }

  const valid = otp.verifyCode(code, record.code_hash);
  if (!valid) {
    await supabase.update('email_otps', { id: record.id }, { attempts: record.attempts + 1 });
    const remaining = config.otp.maxAttempts - (record.attempts + 1);
    throw httpError(
      400,
      'OTP_INCORRECT',
      remaining > 0 ? `Code incorrect. ${remaining} tentative${remaining > 1 ? 's' : ''} restante${remaining > 1 ? 's' : ''}.` : 'Code incorrect. Demandez un nouveau code.'
    );
  }

  await supabase.update('email_otps', { id: record.id }, { consumed_at: new Date().toISOString() });
  return true;
}

/** Rate-limited resend: reuses createAndSendOtp, callers enforce the cooldown via rateLimit. */
async function resendOtp(merchant, purpose) {
  await createAndSendOtp(merchant, purpose);
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { createAndSendOtp, verifyOtp, resendOtp, getLatestActiveOtp };
