'use strict';
const config = require('../config');

const LOGO_URL = config.emailLogoUrl;
const ROLE_LABELS = { admin: 'Administrateur', viewer: 'Lecture seule' };

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function teamInviteEmail({ businessName, role, link, expiryDays }) {
  const roleLabel = ROLE_LABELS[role] || role;
  const subject = `Invitation à rejoindre ${businessName} sur Freda Pay Issuing`;

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
                <img src="${LOGO_URL}" width="36" height="36" alt="" style="display:block;width:36px;height:36px;border-radius:9px;border:0;">
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
            <p style="margin:0 0 6px;font-size:13px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#ff4081;">Invitation</p>
            <h1 style="margin:0 0 16px;font-size:22px;font-weight:800;color:#111111;line-height:1.3;">Rejoignez ${escapeHtml(businessName)}</h1>
            <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#4b4b4b;">
              Vous avez été invité à accéder au compte de <strong>${escapeHtml(businessName)}</strong> avec le rôle <strong>${escapeHtml(roleLabel)}</strong>.
              Créez votre mot de passe pour activer votre accès.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:24px;"><tr>
              <td style="background-color:#111111;border-radius:10px;">
                <a href="${link}" style="display:inline-block;padding:14px 26px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;">Créer mon mot de passe</a>
              </td>
            </tr></table>
            <p style="margin:0 0 6px;font-size:13px;color:#6b5f66;">Ce lien est valable ${expiryDays} jours.</p>
            <p style="margin:0;font-size:13px;color:#6b5f66;">Si vous ne connaissez pas cette entreprise, ignorez cet email.</p>
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
    `Invitation à rejoindre ${businessName} sur Freda Pay Issuing`,
    '',
    `Vous avez été invité à accéder au compte de ${businessName} avec le rôle ${roleLabel}.`,
    `Créez votre mot de passe : ${link}`,
    `Ce lien est valable ${expiryDays} jours.`,
    '',
    'Si vous ne connaissez pas cette entreprise, ignorez cet email.',
  ].join('\n');

  return { subject, html, text };
}

module.exports = { teamInviteEmail, ROLE_LABELS };
