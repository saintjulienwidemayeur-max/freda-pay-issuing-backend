'use strict';
const supabase = require('../lib/supabase');
const ledger = require('./ledger');
const guarantee = require('./guarantee');
const config = require('../config');
const tranzak = require('./tranzak');

/**
 * "Why can this merchant not connect the payment service or the cards?" One list of checks, each ok / warn / fail, with what it means and
 * what to do, for the admin. It only reads: nothing is changed, and no secret is ever returned.
 */
const ok = (id, area, label, detail) => ({ id, area, label, status: 'ok', detail: detail || null });
const warn = (id, area, label, detail, fix) => ({ id, area, label, status: 'warn', detail: detail || null, fix: fix || null });
const fail = (id, area, label, detail, fix) => ({ id, area, label, status: 'fail', detail: detail || null, fix: fix || null });

const safe = async (fn, fallback) => { try { return await fn(); } catch (e) { return fallback; } };
const day = 24 * 3600 * 1000;

async function diagnose(merchantId) {
  const m = await supabase.selectOne('merchants', { id: merchantId });
  if (!m) return null;
  const since7 = new Date(Date.now() - 7 * day).toISOString();
  const [keys, hook, verifs, access, holders, cards, identity, apiLog, provErr, payments, cryptoWallets] = await Promise.all([
    safe(() => supabase.select('api_keys', { merchant_id: m.id }, { limit: 50 }), []),
    safe(() => supabase.selectOne('webhook_endpoints', { merchant_id: m.id }), null),
    safe(() => supabase.select('verification_submissions', { merchant_id: m.id }, { order: 'created_at.desc', limit: 10 }), []),
    safe(() => supabase.select('issuing_access_requests', { merchant_id: m.id }, { order: 'created_at.desc', limit: 5 }), []),
    safe(() => supabase.select('maplerad_customers', { merchant_id: m.id }, { order: 'created_at.desc', limit: 20 }), []),
    safe(() => supabase.select('cards', { merchant_id: m.id }, { order: 'created_at.desc', limit: 50 }), []),
    safe(() => supabase.selectOne('merchant_identity', { merchant_id: m.id }), null),
    safe(() => supabase.select('api_call_log', { merchant_id: m.id, created_at: supabase.gt(since7) }, { order: 'created_at.desc', limit: 300 }), []),
    safe(() => supabase.select('provider_errors', { merchant_id: m.id }, { order: 'created_at.desc', limit: 10 }), []),
    safe(() => supabase.select('payments', { merchant_id: m.id, created_at: supabase.gt(since7) }, { order: 'created_at.desc', limit: 200 }), []),
    safe(() => supabase.select('crypto_addresses', { merchant_id: m.id }, { limit: 50 }), []),
  ]);

  const checks = [];

  // ---- Account
  checks.push(m.deleted_at ? fail('account_active', 'Compte', 'Compte actif', "Le compte est désactivé : aucune clé API ne fonctionne.", "Réactivez le compte depuis l'admin si c'est une erreur.") : ok('account_active', 'Compte', 'Compte actif'));
  checks.push(m.email_verified ? ok('email_verified', 'Compte', 'E-mail vérifié') : fail('email_verified', 'Compte', 'E-mail vérifié', "Le marchand n'a pas validé le code reçu par e-mail : il ne peut pas se connecter.", "Demandez-lui de terminer la vérification (code OTP) ou de renvoyer le code."));
  const country = String((m.onboarding && m.onboarding.country) || '').toUpperCase();
  if (country && config.restrictedCountries.includes(country)) checks.push(fail('country', 'Compte', 'Pays pris en charge', `Le pays ${country} est soumis à des sanctions : nos services ne sont pas disponibles.`));
  checks.push(identity && identity.date_of_birth && identity.identification_number && identity.address && identity.address.street
    ? ok('identity', 'Compte', "Identité du propriétaire enregistrée", 'Date de naissance, pièce et adresse : de quoi créer un client Tier 1.')
    : warn('identity', 'Compte', "Identité du propriétaire enregistrée", "Informations d'identité manquantes ou incomplètes (anciens comptes).", "Elles seront demandées au marchand à la création du premier wallet crypto."));

  // ---- Vérification (KYC / KYB)
  const verified = m.account_type === 'business' ? m.kyb_status === 'verified' : m.kyc_status === 'verified';
  const lastV = (verifs || []).find((v) => v.kind === (m.account_type === 'business' ? 'kyb' : 'kyc'));
  if (verified) checks.push(ok('verification', 'Vérification', m.account_type === 'business' ? 'KYB vérifié' : 'KYC vérifié'));
  else if (lastV && lastV.status === 'rejected') checks.push(fail('verification', 'Vérification', 'Vérification du compte', `Rejetée : ${lastV.rejection_reason || 'raison non précisée'}.`, 'Le marchand doit renvoyer des documents valides.'));
  else if (lastV && lastV.status === 'submitted') checks.push(warn('verification', 'Vérification', 'Vérification du compte', "Documents envoyés, en attente de revue par l'équipe.", 'Examinez la demande dans la file de vérification.'));
  else checks.push(fail('verification', 'Vérification', 'Vérification du compte', "Aucun document envoyé : le Live reste fermé.", 'Le marchand doit envoyer ses documents (KYC / KYB) depuis son tableau de bord.'));

  // ---- Clés API
  const live = (keys || []).filter((k) => k.mode === 'live' && !k.revoked_at);
  const test = (keys || []).filter((k) => k.mode === 'test' && !k.revoked_at);
  checks.push(test.length ? ok('key_test', 'Clés API', 'Clé de test (Sandbox)', `${test.length} clé(s) active(s).`) : warn('key_test', 'Clés API', 'Clé de test (Sandbox)', "Aucune clé de test active.", 'Le marchand peut en créer une dans Clés API.'));
  checks.push(live.length ? ok('key_live', 'Clés API', 'Clé Live', `${live.length} clé(s) active(s).`)
    : (m.gateway_live_enabled ? warn('key_live', 'Clés API', 'Clé Live', "Le Live est ouvert mais aucune clé Live active.", 'Le marchand doit créer sa clé Live dans Clés API.') : warn('key_live', 'Clés API', 'Clé Live', "Pas de clé Live (le Live n'est pas encore ouvert).")));

  // ---- Paiements (Gateway)
  checks.push(m.gateway_live_enabled ? ok('gateway_live', 'Paiements', 'Gateway Live ouvert') : (verified ? fail('gateway_live', 'Paiements', 'Gateway Live ouvert', "Compte vérifié mais le Live paiements n'est pas ouvert.", "Ouvrez le Live Gateway pour ce marchand (admin > Live).") : warn('gateway_live', 'Paiements', 'Gateway Live ouvert', "Fermé tant que le compte n'est pas vérifié.", "Vérifiez le compte d'abord.")));
  checks.push(hook ? (hook.active === false ? warn('webhook', 'Paiements', 'Webhook', `Enregistré (${hook.url}) mais désactivé.`) : ok('webhook', 'Paiements', 'Webhook', `Enregistré : ${hook.url}`)) : warn('webhook', 'Paiements', 'Webhook', "Aucun webhook enregistré : le marchand ne reçoit pas les notifications de paiement.", 'Il peut en enregistrer un (POST /v1/webhooks ou le tableau de bord).'));
  const failedPay = (payments || []).filter((p) => p.status === 'failed').length;
  const pendingOld = (payments || []).filter((p) => p.status === 'pending' && Date.now() - new Date(p.created_at).getTime() > 3600 * 1000).length;
  checks.push((payments || []).length === 0 ? warn('payments', 'Paiements', 'Paiements des 7 derniers jours', "Aucun paiement créé : le marchand n'a probablement pas encore intégré l'API.") : ok('payments', 'Paiements', 'Paiements des 7 derniers jours', `${payments.length} créé(s), ${failedPay} échoué(s), ${pendingOld} en attente depuis plus d'une heure.`));
  if (pendingOld) checks.push(warn('payments_pending', 'Paiements', 'Paiements bloqués', `${pendingOld} paiement(s) en attente depuis plus d'une heure.`, 'Ouvrez le diagnostic des paiements MonCash/Natcash.'));

  // ---- Appels API récents
  const calls = apiLog || [];
  const errs = calls.filter((c) => c.status >= 400);
  const byCode = {};
  for (const e of errs) byCode[e.code || `HTTP_${e.status}`] = (byCode[e.code || `HTTP_${e.status}`] || 0) + 1;
  const unauthorized = errs.filter((e) => e.status === 401).length;
  if (!calls.length) checks.push(warn('api_calls', 'Intégration', "Appels API des 7 derniers jours", "Aucun appel : le marchand n'a pas encore appelé l'API avec une clé."));
  else if (unauthorized && unauthorized === errs.length && unauthorized >= calls.length * 0.5) checks.push(fail('api_calls', 'Intégration', "Appels API des 7 derniers jours", `${unauthorized} appel(s) refusé(s) (clé absente ou invalide) sur ${calls.length}.`, "Le marchand utilise une mauvaise clé, une clé révoquée, ou ne met pas l'en-tête Authorization: Bearer."));
  else if (errs.length > calls.length * 0.3) checks.push(warn('api_calls', 'Intégration', "Appels API des 7 derniers jours", `${errs.length} erreur(s) sur ${calls.length} appels.`, 'Voyez les codes ci-dessous.'));
  else checks.push(ok('api_calls', 'Intégration', "Appels API des 7 derniers jours", `${calls.length} appel(s), ${errs.length} erreur(s).`));

  // ---- Paiement par carte (Visa / Mastercard, USD)
  const cardPays = (payments || []).filter((p) => p.provider === 'tranzak');
  for (const mode of ['sandbox', 'live']) {
    const configured = tranzak.isConfigured(mode);
    const label = `Service de paiement par carte (${mode === 'live' ? 'Live' : 'Sandbox'})`;
    if (configured) checks.push(ok(`card_service_${mode}`, 'Paiement par carte', label, 'Clé et secret de webhook configurés sur la plateforme.'));
    else checks.push((mode === 'live' && m.gateway_live_enabled ? fail : warn)(`card_service_${mode}`, 'Paiement par carte', label, "Le service de paiement par carte n'est pas configuré sur la plateforme pour ce mode (clé ou secret de webhook manquant) : tous les marchands reçoivent une erreur.", "Renseignez les clés du service carte dans les variables d'environnement du serveur."));
  }
  if (!cardPays.length) {
    checks.push(warn('card_payments', 'Paiement par carte', 'Paiements par carte des 7 derniers jours', "Aucun paiement par carte créé : le marchand n'a pas encore essayé (method « carte », currency USD, minimum 1 USD).", "Vérifiez qu'il envoie method: \"carte\" et currency: \"USD\"."));
  } else {
    const okCount = cardPays.filter((p) => p.status === 'succeeded').length;
    const failedCard = cardPays.filter((p) => p.status === 'failed');
    const stuck = cardPays.filter((p) => p.status === 'pending' && Date.now() - new Date(p.created_at).getTime() > 3600 * 1000).length;
    const reasons = {};
    for (const p of failedCard) { const r = String(p.failure_reason || 'raison inconnue').slice(0, 100); reasons[r] = (reasons[r] || 0) + 1; }
    const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, n]) => `${r} (${n})`).join(' ; ');
    const detail = `${cardPays.length} créé(s) : ${okCount} réussi(s), ${failedCard.length} échoué(s), ${stuck} en attente depuis plus d'une heure.${top ? ' Causes : ' + top + '.' : ''}`;
    if (okCount === 0 && failedCard.length >= 3) checks.push(fail('card_payments', 'Paiement par carte', 'Paiements par carte des 7 derniers jours', detail, "Aucun n'a réussi : voyez les causes ci-dessus (carte refusée, montant trop bas, service indisponible)."));
    else if (failedCard.length > cardPays.length * 0.5 || stuck) checks.push(warn('card_payments', 'Paiement par carte', 'Paiements par carte des 7 derniers jours', detail, stuck ? "Des paiements restent en attente : le webhook du service carte n'arrive peut-être pas." : 'Beaucoup d\'échecs : voyez les causes.'));
    else checks.push(ok('card_payments', 'Paiement par carte', 'Paiements par carte des 7 derniers jours', detail));
  }
  const cardCodes = Object.entries(byCode).filter(([k]) => /CARD|AMOUNT_TOO|CURRENCY|CHECKOUT/i.test(k));
  if (cardCodes.length) checks.push(warn('card_errors', 'Paiement par carte', "Erreurs API liées à la carte", cardCodes.map(([k, v]) => `${k} : ${v}`).join(' · '), 'Montant minimum 1 USD, currency USD, method carte : vérifiez la requête du marchand.'));

  // ---- Cartes (Issuing)
  const pendingAccess = (access || []).find((a) => a.status === 'pending');
  const rejectedAccess = (access || [])[0] && access[0].status === 'rejected' ? access[0] : null;
  if (m.issuing_live_enabled) checks.push(ok('issuing_live', 'Cartes', 'Issuing Live ouvert'));
  else if (pendingAccess) checks.push(warn('issuing_live', 'Cartes', 'Issuing Live ouvert', "Demande d'accès Live en attente.", "Examinez la demande dans l'admin (accès Issuing)."));
  else if (rejectedAccess) checks.push(fail('issuing_live', 'Cartes', 'Issuing Live ouvert', `Demande rejetée${rejectedAccess.note ? ' : ' + rejectedAccess.note : ''}.`, 'Le marchand peut refaire une demande.'));
  else checks.push(warn('issuing_live', 'Cartes', 'Issuing Live ouvert', "Le marchand n'a pas demandé l'accès Live aux cartes (le Sandbox fonctionne).", "Il doit faire la demande depuis Cartes."));
  const enrolled = (holders || []).filter((h) => h.status === 'enrolled').length;
  const failedHolders = (holders || []).filter((h) => h.status === 'failed');
  if (failedHolders.length) checks.push(warn('holders', 'Cartes', 'Titulaires de cartes', `${failedHolders.length} échec(s) : ${failedHolders[0].failure_reason || 'raison inconnue'}.`, 'Le marchand doit corriger les informations du titulaire et réessayer.'));
  else checks.push((holders || []).length ? ok('holders', 'Cartes', 'Titulaires de cartes', `${enrolled} enregistré(s).`) : ok('holders', 'Cartes', 'Titulaires de cartes', 'Aucun (pas nécessaire pour une carte entreprise).'));
  const failedCards = (cards || []).filter((c) => c.status === 'failed');
  if (failedCards.length) checks.push(warn('cards_failed', 'Cartes', 'Créations de cartes échouées', `${failedCards.length} carte(s) échouée(s). Dernière : ${failedCards[0].failure_reason || 'raison inconnue'}.`, 'Voyez les erreurs du fournisseur ci-dessous.'));
  for (const mode of ['sandbox', 'live']) {
    if (mode === 'live' && !m.issuing_live_enabled) continue;
    const bal = await safe(() => ledger.getBalance(m.id, 'master_wallet', 'USD', mode), 0);
    const locked = mode === 'live' ? await safe(() => guarantee.get(m.id), 0) : 0;
    const spendable = Math.round((bal - locked) * 100) / 100;
    const need = config.minimumBalanceUsd || 50;
    const label = `Master Wallet ${mode === 'live' ? 'Live' : 'Sandbox'}`;
    if (spendable < need) checks.push((mode === 'live' ? fail : warn)(`wallet_${mode}`, 'Cartes', label, `Utilisable ${spendable.toFixed(2)} $ (solde ${bal.toFixed(2)} $, garantie bloquée ${Number(locked).toFixed(2)} $) : sous la réserve minimale de ${need} $.`, 'Le marchand doit recharger son Master Wallet pour créer ou recharger des cartes.'));
    else checks.push(ok(`wallet_${mode}`, 'Cartes', label, `Utilisable ${spendable.toFixed(2)} $ (solde ${bal.toFixed(2)} $).`));
  }

  // ---- Wallet crypto
  checks.push((cryptoWallets || []).length ? ok('crypto', 'Wallet crypto', 'Wallets crypto', `${cryptoWallets.length} wallet(s) créé(s).`) : ok('crypto', 'Wallet crypto', 'Wallets crypto', 'Aucun wallet créé.'));

  const recentErrors = errs.slice(0, 8).map((e) => ({ at: e.created_at, method: e.method, route: e.route, status: e.status, code: e.code, message: e.message, mode: e.mode }));
  const providerErrors = (provErr || []).slice(0, 8).map((e) => ({ at: e.created_at, mode: e.mode, route: e.route, provider_path: e.path, http_status: e.http_status, message: e.message, shown_to_merchant: e.shown_to_merchant }));
  const failing = checks.filter((c) => c.status === 'fail');
  const warning = checks.filter((c) => c.status === 'warn');
  return {
    merchant: { id: m.id, business_name: m.business_name, email: m.email, phone: m.phone || null, account_type: m.account_type, website: (m.onboarding && m.onboarding.website) || null, created_at: m.created_at, kyc_status: m.kyc_status, kyb_status: m.kyb_status, gateway_live_enabled: !!m.gateway_live_enabled, issuing_live_enabled: !!m.issuing_live_enabled, active_mode: m.active_mode },
    summary: { fail: failing.length, warn: warning.length, headline: failing.length ? failing[0].detail || failing[0].label : (warning.length ? warning[0].detail || warning[0].label : 'Tout est en ordre.') },
    checks,
    api_errors_by_code: byCode,
    recent_api_errors: recentErrors,
    recent_provider_errors: providerErrors,
  };
}

module.exports = { diagnose };
