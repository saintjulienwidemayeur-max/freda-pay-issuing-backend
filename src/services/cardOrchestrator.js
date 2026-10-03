'use strict';
const supabase = require('../lib/supabase');
const maplerad = require('./maplerad');
const ledger = require('./ledger');
const pricing = require('./pricing');
const masterWallet = require('./masterWallet');
const webhookDispatcher = require('./webhookDispatcher');
const revenue = require('./revenue');
const { randomHex } = require('../utils/ids');

/**
 * Pulls the "reference" Maplerad returns from POST /issuing (or /issuing/business)
 * out of whatever shape the response turns out to have. Maplerad's own docs only
 * confirm the FIELD NAME ("reference") - not which wrapper object it sits in - so
 * this checks the shapes real fintech APIs commonly use, in order. If none match,
 * it logs the full raw response so the exact shape is visible in the server logs
 * for a one-time fix, instead of silently storing null (which is what causes a
 * card to stay "pending" forever: the later webhook then has nothing to match).
 */
function extractMapleradReference(res, cardId) {
  const candidates = [
    res && res.reference,
    res && res.data && res.data.reference,
    res && res.data && res.data.data && res.data.data.reference,
    res && res.result && res.result.reference,
  ];
  const found = candidates.find((v) => typeof v === 'string' && v.length > 0);
  if (!found) {
    // eslint-disable-next-line no-console
    console.error(
      `Card ${cardId}: could not find a "reference" in Maplerad's create-card response - ` +
      'the later confirmation webhook will not be able to match this card. Raw response:',
      JSON.stringify(res)
    );
  }
  return found || null;
}

/**
 * Pulls the customer id Maplerad returns from POST /customers/enroll out of
 * whatever shape the response has. Same reasoning as extractMapleradReference
 * above: this is the id later required as CustomerID when creating an
 * individual card, so a silent miss here breaks every individual card that
 * customer tries to get (fails with "CustomerID ... required"). Logs the raw
 * response when nothing is found, instead of failing silently.
 */
function extractMapleradCustomerId(res) {
  const candidates = [
    res && res.id,
    res && res.customer_id,
    res && res.data && res.data.id,
    res && res.data && res.data.customer_id,
    res && res.data && res.data.data && res.data.data.id,
  ];
  const found = candidates.find((v) => typeof v === 'string' && v.length > 0);
  if (!found) {
    // eslint-disable-next-line no-console
    console.error(
      'Could not find a customer id in Maplerad\'s enroll-customer response - individual card creation for ' +
      'this holder will fail with a CustomerID validation error. Raw response:',
      JSON.stringify(res)
    );
  }
  return found || null;
}


/** Finds a customer id inside a list response, matching by email. */
function extractCustomerIdFromList(res, email) {
  const lists = [res, res && res.data, res && res.data && res.data.data, res && res.data && res.data.customers, res && res.customers, res && res.result];
  const list = lists.find((v) => Array.isArray(v));
  if (!list) return null;
  const wanted = String(email || '').trim().toLowerCase();
  const hit = list.find((c) => c && typeof c.email === 'string' && c.email.trim().toLowerCase() === wanted) || (list.length === 1 ? list[0] : null);
  return hit && typeof hit.id === 'string' ? hit.id : null;
}

/** Looks the provider-side customer up by email (both registration states). Best effort: never throws. */
async function lookupProviderCustomerId(email, mode) {
  for (const status of ['COMPLETED', 'PENDING']) {
    try {
      const res = await maplerad.forMode(mode).findCustomersByEmail(email, status);
      const id = extractCustomerIdFromList(res, email);
      if (id) return id;
    } catch (e) { /* try the next status */ }
  }
  return null;
}

function isAlreadyEnrolledError(err) {
  return /already (enrolled|exist|registered)|customer.*exist/i.test((err && err.providerRawMessage) || '');
}

/**
 * Turns whatever the provider calls the card expiry into { month, year }.
 * Seen in the wild: "12/28", "12/2028", "2028-12", "2028-12-31T00:00:00Z",
 * "1228", or an object with month/year. Returns null if unrecognised.
 */
