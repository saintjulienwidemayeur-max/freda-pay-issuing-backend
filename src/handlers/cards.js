'use strict';
const config = require('../config');
const cardOrchestrator = require('../services/cardOrchestrator');
const maplerad = require('../services/maplerad');
const identityImage = require('../services/identityImage');
const supabase = require('../lib/supabase');
const { generateCardId } = require('../utils/ids');
const { fetchPage } = require('../utils/pagination');
const { resolveMode } = require('../utils/mode');
const { parseAmount } = require('../utils/money');

const VALID_BRANDS = ['VISA', 'MASTERCARD'];

/** @deprecated kept for backward compat - returns the most recently created holder. */
async function getHolderProfile(ctx) {
  const profile = await cardOrchestrator.getHolderProfile(ctx.merchantId, await resolveMode(ctx));
  return { status: 200, body: { profile: profile ? toPublicProfile(profile) : null } };
}

/** All holders this merchant has enrolled, for picking one when issuing an individual card. */
async function listHolders(ctx) {
  const holders = await cardOrchestrator.listHolders(ctx.merchantId, await resolveMode(ctx));
  return { status: 200, body: { holders: holders.map(toPublicProfile) } };
}

async function getHolder(ctx) {
  const holder = await cardOrchestrator.getHolderById(ctx.merchantId, ctx.params.id);
  if (!holder) throw httpError(404, 'NOT_FOUND', 'Titulaire introuvable.');
  return { status: 200, body: { holder: toPublicProfile(holder) } };
}

const VALID_IDENTITY_TYPES = ['NIN', 'PASSPORT', 'VOTERS_CARD', 'DRIVERS_LICENSE'];
const HOLDER_REQUIRED_FIELDS = ['firstName', 'lastName', 'email', 'country', 'dob', 'identificationNumber', 'phoneNumber', 'phoneShortCode', 'address'];
const HOLDER_ADDRESS_REQUIRED_FIELDS = ['street', 'city', 'state', 'country'];

/** @deprecated old single-profile endpoint - now just creates a new holder, same as createHolder. */
async function submitHolderProfile(ctx) {
  return createHolder(ctx);
}

async function createHolder(ctx) {
  const b = ctx.body || {};
  const missing = HOLDER_REQUIRED_FIELDS.filter((f) => !b[f]);
  if (missing.length) {
    throw httpError(400, 'MISSING_FIELDS', `Champs requis manquants : ${missing.join(', ')}.`);
  }
  const missingAddress = HOLDER_ADDRESS_REQUIRED_FIELDS.filter((f) => !(b.address && b.address[f]));
  if (!(b.address && (b.address.postalCode || b.address.postal_code))) missingAddress.push('postalCode');
  if (missingAddress.length) {
    throw httpError(400, 'MISSING_FIELDS', `Adresse incomplète : ${missingAddress.join(', ')}.`);
  }
  const idn = b.identity || {};
  if (!VALID_IDENTITY_TYPES.includes(String(idn.type || '').toUpperCase())) {
    throw httpError(400, 'MISSING_FIELDS', `identity.type doit être l'un de : ${VALID_IDENTITY_TYPES.join(', ')}.`);
  }
  if (!idn.number) throw httpError(400, 'MISSING_FIELDS', 'identity.number est requis.');
  const idImage = String(idn.imageUrl || idn.image || '');
  if (!/^https:\/\//.test(idImage) && !identityImage.isDataUri(idImage)) {
    throw httpError(400, 'MISSING_FIELDS', "identity.imageUrl est requis : image de la pièce d'identité en Base64 (data:image/jpeg;base64,...) ou lien https vers l'image.");
  }
  const idBack = idn.imageBackUrl || idn.image_back;
  if (idBack && !/^https:\/\//.test(String(idBack)) && !identityImage.isDataUri(String(idBack))) {
    throw httpError(400, 'MISSING_FIELDS', "identity.imageBackUrl doit être le verso de la pièce en Base64 (data:image/jpeg;base64,...) ou un lien https vers l'image.");
  }
  if (idn.country && !/^[A-Za-z]{2}$/.test(idn.country)) {
    throw httpError(400, 'MISSING_FIELDS', 'identity.country doit être un code pays à 2 lettres.');
  }
  if (b.photoUrl) {
    const okFormat = /^data:image\/(png|jpe?g|webp);base64,/.test(b.photoUrl) || /^https:\/\//.test(b.photoUrl);
    if (!okFormat || String(b.photoUrl).length > 200000) {
      throw httpError(400, 'INVALID_PHOTO', 'photoUrl doit être une image (data URL png/jpeg/webp) de moins de 200 Ko, ou une URL https.');
    }
  }
  try {
    const profile = await cardOrchestrator.createHolder(ctx.merchantId, b, await resolveMode(ctx));
    const pub = toPublicProfile(profile);
    // 200 + already_existed when this email was already enrolled (no duplicate is created).
    if (profile.alreadyExisted) return { status: 200, body: { id: pub.id, already_existed: true, profile: pub, holder: pub } };
    return { status: 201, body: { id: pub.id, already_existed: false, profile: pub, holder: pub } };
  } catch (err) {
    throw httpError(err.httpStatus || 502, err.code || 'ENROLLMENT_ERROR', err.message);
  }
}

