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
      `**${contract.admin_name}** (Freda Pay Issuing) vous a envoyé le contrat **${contract.title}**. Freda Pay Issuing l'a déjà signé.`,
      merchant
        ? 'Connectez-vous à votre tableau de bord, ouvrez la rubrique **Contrats**, lisez le document, remplissez les champs demandés puis signez.'
        : 'Ouvrez le lien ci-dessous, lisez le document, remplissez les champs demandés puis signez directement en ligne. Aucun compte n\'est nécessaire.',
    ],
    button: { label: merchant ? 'Ouvrir mes contrats' : 'Lire et signer le contrat', url },
    notice: merchant ? null : 'Ce lien est personnel : ne le transférez pas. Si vous ne connaissez pas Freda Pay Issuing, ignorez cet email.',
  }), 'contract-sent');
}

/** An extra signer is invited. Without a url the contract is not ready yet: they will get the link once it is. */
function invited(contract, signer, url) {
  const side = signer.side === 'FREDA' ? 'pour Freda Pay Issuing' : `pour ${contract.recipient_name}`;
  return deliver(signer.email, signer.name, buildEmail({
    subject: `Votre signature est demandée : ${contract.title}`,
    eyebrow: 'Contrat à signer',
    heading: url ? 'Votre signature est demandée' : 'Vous êtes invité à signer un contrat',
    paragraphs: [
      `Bonjour ${signer.name},`,
      `Vous êtes invité à signer ${side} le contrat **${contract.title}**.`,
      url
        ? 'Ouvrez le lien ci-dessous, lisez le document puis signez directement en ligne. Aucun compte n\'est nécessaire.'
        : `Le contrat sera prêt à signer dès que **${contract.recipient_name}** l'aura signé. Vous recevrez alors un second email avec votre lien de signature.`,
    ],
    button: url ? { label: 'Lire et signer le contrat', url } : undefined,
    notice: url ? 'Ce lien est personnel : ne le transférez pas. Si vous ne connaissez pas Freda Pay Issuing, ignorez cet email.' : null,
  }), 'contract-invited');
}

/** Everyone who signed gets the signed PDF. */
async function completed(contract, pdf) {
  const attachments = [{ name: `contrat-${contract.id}.pdf`, content: pdf.toString('base64') }];
  const built = (who) => buildEmail({
    subject: `Contrat signé : ${contract.title}`,
    eyebrow: 'Contrat signé',
    tone: 'success',
    heading: 'Le contrat est signé par toutes les parties',
    paragraphs: [
      `Bonjour ${who},`,
      `Le contrat **${contract.title}** a été signé par toutes les parties.`,
      'Vous trouverez le document PDF en pièce jointe, avec les signatures et le certificat de signature électronique (date, heure, adresse IP). Conservez-le précieusement.',
    ],
  });
  const people = [
    { email: contract.signer_email || contract.recipient_email, name: contract.signer_name || contract.recipient_name },
    { email: contract.admin_email, name: contract.admin_name },
  ].concat((contract.signers || []).map((s) => ({ email: s.email, name: s.name })));
  const seen = new Set();
  let ok = true;
  for (const p of people) {
    const key = String(p.email || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!(await deliver(p.email, p.name, built(p.name), 'contract-completed', attachments))) ok = false;
  }
  return ok;
}

function signUrl(token) {
  return `${siteUrl.get()}/sign?token=${encodeURIComponent(token)}`;
}
function dashboardUrl() {
  return `${siteUrl.get()}/dashboard#contrats`;
}

module.exports = { sent, invited, completed, signUrl, dashboardUrl };