function parseExpiry(value) {
  if (value == null) return null;
  const norm = (mo, yr) => {
    let month = parseInt(mo, 10);
    let year = parseInt(yr, 10);
    if (!Number.isFinite(month) || !Number.isFinite(year)) return null;
    if (year < 100) year += 2000;
    if (month < 1 || month > 12) return null;
    return { month, year };
  };
  if (typeof value === 'object') {
    return norm(value.month || value.expiry_month || value.mm, value.year || value.expiry_year || value.yy);
  }
  const str = String(value).trim();
  let m;
  if ((m = /^(\d{4})[-/](\d{1,2})(?:[-/T ].*)?$/.exec(str))) return norm(m[2], m[1]); // 2028-12, 2028-12-31, ISO
  if ((m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(str))) return norm(m[2], m[3]); // 31/12/2028
  if ((m = /^(\d{1,2})\s*[-/]\s*(\d{2}|\d{4})$/.exec(str))) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (a > 12 && b >= 1 && b <= 12) return norm(b, a); // "28/12" written year-first
    return norm(m[1], m[2]);
  }
  if ((m = /^(\d{2})(\d{2}|\d{4})$/.exec(str))) return norm(m[1], m[2]); // 1228 / 122028
  return null;
}

/** Address in whatever shape it arrives (object or string) -> one readable line. */
function formatAddress(addr) {
  if (!addr) return null;
  if (typeof addr === 'string') return addr;
  if (typeof addr !== 'object') return null;
  const order = ['street', 'line1', 'address_line_1', 'street2', 'line2', 'address_line_2', 'city', 'state', 'region', 'postal_code', 'zip_code', 'zip', 'country'];
  const parts = order.map((k) => addr[k]).filter((v) => typeof v === 'string' && v.trim());
  if (parts.length) return parts.join(', ');
  const any = Object.values(addr).filter((v) => typeof v === 'string' && v.trim());
  return any.length ? any.join(', ') : null;
}

/** Our API and dashboard use YYYY-MM-DD; the card provider wants DD-MM-YYYY. */
function toProviderDob(dob) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dob || ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : dob;
}

/** USD-to-cents helper: Maplerad amounts are in the lowest denomination. */
function toCents(usd) {
  return Math.round(Number(usd) * 100);
}
function fromCents(cents) {
  return Math.round(Number(cents)) / 100;
}

async function getMerchant(merchantId) {
  return supabase.selectOne('merchants', { id: merchantId });
}

/* ===================== Holder profile / enrollment ===================== */

/** All card holders a merchant has enrolled (for picking one when issuing an individual card). */
async function listHolders(merchantId, mode) {
  const filters = { merchant_id: merchantId };
  if (mode) filters.mode = mode; // sandbox holders do not exist on the live provider account (and vice versa)
  return supabase.select('maplerad_customers', filters, { order: 'created_at.desc' });
}

/** One specific holder, ownership-checked. */
async function getHolderById(merchantId, holderId) {
  return supabase.selectOne('maplerad_customers', { id: holderId, merchant_id: merchantId });
}

/**
 * @deprecated kept for any caller still expecting "the one profile" - returns
 * the most recently created holder. New code should use listHolders/getHolderById.
 */
async function getHolderProfile(merchantId, mode) {
  const filters = { merchant_id: merchantId };
  if (mode) filters.mode = mode;
  const rows = await supabase.select('maplerad_customers', filters, { order: 'created_at.desc', limit: 1 });
  return rows && rows[0];
}

/**
 * Enrolls a NEW card holder for this merchant (POST /customers/enroll).
 * A merchant can enroll several holders (e.g. different employees) and pick
 * which one an individual card is issued for at creation time. Identity
 * document + photo are optional at enrollment (Maplerad Tier 0+1).
 */
