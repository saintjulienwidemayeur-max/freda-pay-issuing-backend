'use strict';
const brevo = require('./brevo');
const siteUrl = require('./siteUrl');
const { buildEmail } = require('../templates/notificationEmail');

/** Emails around a contract. A mail problem never undoes the business action: failures are logged and reported as false. */
async function deliver(to, toName, built, label, attachments) {
  if (!to) return false;
  try {
    await brevo.sendEmail({ to, toName, subject: built.subject, html: built.html, text: built.text, attachments });
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Contract email "${label}" failed:`, err.message);
    return false;
  }
}

/** A contract is waiting: for a merchant the button opens the dashboard, for an outside partner the private link. */
function sent(contract, url) {
  const merchant = !!contract.merchant_id;
  return deliver(contract.recipient_email, contract.recipient_name, buildEmail({
    subject: `Un contrat vous attend : ${contract.title}`,
    eyebrow: 'Contrat à signer',
    heading: 'Un contrat attend votre signature',
    paragraphs: [
      `Bonjour ${contract.recipient_name},`,
      `**${contract.admin_name}** (Freda Pay) vous a envoyé le contrat **${contract.title}**. Freda Pay l'a déjà signé.`,
      merchant
        ? 'Connectez-vous à votre tableau de bord, ouvrez la rubrique **Contrats**, lisez le document, remplissez les champs demandés puis signez.'
        : 'Ouvrez le lien ci-dessous, lisez le document, remplissez les champs demandés puis signez directement en ligne. Aucun compte n\'est nécessaire.',
    ],
    button: { label: merchant ? 'Ouvrir mes contrats' : 'Lire et signer le contrat', url },
    notice: merchant ? null : 'Ce lien est personnel : ne le transférez pas. Si vous ne connaissez pas Freda Pay, ignorez cet email.',
  }), 'contract-sent');
}

/** Both parties get the signed PDF. */
async function completed(contract, pdf) {
  const attachments = [{ name: `contrat-${contract.id}.pdf`, content: pdf.toString('base64') }];
  const built = (who) => buildEmail({
    subject: `Contrat signé : ${contract.title}`,
    eyebrow: 'Contrat signé',
    tone: 'success',
    heading: 'Le contrat est signé par les deux parties',
    paragraphs: [
      `Bonjour ${who},`,
      `Le contrat **${contract.title}** a été signé par **${contract.signer_name}** et par **${contract.admin_name}** (Freda Pay).`,
      'Vous trouverez le document PDF en pièce jointe, avec la signature des deux parties et le journal d\'audit (date, heure, adresse IP). Conservez-le précieusement.',
    ],
  });
  const a = await deliver(contract.signer_email || contract.recipient_email, contract.signer_name, built(contract.signer_name), 'contract-completed-signer', attachments);
  const b = contract.admin_email && contract.admin_email !== (contract.signer_email || contract.recipient_email)
    ? await deliver(contract.admin_email, contract.admin_name, built(contract.admin_name), 'contract-completed-admin', attachments)
    : true;
  return a && b;
}

function signUrl(token) {
  return `${siteUrl.get()}/sign?token=${encodeURIComponent(token)}`;
}
function dashboardUrl() {
  return `${siteUrl.get()}/dashboard#contrats`;
}

module.exports = { sent, completed, signUrl, dashboardUrl };
