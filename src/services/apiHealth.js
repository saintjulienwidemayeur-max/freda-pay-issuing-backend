'use strict';
const supabase = require('../lib/supabase');
const apiUsage = require('./apiUsage');
const apiTraffic = require('./apiTraffic');
const apiBlocks = require('./apiBlocks');
const webhookHealth = require('./webhookHealth');
const haitiTime = require('../utils/haitiTime');

/** What an error code means for the merchant's integration, and what to tell them. */
const EXPLAIN = {
  MISSING_API_KEY: "La clé API n'est pas envoyée correctement : l'en-tête doit être « Authorization: Bearer sk_… ».",
  INVALID_API_KEY: 'La clé utilisée est invalide ou a été révoquée : le marchand doit en créer une nouvelle.',
  MERCHANT_NOT_FOUND: 'La clé pointe vers un compte introuvable.',
  ACCOUNT_SUSPENDED: 'Le compte est suspendu : tous les appels sont refusés.',
  LIVE_NOT_ENABLED: "Le marchand utilise une clé Live alors que son compte n'est pas encore validé (KYC/KYB).",
  ISSUING_LIVE_NOT_ENABLED: "Le marchand appelle les cartes en Live sans avoir l'accès Issuing Live.",
  API_BLOCKED: "L'accès API est bloqué par l'équipe : le marchand continue pourtant d'envoyer des requêtes.",
  RATE_LIMITED: 'Le marchand dépasse la limite de requêtes : il interroge trop souvent (boucle de vérification).',
  MISSING_FIELDS: 'Des champs obligatoires manquent dans les requêtes : le code du marchand est incomplet.',
  INVALID_AMOUNT: 'Montants invalides envoyés (texte, négatif, trop de décimales ou trop petit).',
  INVALID_METHOD: 'Méthode de paiement ou de retrait inconnue.',
  INVALID_JSON: 'Le corps de la requête n\'est pas du JSON valide.',
  INVALID_RECIPIENT: 'Numéro de téléphone destinataire invalide (format attendu 509XXXXXXXX).',
  INSUFFICIENT_BALANCE: 'Solde insuffisant pour les opérations demandées.',
  DUPLICATE_REFERENCE: 'La même référence est réutilisée : chaque opération doit avoir une référence unique.',
  NOT_FOUND: "Le marchand demande des ressources qui n'existent pas (mauvais identifiant ou mauvaise adresse).",
  AMOUNT_TOO_LOW: 'Montant en dessous du minimum autorisé.',
  MIN_BALANCE_FOR_WITHDRAWAL: 'Retrait MonCash/Natcash demandé avec un solde inférieur au minimum requis.',
  BANK_ACCOUNT_CURRENCY: 'Le compte bancaire choisi ne correspond pas à la devise du retrait.',
  INTERNAL_ERROR: 'Erreur interne chez nous : à vérifier dans les logs du serveur.',
  ERROR: 'Erreur non détaillée.',
};
const explain = (code) => EXPLAIN[code] || 'Erreur renvoyée par l\'API : voir la documentation.';

function mergeCodes(rows) {
  const out = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.codes || {})) out[k] = (out[k] || 0) + v;
  return out;
}