async function createHolder(merchantId, profile, mode) {
  const providerMode = mode === 'live' ? 'live' : 'sandbox';
  const provider = maplerad.forMode(providerMode);
  const row = {
    mode: providerMode,
    id: `mpc_${randomHex(8)}`,
    merchant_id: merchantId,
    status: 'pending',
    first_name: profile.firstName,
    last_name: profile.lastName,
    email: profile.email,
    country: profile.country,
    dob: profile.dob,
    identification_number: profile.identificationNumber,
    phone_number: profile.phoneNumber,
    phone_short_code: profile.phoneShortCode,
    address: profile.address || null,
    photo_url: profile.photoUrl || null,
  };

  const record = await supabase.insert('maplerad_customers', row);

  let mapleradCustomerId = null;
  try {
    // Step 1: create the customer (Tier 0) and capture the id it returns.
    // If this person was registered before (an earlier attempt), recover the
    // existing id by email instead of failing.
    try {
      const created = await provider.createCustomer({
        firstName: profile.firstName,
        lastName: profile.lastName,
        email: profile.email,
        country: profile.country,
      });
      mapleradCustomerId = extractMapleradCustomerId(created);
    } catch (err) {
      if (!isAlreadyEnrolledError(err)) throw err;
      mapleradCustomerId = await lookupProviderCustomerId(profile.email, providerMode);
      if (!mapleradCustomerId) throw err; // simple "Ce titulaire existe déjà."
    }
    if (!mapleradCustomerId) {
      const err = new Error("Ce titulaire n'a pas pu être créé. Réessayez dans un instant.");
      err.code = 'HOLDER_CREATION_FAILED';
      err.httpStatus = 502;
      throw err;
    }

    // Step 2: upgrade to Tier 1. The provider expects dob as DD-MM-YYYY.
    try {
      await provider.upgradeCustomerTier1({
        customerId: mapleradCustomerId,
        dob: toProviderDob(profile.dob),
        phone: { phone_number: profile.phoneNumber, phone_country_code: profile.phoneShortCode },
        // Tier 1 requires street, city, state, postal_code and country - all five,
        // not just city/country (that's what the provider's "Street"/"State"/
        // "PostalCode" required-field errors were telling us).
        address: {
          street: profile.address && profile.address.street,
          city: profile.address && profile.address.city,
          state: profile.address && profile.address.state,
          postal_code: profile.address && (profile.address.postal_code || profile.address.postalCode),
          country: profile.address && profile.address.country,
        },
        identificationNumber: profile.identificationNumber,
        // photoUrl is only a dashboard avatar/logo for our own UI - deliberately
        // NOT forwarded to the card provider (it isn't an identity document).
      });
    } catch (err) {
      // Already upgraded on an earlier attempt: that is the state we want.
      if (!/already/i.test(err.providerRawMessage || '')) throw err;
    }

    const [updated] = await supabase.update(
      'maplerad_customers',
      { id: record.id },
      { status: 'enrolled', maplerad_customer_id: mapleradCustomerId, updated_at: new Date().toISOString() }
    );
    return updated;
  } catch (err) {
    await supabase.update(
      'maplerad_customers',
      { id: record.id },
      { status: 'failed', maplerad_customer_id: mapleradCustomerId, failure_reason: err.message, updated_at: new Date().toISOString() }
    );
    throw err;
  }
}

/* ===================== Cards ===================== */

/** Counts cards that occupy a slot against the plan's card limit (everything but failed/terminated). */
async function countActiveCards(merchantId) {
  const rows = await supabase.select('cards', { merchant_id: merchantId }, { select: 'id,status' });
  return rows.filter((c) => c.status === 'active' || c.status === 'pending' || c.status === 'disabled').length;
}

/** This merchant's custom fee overrides, if an admin set any (null fields fall back to plan pricing). */
async function getMerchantPricingOverride(merchantId) {
  return supabase.selectOne('merchant_pricing', { merchant_id: merchantId });
}

async function assertUnderCardLimit(merchantId, issuingPlanKey) {
  const limit = pricing.cardLimitFor(issuingPlanKey);
  if (limit == null) return; // unlimited
  const count = await countActiveCards(merchantId);
  if (count >= limit) {
    const err = new Error(
      `Limite de cartes atteinte pour votre plan (${limit} cartes maximum). Passez à un plan supérieur pour en émettre davantage.`
    );
    err.code = 'CARD_LIMIT_REACHED';
    err.httpStatus = 400;
    throw err;
  }
}

