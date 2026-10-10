'use strict';
const brevo = require('./brevo');
const config = require('../config');
const { buildEmail } = require('../templates/notificationEmail');
const { walletCreditedEmail } = require('../templates/walletCreditedEmail');

const siteUrl = require('./siteUrl');
const DASHBOARD = { toString: () => `${siteUrl.get()}/dashboard` }; // read at send time, after the address was verified
const KIND_LABEL = { kyc: "vérification d'identité (KYC)", kyb: "vérification d'entreprise (KYB)" };

/**
 * Sends a built email without ever letting a mail problem break the business
 * action that triggered it (a KYC approval must stand even if Brevo is down).
 */
function dispatch(merchant, built, label) {
  if (!merchant || !merchant.email) return Promise.resolve(false);
  return brevo
    .sendEmail({ to: merchant.email, toName: merchant.business_name, subject: built.subject, html: built.html, text: built.text })
    .then(() => true)
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`Notification email "${label}" failed:`, err.message);
      return false;
    });
}

const hello = (m) => `Bonjour ${m.business_name || ''},`.replace(/\s+,/, ',');

function verificationApproved(merchant, kind, { liveEnabled }) {
  const stillPending = !liveEnabled;
  return dispatch(merchant, buildEmail({
    subject: `Votre ${KIND_LABEL[kind] || 'vérification'} est approuvée : Freda Pay`,
    eyebrow: 'Vérification approuvée',
    tone: 'success',
    heading: liveEnabled ? 'Votre compte est activé en Live' : 'Vérification approuvée',
    paragraphs: [
      hello(merchant),
      `Bonne nouvelle : votre **${KIND_LABEL[kind] || 'vérification'}** a été approuvée.`,
      liveEnabled
        ? 'Votre compte est maintenant activé en **mode Live** pour les paiements. Vous pouvez créer vos clés API Live et basculer du Sandbox au Live depuis le tableau de bord, à tout moment.'
        : 'Il reste une dernière vérification à valider pour activer le mode Live. Connectez-vous pour la compléter.',
      liveEnabled ? "L'émission de cartes en Live demande une autorisation séparée, à demander depuis le tableau de bord." : '',
    ].filter(Boolean),
    button: { label: 'Ouvrir mon tableau de bord', url: String(DASHBOARD) },
  }), 'verification-approved');
}

function verificationRejected(merchant, kind, reason) {
  return dispatch(merchant, buildEmail({
    subject: `Votre ${KIND_LABEL[kind] || 'vérification'} n'a pas pu être validée : Freda Pay`,
    eyebrow: 'Vérification refusée',
    tone: 'danger',
    heading: "Nous n'avons pas pu valider vos documents",
    paragraphs: [
      hello(merchant),
      `Votre **${KIND_LABEL[kind] || 'vérification'}** n'a pas pu être validée.`,
      `Raison : **${reason || 'documents insuffisants ou illisibles'}**.`,
      'Vous pouvez envoyer de nouveaux documents depuis la section Vérification du tableau de bord, ou nous les écrire à issuing@fredapay.com.',
    ],
    button: { label: 'Renvoyer mes documents', url: String(DASHBOARD) },
  }), 'verification-rejected');
}

function accountSuspended(merchant) {
  return dispatch(merchant, buildEmail({
    subject: 'Votre compte Freda Pay a été suspendu',
    eyebrow: 'Compte suspendu',
    tone: 'danger',
    heading: 'Votre compte est suspendu',
    paragraphs: [
      hello(merchant),
      "Votre compte Freda Pay a été **suspendu**. Vous ne pouvez plus vous y connecter pour le moment, et les nouvelles opérations sont bloquées.",
      'Vos données et votre historique sont conservés. Pour comprendre la raison ou demander une réactivation, écrivez-nous à issuing@fredapay.com.',
    ],
  }), 'account-suspended');
}

