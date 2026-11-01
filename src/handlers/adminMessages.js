'use strict';
const supabase = require('../lib/supabase');
const brevo = require('../services/brevo');
const config = require('../config');
const { buildEmail } = require('../templates/notificationEmail');
const { randomHex } = require('../utils/ids');

const AUDIENCES = ['one', 'all', 'live', 'sandbox', 'unverified'];
const MAX_RECIPIENTS = 2000;
const CONCURRENCY = 5;

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

/** Merchants an audience resolves to. Bulk sends skip suspended accounts and unverified emails. */
async function resolveRecipients(audience, merchantId) {
  if (!AUDIENCES.includes(audience)) throw httpError(400, 'INVALID_AUDIENCE', 'Audience invalide (one, all, live, sandbox, unverified).');
  if (audience === 'one') {
    if (!merchantId) throw httpError(400, 'MISSING_FIELDS', 'merchant_id est requis pour un envoi individuel.');
    const m = await supabase.selectOne('merchants', { id: merchantId });
    if (!m) throw httpError(404, 'NOT_FOUND', 'Marchand introuvable.');
    if (!m.email) throw httpError(400, 'NO_EMAIL', "Ce marchand n'a pas d'adresse email.");
    return [m];
  }
  const rows = await supabase.select('merchants', { deleted_at: supabase.isNull(), email_verified: true }, { order: 'created_at.desc', limit: MAX_RECIPIENTS });
  return rows.filter((m) => {
    if (!m.email) return false;
    const live = !!(m.gateway_live_enabled || m.issuing_live_enabled);
    if (audience === 'live') return live;
    if (audience === 'sandbox') return !live;
    // Never sent identity documents (a submitted file waiting for review is not "late"): KYC for individuals, KYB for businesses.
    if (audience === 'unverified') return (m.account_type === 'business' ? m.kyb_status : m.kyc_status) === 'not_started';
    return true;
  });
}

async function audience(ctx) {
  const a = ctx.query && ctx.query.audience;
  const list = await resolveRecipients(a, ctx.query && ctx.query.merchant_id);
  // The names and addresses themselves: the admin sees WHO will receive the email before sending it.
  return { status: 200, body: { audience: a, count: list.length, recipients: list.slice(0, 500).map((m) => ({ name: m.business_name || '', email: m.email })) } };
}

function buildMessage(merchant, subject, message) {
  const name = merchant.business_name || '';
  const personalise = (t) => t.replace(/\{\{\s*name\s*\}\}/gi, name);
  const paragraphs = personalise(message).split(/\n\s*\n/).map((p) => p.trim().replace(/\n/g, ' ')).filter(Boolean);
  return buildEmail({
    subject,
    eyebrow: 'Message de Freda Pay Issuing',
    heading: subject,
    paragraphs: [`Bonjour ${name || ''},`.replace(/\s+,/, ','), ...paragraphs],
    tone: 'info',
  });
}

function sendOne(merchant, subject, message) {
  const built = buildMessage(merchant, subject, message);
  return brevo.sendEmail({
    to: merchant.email,
    toName: merchant.business_name,
    subject: built.subject,
    html: built.html,
    text: built.text,
    senderEmail: config.brevo.adminSenderEmail,
    senderName: config.brevo.adminSenderName,
    replyTo: config.brevo.inboundReplyAddress || config.brevo.adminSenderEmail,
  });
}

async function send(ctx) {
  const { audience: a, merchant_id: merchantId, subject, message, test, expected_count: expectedCount } = ctx.body || {};
  const subj = String(subject || '').trim();
  const msg = String(message || '').trim();
  if (!subj || !msg) throw httpError(400, 'MISSING_FIELDS', "L'objet et le message sont requis.");
  if (subj.length > 150) throw httpError(400, 'SUBJECT_TOO_LONG', "L'objet est trop long (150 caractères max).");
  if (msg.length > 8000) throw httpError(400, 'MESSAGE_TOO_LONG', 'Le message est trop long (8000 caractères max).');

  // Test mode: one copy to the admin who is writing, nobody else.
  if (test) {
    const to = ctx.admin && ctx.admin.email;
    if (!to) throw httpError(400, 'NO_EMAIL', "Votre compte admin n'a pas d'adresse email.");
    await sendOne({ email: to, business_name: 'Test' }, subj, msg);
    return { status: 200, body: { test: true, sent: 1, to } };
  }

  const recipients = await resolveRecipients(a, merchantId);
  if (!recipients.length) throw httpError(400, 'NO_RECIPIENTS', "Aucun destinataire pour cette audience.");
  // The count the admin saw and confirmed must be the count about to be emailed: a mismatch (stale page, wrong audience) sends nothing.
  if (expectedCount !== undefined && Number(expectedCount) !== recipients.length) {
    throw httpError(409, 'RECIPIENTS_CHANGED', `Le nombre de destinataires a changé (${recipients.length} au lieu de ${Number(expectedCount)}). Rien n'a été envoyé : vérifiez la liste et recommencez.`);
  }

  let sent = 0;
  let failed = 0;
  const failures = [];
  for (let i = 0; i < recipients.length; i += CONCURRENCY) {
    const batch = recipients.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map((m) => sendOne(m, subj, msg)));
    results.forEach((r, k) => {
      if (r.status === 'fulfilled') sent += 1;
      else { failed += 1; failures.push(batch[k].email); }
    });
  }
  if (sent === 0 && failed > 0 && recipients.length === 1) {
    throw httpError(502, 'EMAIL_SEND_FAILED', "L'envoi a échoué. Vérifiez que administration@fredapay.com est un expéditeur validé dans Brevo.");
  }

  const row = await supabase.insert('admin_messages', {
    id: 'msg_' + randomHex(8),
    sent_by: ctx.adminId,
    sent_by_email: (ctx.admin && ctx.admin.email) || null,
    audience: a,
    merchant_id: a === 'one' ? merchantId : null,
    subject: subj,
    body: msg,
    recipients: recipients.length,
    sent,
    failed,
  });
  return { status: 201, body: { id: row.id, recipients: recipients.length, sent, failed, failed_emails: failures.slice(0, 20) } };
}

async function history(ctx) {
  const rows = await supabase.select('admin_messages', {}, { order: 'created_at.desc', limit: 50 });
  return { status: 200, body: { messages: rows } };
}

module.exports = { audience, send, history };