async function createIndividualCard({ merchantId, id, ownReference, brand, amountUsd, holderId, mode }) {
  const profile = holderId ? await getHolderById(merchantId, holderId) : await getHolderProfile(merchantId, mode || 'sandbox');
  if (!profile) {
    const err = new Error(
      holderId
        ? 'Titulaire introuvable.'
        : "Créez d'abord un titulaire de carte, puis réessayez."
    );
    err.code = holderId ? 'NOT_FOUND' : 'HOLDER_PROFILE_REQUIRED';
    err.httpStatus = holderId ? 404 : 400;
    throw err;
  }
  if ((profile.mode || 'sandbox') !== (mode || 'sandbox')) {
    const err = new Error("Ce titulaire a été créé dans l'autre mode (Sandbox/Live). Créez-le dans le mode actuel.");
    err.code = 'HOLDER_MODE_MISMATCH';
    err.httpStatus = 409;
    throw err;
  }
  if (profile.status !== 'enrolled') {
    const err = new Error(
      "Créez d'abord un titulaire de carte, puis réessayez."
    );
    err.code = 'HOLDER_PROFILE_REQUIRED';
    err.httpStatus = 400;
    throw err;
  }
  if (!profile.maplerad_customer_id) {
    // Older holders were saved as "verified" without an id. Recover it by
    // email (the customer exists on the provider side), then carry on.
    const recovered = await lookupProviderCustomerId(profile.email, mode || 'sandbox');
    if (recovered) {
      await supabase.update('maplerad_customers', { id: profile.id }, { maplerad_customer_id: recovered, updated_at: new Date().toISOString() });
      profile.maplerad_customer_id = recovered;
    } else {
      const err = new Error("Ce titulaire n'est pas prêt. Créez-le à nouveau, puis réessayez.");
      err.code = 'HOLDER_PROFILE_INCOMPLETE';
      err.httpStatus = 409;
      throw err;
    }
  }

  const merchant = await getMerchant(merchantId);
  const issuingPlanKey = (merchant && merchant.issuing_plan) || 'startup';
  await assertUnderCardLimit(merchantId, issuingPlanKey);
  const pricingOverride = await getMerchantPricingOverride(merchantId);

  const creationFee = pricing.cardCreationFee(issuingPlanKey, pricingOverride);
  const preload = amountUsd || 0;
  const totalDebit = pricing.round2(preload + creationFee);
  await debitMasterWalletForCard(merchantId, totalDebit, ownReference, id, mode);
  await revenue.log(merchantId, 'card_creation', creationFee, 'USD', id, mode);

  const cents = toCents(preload);
  const row = await supabase.insert('cards', {
    id,
    merchant_id: merchantId,
    own_reference: ownReference,
    kind: 'individual',
    brand: brand || 'VISA',
    currency: 'USD',
    status: 'pending',
    initial_amount: cents,
    creation_fee: creationFee,
    holder_id: profile.id,
    holder_name: [profile.first_name, profile.last_name].filter(Boolean).join(' ') || null,
    mode: mode || 'sandbox',
  });

  try {
    const res = await maplerad.forMode(mode).createCard({
      customerId: profile.maplerad_customer_id,
      currency: 'USD',
      type: 'VIRTUAL',
      autoApprove: true,
      brand: brand || 'VISA',
      amount: cents,
    });
    // Maplerad confirms asynchronously via webhook (issuing.created.successful/failed).
    // The webhook echoes back Maplerad's OWN "reference" from this response - NOT our
    // own_reference - so we must store it to correlate the later event.
    await supabase.update('cards', { id }, { maplerad_reference: extractMapleradReference(res, id) });
  } catch (err) {
    await markCardFailed(id, err.message);
    await refundMasterWalletForFailedCard(merchantId, totalDebit, ownReference, id, mode);
    throw err;
  }

  return row;
}

async function createBusinessCard({ merchantId, id, ownReference, businessName, brand, amountUsd, mode }) {
  if (!(amountUsd > 0)) {
    const err = new Error('Un montant de préfinancement est requis pour une carte entreprise.');
    err.code = 'INVALID_AMOUNT';
    err.httpStatus = 400;
    throw err;
  }

  const merchant = await getMerchant(merchantId);
  const issuingPlanKey = (merchant && merchant.issuing_plan) || 'startup';
  await assertUnderCardLimit(merchantId, issuingPlanKey);
  const pricingOverride = await getMerchantPricingOverride(merchantId);

  const creationFee = pricing.cardCreationFee(issuingPlanKey, pricingOverride);
  const totalDebit = pricing.round2(amountUsd + creationFee);
  await debitMasterWalletForCard(merchantId, totalDebit, ownReference, id, mode);
  await revenue.log(merchantId, 'card_creation', creationFee, 'USD', id, mode);

  const cents = toCents(amountUsd);
  const row = await supabase.insert('cards', {
    id,
    merchant_id: merchantId,
    own_reference: ownReference,
    kind: 'business',
    brand: brand || 'MASTERCARD',
    currency: 'USD',
    status: 'pending',
    holder_name: businessName,
    initial_amount: cents,
    creation_fee: creationFee,
    mode: mode || 'sandbox',
  });

  try {
    const res = await maplerad.forMode(mode).createBusinessCard({
      name: businessName,
      type: 'VIRTUAL',
      brand: brand || 'MASTERCARD',
      amount: cents,
      autoApprove: true,
      currency: 'USD',
    });
    await supabase.update('cards', { id }, { maplerad_reference: extractMapleradReference(res, id) });
  } catch (err) {
    await markCardFailed(id, err.message);
    await refundMasterWalletForFailedCard(merchantId, totalDebit, ownReference, id, mode);
    throw err;
  }

  return row;
}