async function createCard(ctx) {
  const b = ctx.body || {};
  const { kind, brand, amount, reference, business_name, holder_id } = b;

  if (!reference) throw httpError(400, 'MISSING_FIELDS', 'reference est requis.');
  if (brand && !VALID_BRANDS.includes(brand)) throw httpError(400, 'INVALID_BRAND', "brand doit être 'VISA' ou 'MASTERCARD'.");
  // Strict number before anything is charged: a string like "100" must never reach the wallet arithmetic.
  if (kind === 'business' || (amount != null && amount !== 0)) parseAmount(amount);

  const existing = await cardOrchestrator.getByOwnReference(ctx.merchantId, reference);
  if (existing) return { status: 200, body: toPublicCard(existing, ctx) };

  if (kind === 'business' && config.businessCardsPaused) {
    throw httpError(503, 'BUSINESS_CARDS_PAUSED', "La création de cartes entreprise est temporairement suspendue. Aucun montant n'a été débité. Les cartes individuelles restent disponibles. Réessayez plus tard.");
  }

  const id = generateCardId();
  const mode = await resolveMode(ctx);
  // Dashboard (session) requests don't go through the API-key middleware's
  // Issuing-live check - enforce the same rule here so a merchant can't
  // create a real Live card from the dashboard before Issuing access was
  // actually approved, even if Gateway is already live.
  if (mode === 'live') {
    const merchant = ctx.merchant || (await supabase.selectOne('merchants', { id: ctx.merchantId }));
    if (!merchant || !merchant.issuing_live_enabled) {
      throw httpError(403, 'ISSUING_LIVE_NOT_ENABLED', "L'accès Issuing en mode Live n'a pas encore été accordé pour ce compte. Envoyez une demande depuis Soldes & Wallet.");
    }
  }

  try {
    // Fail BEFORE any wallet debit if this environment's provider key is missing or wrong.
    maplerad.assertReadyForIssuance(mode);
    let card;
    if (kind === 'business') {
      if (!business_name) throw httpError(400, 'MISSING_FIELDS', 'business_name est requis pour une carte entreprise.');
      card = await cardOrchestrator.createBusinessCard({
        merchantId: ctx.merchantId,
        id,
        ownReference: reference,
        businessName: business_name,
        brand: brand || 'MASTERCARD',
        amountUsd: amount,
        mode,
      });
    } else {
      card = await cardOrchestrator.createIndividualCard({
        merchantId: ctx.merchantId,
        id,
        ownReference: reference,
        brand: brand || 'VISA',
        amountUsd: amount,
        holderId: holder_id,
        mode,
      });
    }
    return { status: 202, body: toPublicCard(card, ctx) }; // 202: creation confirmed async via webhook
  } catch (err) {
    const out = err.httpStatus ? httpError(err.httpStatus, err.code, err.message) : httpError(502, 'CARD_SERVICE_ERROR', err.message);
    if (err.providerInfo) out.providerInfo = err.providerInfo; // kept for the admin "Erreurs cartes" view
    throw out;
  }
}

