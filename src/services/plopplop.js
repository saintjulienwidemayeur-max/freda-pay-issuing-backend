'use strict';
const config = require('../config');

function baseUrl() {
  return config.plopplop.baseUrl.replace(/\/+$/, '');
}

async function postJson(path, body, headers) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: JSON.stringify(body),
  });
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
