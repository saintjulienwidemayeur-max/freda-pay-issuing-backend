'use strict';
const crypto = require('crypto');
const config = require('../config');

/**
 * Monerails card-issuing API (https://docs.monerails.com), SANDBOX ONLY.
 * Used by the admin panel to test the partner: nothing here touches a merchant, a merchant card, the ledger or the Master Wallet.
 *   - only a test key (mr_test_...) is accepted: a live key is refused outright, so no real money can move from here;
 *   - amounts are sent in US cents, as the API expects;
 *   - every POST carries an Idempotency-Key, so a retry never runs twice.
 */
function httpError(status, code, message, extra) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  if (extra) err.details = extra;
  return err;
}

/**
 * The key for an environment. Test (mr_test_...) and live (mr_live_...) keys are kept apart: a key of the wrong kind is refused, so the
 * test page can never move real money and live cards never fall back to the test environment.
 */
function key(mode) {
  if (mode === 'live') {
    const k = config.monerails.liveKey;
    if (!k) throw httpError(409, 'MONERAILS_LIVE_NOT_CONFIGURED', 'Aucune clé Live Monerails : ajoutez-la (mr_live_...) dans Admin > Monerails, ou MONERAILS_LIVE_KEY sur le serveur.');
    if (!/^mr_live_/.test(k)) throw httpError(409, 'MONERAILS_LIVE_KEY_INVALID', 'La clé Live Monerails doit commencer par mr_live_.');
    return k;
  }
  const k = config.monerails.testKey;
  if (!k) throw httpError(409, 'MONERAILS_NOT_CONFIGURED', 'Aucune clé Monerails : ajoutez la clé de test (mr_test_...) dans Agent IA > Clés API, ou MONERAILS_TEST_KEY sur le serveur.');
  if (!/^mr_test_/.test(k)) throw httpError(409, 'MONERAILS_LIVE_KEY_REFUSED', "Seule une clé de TEST Monerails (mr_test_...) est acceptée ici.");
  return k;
}
const configured = (mode) => (mode === 'live' ? /^mr_live_/.test(config.monerails.liveKey || '') : /^mr_test_/.test(config.monerails.testKey || ''));

async function callRaw(method, path, body, { idempotencyKey, mode } = {}) {
  const headers = { Authorization: `Bearer ${key(mode)}`, Accept: 'application/json', 'Accept-Language': 'fr' };
  if (body) headers['Content-Type'] = 'application/json';
  if (method === 'POST') headers['Idempotency-Key'] = idempotencyKey || `fp-${crypto.randomBytes(12).toString('hex')}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25000);
  let res;
  try {
    res = await fetch(`${config.monerails.baseUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
  } catch (e) {
    throw httpError(424, 'MONERAILS_UNREACHABLE', e.name === 'AbortError' ? "Monerails n'a pas répondu à temps." : `Monerails est injoignable : ${e.message}`);
  } finally { clearTimeout(timer); }
  let data = null;
  try { data = await res.json(); } catch (e) { /* empty body */ }
  if (!res.ok) {
    const e = (data && data.error) || {};
    // HTTP 424: Render replaces 502/503/504 with its own page (no CORS); the admin must see Monerails' real code and message.
    throw httpError(res.status >= 500 ? 424 : res.status === 401 || res.status === 403 ? 424 : res.status, `MONERAILS_${String(e.code || res.status).toUpperCase()}`,
      `Monerails (HTTP ${res.status}${e.code ? `, ${e.code}` : ''}) : ${String(e.message || 'erreur').slice(0, 300)}${e.param ? ` [champ : ${e.param}]` : ''}`,
      { request_id: e.request_id || res.headers.get('request-id') || null });
  }
  return { status: res.status, data: data || {} };
}

const cents = (usd) => {
  const n = Math.round(Number(usd) * 100);
  if (!Number.isFinite(n) || n <= 0) throw httpError(400, 'INVALID_AMOUNT', 'Montant invalide (en dollars, ex. 10 ou 12.50).');
  return n;
};
const qs = (o) => { const p = Object.entries(o || {}).filter(([, v]) => v != null && v !== ''); return p.length ? `?${p.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}` : ''; };

function api(mode) {
  const call = (method, path, body, opts) => callRaw(method, path, body, Object.assign({}, opts, { mode }));
  return {
  balance: () => call('GET', '/balance'),
  listCardholders: (q) => call('GET', `/cardholders${qs({ limit: 100, ...q })}`),
  getCardholder: (id) => call('GET', `/cardholders/${encodeURIComponent(id)}`),
  createCardholder: (body) => call('POST', '/cardholders', body),
  submitVerification: (id, body) => call('POST', `/cardholders/${encodeURIComponent(id)}/verification`, body),
  testVerification: (id, result, reason) => call('POST', `/test/cardholders/${encodeURIComponent(id)}/verification`, { result, ...(reason ? { reason } : {}) }),
  listCards: (q) => call('GET', `/cards${qs({ limit: 100, ...q })}`),
  getCard: (id) => call('GET', `/cards/${encodeURIComponent(id)}`),
  createCard: (body) => call('POST', '/cards', body),
  fund: (id, amountCents) => call('POST', `/cards/${encodeURIComponent(id)}/fund`, { amount: amountCents }),
  withdraw: (id, amountCents) => call('POST', `/cards/${encodeURIComponent(id)}/withdraw`, { amount: amountCents }),
  freeze: (id) => call('POST', `/cards/${encodeURIComponent(id)}/freeze`),
  unfreeze: (id) => call('POST', `/cards/${encodeURIComponent(id)}/unfreeze`),
  terminate: (id) => call('POST', `/cards/${encodeURIComponent(id)}/terminate`),
  details: (id) => call('GET', `/cards/${encodeURIComponent(id)}/details`),
  testAuthorization: (id, body) => call('POST', `/test/cards/${encodeURIComponent(id)}/authorizations`, body),
  transactions: (q) => call('GET', `/transactions${qs({ limit: 100, ...q })}`),
  listEvents: (q) => call('GET', `/events${qs({ limit: 50, ...q })}`),
  listWebhookEndpoints: () => call('GET', '/webhook_endpoints'),
  createWebhookEndpoint: (url, events) => call('POST', '/webhook_endpoints', { url, events }),
  rotateWebhookSecret: (id) => call('POST', `/webhook_endpoints/${encodeURIComponent(id)}/rotate_secret`, { overlap_minutes: 0 }),

  };
}

module.exports = Object.assign(api('sandbox'), {
  configured,
  cents,
  /** The same calls for one environment: forMode('live') uses the live key, anything else the test key. */
  forMode: (mode) => api(mode === 'live' ? 'live' : 'sandbox'),

  /**
   * Monerail-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(t + "." + raw body, full whsec_ secret)> ; during a secret rotation two v1 values come.
   * Rejects an old timestamp (more than 5 minutes) and compares in constant time.
   */
  verifySignature(header, rawBody, secret, nowSec) {
    if (!secret || !header) return false;
    const parts = String(header).split(',').map((p) => p.trim());
    const t = (parts.find((p) => p.startsWith('t=')) || '').slice(2);
    const sigs = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
    if (!/^\d+$/.test(t) || !sigs.length) return false;
    if (Math.abs((nowSec || Date.now() / 1000) - Number(t)) > 300) return false;
    const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
    return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  },
  httpError,
});