async function list(ctx) {
  const mode = await resolveMode(ctx);
  const kind = ctx.query && (ctx.query.kind === 'business' || ctx.query.kind === 'individual') ? ctx.query.kind : undefined;
  const { rows, pagination } = await fetchPage(ctx.query, (limit, offset) =>
    cardOrchestrator.list(ctx.merchantId, limit, offset, mode, kind)
  );
  return { status: 200, body: { cards: rows.map((c) => toPublicCard(c, ctx)), pagination, mode } };
}

async function get(ctx) {
  const card = await cardOrchestrator.getById(ctx.merchantId, ctx.params.id);
  if (!card) throw httpError(404, 'NOT_FOUND', 'Carte introuvable.');
  return { status: 200, body: toPublicCard(card, ctx) };
}

const TX_LABEL = {
  AUTHORIZATION: 'Achat', 'AUTHORIZATION-SETTLEMENT': 'Règlement', SETTLEMENT: 'Règlement', REFUND: 'Remboursement', REVERSAL: 'Annulation',
  DECLINE: 'Refusé', FUNDING: 'Recharge', WITHDRAWAL: 'Retrait', TERMINATION: 'Fermeture', 'CROSS-BORDER': 'Frais de change',
};
/** One transaction stored from the partner's notifications (card_transactions), in the public shape. */
function toPublicStored(t) {
  const type = String(t.type || '').toUpperCase();
  return {
    id: t.provider_reference, type, mode: t.direction || null, status: t.status || null, amount: t.amount_usd == null ? 0 : Number(t.amount_usd), currency: t.currency || 'USD',
    merchant_name: t.merchant_name || null, merchant_city: null, date: t.occurred_at || t.created_at || null, label: TX_LABEL[type] || 'Transaction',
  };
}

async function getTransactions(ctx) {
  const card = await cardOrchestrator.getById(ctx.merchantId, ctx.params.id);
  if (!card) throw httpError(404, 'NOT_FOUND', 'Carte introuvable.');
  if (!ctx.apiKeyMode && card.kind === 'individual') {
    throw httpError(403, 'INDIVIDUAL_CARD_DETAILS_HIDDEN', "L'activité d'une carte individuelle n'est visible que par son titulaire.");
  }
  if (!card.maplerad_card_id) {
    return { status: 200, body: { transactions: [], month_spend: 0, currency: 'USD' } };
  }

  // 1) What the partner told us, stored as it arrived: always available, exact, and fast.
  const stored = (await supabase.select('card_transactions', { card_id: card.id }, { order: 'occurred_at.desc', limit: 500 })).map(toPublicStored);
  const known = new Set(stored.map((t) => String(t.id)));

  // 2) The partner's own list adds what a notification may have missed. If the partner is unreachable, the stored list is still shown.
  let partnerOk = true;
  let extra = [];
  try {
    const res = await maplerad.forMode(card.mode).getCardTransactions(card.maplerad_card_id, {
      start_date: ctx.query.start_date,
      end_date: ctx.query.end_date,
      page: ctx.query.page,
      page_size: ctx.query.page_size,
    });
    const raw = (res && (res.data || res.transactions || res.result)) || [];
    extra = (Array.isArray(raw) ? raw : []).map(toPublicTransaction).filter((t) => t.id == null || !known.has(String(t.id)));
    extra.forEach((t) => { t.label = TX_LABEL[String(t.type || '').toUpperCase()] || 'Transaction'; });
  } catch (err) {
    partnerOk = false;
    if (!stored.length) {
      const out = httpError(err.httpStatus || 502, err.code || 'CARD_SERVICE_ERROR', err.message);
      if (err.providerInfo) out.providerInfo = err.providerInfo;
      throw out;
    }
  }

  const transactions = stored.concat(extra).sort((a, b) => (String(a.date) === String(b.date) ? 0 : String(a.date) < String(b.date) ? 1 : -1));
  const now = new Date();
  const thisMonth = (t) => { const d = new Date(t.date); return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth(); };
  const ok = (t) => !/DECLIN|FAIL|REJECT/.test(String(t.status || '').toUpperCase());
  const spent = transactions.filter((t) => t.type === 'AUTHORIZATION' && t.mode === 'DEBIT' && ok(t) && thisMonth(t)).reduce((sum, t) => sum + Math.abs(t.amount), 0);
  const back = transactions.filter((t) => (t.type === 'REFUND' || t.type === 'REVERSAL') && ok(t) && thisMonth(t)).reduce((sum, t) => sum + Math.abs(t.amount), 0);
  const monthSpend = Math.max(0, spent - back);

  return { status: 200, body: { transactions, month_spend: Math.round(monthSpend * 100) / 100, currency: 'USD', complete: partnerOk } };
}

