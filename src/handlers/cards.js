'use strict';
const cardOrchestrator = require('../services/cardOrchestrator');
const maplerad = require('../services/maplerad');
const supabase = require('../lib/supabase');
const { generateCardId } = require('../utils/ids');
const { fetchPage } = require('../utils/pagination');
const { resolveMode } = require('../utils/mode');

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
  if (b.photoUrl) {
    const okFormat = /^data:image\/(png|jpe?g|webp);base64,/.test(b.photoUrl) || /^https:\/\//.test(b.photoUrl);
    if (!okFormat || String(b.photoUrl).length > 200000) {
      throw httpError(400, 'INVALID_PHOTO', 'photoUrl doit être une image (data URL png/jpeg/webp) de moins de 200 Ko, ou une URL https.');
    }
  }
  try {
    const profile = await cardOrchestrator.createHolder(ctx.merchantId, b, await resolveMode(ctx));
    return { status: 201, body: { profile: toPublicProfile(profile), holder: toPublicProfile(profile) } };
  } catch (err) {
    throw httpError(err.httpStatus || 502, err.code || 'ENROLLMENT_ERROR', err.message);
  }
}

async function createCard(ctx) {
  const b = ctx.body || {};
  const { kind, brand, amount, reference, business_name, holder_id } = b;

  if (!reference) throw httpError(400, 'MISSING_FIELDS', 'reference est requis.');
  if (brand && !VALID_BRANDS.includes(brand)) throw httpError(400, 'INVALID_BRAND', "brand doit être 'VISA' ou 'MASTERCARD'.");

  const existing = await cardOrchestrator.getByOwnReference(ctx.merchantId, reference);
  if (existing) return { status: 200, body: toPublicCard(existing) };

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
    return { status: 202, body: toPublicCard(card) }; // 202: creation confirmed async via webhook
  } catch (err) {
    if (err.httpStatus) throw httpError(err.httpStatus, err.code, err.message);
    throw httpError(502, 'CARD_SERVICE_ERROR', err.message);
  }
}

async function list(ctx) {
  const mode = await resolveMode(ctx);
  const { rows, pagination } = await fetchPage(ctx.query, (limit, offset) =>
    cardOrchestrator.list(ctx.merchantId, limit, offset, mode)
  );
  return { status: 200, body: { cards: rows.map(toPublicCard), pagination, mode } };
}

async function get(ctx) {
  const card = await cardOrchestrator.getById(ctx.merchantId, ctx.params.id);
  if (!card) throw httpError(404, 'NOT_FOUND', 'Carte introuvable.');
  return { status: 200, body: toPublicCard(card) };
}

async function getTransactions(ctx) {
  const card = await cardOrchestrator.getById(ctx.merchantId, ctx.params.id);
  if (!card) throw httpError(404, 'NOT_FOUND', 'Carte introuvable.');
  if (!card.maplerad_card_id) {
    return { status: 200, body: { transactions: [], month_spend: 0, currency: 'USD' } };
  }

  let res;
  try {
    res = await maplerad.forMode(card.mode).getCardTransactions(card.maplerad_card_id, {
      start_date: ctx.query.start_date,
      end_date: ctx.query.end_date,
      page: ctx.query.page,
      page_size: ctx.query.page_size,
    });
  } catch (err) {
    throw httpError(err.httpStatus || 502, err.code || 'CARD_SERVICE_ERROR', err.message);
  }

  const raw = (res && (res.data || res.transactions || res.result)) || [];
  const list = Array.isArray(raw) ? raw : [];
  const transactions = list.map(toPublicTransaction);

  const now = new Date();
  const monthSpend = transactions
    .filter((t) => {
      const d = new Date(t.date);
      return t.mode === 'DEBIT' && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    })
    .reduce((sum, t) => sum + Math.abs(t.amount), 0);

  return { status: 200, body: { transactions, month_spend: Math.round(monthSpend * 100) / 100, currency: 'USD' } };
}

/** Overview page: recent transactions across ALL of this merchant's cards (current mode only), newest first. */
async function getAllTransactions(ctx) {
  const mode = await resolveMode(ctx);
  const cards = await cardOrchestrator.list(ctx.merchantId, 100, 0, mode);
  const withProvider = cards.filter((c) => c.maplerad_card_id);

  const perCard = await Promise.all(withProvider.map(async (card) => {
    try {
      const res = await maplerad.forMode(card.mode).getCardTransactions(card.maplerad_card_id, { page_size: 10 });
      const raw = (res && (res.data || res.transactions || res.result)) || [];
      const list = Array.isArray(raw) ? raw : [];
      return list.map((t) => Object.assign(toPublicTransaction(t), { card_id: card.id, card_reference: card.own_reference }));
    } catch (err) {
      return []; // one card's provider hiccup shouldn't break the whole overview widget
    }
  }));

  const all = perCard.flat().sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)).slice(0, 20);
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
  if (typeof amount !== 'number' || amount <= 0) throw httpError(400, 'INVALID_AMOUNT', 'amount doit être un nombre positif.');

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
  const details = await cardOrchestrator.revealCardDetails(ctx.merchantId, ctx.params.id);
  return { status: 200, body: details };
}

async function fund(ctx) {
  const amount = ctx.body && ctx.body.amount;
  if (typeof amount !== 'number' || amount <= 0) throw httpError(400, 'INVALID_AMOUNT', 'amount doit être un nombre positif.');
  try {
    const card = await cardOrchestrator.fundCard(ctx.merchantId, ctx.params.id, amount);
    return { status: 200, body: toPublicCard(card) };
  } catch (err) {
    throw httpError(err.httpStatus || 502, err.code || 'CARD_SERVICE_ERROR', err.message);
  }
}

async function withdraw(ctx) {
  const amount = ctx.body && ctx.body.amount;
  if (typeof amount !== 'number' || amount <= 0) throw httpError(400, 'INVALID_AMOUNT', 'amount doit être un nombre positif.');
  try {
    const card = await cardOrchestrator.withdrawFromCard(ctx.merchantId, ctx.params.id, amount);
    return { status: 200, body: toPublicCard(card) };
  } catch (err) {
    throw httpError(err.httpStatus || 502, err.code || 'CARD_SERVICE_ERROR', err.message);
  }
}

async function freeze(ctx) {
  try {
    const card = await cardOrchestrator.freezeCard(ctx.merchantId, ctx.params.id);
    return { status: 200, body: toPublicCard(card) };
  } catch (err) {
    throw httpError(err.httpStatus || 502, err.code || 'CARD_SERVICE_ERROR', err.message);
  }
}

async function unfreeze(ctx) {
  try {
    const card = await cardOrchestrator.unfreezeCard(ctx.merchantId, ctx.params.id);
    return { status: 200, body: toPublicCard(card) };
  } catch (err) {
    throw httpError(err.httpStatus || 502, err.code || 'CARD_SERVICE_ERROR', err.message);
  }
}

async function terminate(ctx) {
  try {
    const card = await cardOrchestrator.terminateCard(ctx.merchantId, ctx.params.id);
    return { status: 200, body: toPublicCard(card) };
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
    status: p.status,
    first_name: p.first_name,
    last_name: p.last_name,
    email: p.email,
    country: p.country,
    photo_url: p.photo_url || null,
    failure_reason: p.failure_reason,
    created_at: p.created_at,
  };
}

function toPublicCard(c) {
  return {
    id: c.id,
    reference: c.own_reference,
    kind: c.kind,
    brand: c.brand,
    currency: c.currency,
    status: c.status, // pending | active | disabled | terminated | failed
    masked_pan: c.masked_pan,
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
