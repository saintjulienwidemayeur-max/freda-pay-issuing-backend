'use strict';
const config = require('../config');

function baseUrl() {
  return config.plopplop.baseUrl.replace(/\/+$/, '');
}

const MAX_REDIRECTS = 3;

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
    res = await fetch(url, { method: 'POST', headers: allHeaders, body: payload, redirect: 'manual' });
    const location = res.headers.get('location');
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
    data = await res.json();
  } catch (e) {
    data = null;
  }
  return { httpStatus: res.status, data };
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

/** Step 2: obtain a short-lived, signed withdrawal token. */
async function getWithdrawalToken({ marchandToken, amount, method, recipient, reference, timestamp, signature }) {
  return postJson(
    '/api/auth/marchand/withdrawal-token',
    { amount, method, recipient, reference, timestamp, withdrawal_signature: signature },
    { Authorization: `Bearer ${marchandToken}` }
  );
}

/** Step 3: execute the withdrawal using the token from step 2. */
async function executeWithdrawal({ withdrawalToken, amount, method, recipient, reference }) {
  return postJson(
    '/api/withdraw/marchand',
    { amount, method, recipient, reference },
    { Authorization: `Bearer ${withdrawalToken}` }
  );
}

/** Check the status of a previously created withdrawal, by reference. */
async function verifyWithdrawal({ authToken, reference }) {
  return postJson('/api/withdraw/marchand/verify', { reference }, { Authorization: `Bearer ${authToken}` });
}

module.exports = {
  createPayment,
  verifyPayment,
  authMerchant,
  getWithdrawalToken,
  executeWithdrawal,
  verifyWithdrawal,
};
