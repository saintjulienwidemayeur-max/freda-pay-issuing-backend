'use strict';
const supabase = require('../lib/supabase');

/**
 * Failed calls to the card provider, kept for the admin panel: the merchant only gets a short French sentence, the team
 * needs the provider's own message to see what to fix. Saved to the database (best effort) and kept in memory too.
 */
const recent = [];
const MAX_MEMORY = 100;

/** What the team should check, by the provider's wording. */
/** What to check for a failure at the NEW issuer, by its error code (the message starts with MONERAILS_<CODE>: …). */
function newIssuerHint(code, m, status) {
  if (/UNREACHABLE|RESULT_UNKNOWN/.test(code) || /pas répondu|injoignable/.test(m)) return "Monerails n'a pas répondu (délai ou panne). Le résultat est inconnu : ne rien refaire à la main, le système recontrôle la carte tout seul ; vérifiez chez Monerails si la carte existe.";
  if (/BALANCE_INSUFFICIENT|INSUFFICIENT/.test(code) || /insufficient|solde/.test(m)) return "Le solde du compte Freda Pay chez Monerails est insuffisant : rechargez-le (voir l'alerte de solde bas).";
  if (/CARDHOLDER_EXISTS/.test(code)) return "Cet email est déjà enregistré chez Monerails par un autre marchand. La carte est alors créée chez l'ancien partenaire ; il faut un email propre à ce titulaire.";
  if (/CARDHOLDER_NOT_VERIFIED|VERIFICATION|KYC/.test(code) || /verif/.test(m)) return "Le titulaire n'est pas (encore) vérifié chez Monerails : attendre le résultat de la vérification, ou renvoyer sa pièce d'identité (recto et verso).";
  if (/MINIMUM_BALANCE/.test(code)) return "Monerails exige qu'il reste au moins 1 $ sur la carte : le montant demandé est trop élevé.";
  if (/TERMINATED/.test(code)) return 'La carte est déjà fermée chez Monerails.';
  if (/SINGLE_USE/.test(code)) return 'Carte à usage unique : elle ne peut être ni rechargée ni vidée.';
  if (/OPERATION_IN_PROGRESS/.test(code)) return "Une autre opération était en cours sur cette carte : réessayer dans un instant.";
  if (/RATE_LIMITED/.test(code) || status === 429) return 'Trop de demandes envoyées à Monerails : espacer les appels (le détail des cartes est limité).';
  if (status === 401 || status === 403 || /UNAUTHORIZED|FORBIDDEN|KEY/.test(code)) return "Monerails refuse nos accès : vérifiez la clé (Sandbox mr_test_ / Live mr_live_) et le webhook dans Admin › Monerails.";
  if (/INVALID|VALIDATION|PARAMETER|MISSING/.test(code) || status === 400 || status === 422) return `Une valeur envoyée à Monerails a été refusée (${code.replace(/^MONERAILS_/, '').toLowerCase() || 'validation'}) : lisez la réponse brute ci-dessus (nom, date de naissance, montant, pays...).`;
  if (status >= 500) return 'Erreur chez Monerails : réessayer plus tard ; si cela dure, contacter leur support.';
  return 'Réponse de Monerails non reconnue : lisez-la telle quelle ci-dessus et comparez avec leur documentation.';
}

function hintFor({ message, http_status }) {
  const m = String(message || '').toLowerCase();
  const mc = /^(MONERAILS_[A-Z0-9_]+)/.exec(String(message || ''));
  if (mc || /monerails/.test(m)) return newIssuerHint(mc ? mc[1] : '', m, http_status);
  if (http_status === 401 || http_status === 403) return "Le fournisseur refuse nos accès : clés, accès Live non activé ou adresse IP du serveur non autorisée (voir Paramètres, Diagnostic Maplerad).";
  if (/not available|unavailable|maintenance/.test(m)) return "Le fournisseur répond « service indisponible » : panne ou maintenance de son côté, ou ce type de carte (ex. carte business) n'est pas activé sur notre compte. Contacter le support du fournisseur.";
  if (/name/.test(m) && /required|empty/.test(m)) return "Le nom de la carte est vide : le marchand doit envoyer un nom d'entreprise (business_name).";
  if (/field validation/.test(m)) return `Un champ envoyé est manquant ou au mauvais format (${(m.match(/for '([^']+)'/) || [])[1] || 'voir le message'}).`;
  if (/insufficient/.test(m)) return 'Le solde du compte chez le fournisseur est insuffisant : rechargez-le.';
  if (/amount|min|max/.test(m)) return 'Le montant demandé est hors des limites du fournisseur (minimum ou maximum).';
  if (/currency/.test(m)) return 'Devise non prise en charge pour ce type de carte.';
  if (/brand/.test(m)) return 'Marque de carte non prise en charge (VISA ou MASTERCARD).';
  if (/kyc|tier|verif/.test(m)) return "Le titulaire doit d'abord compléter sa vérification d'identité.";
  if (/rate limit|too many/.test(m)) return 'Trop de requêtes envoyées au fournisseur : espacer les appels.';
  if (http_status >= 500) return 'Panne ou erreur chez le fournisseur : réessayer plus tard.';
  return 'Message du fournisseur non reconnu : lisez-le tel quel ci-dessus et comparez avec sa documentation.';
}

async function record(info) {
  const row = {
    mode: info.mode || null, merchant_id: info.merchant_id || null, route: info.route || null, method: info.method || null, path: info.path || null,
    http_status: info.http_status || null, message: String(info.message == null ? '' : info.message).slice(0, 1000),
    request_keys: Array.isArray(info.request_keys) ? info.request_keys.join(', ') : (info.request_keys || null), shown_to_merchant: info.shown_to_merchant || null,
  };
  recent.unshift(Object.assign({ created_at: new Date().toISOString() }, row));
  if (recent.length > MAX_MEMORY) recent.length = MAX_MEMORY;
  try { await supabase.insert('provider_errors', row); } catch (e) { /* the table may not exist yet: the memory copy remains */ }
}

async function list(limit) {
  let rows = [];
  try { rows = await supabase.select('provider_errors', {}, { order: 'created_at.desc', limit: limit || 100 }); } catch (e) { rows = []; }
  if (!rows.length) rows = recent.slice(0, limit || 100);
  return rows.map((r) => Object.assign({}, r, { hint: hintFor(r) }));
}

function reset() { recent.length = 0; }

/** A failure of one card at the new issuer, kept with the card id so the admin can ask "why did THIS card fail". */
function recordCardFailure(card, err, shown) {
  return record({
    mode: card && card.mode, merchant_id: card && card.merchant_id, route: 'carte', method: null, path: `card:${card && card.id}`,
    http_status: err && err.httpStatus, message: `${(err && err.code) || 'ERROR'}: ${(err && err.message) || ''}`, shown_to_merchant: shown || null,
  }).catch(() => {});
}

module.exports = { record, recordCardFailure, list, hintFor, reset };