/** Overview page: recent transactions across ALL of this merchant's cards (current mode only), newest first. */
async function getAllTransactions(ctx) {
  const mode = await resolveMode(ctx);
  // The partner's notifications are stored as they arrive (card_transactions): one fast read here, not one call to the
  // partner per card on every dashboard load. Business cards only: an end user's activity is not the merchant's to browse.
  const [businessCards, rows] = await Promise.all([
    cardOrchestrator.list(ctx.merchantId, 200, 0, mode, 'business'),
    supabase.select('card_transactions', { merchant_id: ctx.merchantId, mode }, { order: 'occurred_at.desc', limit: 200 }),
  ]);
  const byId = new Map(businessCards.map((c) => [c.id, c]));
  const all = rows
    .filter((t) => byId.has(t.card_id) && ['AUTHORIZATION', 'AUTHORIZATION-SETTLEMENT', 'REFUND', 'REVERSAL'].includes(t.type))
    .slice(0, 20)
    .map((t) => ({
      id: t.id, type: t.type, status: t.status, mode: t.direction, amount: t.amount_usd, currency: t.currency || 'USD',
      description: t.description, merchant_name: t.merchant_name, date: t.occurred_at,
      card_id: t.card_id, card_reference: byId.get(t.card_id).own_reference,
    }));
  return { status: 200, body: { transactions: all, mode } };
}

function toPublicTransaction(t) {
  return {
    id: t.id || t.reference || null,
    type: t.type || null,
    mode: t.mode || null, // CREDIT | DEBIT
    status: t.status || null,
    amount: typeof t.amount === 'number' ? t.amount / 100 : Number(t.amount || 0),
    currency: t.currency || 'USD',
    merchant_name: t.merchant && t.merchant.name,
    merchant_city: t.merchant && t.merchant.city,
    date: t.created_at || t.updated_at || null,
  };
}

/** Sandbox-only: simulate a real transaction on a card (purchase or credit), for testing. */
async function simulateTransaction(ctx) {
  const card = await cardOrchestrator.getById(ctx.merchantId, ctx.params.id);
  if (!card) throw httpError(404, 'NOT_FOUND', 'Carte introuvable.');
  // Decided by the CARD, not by the account: a sandbox card can always be
  // simulated (even for a merchant who is live elsewhere), a live card never.
  if ((card.mode || 'sandbox') === 'live') {
    throw httpError(403, 'LIVE_NOT_ALLOWED', 'La simulation de transaction est réservée au mode sandbox.');
  }
  if (!card.maplerad_card_id) throw httpError(409, 'CARD_NOT_READY', "Cette carte n'est pas encore active.");

  const amount = ctx.body && ctx.body.amount;
  const type = ctx.body && ctx.body.type === 'DEBIT' ? 'DEBIT' : 'CREDIT';
  parseAmount(amount);

  try {
    const res = await maplerad.forMode('sandbox').mockCardTransaction(card.maplerad_card_id, Math.round(amount * 100), type);
    return { status: 200, body: { simulated: true, response: res } };
  } catch (err) {
    throw httpError(err.httpStatus || 502, err.code || 'CARD_SERVICE_ERROR', err.message);
  }
}

/**
 * Returns the card's full number, CVV, and expiry to the merchant who owns
 * it, for their own business purchases. This is sensitive: never logged by
 * this handler, never stored, and only reachable by the account owner (the
 * same session/API-key auth as every other card endpoint) - never exposed
 * to whoever the merchant issues the card to.
 */
async function revealDetails(ctx) {
  const details = await cardOrchestrator.revealCardDetails(ctx.merchantId, ctx.params.id, { fromDashboard: !ctx.apiKeyMode });
  return { status: 200, body: details };
}

