'use strict';
const supabase = require('../lib/supabase');
const webhookDispatcher = require('../services/webhookDispatcher');
const rateLimit = require('../utils/rateLimit');
const { planKeyFor } = require('../services/plans');

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

/**
 * GET /v1/ping
 * "Is my API key accepted, and is my account configured?" The key itself was already validated by the API-key
 * middleware (invalid / revoked / suspended / Live-not-enabled keys never get here: they get a precise error
 * from the middleware instead). This returns a checklist of what the key can do. Never returns secrets.
 */
async function ping(ctx) {
  const m = ctx.merchant;
  const mode = ctx.apiKeyMode; // 'test' | 'live'
  const live = mode === 'live';
  const endpoint = await supabase.selectOne('webhook_endpoints', { merchant_id: m.id });
  const webhookOk = !!(endpoint && endpoint.active);

  const checks = [
    { id: 'key', ok: true, label: 'Clé API reconnue', detail: `Environnement : ${live ? 'Live (argent réel)' : 'Sandbox (argent fictif)'}.` },
    { id: 'account', ok: true, label: 'Compte actif', detail: m.business_name || m.id },
    {
      id: 'payments', ok: true, label: 'Paiements et retraits',
      detail: live ? 'Autorisés en Live (KYC/KYB validé).' : 'Disponibles en Sandbox.',
    },
    {
      id: 'cards', ok: !live || !!m.issuing_live_enabled, label: 'Émission de cartes',
      detail: !live ? 'Disponible en Sandbox.' : (m.issuing_live_enabled ? 'Autorisée en Live.' : "Pas encore autorisée en Live : envoyez une demande « Accès Issuing » depuis le tableau de bord."),
    },
    {
      id: 'webhook', ok: webhookOk, label: 'Endpoint webhook',
      detail: webhookOk ? `Enregistré : ${endpoint.url}` : "Aucun endpoint enregistré (facultatif : sans lui, utilisez le polling). Enregistrez-en un avec POST /v1/webhooks.",
      optional: true,
    },
  ];

  return {
    status: 200,
    body: {
      ok: checks.filter((c) => !c.optional).every((c) => c.ok),
      mode: live ? 'live' : 'test',
      merchant: { id: m.id, business_name: m.business_name },
      account: {
        gateway_live_enabled: !!m.gateway_live_enabled,
        issuing_live_enabled: !!m.issuing_live_enabled,
        gateway_plan: planKeyFor(m, 'gateway', live ? 'live' : 'sandbox'),
        issuing_plan: planKeyFor(m, 'issuing', live ? 'live' : 'sandbox'),
      },
      webhook: { configured: webhookOk, url: webhookOk ? endpoint.url : null },
      checks,
    },
  };
}

/**
 * POST /v1/webhooks/test
 * Sends a signed `webhook.test` event to the merchant's registered endpoint right now and reports whether their
 * server answered 2xx. Lets a developer verify URL, firewall and signature code before going live.
 */
async function webhookTest(ctx) {
  const who = `webhook-test:${ctx.merchantId}`;
  if (rateLimit.isLimited(who, 10).limited) throw httpError(429, 'RATE_LIMITED', 'Trop de tests webhook. Réessayez dans une minute.');
  rateLimit.hit(who, 10, 60 * 1000);

  const result = await webhookDispatcher.deliverNow(ctx.merchantId, 'webhook.test', {
    message: 'Ceci est un événement de test envoyé par Freda Pay Issuing.',
    mode: ctx.apiKeyMode === 'live' ? 'live' : 'test',
  });
  if (result.reason === 'NO_ENDPOINT') {
    throw httpError(409, 'NO_WEBHOOK_ENDPOINT', "Aucun endpoint webhook n'est enregistré. Enregistrez-en un avec POST /v1/webhooks.");
  }
  return { status: 200, body: { event: 'webhook.test', ...result } };
}

module.exports = { ping, webhookTest };
