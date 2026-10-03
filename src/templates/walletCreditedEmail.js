'use strict';
const config = require('../config');

const LOGO_URL = `${config.siteUrl}/logo.png`;

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtAmount(amount, currency) {
  const n = Number(amount).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === 'USD' ? `${n} $` : `${n} ${currency}`;
}

/** Sent whenever a merchant's Master Wallet or Gateway balance is credited (auto top-up confirmed, or an admin adds funds). */
function walletCreditedEmail({ businessName, amount, currency, walletLabel, newBalance, note }) {
  const amountStr = fmtAmount(amount, currency);
  const subject = `${amountStr} ajoutés à votre ${walletLabel} : Freda Pay Issuing`;

  const html = `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background-color:#f4f1f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f1f3;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 20px 50px -20px rgba(0,0,0,0.15);">
        <tr>
          <td style="background-color:#111111;padding:28px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
              <td style="width:36px;height:36px;border-radius:9px;overflow:hidden;">
                <img src="${LOGO_URL}" width="36" height="36" alt="Freda Pay Issuing" style="display:block;width:36px;height:36px;border-radius:9px;border:0;">
              </td>
              <td style="padding-left:11px;vertical-align:middle;">
                <span style="color:#ffffff;font-size:16px;font-weight:800;">FREDA PAY</span>
                <span style="color:#ff4081;font-size:16px;font-weight:800;">&nbsp;ISSUING</span>
              </td>
            </tr></table>
          </td>
        </tr>
        <tr>
          <td style="padding:40px 32px 32px;">
            <p style="margin:0 0 6px;font-size:13px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#16a34a;">Fonds reçus</p>
            <h1 style="margin:0 0 16px;font-size:26px;font-weight:800;color:#111111;line-height:1.3;">+${amountStr}</h1>
            <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#4b4b4b;">
              Bonjour ${escapeHtml(businessName || '')},<br><br>
              Votre <strong>${escapeHtml(walletLabel)}</strong> vient d'être crédité de <strong>${amountStr}</strong>${note ? ` (${escapeHtml(note)})` : ''}.
            </p>
            ${newBalance != null ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background-color:#faf6f8;border-radius:10px;margin-bottom:24px;"><tr><td style="padding:14px 18px;"><span style="font-size:12px;color:#6b5f66;text-transform:uppercase;letter-spacing:0.04em;">Nouveau solde</span><br><span style="font-size:18px;font-weight:800;color:#111111;">${fmtAmount(newBalance, currency)}</span></td></tr></table>` : ''}
            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
              <td style="background-color:#111111;border-radius:10px;">
                <a href="${config.siteUrl}/freda-pay-sandbox.html" style="display:inline-block;padding:14px 26px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;">Voir mon tableau de bord</a>
              </td>
            </tr></table>
          </td>
        </tr>
        <tr>
          <td style="padding:22px 32px;border-top:1px solid #ece4e8;">
            <p style="margin:0;font-size:12px;color:#9c9297;line-height:1.6;">© ${new Date().getFullYear()} Freda Pay LLC · <a href="mailto:issuing@fredapay.com" style="color:#ff4081;text-decoration:none;">issuing@fredapay.com</a></p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    `+${amountStr} : ${walletLabel} Freda Pay Issuing`,
    '',
    `Votre ${walletLabel} vient d'être crédité de ${amountStr}${note ? ` (${note})` : ''}.`,
    newBalance != null ? `Nouveau solde : ${fmtAmount(newBalance, currency)}` : '',
    '',
    `Tableau de bord : ${config.siteUrl}/freda-pay-sandbox.html`,
  ].filter(Boolean).join('\n');

  return { subject, html, text };
}

module.exports = { walletCreditedEmail };
