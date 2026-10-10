'use strict';
const config = require('../config');

/**
 * Branded transactional email for the signup OTP. Built with table-based,
 * inline-styled HTML for maximum compatibility across email clients (Gmail,
 * Outlook, Apple Mail, etc. - most strip <style> blocks and modern CSS).
 * The logo is loaded from the real hosted file (config.siteUrl + /logo.png)
 * rather than embedded, since most email clients strip/block data: URIs;
 * the "FREDA PAY ISSUING" text next to it still shows even if the image
 * itself is blocked by the recipient's client.
 */
const LOGO_URL = config.emailLogoUrl;

function otpEmail({ businessName, code, expiryMinutes }) {
  const subject = `${code} : Votre code de vérification Freda Pay Issuing`;

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${subject}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f1f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f1f3;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 20px 50px -20px rgba(0,0,0,0.15);">

        <!-- Header -->
        <tr>
          <td style="background-color:#111111;padding:28px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td style="width:36px;height:36px;border-radius:9px;overflow:hidden;text-align:center;vertical-align:middle;">
                  <img src="${LOGO_URL}" width="36" height="36" alt="" style="display:block;width:36px;height:36px;border-radius:9px;border:0;">
                </td>
                <td style="padding-left:11px;vertical-align:middle;">
                  <span style="color:#ffffff;font-size:16px;font-weight:800;letter-spacing:0.01em;">FREDA PAY</span>
                  <span style="color:#ff4081;font-size:16px;font-weight:800;">&nbsp;ISSUING</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:40px 32px 32px;">
            <p style="margin:0 0 6px;font-size:13px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#ff4081;">Vérification d'email</p>
            <h1 style="margin:0 0 16px;font-size:22px;font-weight:800;color:#111111;line-height:1.3;">Confirmez votre adresse email</h1>
            <p style="margin:0 0 28px;font-size:15px;line-height:1.6;color:#4b4b4b;">
              Bonjour${businessName ? ' ' + escapeHtml(businessName) : ''},<br>
              Utilisez le code ci-dessous pour terminer la création de votre compte Freda Pay Issuing.
            </p>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#faf6f8;border:1px solid #ece4e8;border-radius:12px;margin-bottom:24px;">
              <tr><td align="center" style="padding:26px 16px;">
                <span style="font-family:'Courier New',monospace;font-size:36px;font-weight:800;letter-spacing:0.28em;color:#111111;">${escapeHtml(code)}</span>
              </td></tr>
            </table>

            <p style="margin:0 0 6px;font-size:14px;color:#6b5f66;">Ce code expire dans <strong>${expiryMinutes} minutes</strong>.</p>
            <p style="margin:0;font-size:14px;color:#6b5f66;">Si vous n'avez pas demandé ce code, ignorez cet email. Aucune action supplémentaire n'est requise.</p>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px;background-color:#fff8eb;border-radius:10px;">
              <tr><td style="padding:14px 16px;font-size:13px;color:#92400e;line-height:1.5;">
                Freda Pay Issuing ne vous demandera jamais ce code par téléphone, WhatsApp ou email. Ne le partagez avec personne.
              </td></tr>
            </table>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:22px 32px;border-top:1px solid #ece4e8;">
            <p style="margin:0;font-size:12px;color:#9c9297;line-height:1.6;">
              © ${new Date().getFullYear()} Freda Pay LLC · Cet email a été envoyé à votre adresse car un compte Freda Pay Issuing a été créé avec elle.<br>
              Besoin d'aide ? <a href="mailto:issuing@fredapay.com" style="color:#ff4081;text-decoration:none;">issuing@fredapay.com</a>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    `Freda Pay Issuing - Vérification d'email`,
    ``,
    `Bonjour${businessName ? ' ' + businessName : ''},`,
    `Votre code de vérification : ${code}`,
    `Ce code expire dans ${expiryMinutes} minutes.`,
    ``,
    `Si vous n'avez pas demandé ce code, ignorez cet email.`,
    `Freda Pay Issuing ne vous demandera jamais ce code par téléphone, WhatsApp ou email.`,
    ``,
    `Besoin d'aide ? issuing@fredapay.com`,
  ].join('\n');

  return { subject, html, text };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { otpEmail };
