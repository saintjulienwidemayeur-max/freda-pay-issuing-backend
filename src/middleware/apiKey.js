'use strict';
const crypto = require('crypto');
const supabase = require('../lib/supabase');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}


// Every /v1 request used to cost two sequential database round trips (key,
// then merchant). A short in-memory cache removes them from the hot path.
// Only successful lookups are cached, and revoking a key evicts it at once
// (see invalidateKey), so a revoked key stops working immediately on this
// instance. Merchant changes (e.g. live_enabled) apply within CACHE_TTL_MS.
const CACHE_TTL_MS = 15 * 1000;
const CACHE_MAX = 5000;
const authCache = new Map(); // secret hash -> { keyId, merchant, expires }

function cacheGet(hash) {
  const e = authCache.get(hash);
  if (!e) return null;
  if (Date.now() > e.expires) { authCache.delete(hash); return null; }
  return e;
}

function cacheSet(hash, value) {
  if (authCache.size >= CACHE_MAX) authCache.delete(authCache.keys().next().value);
  const e = Object.assign({ expires: Date.now() + CACHE_TTL_MS }, value);
  authCache.set(hash, e);
  return e;
}

/** Evicts every cached entry for a key id (called when a key is revoked). */
function invalidateKey(keyId) {
  for (const [hash, e] of authCache.entries()) if (e.keyId === keyId) authCache.delete(hash);
}

/** Test/support hook: drop everything. */
function clearAuthCache() { authCache.clear(); }

/**
 * Requires a valid Freda Pay API key:
 *   Authorization: Bearer sk_test_xxx   (or sk_live_xxx)
 * We hash the presented secret and look it up directly - the hash is
 * effectively unique per key, so no separate key_id lookup is needed.
 */
async function requireApiKey(ctx) {
  const header = ctx.req.headers['authorization'] || '';
  const match = header.match(/^Bearer\s+(sk_(test|live)_[a-f0-9]+)$/i);
  if (!match) {
    throw httpError(401, 'MISSING_API_KEY', "Clé API manquante ou mal formée (attendu: 'Bearer sk_test_...').");
  }
  const secret = match[1];
  const mode = match[2].toLowerCase();
  const hash = sha256(secret);

  let entry = cacheGet(hash);
  if (!entry) {
    const keyRow = await supabase.selectOne('api_keys', { secret_hash: hash, revoked_at: 'is.null' });
    if (!keyRow) {
      throw httpError(401, 'INVALID_API_KEY', 'Clé API invalide ou révoquée.');
    }
    const merchantRow = await supabase.selectOne('merchants', { id: keyRow.merchant_id });
    if (!merchantRow) {
      throw httpError(401, 'MERCHANT_NOT_FOUND', 'Marchand introuvable pour cette clé.');
    }
    entry = cacheSet(hash, { keyId: keyRow.id, merchant: merchantRow });
  }
  const merchant = entry.merchant;

  // A suspended account is suspended everywhere: dashboard AND API keys.
  if (merchant.deleted_at) {
    throw httpError(403, 'ACCOUNT_SUSPENDED', 'Ce compte est suspendu. Contactez issuing@fredapay.com.');
  }

  if (mode === 'live' && !merchant.gateway_live_enabled) {
    throw httpError(
      403,
      'LIVE_NOT_ENABLED',
      "Ce compte n'est pas encore activé pour le mode Live. Complétez la vérification KYC/KYB."
    );
  }
  // Issuing (cards) requires its own separate Live approval, even when
  // Gateway is already live - KYC/KYB never auto-grants this one.
  const isIssuingRoute = /^\/v1\/cards(\/|$)/.test((ctx.req.url || '').split('?')[0]);
  if (mode === 'live' && isIssuingRoute && !merchant.issuing_live_enabled) {
    throw httpError(
      403,
      'ISSUING_LIVE_NOT_ENABLED',
      "L'accès Issuing en mode Live n'a pas encore été accordé pour ce compte. Envoyez une demande depuis le tableau de bord."
    );
  }

  ctx.merchantId = merchant.id;
  ctx.merchant = merchant;
  ctx.apiKeyMode = mode;
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { requireApiKey, sha256, invalidateKey, clearAuthCache };