async function debitMasterWalletForCard(merchantId, amountUsd, reference, relatedId, mode) {
  // Enforces the platform-wide minimum Master Wallet reserve and sends a
  // low-balance email the first time a debit brings the balance down to it.
  await masterWallet.debitWithFloor(merchantId, amountUsd, reference, relatedId, mode);
}

async function refundMasterWalletForFailedCard(merchantId, amountUsd, reference, relatedId, mode) {
  await ledger.creditMasterWallet(merchantId, amountUsd, 'USD', `refund:${reference}`, relatedId, mode);
}

async function markCardFailed(cardId, reason) {
  await supabase.update('cards', { id: cardId }, { status: 'failed', failure_reason: reason, updated_at: new Date().toISOString() });
}

/**
 * Called by the webhook handler when Maplerad confirms (or fails) card creation.
 */
async function applyCardCreationWebhook({ mapleradReference, mapleradCardId, maskedPan, holderName, status, currency, webhookMode }) {
  const card = await supabase.selectOne('cards', { maplerad_reference: mapleradReference });
  if (!card) {
    // eslint-disable-next-line no-console
    console.error(
      `Maplerad webhook reference "${mapleradReference}" matches no card in our database. ` +
      'That card will stay "pending" forever unless reconciled manually - this usually means ' +
      'the reference wasn\'t captured correctly when the card was created (check the ' +
      '"Maplerad POST /issuing raw response" log line from when this card was created).'
    );
    return null;
  }

  if (webhookMode && (card.mode || 'sandbox') !== webhookMode) {
    // eslint-disable-next-line no-console
    console.error(`Ignoring a ${webhookMode} webhook for a ${card.mode || 'sandbox'} card (${card.id}): environments must never cross.`);
    return null;
  }

  if (status === 'ACTIVE') {
    const [updated] = await supabase.update(
      'cards',
      { id: card.id },
      {
        status: 'active',
        maplerad_card_id: mapleradCardId,
        masked_pan: maskedPan,
        holder_name: holderName || card.holder_name,
        balance: fromCents(card.initial_amount || 0),
        updated_at: new Date().toISOString(),
      }
    );
    webhookDispatcher.dispatch(card.merchant_id, 'card.created', {
      id: updated.id, reference: updated.own_reference, kind: updated.kind, brand: updated.brand,
      status: 'active', masked_pan: updated.masked_pan, balance: Number(updated.balance),
    });
    return updated;
  }

  // Creation failed on Maplerad's side: refund whatever Master Wallet amount we debited
  // (the preload amount AND the creation fee, since the card never came into existence).
  await markCardFailed(card.id, 'La création de la carte a échoué. Les montants débités ont été remboursés.');
  const refundAmount = fromCents(card.initial_amount || 0) + Number(card.creation_fee || 0);
  if (refundAmount > 0) {
    await refundMasterWalletForFailedCard(card.merchant_id, refundAmount, card.own_reference, card.id, card.mode);
  }
  webhookDispatcher.dispatch(card.merchant_id, 'card.failed', {
    id: card.id, reference: card.own_reference, kind: card.kind, brand: card.brand,
    failure_reason: 'La création de la carte a échoué. Les montants débités ont été remboursés.',
  });
  return supabase.selectOne('cards', { id: card.id });
}

