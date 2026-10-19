'use strict';
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const webhookHealth = require('./webhookHealth');
const { randomHex } = require('../utils/ids');
const urlSafety = require('../utils/urlSafety');

// Simple retry schedule: immediate, then +5s, then +30s. After that we give
// up and just log it - a merchant who needs stronger delivery guarantees
// than best-effort HTTP should also poll as a safety net (same advice we
// give for Maplerad's own inbound webhooks).
const RETRY_DELAYS_MS = [0, 5000, 30000];
const DELIVERY_TIMEOUT_MS = 8000;

/**
 * Notifies the merchant's registered webhook endpoint (if any) of an event.
 * Fire-and-forget: never awaited by callers, so a slow/down merchant server
 * never slows down the actual API response that triggered the event.
 */
function dispatch(merchantId, event, data) {
  // Deliberately not awaited by the caller - see comment above.
  dispatchAsync(merchantId, event, data).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`Webhook dispatch setup failed for merchant ${merchantId}, event ${event}:`, err.message);
  });
}

async function dispatchAsync(merchantId, event, data) {
  const endpoint = await supabase.selectOne('webhook_endpoints', { merchant_id: merchantId, active: true });
  if (!endpoint) return; // merchant hasn't registered a webhook - they're polling instead, nothing to do

  const payload = {
    id: `evt_${randomHex(12)}`,
    event,
    created_at: new Date().toISOString(),
    data,
  };
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', endpoint.secret).update(body).digest('hex');

  attemptDelivery(endpoint.url, body, signature, payload.id, 0, merchantId);
}

async function attemptDelivery(url, body, signature, eventId, attemptIndex, merchantId) {
  try {
    await urlSafety.assertPublicUrl(url); // re-checked at send time (DNS may have changed since registration)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        redirect: 'manual', // never follow a redirect to an internal address
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Freda-Signature': `sha256=${signature}`,
          'X-Freda-Event-Id': eventId,
          'X-Freda-Delivery-Attempt': String(attemptIndex + 1),
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (res.ok) { webhookHealth.record(merchantId, true); return; } // any 2xx = delivered, per our docs
    throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    const nextAttempt = attemptIndex + 1;
    if (nextAttempt < RETRY_DELAYS_MS.length) {
      const timer = setTimeout(
        () => attemptDelivery(url, body, signature, eventId, nextAttempt, merchantId),
        RETRY_DELAYS_MS[nextAttempt]
      );
      timer.unref();
    } else {
      webhookHealth.record(merchantId, false, err.message);
      // eslint-disable-next-line no-console
      console.error(`Webhook delivery to ${url} failed permanently (event ${eventId}) after ${nextAttempt} attempts:`, err.message);
    }
  }
}

/**
 * Sends ONE event to the merchant's endpoint right now and reports the outcome (used when an admin re-sends a webhook,
 * so the admin sees whether the merchant's server accepted it). Same payload shape and signature as a normal delivery.
 */
