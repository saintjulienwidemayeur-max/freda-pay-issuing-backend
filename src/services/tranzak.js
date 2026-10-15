'use strict';
const crypto = require('crypto');
const config = require('../config');

/**
 * Tranzak: CARD payments only (USD). The API key alone decides the environment, so each platform mode uses its own
 * key: sandbox -> TRANZAK_TEST_KEY (tk_test_...), live -> TRANZAK_LIVE_KEY (tk_live_...). The word "Tranzak" never
 * appears in a message a merchant or a customer can read: errors are translated below.
 */
function baseUrl() {
  return config.tranzak.baseUrl.replace(/\/+$/, '');
}
function keyFor(mode) {
  return mode === 'live' ? config.tranzak.liveKey : config.tranzak.testKey;
}
function isConfigured(mode) {
  return !!keyFor(mode);
}

function fail(code, message, httpStatus) {
  const err = new Error(message);
  err.code = code;
  if (httpStatus) err.httpStatus = httpStatus;
  return err;
}

/** The API puts the payment at the root on creation and inside `data` on reads: accept both. */
function unwrap(body) {
  if (body && body.data && typeof body.data === 'object' && !Array.isArray(body.data)) return body.data;
  return body || {};
}

function errorCodeOf(body) {
  if (!body) return '';
  const e = body.error;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') return String(e.code || e.type || '');
  return String(body.code || body.message || '');
}

/** Provider errors, in words a merchant can act on. */
function translateError(httpStatus, body) {
  const code = errorCodeOf(body);
  if (code.includes('payment_method_not_approved') || (httpStatus === 403 && !code)) {
    return fail('CARD_NOT_AVAILABLE', "Le paiement par carte n'est pas encore activé pour ce compte en mode Live. Contactez le support.", 403);
  }
  if (code.includes('amount_too_low')) {
    return fail('AMOUNT_TOO_LOW', `Le montant minimum d'un paiement par carte est de ${config.tranzak.minimumUSD} USD.`, 400);
  }
  if (httpStatus === 401) return fail('PROVIDER_ERROR', 'Le service de paiement par carte est momentanément indisponible. Réessayez dans un instant.', 502);
  if (httpStatus === 429) return fail('PROVIDER_BUSY', 'Le service de paiement par carte est très sollicité. Réessayez dans quelques secondes.', 503);
  return fail('PROVIDER_ERROR', 'Le service de paiement par carte est momentanément indisponible. Réessayez dans un instant.', 502);
}

async function call(mode, method, path, body) {
  const key = keyFor(mode);
  if (!key) throw fail('PROVIDER_ERROR', "Le paiement par carte n'est pas encore disponible. Réessayez plus tard.", 502);
  let res;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const err = fail('PROVIDER_ERROR', 'Le service de paiement par carte est momentanément indisponible. Réessayez dans un instant.', 502);
    err.network = true;
    throw err;
  }
  let data = null;
  try { data = await res.json(); } catch (_) { data = null; }
  return { httpStatus: res.status, data };
}

/** Finds a payment by OUR reference (the provider has no idempotency key: look first, before ever retrying a creation). */
async function findByReference(mode, reference) {
  const res = await call(mode, 'GET', `/payments/reference/${encodeURIComponent(reference)}`);
  if (res.httpStatus === 404) return null;
  if (res.httpStatus >= 400) throw translateError(res.httpStatus, res.data);
  const p = unwrap(res.data);
  return p && p.transaction_id ? p : null;
}

/** Creates a card payment. Returns { transactionId, clientSecret, publishableKey, status }. */
async function createCardPayment(mode, { amount, reference, customerName, customerEmail, customerPhone, description, metadata }) {
  const body = {
    amount,
    currency: 'USD',
    payment_method: 'card',
    customer_name: customerName || 'Client',
    reference,
  };
  if (customerEmail) body.customer_email = customerEmail;
  if (customerPhone) body.customer_phone = customerPhone;
  if (description) body.description = String(description).slice(0, 200);
  if (metadata) body.metadata = metadata;

  const res = await call(mode, 'POST', '/payments', body);
  if (res.httpStatus >= 400 || !res.data) throw translateError(res.httpStatus, res.data);
  const p = unwrap(res.data);
  if (!p.transaction_id || !p.client_secret || !p.publishable_key) {
    throw fail('PROVIDER_ERROR', 'Le service de paiement par carte est momentanément indisponible. Réessayez dans un instant.', 502);
  }
  return {
    transactionId: String(p.transaction_id),
    clientSecret: p.client_secret,
    publishableKey: p.publishable_key,
    status: p.status,
  };
}

/** Reads a payment. Returns the payment object, or null when the provider does not know it (404). */
async function retrievePayment(mode, transactionId) {
  const res = await call(mode, 'GET', `/payments/${encodeURIComponent(transactionId)}`);
  if (res.httpStatus === 404) return null;
  if (res.httpStatus >= 400 || !res.data) throw translateError(res.httpStatus, res.data);
  return unwrap(res.data);
}

/** Maps the provider's status onto ours: pending | succeeded | failed. */
function mapStatus(status) {
  if (status === 'completed') return 'succeeded';
  if (status === 'failed') return 'failed';
  return 'pending';
}

/**
 * Verifies a webhook: hex HMAC-SHA256 of the RAW body with the website's secret. Tries the sandbox then the live
 * secret; the one that matches is the only trusted source of the mode. Returns 'sandbox' | 'live' | null.
 */
function verifyWebhook(rawBody, signature) {
  const sig = String(signature || '');
  if (!sig || !rawBody) return null;
  for (const [mode, secret] of [['sandbox', config.tranzak.testWebhookSecret], ['live', config.tranzak.liveWebhookSecret]]) {
    if (!secret) continue;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    if (expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return mode;
  }
  return null;
}

module.exports = { isConfigured, createCardPayment, retrievePayment, findByReference, mapStatus, verifyWebhook, translateError, unwrap };
