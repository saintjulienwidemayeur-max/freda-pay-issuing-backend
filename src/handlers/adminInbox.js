'use strict';
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const brevo = require('../services/brevo');
const config = require('../config');
const { buildEmail } = require('../templates/notificationEmail');
const { randomHex } = require('../utils/ids');

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const ACK_COOLDOWN_MS = 60 * 60 * 1000; // at most one acknowledgement per sender per hour

/** Never answer robots (bounces, auto-replies, no-reply senders) or ourselves: that is how mail loops start. */
function shouldAcknowledge(it, fromEmail) {
  const ours = [config.brevo.adminSenderEmail, config.brevo.senderEmail, config.brevo.inboundReplyAddress].filter(Boolean).map((e) => e.toLowerCase());
  if (ours.includes(fromEmail)) return false;
  if (/^(no-?reply|noreply|do-?not-?reply|mailer-daemon|postmaster|bounce|notifications?)[@+._-]/i.test(fromEmail)) return false;
  if (/^(re:\s*)*(automatic reply|auto(matic)? ?reply|réponse automatique|out of office|undeliverable|delivery status|returned mail|failure notice)/i.test(String(it.Subject || '').trim())) return false;
  const h = it.Headers || {};
  const get = (k) => { const key = Object.keys(h).find((x) => x.toLowerCase() === k); return key ? String(h[key]) : ''; };
  const auto = get('auto-submitted');
  if (auto && !/^no$/i.test(auto.trim())) return false;
  if (/bulk|junk|list|auto_reply/i.test(get('precedence'))) return false;
  if (get('x-auto-response-suppress') || get('list-id') || get('list-unsubscribe')) return false;
  return true;
}

/** Sends the automatic "we received your message" email. Never throws: a mail problem must not lose the message. */
async function sendAcknowledgement(row, fromName) {
  try {
    const recent = await supabase.select('admin_inbox', { from_email: row.from_email, ack_sent_at: 'not.is.null' }, { order: 'ack_sent_at.desc', limit: 1 });
    if (recent[0] && Date.now() - new Date(recent[0].ack_sent_at).getTime() < ACK_COOLDOWN_MS) return false;
    const subject = 'Nous avons bien reçu votre message';
    const built = buildEmail({
      subject,
      eyebrow: 'Accusé de réception',
      heading: subject,
      paragraphs: [
        fromName ? `Bonjour ${fromName},` : 'Bonjour,',
        'Nous avons bien reçu votre message. Notre équipe vous contactera dans les plus brefs délais.',
        'Cordialement,',
        "**L'équipe Freda Pay Issuing**",
      ],
      tone: 'success',
    });
    await brevo.sendEmail({
      to: row.from_email,
      toName: fromName || row.from_email,
      subject: built.subject,
      html: built.html,
      text: built.text,
      senderEmail: config.brevo.adminSenderEmail,
      senderName: config.brevo.adminSenderName,
      replyTo: config.brevo.inboundReplyAddress || config.brevo.adminSenderEmail,
      headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All' },
    });
    await supabase.update('admin_inbox', { id: row.id }, { ack_sent_at: new Date().toISOString() });
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Inbound acknowledgement failed:', err.message);
    return false;
  }
}

/**
 * POST /webhooks/inbound-email?token=SECRET
 * Called by Brevo Inbound Parsing when someone writes to the inbound address.
 * Trust comes from the secret token in the URL; without INBOUND_EMAIL_SECRET
 * configured the endpoint is closed.
 */
async function receive(ctx) {
  const secret = config.brevo.inboundSecret;
  const token = (ctx.query && ctx.query.token) || '';
  if (!secret || !safeEqual(token, secret)) throw httpError(401, 'INVALID_TOKEN', 'Jeton invalide.');

  const items = Array.isArray(ctx.body && ctx.body.items) ? ctx.body.items : [];
  let stored = 0;
  for (const it of items.slice(0, 50)) {
    const fromEmail = String((it.From && (it.From.Address || it.From.address)) || '').toLowerCase().trim();
    if (!fromEmail) continue;
    const messageId = String(it.MessageId || it.Uuid || '').slice(0, 300) || null;
    if (messageId && (await supabase.selectOne('admin_inbox', { message_id: messageId }))) continue; // Brevo retries: keep it idempotent
    const body = String(it.ExtractedMarkdownMessage || it.RawTextBody || '').trim().slice(0, 20000);
    const merchant = await supabase.selectOne('merchants', { email: fromEmail });
    const row = await supabase.insert('admin_inbox', {
      id: 'in_' + randomHex(8),
      message_id: messageId,
      from_email: fromEmail,
      from_name: String((it.From && (it.From.Name || it.From.name)) || '').slice(0, 200) || null,
      subject: String(it.Subject || '(sans objet)').slice(0, 300),
      body,
      merchant_id: merchant ? merchant.id : null,
      is_read: false,
    });
    stored += 1;
    if (shouldAcknowledge(it, fromEmail)) await sendAcknowledgement(row, row.from_name);
  }
  return { status: 200, body: { received: stored } };
}

async function list(ctx) {
  const rows = await supabase.select('admin_inbox', {}, { order: 'received_at.desc', limit: 100 });
  const ids = [...new Set(rows.map((r) => r.merchant_id).filter(Boolean))];
  const names = {};
  for (const id of ids) {
    const m = await supabase.selectOne('merchants', { id });
    if (m) names[id] = m.business_name;
  }
  return {
    status: 200,
    body: {
      unread: rows.filter((r) => !r.is_read).length,
      messages: rows.map((r) => ({ ...r, merchant_name: r.merchant_id ? names[r.merchant_id] || null : null })),
    },
  };
}

async function markRead(ctx) {
  const row = await supabase.selectOne('admin_inbox', { id: ctx.params.id });
  if (!row) throw httpError(404, 'NOT_FOUND', 'Message introuvable.');
  await supabase.update('admin_inbox', { id: row.id }, { is_read: true });
  return { status: 200, body: { id: row.id, is_read: true } };
}

async function reply(ctx) {
  const row = await supabase.selectOne('admin_inbox', { id: ctx.params.id });
  if (!row) throw httpError(404, 'NOT_FOUND', 'Message introuvable.');
  const text = String((ctx.body && ctx.body.message) || '').trim();
  if (!text) throw httpError(400, 'MISSING_FIELDS', 'Le message est requis.');
  if (text.length > 8000) throw httpError(400, 'MESSAGE_TOO_LONG', 'Le message est trop long (8000 caractères max).');

  const base = String(row.subject || '').replace(/^\s*(re:\s*)+/i, '');
  const subject = `Re: ${base}`.slice(0, 150);
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim().replace(/\n/g, ' ')).filter(Boolean);
  const built = buildEmail({ subject, eyebrow: 'Message de Freda Pay', heading: subject, paragraphs, tone: 'info' });
  await brevo.sendEmail({
    to: row.from_email,
    toName: row.from_name || row.from_email,
    subject: built.subject,
    html: built.html,
    text: built.text,
    senderEmail: config.brevo.adminSenderEmail,
    senderName: config.brevo.adminSenderName,
    replyTo: config.brevo.inboundReplyAddress || config.brevo.adminSenderEmail,
  });
  const [updated] = await supabase.update('admin_inbox', { id: row.id }, { replied_at: new Date().toISOString(), last_reply: text, is_read: true });
  return { status: 200, body: { id: row.id, replied_at: updated && updated.replied_at } };
}

module.exports = { receive, list, markRead, reply };