/** Optional idempotency key for fund / withdraw: body.reference, or the Idempotency-Key header. */
function idempotencyKey(ctx) {
  const raw = (ctx.body && ctx.body.reference) || (ctx.req && ctx.req.headers && ctx.req.headers['idempotency-key']) || '';
  const key = String(raw).trim();
  if (!key) return null;
  if (!/^[A-Za-z0-9._:\-]{1,64}$/.test(key)) throw httpError(400, 'INVALID_REFERENCE', "reference (ou Idempotency-Key) : 64 caractères maximum, lettres, chiffres et . _ : -");
  return key;
}

function withOperation(card, ctx) {
  const op = card._op || {};
  const { type, ...rest } = op;
  return { ...toPublicCard(card, ctx), ...rest, idempotent_replay: !!op.replayed };
}

async function fund(ctx) {
  const amount = ctx.body && ctx.body.amount;
  parseAmount(amount);
  try {
    const card = await cardOrchestrator.fundCard(ctx.merchantId, ctx.params.id, amount, idempotencyKey(ctx));
    return { status: 200, body: withOperation(card, ctx) };
  } catch (err) {
    throw httpError(err.httpStatus || 502, err.code || 'CARD_SERVICE_ERROR', err.message);
  }
}

async function withdraw(ctx) {
  const amount = ctx.body && ctx.body.amount;
  parseAmount(amount);
  try {
    const card = await cardOrchestrator.withdrawFromCard(ctx.merchantId, ctx.params.id, amount, idempotencyKey(ctx));
    return { status: 200, body: withOperation(card, ctx) };
  } catch (err) {
    throw httpError(err.httpStatus || 502, err.code || 'CARD_SERVICE_ERROR', err.message);
  }
}

async function freeze(ctx) {
  try {
    const card = await cardOrchestrator.freezeCard(ctx.merchantId, ctx.params.id);
    return { status: 200, body: toPublicCard(card, ctx) };
  } catch (err) {
    throw httpError(err.httpStatus || 502, err.code || 'CARD_SERVICE_ERROR', err.message);
  }
}

async function unfreeze(ctx) {
  try {
    const card = await cardOrchestrator.unfreezeCard(ctx.merchantId, ctx.params.id);
    return { status: 200, body: toPublicCard(card, ctx) };
  } catch (err) {
    throw httpError(err.httpStatus || 502, err.code || 'CARD_SERVICE_ERROR', err.message);
  }
}

async function terminate(ctx) {
  try {
    const card = await cardOrchestrator.terminateCard(ctx.merchantId, ctx.params.id);
    return { status: 200, body: { ...toPublicCard(card, ctx), deleted: true } };
  } catch (err) {
    throw httpError(err.httpStatus || 502, err.code || 'CARD_SERVICE_ERROR', err.message);
  }
}

function num(v) {
  return v == null ? v : Number(v);
}

function toPublicProfile(p) {
  return {
    id: p.id,
    mode: p.mode || 'sandbox',
    status: p.status,
    first_name: p.first_name,
    last_name: p.last_name,
    email: p.email,
    country: p.country,
    photo_url: p.photo_url || null,
    dob: p.dob || null,
    phone: p.phone_number ? `${p.phone_short_code || ''}${p.phone_number}` : null,
    address: p.address || null,
    identification_number_last4: p.identification_number ? String(p.identification_number).slice(-4) : null,
    failure_reason: p.failure_reason,
    created_at: p.created_at,
  };
}

/** From the dashboard, an individual card is shown by its last 4 digits only (an end user's card is not the merchant's to read). */
function maskedFor(c, ctx) {
  if (c.kind !== 'individual' || !ctx || ctx.apiKeyMode || !c.masked_pan) return c.masked_pan;
  return `•••• •••• •••• ${String(c.masked_pan).replace(/\D/g, '').slice(-4)}`;
}

function toPublicCard(c, ctx) {
  return {
    id: c.id,
    reference: c.own_reference,
    kind: c.kind,
    brand: c.brand,
    currency: c.currency,
    status: c.status, // pending | active | disabled | terminated | failed
    masked_pan: maskedFor(c, ctx),
    holder_name: c.holder_name,
    balance: num(c.balance),
    failure_reason: c.failure_reason,
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { getHolderProfile, submitHolderProfile, listHolders, getHolder, createHolder, createCard, list, get, getTransactions, getAllTransactions, simulateTransaction, revealDetails, fund, withdraw, freeze, unfreeze, terminate };