function cardRemovedByAdmin(merchant, { reference, refunded }) {
  return dispatch(merchant, buildEmail({
    subject: 'Une de vos cartes a été supprimée par notre équipe',
    eyebrow: 'Carte supprimée',
    tone: 'warning',
    heading: 'Une carte a été supprimée',
    paragraphs: [
      hello(merchant),
      `Notre équipe a supprimé la carte **${reference}** de votre compte.` + (refunded > 0 ? ` Son solde restant (**${Number(refunded).toFixed(2)} $**) a été reversé sur votre Master Wallet.` : ''),
      'Pour connaître la raison ou en discuter, répondez à cet email ou écrivez-nous à issuing@fredapay.com.',
    ],
  }), 'card-removed-by-admin');
}

function accountRestored(merchant) {
  return dispatch(merchant, buildEmail({
    subject: 'Votre compte Freda Pay est de nouveau actif',
    eyebrow: 'Compte réactivé',
    tone: 'success',
    heading: 'Votre compte est réactivé',
    paragraphs: [hello(merchant), 'Votre compte Freda Pay est de nouveau **actif**. Vous pouvez vous reconnecter normalement.'],
    button: { label: 'Me connecter', url: String(DASHBOARD) },
  }), 'account-restored');
}

function liveGranted(merchant) {
  return dispatch(merchant, buildEmail({
    subject: 'Votre compte est activé en Live : Freda Pay',
    eyebrow: 'Accès Live accordé',
    tone: 'success',
    heading: 'Le mode Live est activé',
    paragraphs: [
      hello(merchant),
      "Notre équipe a activé le **mode Live** sur votre compte pour les paiements. Aucune vérification supplémentaire n'est demandée.",
      'Vous pouvez créer vos clés API Live et basculer entre Sandbox et Live depuis le tableau de bord.',
    ],
    button: { label: 'Ouvrir mon tableau de bord', url: String(DASHBOARD) },
  }), 'live-granted');
}

function issuingDecision(merchant, approved, note) {
  return dispatch(merchant, buildEmail({
    subject: approved ? "L'émission de cartes Live est activée : Freda Pay" : "Votre demande d'accès Issuing Live a été refusée",
    eyebrow: approved ? 'Issuing Live accordé' : 'Demande refusée',
    tone: approved ? 'success' : 'danger',
    heading: approved ? "Vous pouvez émettre de vraies cartes" : "Votre demande n'a pas été acceptée",
    paragraphs: approved
      ? [hello(merchant), "Votre demande d'accès **Issuing Live** a été approuvée. Pour émettre une carte réelle, alimentez d'abord votre Master Wallet Live depuis Soldes & Wallet."]
      : [hello(merchant), "Votre demande d'accès **Issuing Live** n'a pas été acceptée pour le moment.", note ? `Raison : **${note}**.` : '', "Vos paiements (Gateway) continuent de fonctionner normalement. Vous pouvez refaire une demande plus tard."].filter(Boolean),
    button: { label: 'Ouvrir mon tableau de bord', url: String(DASHBOARD) },
  }), 'issuing-decision');
}

/** A deposit was confirmed and the wallet credited (automatic MonCash/Natcash top-up, or a manual one an admin approved). */
function walletCredited(merchant, { amount, currency, walletLabel, newBalance, note, mode }) {
  const suffix = mode === 'live' ? '' : ' · Sandbox (argent de test)';
  return dispatch(merchant, walletCreditedEmail({
    businessName: merchant.business_name, amount, currency, walletLabel, newBalance, note: `${note || 'dépôt confirmé'}${suffix}`,
  }), 'wallet-credited');
}

function depositRejected(merchant, { amount, method, reason }) {
  const label = { zelle: 'Zelle', bank_transfer: 'virement bancaire' }[method] || method;
  return dispatch(merchant, buildEmail({
    subject: "Votre dépôt n'a pas pu être confirmé : Freda Pay",
    eyebrow: 'Dépôt non confirmé',
    tone: 'warning',
    heading: "Nous n'avons pas pu confirmer votre dépôt",
    paragraphs: [
      hello(merchant),
      `Votre dépôt par **${label}**${amount ? ` de **${Number(amount).toLocaleString('fr-FR', { minimumFractionDigits: 2 })} $**` : ''} n'a pas pu être confirmé.`,
      `Raison : **${reason || 'justificatif insuffisant'}**.`,
      'Aucun montant n\'a été crédité. Vous pouvez renvoyer un justificatif lisible, ou nous écrire à issuing@fredapay.com.',
    ],
    button: { label: 'Ouvrir Soldes & Wallet', url: String(DASHBOARD) },
  }), 'deposit-rejected');
}

