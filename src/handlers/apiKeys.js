'use strict';
const supabase = require('../lib/supabase');
const { generateApiKeyId, generateApiSecret, randomHex } = require('../utils/ids');
const { sha256 } = require('../middleware/apiKey');

async function create(ctx) {
  const requestedMode = ctx.body && ctx.body.mode === 'live' ? 'live' : 'test';

  if (requestedMode === 'test') {
    // In Live, test keys are off the table: switch the dashboard back to Sandbox to make one.
    const merchantNow = await supabase.selectOne('merchants', { id: ctx.merchantId });
    if (merchantNow && merchantNow.active_mode === 'live') {
      const err = new Error('Vous êtes en mode Live. Repassez en Sandbox pour créer une clé de test.');
      err.httpStatus = 403;
      err.code = 'TEST_KEY_IN_LIVE';
      throw err;
    }
  }

  if (requestedMode === 'live') {
    const merchant = await supabase.selectOne('merchants', { id: ctx.merchantId });
    // A live key only requires Gateway Live - the same key is used for both
    // products, but Issuing endpoints separately check issuing_live_enabled
    // when that key is actually used for a card action (see apiKey.js).
    if (!merchant || !merchant.gateway_live_enabled) {
      const err = new Error(
        "Ce compte n'est pas encore activé pour le mode Live. Complétez la vérification KYC/KYB d'abord."
      );
      err.httpStatus = 403;
      err.code = 'LIVE_NOT_ENABLED';
      throw err;
    }
  }

  const id = `key_${randomHex(8)}`;
  const keyId = generateApiKeyId(requestedMode);
  const secret = generateApiSecret(requestedMode);

  await supabase.insert('api_keys', {
    id,
    merchant_id: ctx.merchantId,
    key_id: keyId,
    secret_hash: sha256(secret),
    mode: requestedMode,
  });

  return {
    status: 201,
    body: {
      id,
      key_id: keyId,
      mode: requestedMode,
      // The secret is only ever returned once, at creation time.
      secret,
      warning: 'Conservez cette clé secrète maintenant : elle ne sera plus jamais affichée.',
    },
  };
}

async function list(ctx) {
  const keys = await supabase.select(
    'api_keys',
    { merchant_id: ctx.merchantId },
    { select: 'id,key_id,mode,created_at,revoked_at', order: 'created_at.desc' }
  );
  return { status: 200, body: { keys } };
}

async function revoke(ctx) {
  await supabase.update(
    'api_keys',
    { id: ctx.params.id, merchant_id: ctx.merchantId },
    { revoked_at: new Date().toISOString() }
  );
  require('../middleware/apiKey').invalidateKey(ctx.params.id); // stop honouring it immediately, not after the cache TTL
  return { status: 200, body: { revoked: true } };
}

module.exports = { create, list, revoke };
