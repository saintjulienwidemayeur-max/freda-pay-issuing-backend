'use strict';
const supabase = require('../lib/supabase');

/**
 * Failed calls to the card provider, kept for the admin panel: the merchant only gets a short French sentence, the team
 * needs the provider's own message to see what to fix. Saved to the database (best effort) and kept in memory too.
 */
const recent = [];
const MAX_MEMORY = 100;

/** What the team should check, by the provider's wording. */
function hintFor({ message, http_status }) {
  const m = String(message || '').toLowerCase();
  if (http_status === 401 || http_status === 403) return "Le fournisseur refuse nos accès : clés, accès Live non activé ou adresse IP du serveur non autorisée (voir Paramètres, Diagnostic Maplerad).";
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

module.exports = { record, list, hintFor, reset };