/** Maplerad rejects funding/withdrawal on a frozen card - we check for it upfront so the merchant gets a clear French error instead of a confusing provider one. */
function assertNotFrozen(card) {
  if (card.status === 'disabled') {
    const err = new Error('Cette carte est gelée. Dégelez-la avant de la recharger ou d\'en retirer des fonds.');
    err.code = 'CARD_FROZEN';
    err.httpStatus = 409;
    throw err;
  }
}

async function fundCard(merchantId, cardId, amountUsd) {
  const card = await getCardOwned(merchantId, cardId);
  assertNotFrozen(card);
  const merchant = await getMerchant(merchantId);
  const issuingPlanKey = (merchant && merchant.issuing_plan) || 'startup';
  const rechargeFee = pricing.cardRechargeFee(issuingPlanKey, await getMerchantPricingOverride(merchantId));
  const totalDebit = pricing.round2(amountUsd + rechargeFee);

  await debitMasterWalletForCard(merchantId, totalDebit, `fund:${card.own_reference}:${Date.now()}`, card.id, card.mode);
  try {
    await maplerad.forMode(card.mode).fundCard(card.maplerad_card_id, toCents(amountUsd));
    await revenue.log(merchantId, 'card_recharge', rechargeFee, 'USD', card.id, card.mode);
  } catch (err) {
    await refundMasterWalletForFailedCard(merchantId, totalDebit, `fund-refund:${card.own_reference}`, card.id, card.mode);
    throw err;
  }
  const [updated] = await supabase.update('cards', { id: card.id }, { balance: Number(card.balance) + Number(amountUsd), updated_at: new Date().toISOString() });
  return updated;
}

async function withdrawFromCard(merchantId, cardId, amountUsd) {
  const card = await getCardOwned(merchantId, cardId);
  assertNotFrozen(card);
  const merchant = await getMerchant(merchantId);
  const issuingPlanKey = (merchant && merchant.issuing_plan) || 'startup';
  const withdrawalFee = pricing.cardWithdrawalFee(issuingPlanKey, await getMerchantPricingOverride(merchantId));

  if (Number(card.balance) < amountUsd) {
    const err = new Error(`Solde de la carte insuffisant (disponible : ${card.balance} $).`);
    err.code = 'INSUFFICIENT_CARD_BALANCE';
    err.httpStatus = 400;
    throw err;
  }
  if (amountUsd <= withdrawalFee) {
    const err = new Error(`Le montant doit être supérieur aux frais de retrait (${withdrawalFee} $).`);
    err.code = 'AMOUNT_BELOW_FEE';
    err.httpStatus = 400;
    throw err;
  }

  await maplerad.forMode(card.mode).withdrawFromCard(card.maplerad_card_id, toCents(amountUsd));
  const netCredited = pricing.round2(amountUsd - withdrawalFee);
  await ledger.creditMasterWallet(merchantId, netCredited, 'USD', `card-withdraw:${card.own_reference}`, card.id, card.mode);
  await revenue.log(merchantId, 'card_withdrawal', withdrawalFee, 'USD', card.id, card.mode);
  const [updated] = await supabase.update('cards', { id: card.id }, { balance: Number(card.balance) - Number(amountUsd), updated_at: new Date().toISOString() });
  return updated;
}

async function freezeCard(merchantId, cardId) {
  const card = await getCardOwned(merchantId, cardId);
  await maplerad.forMode(card.mode).freezeCard(card.maplerad_card_id);
  const [updated] = await supabase.update('cards', { id: card.id }, { status: 'disabled', updated_at: new Date().toISOString() });
  webhookDispatcher.dispatch(merchantId, 'card.frozen', { id: updated.id, reference: updated.own_reference });
  return updated;
}

async function unfreezeCard(merchantId, cardId) {
  const card = await getCardOwned(merchantId, cardId);
  await maplerad.forMode(card.mode).unfreezeCard(card.maplerad_card_id);
  const [updated] = await supabase.update('cards', { id: card.id }, { status: 'active', updated_at: new Date().toISOString() });
  webhookDispatcher.dispatch(merchantId, 'card.unfrozen', { id: updated.id, reference: updated.own_reference });
  return updated;
}

