'use strict';
const config = require('../config');

/**
 * Brevo (formerly Sendinblue) transactional email API.
 * https://developers.brevo.com/reference/sendtransacemail
 */
async function sendEmail({ to, toName, subject, html, text, senderEmail, senderName, replyTo, headers }) {
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

module.exports = { sendEmail };
