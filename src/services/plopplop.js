'use strict';
const http = require('http');
const https = require('https');
const config = require('../config');

function baseUrl() {
  return config.plopplop.baseUrl.replace(/\/+$/, '');
}

const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 30000;

/**
 * One POST with the header names written exactly as in the provider's documentation (Authorization, Content-Type).
 * fetch() sends every header name in lower case; a provider that reads headers case-sensitively (some PHP stacks do)
 * then reports "Jeton d'authentification manquant" although the token is there.
 */
function rawPost(url, headers, payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'POST',
      headers: Object.assign({}, headers, { 'Content-Length': Buffer.byteLength(payload) }),
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location || null, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}

/** The same provider on another name (www., api., the apex) or upgraded to https: the only redirect it is safe to re-send our credentials to. */
function sameProvider(from, to) {
  const root = (h) => h.replace(/^(www|api)\./i, '').toLowerCase();
  return root(from.hostname) === root(to.hostname) && (to.protocol === 'https:' || from.protocol === to.protocol);
}

/**
 * POST JSON. Redirects are followed by hand: fetch silently DROPS the Authorization header when a redirect changes the
 * host (http -> https, apex -> www), and the provider then answers "Jeton d'authentification manquant" on every call that
 * carries a token (withdrawals) while the calls that authenticate in the body (payments) keep working.
 */
async function postJson(path, body, headers) {
  let url = `${baseUrl()}${path}`;
  const payload = JSON.stringify(body);
  const allHeaders = Object.assign({ 'Content-Type': 'application/json' }, headers || {});
  let res;
  for (let hop = 0; ; hop++) {
    res = await rawPost(url, allHeaders, payload);
    const location = res.location;
    if (![301, 302, 303, 307, 308].includes(res.status) || !location) break;
    if (hop >= MAX_REDIRECTS) break;
    const next = new URL(location, url);
    if (!sameProvider(new URL(url), next)) {
      // eslint-disable-next-line no-console
      console.error(`PlopPlop redirected ${url} to another site (${next.host}): not followed. Set PLOPPLOP_BASE_URL to the final address.`);
      break;
    }
    // eslint-disable-next-line no-console
    console.warn(`PlopPlop redirected ${url} -> ${next.href}. Set PLOPPLOP_BASE_URL to the final address to save a round trip.`);
    url = next.href;
  }
  let data;
  try {
    data = JSON.parse(res.text);
  } catch (e) {
    data = null;
  }
  return { httpStatus: res.status, data, finalUrl: url, sentAuth: !!allHeaders.Authorization && !!allHeaders['X-Authorization'] && !!allHeaders['X-Access-Token'], redirected: url !== `${baseUrl()}${path}` };
}

/**
 * Create a merchant payment (accept MonCash / Natcash / carte / moncash_ussd).
 * refferenceId must be globally unique across ALL Freda merchants - see
 * utils/ids.js#namespaceReference, which the caller is responsible for using.
 */
async function createPayment({ refferenceId, montant, paymentMethod, phoneNumber }) {
  const body = {
    client_id: config.plopplop.clientId,
    refference_id: refferenceId,
    montant,
    payment_method: paymentMethod,
  };
  if (paymentMethod === 'moncash_ussd') body.phone_number = phoneNumber;
  return postJson('/api/paiement-marchand', body);
}

/** Check the status of a previously created payment. */
async function verifyPayment({ refferenceId }) {
  return postJson('/api/paiement-verify', {
    client_id: config.plopplop.clientId,
    refference_id: refferenceId,
  });
}

/** Step 1 of the withdrawal flow: authenticate as the (single) Freda merchant on PlopPlop. */
async function authMerchant() {
  return postJson('/api/auth/marchand', {
    client_id: config.plopplop.clientId,
    client_secret: config.plopplop.clientSecret,
  });
}

/**
 * The provider runs on Apache, which commonly removes the Authorization header before the application sees it ("Jeton
 * d'authentification manquant" with a valid token). Its CORS headers list X-Authorization and X-Access-Token as accepted
 * alternatives, so the token travels in all three: whichever one survives is read.
 */
function bearerHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'X-Authorization': `Bearer ${token}`, 'X-Access-Token': String(token) };
}

/** Step 2: obtain a short-lived, signed withdrawal token. */
async function getWithdrawalToken({ marchandToken, amount, method, recipient, reference, timestamp, signature }) {
  return postJson(
    '/api/auth/marchand/withdrawal-token',
    { amount, method, recipient, reference, timestamp, withdrawal_signature: signature },
    bearerHeaders(marchandToken)
  );
}

/** Step 3: execute the withdrawal using the token from step 2. */
async function executeWithdrawal({ withdrawalToken, amount, method, recipient, reference }) {
  return postJson(
    '/api/withdraw/marchand',
    { amount, method, recipient, reference },
    bearerHeaders(withdrawalToken)
  );
}

/** Check the status of a previously created withdrawal, by reference. */
async function verifyWithdrawal({ authToken, reference }) {
  return postJson('/api/withdraw/marchand/verify', { reference }, bearerHeaders(authToken));
}

module.exports = {
  createPayment,
  verifyPayment,
  authMerchant,
  getWithdrawalToken,
  executeWithdrawal,
  verifyWithdrawal,
};
