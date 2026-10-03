'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const maplerad = require('../src/services/maplerad');

test('known provider messages become one short, simple French sentence', () => {
  const t = maplerad.translateKnownMessage;
  assert.equal(t('Insufficient balance to complete this transaction'), 'Solde insuffisant pour cette opération.');
  assert.equal(t('Customer not found'), 'Titulaire introuvable.');
  assert.equal(t('Card not found'), 'Carte introuvable.');
  assert.equal(t('Card already frozen'), 'Cette carte est déjà gelée.');
  assert.equal(t('customer is already enrolled'), 'Ce titulaire existe déjà.');
  assert.equal(t("Key: 'CreateCardRequest.CustomerID' Error:Field validation for 'CustomerID' failed on the 'required' tag"), 'Une information obligatoire est manquante ou invalide.');
  assert.match(t('KYC required for this action'), /vérification d'identité/);
});

test('credential / access problems are shown as a neutral temporary failure, never as configuration hints', () => {
  const temp = 'Service momentanément indisponible. Réessayez dans un instant.';
  assert.equal(maplerad.translateKnownMessage('Unauthorized'), temp);
  assert.equal(maplerad.translateStatus(401), temp);
  assert.equal(maplerad.translateStatus(503), temp);
});

test('an unrecognized message returns null so the caller shows a neutral sentence, never the raw text', () => {
  assert.equal(maplerad.translateKnownMessage('Some brand new error message we have never seen before'), null);
});

test('no user-facing message ever names the provider or its own vocabulary', () => {
  for (const code of [400, 401, 403, 404, 409, 422, 429, 500, 503]) {
    assert.doesNotMatch(maplerad.translateStatus(code), /maplerad|fournisseur|clé/i);
  }
});