/** The health of one merchant's integration: a status, the checks behind it, the problems found and the errors it provokes. */
function evaluate({ merchant, keys, rows7, recent, webhookEndpoint, block }) {
  const requests = rows7.reduce((n, r) => n + r.requests, 0);
  const limited = rows7.reduce((n, r) => n + r.limited, 0);
  const errors = rows7.reduce((n, r) => n + r.errors, 0);
  const codes = mergeCodes(rows7);
  const errorRate = requests ? Math.round((errors / requests) * 100) : 0;
  const limitedRate = requests ? Math.round((limited / requests) * 100) : 0;
  const wh = webhookHealth.get(merchant.id);
  const checks = [];
  const problems = [];
  const add = (id, label, level, detail) => { checks.push({ id, label, level, detail }); if (level === 'bad' || level === 'warn') problems.push({ severity: level, title: label, detail }); };

  add('key', 'Clé API créée', keys.active > 0 ? 'ok' : 'bad', keys.active > 0 ? `${keys.active} clé(s) active(s)${keys.live ? `, dont ${keys.live} Live` : ''}.` : 'Aucune clé API active : le marchand ne peut pas appeler l\'API.');
  const used = requests > 0 || recent.requests > 0;
  add('used', 'Clé utilisée', used ? 'ok' : (keys.active > 0 ? 'warn' : 'info'), used ? `${requests} requête(s) sur 7 jours.` : (keys.active > 0 ? 'Clé créée mais aucun appel depuis 7 jours : l\'intégration n\'est pas encore branchée.' : 'Pas d\'appel.'));
  if (requests > 0) add('errors', 'Appels réussis', errorRate > 30 ? 'bad' : errorRate > 10 ? 'warn' : 'ok', `${errorRate} % d'erreurs sur 7 jours (${errors} sur ${requests}).`);
  if (requests > 0) add('limit', 'Limite de requêtes respectée', limited === 0 ? 'ok' : (limitedRate > 10 ? 'bad' : 'warn'), limited === 0 ? 'Aucune requête refusée.' : `${limited} requête(s) refusée(s) (429), soit ${limitedRate} %.`);
  if (keys.live > 0 && !merchant.gateway_live_enabled) add('live', 'Accès Live', 'bad', 'Le marchand a une clé Live mais son compte n\'est pas validé pour le Live.');
  else if (keys.live > 0) add('live', 'Accès Live', 'ok', 'Compte autorisé en Live.');
  if (webhookEndpoint) {
    const bad = wh.failed_24h > 0 && (!wh.last_ok || (wh.last_failed && wh.last_failed > wh.last_ok));
    add('webhook', 'Webhook livré', bad ? 'bad' : (wh.failed_24h > 0 ? 'warn' : 'ok'), bad ? `Le serveur du marchand refuse nos notifications (${wh.failed_24h} échec(s) en 24 h${wh.last_error ? `, dernière erreur : ${wh.last_error}` : ''}).` : (wh.delivered_24h ? `${wh.delivered_24h} notification(s) livrée(s) en 24 h.` : 'Webhook enregistré, aucune notification envoyée récemment.'));
  } else if (keys.live > 0) {
    add('webhook', 'Webhook configuré', 'info', 'Pas de webhook : le marchand doit interroger l\'API pour connaître le statut des paiements.');
  }
  if (merchant.deleted_at) add('account', 'Compte actif', 'bad', 'Le compte est suspendu.');
  if (block) add('block', 'Accès API', 'bad', `Bloqué par l'équipe${block.reason ? ` : ${block.reason}` : ''}.`);

  const errorList = Object.entries(codes).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([code, count]) => ({ code, count, explanation: explain(code) }));
  const recentCodes = recent.top_codes.filter((c) => !codes[c.code]).map((c) => ({ code: c.code, count: c.count, explanation: explain(c.code) }));
  let status;
  if (keys.active === 0 && keys.revoked === 0 && requests === 0) status = 'inactive';
  else if (checks.some((c) => c.level === 'bad')) status = 'problem';
  else if (checks.some((c) => c.level === 'warn')) status = keys.active > 0 && !used ? 'inactive' : 'warning';
  else status = 'ok';
  if (keys.active > 0 && !used && !checks.some((c) => c.level === 'bad')) status = 'inactive';
  return {
    merchant_id: merchant.id, business_name: merchant.business_name, email: merchant.email,
    status, checks, problems, errors: errorList.concat(recentCodes),
    requests_7d: requests, error_rate: errorRate, limited_7d: limited,
    last_call: recent.last_seen, keys, webhook: webhookEndpoint ? { url_host: hostOf(webhookEndpoint.url), ...wh } : null,
    block: block ? { reason: block.reason, until: block.until ? new Date(block.until).toISOString() : null } : null,
  };
}
function hostOf(u) { try { return new URL(u).host; } catch (e) { return null; } }

async function all() {
  await apiBlocks.refresh();
  const since = haitiTime.day(Date.now() - 6 * 86400000);
  const keys = await supabase.select('api_keys', {}, { select: 'id,merchant_id,mode,created_at,revoked_at', limit: 5000 });
  const byMerchant = new Map();
  for (const k of keys) {
    const m = byMerchant.get(k.merchant_id) || { active: 0, live: 0, test: 0, revoked: 0 };
    if (k.revoked_at) m.revoked += 1; else { m.active += 1; if (k.mode === 'live') m.live += 1; else m.test += 1; }
    byMerchant.set(k.merchant_id, m);
  }
  const rows = await apiUsage.rows(since);
  const rowsBy = new Map();
  for (const r of rows) { const l = rowsBy.get(r.merchant_id) || []; l.push(r); rowsBy.set(r.merchant_id, l); }
  const ids = [...new Set([...byMerchant.keys(), ...rowsBy.keys(), ...apiTraffic.merchantIds()])];
  const merchants = [];
  for (let i = 0; i < ids.length; i += 100) merchants.push(...await supabase.select('merchants', { id: supabase.inList(ids.slice(i, i + 100)) }, { limit: 200 }));
  const endpoints = ids.length ? await supabase.select('webhook_endpoints', { active: true }, { limit: 5000 }) : [];
  const epBy = new Map(endpoints.map((e) => [e.merchant_id, e]));
  const list = merchants.map((m) => evaluate({
    merchant: m, keys: byMerchant.get(m.id) || { active: 0, live: 0, test: 0, revoked: 0 }, rows7: rowsBy.get(m.id) || [],
    recent: apiTraffic.recent(m.id), webhookEndpoint: epBy.get(m.id) || null, block: apiBlocks.get(m.id),
  }));
  const rank = { problem: 0, warning: 1, ok: 2, inactive: 3 };
  list.sort((a, b) => rank[a.status] - rank[b.status] || b.requests_7d - a.requests_7d);
  const count = (s) => list.filter((m) => m.status === s).length;
  return { generated_at: new Date().toISOString(), summary: { ok: count('ok'), warning: count('warning'), problem: count('problem'), inactive: count('inactive') }, merchants: list };
}

module.exports = { all, evaluate, explain };
