'use strict';
const config = require('../config');

/**
 * Brevo (formerly Sendinblue) transactional email API.
 * https://developers.brevo.com/reference/sendtransacemail
 */
async function sendEmail({ to, toName, subject, html, text, senderEmail, senderName, replyTo, headers, attachments }) {
  if (!config.brevo.apiKey) {
    const err = new Error("L'envoi d'email n'est pas configuré côté serveur (BREVO_API_KEY manquante).");
    err.code = 'EMAIL_NOT_CONFIGURED';
    err.httpStatus = 500;
    throw err;
  }

  let res;
  try {
    res = await fetch(`${config.brevo.baseUrl}/v3/smtp/email`, {
      method: 'POST',
      headers: {
        'api-key': config.brevo.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { name: senderName || config.brevo.senderName, email: senderEmail || config.brevo.senderEmail },
        ...(replyTo ? { replyTo: { email: replyTo } } : {}),
        ...(headers ? { headers } : {}),
        ...(attachments && attachments.length ? { attachment: attachments.map((a) => ({ name: a.name, content: a.content })) } : {}),
        to: [{ email: to, name: toName || to }],
        subject,
        htmlContent: html,
        textContent: text,
      }),
    });
  } catch (networkErr) {
    const err = new Error("Impossible de contacter le service d'envoi d'email. Réessayez dans un instant.");
    err.code = 'EMAIL_NETWORK_ERROR';
    err.httpStatus = 502;
    throw err;
  }

  let data = null;
  try { data = await res.json(); } catch (e) { /* Brevo returns 201 with a small JSON body on success */ }

  if (!res.ok) {
    // eslint-disable-next-line no-console
    console.error(`Brevo sendEmail -> HTTP ${res.status}:`, JSON.stringify(data));
    const err = new Error("L'envoi de l'email a échoué. Réessayez dans un instant.");
    err.code = 'EMAIL_SEND_FAILED';
    err.httpStatus = 502;
    throw err;
  }

  return data;
}

/**
 * What really happened to an email Brevo accepted (201 only means "accepted"): delivered, blocked, bounced, deferred, or still on its way.
 * Never throws: { status: 'unknown' } when Brevo cannot be asked.
 */
async function deliveryStatus(messageId, { waitMs = 0 } = {}) {
  if (!messageId || !config.brevo.apiKey) return { status: 'unknown', reason: null };
  const FINAL = { delivered: 'delivered', blocked: 'blocked', hardBounces: 'bounced', softBounces: 'bounced', bounces: 'bounced', invalid: 'blocked', spam: 'spam', deferred: 'deferred' };
  const deadline = Date.now() + waitMs;
  let last = { status: 'accepted', reason: null };
  for (;;) {
    try {
      const res = await fetch(`${config.brevo.baseUrl}/v3/smtp/statistics/events?messageId=${encodeURIComponent(messageId)}&limit=20`, { headers: { 'api-key': config.brevo.apiKey, Accept: 'application/json' } });
      if (!res.ok) return { status: 'unknown', reason: `Brevo HTTP ${res.status}` };
      const events = ((await res.json()).events || []);
      const hit = events.map((e) => ({ s: FINAL[e.event], reason: e.reason || null })).find((x) => x.s && x.s !== 'deferred') || events.map((e) => ({ s: FINAL[e.event], reason: e.reason || null })).find((x) => x.s);
      if (hit) { last = { status: hit.s, reason: hit.reason }; if (hit.s !== 'deferred') return last; }
    } catch (e) { return { status: 'unknown', reason: null }; }
    if (Date.now() >= deadline) return last;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

let sendersCache = null; let sendersAt = 0;
/** Validated (active) senders of the Brevo account; null when Brevo cannot be asked. Cached 10 minutes. */
async function activeSenders() {
  if (!config.brevo.apiKey) return null;
  if (sendersCache && Date.now() - sendersAt < 10 * 60 * 1000) return sendersCache;
  try {
    const res = await fetch(`${config.brevo.baseUrl}/v3/senders`, { headers: { 'api-key': config.brevo.apiKey, Accept: 'application/json' } });
    if (!res.ok) return null;
    sendersCache = ((await res.json()).senders || []).filter((x) => x.active !== false).map((x) => String(x.email || '').toLowerCase());
    sendersAt = Date.now();
    return sendersCache;
  } catch (e) { return null; }
}
/** The sender to use: the preferred one if Brevo knows it as validated, else the OTP sender that is known to deliver. */
async function resolveSender(preferred) {
  const list = await activeSenders();
  if (!list || !preferred || list.includes(String(preferred).toLowerCase())) return { email: preferred, fallback: false };
  const alt = config.brevo.senderEmail;
  console.error(`Brevo: sender ${preferred} is not a validated sender, using ${alt} instead.`); // eslint-disable-line no-console
  return { email: list.includes(String(alt).toLowerCase()) ? alt : preferred, fallback: list.includes(String(alt).toLowerCase()), requested: preferred };
}

module.exports = { sendEmail, deliveryStatus, activeSenders, resolveSender };
