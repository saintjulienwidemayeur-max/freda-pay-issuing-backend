'use strict';
const crypto = require('crypto');

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** Freda merchant client_id, e.g. fp_live_8f2a9c... or fp_test_... */
function generateApiKeyId(mode) {
  return `pk_${mode}_${randomHex(12)}`;
}

/** Freda merchant secret key, shown once, e.g. sk_test_... */
function generateApiSecret(mode) {
  return `sk_${mode}_${randomHex(24)}`;
}

/** Internal Freda IDs for payments/payouts. */
function generatePaymentId() {
  return `pay_${randomHex(10)}`;
}
function generatePayoutId() {
  return `po_${randomHex(10)}`;
}
function generatePaymentLinkId() {
  return `lnk_${randomHex(12)}`;
}
function generateCardId() {
  return `card_${randomHex(10)}`;
}
function generateMerchantId() {
  return `mch_${randomHex(8)}`;
}

/**
 * Build a globally-unique PlopPlop reference by namespacing the merchant's
 * own reference with their Freda merchant id. This is required because ALL
 * Freda merchants share ONE PlopPlop account, and PlopPlop requires globally
 * unique reference ids across that single account.
 */
function namespaceReference(merchantId, ownReference) {
  return `fp_${merchantId}_${ownReference}`.slice(0, 64);
}

module.exports = {
  randomHex,
  generateApiKeyId,
  generateApiSecret,
  generatePaymentId,
  generatePayoutId,
  generatePaymentLinkId,
  generateCardId,
  generateMerchantId,
  namespaceReference,
};