async function terminateCard(merchantId, cardId) {
  const card = await getCardOwned(merchantId, cardId);
  await maplerad.forMode(card.mode).terminateCard(card.maplerad_card_id);
  if (Number(card.balance) > 0) {
    await ledger.creditMasterWallet(merchantId, Number(card.balance), 'USD', `card-terminate-refund:${card.own_reference}`, card.id, card.mode);
  }
  const [updated] = await supabase.update('cards', { id: card.id }, { status: 'terminated', balance: 0, updated_at: new Date().toISOString() });
  webhookDispatcher.dispatch(merchantId, 'card.terminated', { id: updated.id, reference: updated.own_reference });
  return updated;
}

/**
 * Fetches a card's full sensitive details (full number, CVV, expiry) directly
 * from Maplerad, on demand - only for the merchant who owns the card.
 * NEVER stored in our database, NEVER written to a log (the value itself,
 * not even on error - only field NAMES are logged for diagnosis).
 */
async function revealCardDetails(merchantId, cardId) {
  const card = await getCardOwned(merchantId, cardId);
  const res = await maplerad.forMode(card.mode).getCard(card.maplerad_card_id);
  const data = (res && (res.data || res)) || {};

  // Maplerad's exact field names for this aren't confirmed in their public
  // docs, so check the common candidates other issuers use rather than
  // assuming one exact shape.
  const number = data.card_number || data.number || data.pan || null;
  const cvv = data.cvv || data.cvc || data.cvc2 || data.security_code || null;
  let expiry = parseExpiry(data.expiry) || parseExpiry(data.expiry_date) || parseExpiry(data.exp_date) || parseExpiry(data.expires_at);
  if (!expiry) {
    const mo = data.expiry_month || data.exp_month || data.expiration_month;
    const yr = data.expiry_year || data.exp_year || data.expiration_year;
    expiry = mo && yr ? parseExpiry({ month: mo, year: yr }) : null;
  }
  const billingAddress = formatAddress(data.billing_address) || formatAddress(data.address);

  if (!number) {
    // eslint-disable-next-line no-console
    console.error('Card reveal: no recognizable card-number field. Available keys:', Object.keys(data));
    const err = new Error('Les détails de cette carte ne sont pas disponibles pour le moment.');
    err.code = 'CARD_DETAILS_UNAVAILABLE';
    err.httpStatus = 502;
    throw err;
  }
  if (!expiry) {
    // Only the SHAPE is logged (digits masked), never the value.
    const shape = data.expiry == null ? 'absent' : `${typeof data.expiry}:${String(typeof data.expiry === 'object' ? JSON.stringify(data.expiry) : data.expiry).replace(/\d/g, '9')}`;
    // eslint-disable-next-line no-console
    console.error('Card reveal: expiry not understood. Shape:', shape);
  }

  return {
    number,
    cvv,
    expiry_month: expiry ? expiry.month : null,
    expiry_year: expiry ? expiry.year : null,
    billing_address: billingAddress,
    holder_name: card.holder_name,
  };
}

async function getCardOwned(merchantId, cardId) {
  const card = await supabase.selectOne('cards', { id: cardId, merchant_id: merchantId });
  if (!card) {
    const err = new Error('Carte introuvable.');
    err.code = 'NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  if (!card.maplerad_card_id) {
    const err = new Error("Cette carte n'est pas encore active (création en cours).");
    err.code = 'CARD_NOT_READY';
    err.httpStatus = 409;
    throw err;
  }
  return card;
}

async function list(merchantId, limit, offset, mode) {
  const filters = { merchant_id: merchantId };
  if (mode) filters.mode = mode;
  return supabase.select('cards', filters, { order: 'created_at.desc', limit: limit || 50, offset: offset || 0 });
}

async function getById(merchantId, cardId) {
  return supabase.selectOne('cards', { id: cardId, merchant_id: merchantId });
}

async function getByOwnReference(merchantId, ownReference) {
  return supabase.selectOne('cards', { merchant_id: merchantId, own_reference: ownReference });
}

module.exports = {
  _test: { parseExpiry, formatAddress, extractCustomerIdFromList },
  getHolderProfile,
  listHolders,
  getHolderById,
  createHolder,
  createIndividualCard,
  createBusinessCard,
  applyCardCreationWebhook,
  fundCard,
  withdrawFromCard,
  freezeCard,
  unfreezeCard,
  terminateCard,
  list,
  getById,
  getByOwnReference,
  revealCardDetails,
};