/** Admin > Paramètres: the same layout every real email uses, to check logo and button on a real device. */
function diagnosticTest(to, name) {
  return dispatch({ email: to, business_name: name }, buildEmail({
    subject: 'Test : logo et lien des emails Freda Pay',
    eyebrow: 'Email de test',
    tone: 'info',
    heading: 'Si vous voyez le logo, tout est en place',
    paragraphs: [
      name ? `Bonjour ${name},` : 'Bonjour,',
      "Ceci est un email de test envoyé depuis le panneau admin. Vérifiez deux choses : le logo s'affiche en haut, et le bouton ci-dessous ouvre bien votre tableau de bord (pas une page 404).",
    ],
    button: { label: 'Ouvrir le tableau de bord', url: String(DASHBOARD) },
  }), 'diagnostic-test');
}

const htg = (n) => `${Number(n).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} HTG`;

function bankPayoutSent(merchant, { amount, fee, reference }) {
  return dispatch(merchant, buildEmail({
    subject: 'Votre virement bancaire a été envoyé : Freda Pay',
    eyebrow: 'Retrait envoyé',
    tone: 'success',
    heading: 'Votre virement a été envoyé',
    paragraphs: [
      hello(merchant),
      `Nous avons envoyé votre retrait de **${htg(amount)}** vers votre compte bancaire (frais : ${htg(fee)}).`,
      `Référence du virement : **${reference}**. Le délai d'arrivée dépend de votre banque.`,
    ],
    button: { label: 'Ouvrir Soldes & Wallet', url: String(DASHBOARD) },
  }), 'bank-payout-sent');
}

function bankPayoutRejected(merchant, { amount, reason }) {
  return dispatch(merchant, buildEmail({
    subject: "Votre retrait bancaire n'a pas pu être effectué : Freda Pay",
    eyebrow: 'Retrait non effectué',
    tone: 'warning',
    heading: "Nous n'avons pas pu effectuer votre retrait",
    paragraphs: [
      hello(merchant),
      `Votre demande de retrait de **${htg(amount)}** par virement bancaire n'a pas pu être effectuée.`,
      `Raison : **${reason}**.`,
      "Le montant et les frais ont été remis sur votre solde Gateway. Vous pouvez corriger vos informations bancaires et refaire une demande, ou nous écrire à issuing@fredapay.com.",
    ],
    button: { label: 'Ouvrir Soldes & Wallet', url: String(DASHBOARD) },
  }), 'bank-payout-rejected');
}

function bankAccountChanged(merchant, { bankName, masked, added }) {
  return dispatch(merchant, buildEmail({
    subject: added ? 'Un compte bancaire a été ajouté : Freda Pay' : 'Votre compte bancaire a été modifié : Freda Pay',
    eyebrow: 'Sécurité du compte',
    tone: 'info',
    heading: added ? 'Un compte bancaire a été ajouté' : 'Votre compte bancaire a été modifié',
    paragraphs: [
      hello(merchant),
      `Les informations bancaires utilisées pour vos retraits sont maintenant : **${bankName}** ${masked || ''}.`,
    ],
    button: { label: 'Vérifier dans mon tableau de bord', url: String(DASHBOARD) },
    notice: "Ce n'était pas vous ? Écrivez-nous tout de suite à issuing@fredapay.com : nous bloquerons les retraits.",
  }), 'bank-account-changed');
}

