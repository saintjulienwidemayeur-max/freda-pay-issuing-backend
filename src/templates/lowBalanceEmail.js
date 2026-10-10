'use strict';
const config = require('../config');

const LOGO_URL = config.emailLogoUrl;

function lowBalanceEmail({ businessName, balance, minimumBalance }) {
  const subject = `Solde Master Wallet bas : ${businessName || 'votre compte'} Freda Pay Issuing`;

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f1f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f1f3;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 20px 50px -20px rgba(0,0,0,0.15);">

        <tr>
          <td style="background-color:#111111;padding:28px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td style="width:36px;height:36px;border-radius:9px;overflow:hidden;text-align:center;vertical-align:middle;">
                  <img src="${LOGO_URL}" width="36" height="36" alt="" style="display:block;width:36px;height:36px;border-radius:9px;border:0;">
                </td>
                <td style="padding-left:11px;vertical-align:middle;">
                  <span style="color:#ffffff;font-size:16px;font-weight:800;">FREDA PAY</span>
                  <span style="color:#ff4081;font-size:16px;font-weight:800;">&nbsp;ISSUING</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:40px 32px 32px;">
            <p style="margin:0 0 6px;font-size:13px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#b45309;">Alerte solde</p>
            <h1 style="margin:0 0 16px;font-size:22px;font-weight:800;color:#111111;line-height:1.3;">Votre Master Wallet a atteint le solde minimum</h1>
            <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#4b4b4b;">
              Bonjour${businessName ? ' ' + escapeHtml(businessName) : ''},<br>
              Le solde de votre Master Wallet est descendu à la réserve minimale requise. Tant que ce seuil n'est pas dépassé par un nouveau dépôt, les opérations qui débitent le Master Wallet (émission de carte, recharge, changement de plan) seront refusées.
            </p>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#fff8eb;border:1px solid #fde68a;border-radius:12px;margin-bottom:24px;">
              <tr><td style="padding:18px 20px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="font-size:13px;color:#92400e;padding-bottom:4px;">Solde actuel</td>
                    <td align="right" style="font-size:13px;color:#92400e;padding-bottom:4px;">Minimum requis</td>
                  </tr>
                  <tr>
                    <td style="font-size:24px;font-weight:800;color:#111111;">${formatUsd(balance)}</td>
                    <td align="right" style="font-size:24px;font-weight:800;color:#111111;">${formatUsd(minimumBalance)}</td>
                  </tr>
                </table>
              </td></tr>
            </table>

            <p style="margin:0 0 24px;font-size:14px;color:#6b5f66;">Ajoutez des fonds dès maintenant par MonCash, Natcash, Zelle ou virement bancaire depuis votre tableau de bord.</p>

            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr><td style="background-color:#111111;border-radius:10px;">
                <a href="${require('../services/siteUrl').get()}/dashboard" style="display:inline-block;padding:13px 24px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;">Ajouter des fonds</a>
              </td></tr>
            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:22px 32px;border-top:1px solid #ece4e8;">
            <p style="margin:0;font-size:12px;color:#9c9297;line-height:1.6;">
              © ${new Date().getFullYear()} Freda Pay LLC · Besoin d'aide ? <a href="mailto:issuing@fredapay.com" style="color:#ff4081;text-decoration:none;">issuing@fredapay.com</a>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    `Freda Pay Issuing - Alerte solde Master Wallet`,
    ``,
    `Bonjour${businessName ? ' ' + businessName : ''},`,
    `Le solde de votre Master Wallet (${formatUsd(balance)}) a atteint la réserve minimale requise (${formatUsd(minimumBalance)}).`,
    `Ajoutez des fonds pour continuer à émettre des cartes et débiter votre wallet.`,
    ``,
    `Besoin d'aide ? issuing@fredapay.com`,
  ].join('\n');

  return { subject, html, text };
}

function formatUsd(n) {
  return Number(n).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' $';
}
function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { lowBalanceEmail };