async function deliverNow(merchantId, event, data) {
  const endpoint = await supabase.selectOne('webhook_endpoints', { merchant_id: merchantId, active: true });
  if (!endpoint) return { sent: false, reason: 'NO_ENDPOINT' };
  const payload = { id: `evt_${randomHex(12)}`, event, created_at: new Date().toISOString(), data, resent_by_admin: true };
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', endpoint.secret).update(body).digest('hex');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    try {
      await urlSafety.assertPublicUrl(endpoint.url);
    } catch (_) {
      return { sent: false, event_id: payload.id, reason: 'UNREACHABLE' };
    }
    const res = await fetch(endpoint.url, {
      redirect: 'manual',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Freda-Signature': `sha256=${signature}`,
        'X-Freda-Event-Id': payload.id,
        'X-Freda-Delivery-Attempt': '1',
      },
      body,
      signal: controller.signal,
    });
    return { sent: res.ok, ...(res.ok ? { http_status: res.status } : {}), event_id: payload.id, reason: res.ok ? null : 'REJECTED' }; // the target's status code is not echoed (no port-scan oracle)
  } catch (err) {
    return { sent: false, event_id: payload.id, reason: err.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE' };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Admin check of a merchant's webhook endpoint: sends one test event and explains what came back (reachable? which answer?
 * how fast?) so a badly configured endpoint can be named: wrong address, certificate, server error, refused, redirect...
 * Unlike the merchant-facing test, the details are returned: it is only reachable by the admin team.
 */
async function probe(merchantId) {
  const endpoint = await supabase.selectOne('webhook_endpoints', { merchant_id: merchantId, active: true });
  if (!endpoint) return { configured: false, ok: false, level: 'info', diagnosis: "Aucun webhook enregistré : le marchand doit interroger l'API pour connaître le statut de ses paiements.", checked_at: new Date().toISOString() };
  let host = null;
  try { host = new URL(endpoint.url).host; } catch (e) { /* shown as invalid below */ }
  const result = { configured: true, url_host: host, https: /^https:/i.test(endpoint.url), checked_at: new Date().toISOString() };
  const finish = (level, diagnosis, extra) => { const out = Object.assign(result, { ok: level === 'ok', level, diagnosis }, extra || {}); webhookHealth.recordProbe(merchantId, out); return out; };
  if (!host) return finish('bad', "L'adresse du webhook enregistrée est invalide.");
  try { await urlSafety.assertPublicUrl(endpoint.url); } catch (e) {
    return finish('bad', "L'adresse n'est pas publique (localhost, adresse interne ou domaine inconnu) : nos serveurs ne peuvent pas l'atteindre depuis Internet.");
  }
  const payload = { id: `evt_${randomHex(12)}`, event: 'webhook.test', created_at: new Date().toISOString(), data: { message: 'Test de connexion envoyé par Freda Pay Issuing.' }, sent_by_admin: true };
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', endpoint.secret).update(body).digest('hex');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const started = Date.now();
  try {
    const res = await fetch(endpoint.url, {
      redirect: 'manual', method: 'POST', signal: controller.signal, body,
      headers: { 'Content-Type': 'application/json', 'X-Freda-Signature': `sha256=${signature}`, 'X-Freda-Event-Id': payload.id, 'X-Freda-Delivery-Attempt': '1' },
    });
    const ms = Date.now() - started;
    const s = res.status;
    const extra = { http_status: s, ms };
    if (s >= 200 && s < 300) return finish(ms > 5000 ? 'warn' : 'ok', ms > 5000 ? `Le serveur répond (${s}) mais très lentement (${(ms / 1000).toFixed(1)} s) : il risque de dépasser notre délai de 10 s.` : `Le serveur répond correctement (${s}) en ${ms} ms.`, extra);
    if (s >= 300 && s < 400) return finish('bad', `L'adresse redirige ailleurs (${s}) : nos notifications ne suivent pas les redirections. Le marchand doit enregistrer l'adresse finale.`, extra);
    if (s === 401 || s === 403) return finish('bad', `Le serveur du marchand refuse la requête (${s}) : il exige une authentification ou bloque nos adresses. Il doit accepter les requêtes signées (en-tête X-Freda-Signature).`, extra);
    if (s === 404) return finish('bad', "Adresse introuvable (404) : l'URL du webhook est incorrecte ou la route n'existe pas sur le serveur du marchand.", extra);
    if (s === 405) return finish('bad', "Le serveur refuse la méthode POST (405) : la route du webhook doit accepter POST.", extra);
    if (s === 429) return finish('warn', 'Le serveur du marchand limite nos requêtes (429).', extra);
    if (s >= 500) return finish('bad', `Le serveur du marchand plante (${s}) : erreur dans son code ou serveur indisponible.`, extra);
    return finish('warn', `Réponse inattendue (${s}).`, extra);
  } catch (err) {
    const code = (err.cause && err.cause.code) || err.code || '';
    if (err.name === 'AbortError') return finish('bad', 'Aucune réponse après 8 secondes : le serveur est trop lent ou injoignable.', { ms: 8000 });
    if (code === 'ENOTFOUND') return finish('bad', 'Nom de domaine introuvable : le domaine du webhook n\'existe pas ou son DNS est mal configuré.');
    if (code === 'ECONNREFUSED') return finish('bad', 'Connexion refusée : le serveur ne répond pas sur ce port (service arrêté ou mauvais port).');
    if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code + ' ' + err.message)) return finish('bad', 'Certificat HTTPS invalide, expiré ou auto-signé : le marchand doit installer un certificat valide.');
    return finish('bad', `Le serveur est injoignable (${code || err.message}).`);
  } finally { clearTimeout(timer); }
}

/** Probes every registered webhook (a few at a time) and returns the results by merchant. */
async function probeAll() {
  const endpoints = await supabase.select('webhook_endpoints', { active: true }, { select: 'merchant_id', limit: 200 });
  const ids = endpoints.map((e) => e.merchant_id);
  const out = {};
  for (let i = 0; i < ids.length; i += 5) {
    await Promise.all(ids.slice(i, i + 5).map(async (id) => { out[id] = await probe(id).catch(() => ({ ok: false, level: 'bad', diagnosis: 'Le test a échoué.' })); }));
  }
  return out;
}

module.exports = { dispatch, deliverNow, probe, probeAll };