const usd2 = (n) => `${Number(n).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
const dateFr = (d) => new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const PRODUCT_LABEL = { gateway: 'Payment Gateway', issuing: 'Issuing' };

function planRenewed(merchant, { product, planLabel, amountUsd, nextDate }) {
  return dispatch(merchant, buildEmail({
    subject: `Votre plan ${planLabel} a été renouvelé : Freda Pay`,
    eyebrow: 'Abonnement',
    tone: 'success',
    heading: `Plan ${PRODUCT_LABEL[product]} ${planLabel} renouvelé`,
    paragraphs: [
      hello(merchant),
      `Votre plan **${planLabel}** (${PRODUCT_LABEL[product]}) a été renouvelé : **${usd2(amountUsd)}** ont été prélevés sur votre Master Wallet.`,
      `Prochain renouvellement : **${dateFr(nextDate)}**.`,
    ],
    button: { label: 'Voir ma facturation', url: String(DASHBOARD) },
  }), 'plan-renewed');
}

function planPaymentFailed(merchant, { product, planLabel, amountUsd, until }) {
  return dispatch(merchant, buildEmail({
    subject: `Action requise : renouvellement de votre plan ${planLabel}`,
    eyebrow: 'Abonnement',
    tone: 'warning',
    heading: 'Nous n\'avons pas pu renouveler votre plan',
    paragraphs: [
      hello(merchant),
      `Le renouvellement de votre plan **${planLabel}** (${PRODUCT_LABEL[product]}) coûte **${usd2(amountUsd)}**, mais votre Master Wallet n'a pas assez de fonds disponibles.`,
      `Ajoutez des fonds avant le **${dateFr(until)}** : nous réessayons automatiquement. Passé cette date, votre compte repasse au plan gratuit.`,
    ],
    button: { label: 'Ajouter des fonds', url: String(DASHBOARD) },
  }), 'plan-payment-failed');
}

function planDowngraded(merchant, { product, fromLabel, toLabel }) {
  return dispatch(merchant, buildEmail({
    subject: `Votre plan ${fromLabel} s'est terminé : Freda Pay`,
    eyebrow: 'Abonnement',
    tone: 'warning',
    heading: `Retour au plan ${toLabel}`,
    paragraphs: [
      hello(merchant),
      `Nous n'avons pas pu renouveler votre plan **${fromLabel}** (${PRODUCT_LABEL[product]}). Votre compte est donc repassé au plan **${toLabel}**.`,
      'Vous pouvez reprendre un plan à tout moment depuis la section Facturation.',
    ],
    button: { label: 'Choisir un plan', url: String(DASHBOARD) },
  }), 'plan-downgraded');
}

function passwordReset(to, name, link, minutes) {
  return dispatch({ email: to, business_name: name }, buildEmail({
    subject: 'Réinitialisez votre mot de passe : Freda Pay',
    eyebrow: 'Mot de passe oublié',
    tone: 'info',
    heading: 'Créez un nouveau mot de passe',
    paragraphs: [
      name ? `Bonjour ${name},` : 'Bonjour,',
      `Vous avez demandé à réinitialiser le mot de passe de votre compte Freda Pay. Ce lien est valable **${minutes} minutes** et ne peut servir qu'une seule fois.`,
    ],
    button: { label: 'Choisir un nouveau mot de passe', url: link },
    notice: "Si vous n'avez pas fait cette demande, ignorez ce message : votre mot de passe actuel reste inchangé. Freda Pay ne vous demandera jamais votre mot de passe par email, téléphone ou WhatsApp.",
  }), 'password-reset');
}

function passwordChanged(to, name) {
  return dispatch({ email: to, business_name: name }, buildEmail({
    subject: 'Votre mot de passe Freda Pay a été modifié',
    eyebrow: 'Sécurité du compte',
    tone: 'success',
    heading: 'Votre mot de passe a été modifié',
    paragraphs: [
      name ? `Bonjour ${name},` : 'Bonjour,',
      'Le mot de passe de votre compte vient d\'être modifié, et toutes les sessions ouvertes ont été déconnectées.',
    ],
    button: { label: 'Me connecter', url: String(DASHBOARD) },
    notice: "Ce n'était pas vous ? Écrivez-nous tout de suite à issuing@fredapay.com : nous sécuriserons votre compte.",
  }), 'password-changed');
}

module.exports = { cardRemovedByAdmin, planRenewed, planPaymentFailed, planDowngraded, bankPayoutSent, bankPayoutRejected, bankAccountChanged, diagnosticTest, passwordReset, passwordChanged, dispatch, buildEmail, verificationApproved, verificationRejected, accountSuspended, accountRestored, liveGranted, issuingDecision, walletCredited, depositRejected };
