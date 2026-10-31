'use strict';
const config = require('../config');
const supabase = require('../lib/supabase');
const identityImage = require('./identityImage');
const maplerad = require('./maplerad');
const providerErrors = require('./providerErrors');
const ledger = require('./ledger');
const pricing = require('./pricing');
const masterWallet = require('./masterWallet');
const webhookDispatcher = require('./webhookDispatcher');
const revenue = require('./revenue');
const { planKeyFor } = require('./plans');
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
function extractCustomerIdFromList(res, email, strict) {
  const lists = [res, res && res.data, res && res.data && res.data.data, res && res.data && res.data.customers, res && res.customers, res && res.result];
  const list = lists.find((v) => Array.isArray(v));
  if (!list) return null;
  const wanted = String(email || '').trim().toLowerCase();
  const hit = list.find((c) => c && typeof c.email === 'string' && c.email.trim().toLowerCase() === wanted) || (!strict && list.length === 1 ? list[0] : null);
  return hit && typeof hit.id === 'string' ? hit.id : null;
}

/**
 * Finds the provider-side customer id for an email. Best effort: never throws.
 * The provider account is pooled, so an email can already exist there because of
 * an earlier attempt, another merchant, or another environment row. Order:
 *   1) our own records (any holder with this email in this mode that stored an id);
 *   2) the provider's list filtered by email, WITHOUT a status filter (the status
 *      of a customer changes as it is upgraded), then with COMPLETED / PENDING;
 *   3) a few pages of the unfiltered list, matched by email.
 */
async function lookupProviderCustomerId(email, mode) {
  const wanted = String(email || '').trim();
  try {
    for (const candidate of Array.from(new Set([wanted, wanted.toLowerCase()]))) {
      const rows = await supabase.select('maplerad_customers', { email: candidate, mode }, { order: 'created_at.desc' });
      const hit = (rows || []).find((r) => r.maplerad_customer_id);
      if (hit) return hit.maplerad_customer_id;
    }
  } catch (e) { /* fall through to the provider */ }
  const provider = maplerad.forMode(mode);
  for (const status of [undefined, 'COMPLETED', 'PENDING']) {
    try {
      const id = extractCustomerIdFromList(await provider.findCustomersByEmail(wanted, status), wanted);
      if (id) return id;
    } catch (e) { /* try the next filter */ }
  }
  for (let page = 1; page <= 5; page += 1) {
    try {
      const res = await provider.listCustomers({ page, page_size: 100 });
      const id = extractCustomerIdFromList(res, wanted, true);
      if (id) return id;
      const lists = [res, res && res.data, res && res.data && res.data.data, res && res.data && res.data.customers];
      const list = lists.find((v) => Array.isArray(v));
      if (!list || list.length < 100) break;
    } catch (e) { break; }
  }
  return null;
}

/**
 * What the card partner really holds for a customer: its tier (0, 1 or 2) and status. A holder is saved as "enrolled" here as soon as the
 * identity upgrade call is accepted, but the partner can keep the customer below Tier 2 (identity check not finished or refused), and a
 * card is only created for a Tier 2 customer. Best effort: returns null when the partner does not say (never throws).
 */
async function partnerCustomerState(mode, email, customerId) {
  const provider = maplerad.forMode(mode);
  for (const status of [undefined, 'COMPLETED', 'PENDING']) {
    try {
      const res = await provider.findCustomersByEmail(String(email || '').trim(), status);
      const lists = [res, res && res.data, res && res.data && res.data.data, res && res.data && res.data.customers, res && res.customers, res && res.result];
      const list = lists.find((v) => Array.isArray(v)) || [];
      const hit = list.find((c) => c && c.id === customerId);
      if (hit) return { tier: Number.isFinite(Number(hit.tier)) && hit.tier !== null && hit.tier !== undefined ? Number(hit.tier) : null, status: hit.status ? String(hit.status) : null };
    } catch (e) { /* try the next filter */ }
  }
  return null;
}

function holderNotVerified(tier) {
  const err = new Error(`La vérification d'identité du titulaire n'est pas terminée chez le fournisseur${tier != null ? ` (niveau ${tier} sur 2)` : ''}. Renvoyez le titulaire (POST /v1/cards/holders avec le même e-mail) avec un document d'identité lisible, recto et verso si la pièce en a deux, puis réessayez dans quelques minutes.`);
  err.code = 'HOLDER_NOT_VERIFIED';
  err.httpStatus = 409;
  return err;
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

/** Public holder identity fields -> the provider's identity object. */
function toProviderIdentity(profile) {
  const id = profile.identity || {};
  return {
    type: String(id.type || '').toUpperCase(),
    number: id.number,
    image: id.imageUrl || id.image,
    // Back of the ID card: some countries require both sides (provider field identity.image_back).
    image_back: id.imageBackUrl || id.image_back || undefined,
    country: String(id.country || profile.country || '').toUpperCase(),
  };
}

/**
 * Tier 2 upgrade; "already upgraded" counts as success. The provider wants identity.image as a Base64 URI:
 * links are converted here first. If it still answers "requires Base64 image" (customer already on Tier 2 with an
 * old link as image), the customer is updated with the Base64 image and the upgrade is repeated once.
 */
async function upgradeToTier2(provider, customerId, identity, photo) {
  const ready = { ...identity, image: await identityImage.toBase64Uri(identity.image) };
  if (identity.image_back) ready.image_back = await identityImage.toBase64Uri(identity.image_back);
  else delete ready.image_back;
  const send = () => provider.upgradeCustomerTier2({ customerId, identity: ready, photo: photo || undefined });
  try {
    await send();
  } catch (err) {
    const raw = err.providerRawMessage || '';
    if (/base64/i.test(raw)) {
      await provider.updateCustomer({ customerId, identity: ready });
      try { await send(); } catch (again) { if (!/already/i.test(again.providerRawMessage || '')) throw again; }
      return;
    }
    if (!/already/i.test(raw)) throw err;
  }
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
  // Same person (same email) already enrolled for this merchant in this mode: reuse it instead of creating a duplicate.
  const emailLc = String(profile.email || '').trim().toLowerCase();
  const existing = (await listHolders(merchantId, providerMode)).find(
    (h) => h.status === 'enrolled' && String(h.email || '').trim().toLowerCase() === emailLc
  );
  if (existing) {
    // Holders created before Tier 2 existed are stuck at Tier 1 and cannot get a card: upgrade them now.
    if (existing.maplerad_customer_id) {
      await upgradeToTier2(provider, existing.maplerad_customer_id, toProviderIdentity(profile), profile.photoIdUrl);
    }
    Object.defineProperty(existing, 'alreadyExisted', { value: true, enumerable: false });
    return existing;
  }
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
  const identity = toProviderIdentity(profile);

  const record = await supabase.insert('maplerad_customers', row);

  let mapleradCustomerId = null;
  try {
    // Step 1: create the customer (Tier 0) and capture the id it returns.
    // If this person was registered before (an earlier attempt), recover the
    // existing id by email instead of failing.
    // A previous attempt for this same person may already have created the provider-side customer: reuse its id.
    const previous = (await listHolders(merchantId, providerMode)).find(
      (h) => h.id !== record.id && h.maplerad_customer_id && String(h.email || '').trim().toLowerCase() === emailLc
    );
    if (previous) mapleradCustomerId = previous.maplerad_customer_id;
    if (!mapleradCustomerId) {
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

    // Step 3: upgrade to Tier 2 (government ID document). Cards are refused below Tier 2.
    await upgradeToTier2(provider, mapleradCustomerId, identity, profile.photoIdUrl);

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
async function countActiveCards(merchantId, mode) {
  // Each environment counts its own cards: sandbox test cards must not eat into the real (Live) quota.
  const rows = await supabase.select('cards', { merchant_id: merchantId, mode: mode === 'live' ? 'live' : 'sandbox', deleted_at: supabase.isNull() }, { select: 'id,status' });
  return rows.filter((c) => c.status === 'active' || c.status === 'pending' || c.status === 'disabled').length;
}

/** This merchant's custom fee overrides, if an admin set any (null fields fall back to plan pricing). */
async function getMerchantPricingOverride(merchantId) {
  return supabase.selectOne('merchant_pricing', { merchant_id: merchantId });
}

async function assertUnderCardLimit(merchantId, issuingPlanKey, mode) {
  const limit = pricing.cardLimitFor(issuingPlanKey);
  if (limit == null) return; // unlimited
  const count = await countActiveCards(merchantId, mode);
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
  const effMode = mode || 'sandbox';
  let profile;
  if (holderId) {
    profile = await getHolderById(merchantId, holderId);
    if (!profile) {
      const err = new Error('Titulaire introuvable (holder_id inconnu pour ce compte).');
      err.code = 'NOT_FOUND';
      err.httpStatus = 404;
      throw err;
    }
  } else {
    // No holder_id: default to the most recent ENROLLED holder of this merchant in this mode.
    const all = await listHolders(merchantId, effMode);
    profile = all.find((h) => h.status === 'enrolled' && h.maplerad_customer_id) || all.find((h) => h.status === 'enrolled');
    if (!profile) {
      const err = new Error(
        all.length
          ? "Aucun titulaire n'est prêt (statut « enrolled ») dans ce mode. Consultez GET /v1/cards/holders (status, failure_reason) ou recréez le titulaire."
          : "Aucun titulaire dans ce mode (Sandbox/Live). Créez-en un avec POST /v1/cards/holders, puis passez son id dans holder_id."
      );
      err.code = all.length ? 'HOLDER_NOT_ENROLLED' : 'HOLDER_PROFILE_REQUIRED';
      err.httpStatus = all.length ? 409 : 400;
      throw err;
    }
  }
  if ((profile.mode || 'sandbox') !== effMode) {
    const err = new Error("Ce titulaire a été créé dans l'autre mode (Sandbox/Live). Créez-le dans le mode actuel.");
    err.code = 'HOLDER_MODE_MISMATCH';
    err.httpStatus = 409;
    throw err;
  }
  if (profile.status !== 'enrolled') {
    const err = new Error(
      `Ce titulaire n'est pas prêt (statut « ${profile.status} »${profile.failure_reason ? ` : ${profile.failure_reason}` : ''}). Seul un titulaire « enrolled » peut recevoir une carte.`
    );
    err.code = 'HOLDER_NOT_ENROLLED';
    err.httpStatus = 409;
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

  // The partner only creates a card for a customer at Tier 2. When it says this one is lower (the identity check did not finish or was refused),
  // say so now, before any money moves, instead of letting the creation fail at the partner.
  const state = await partnerCustomerState(effMode, profile.email, profile.maplerad_customer_id);
  if (state && state.tier != null && state.tier < 2) throw holderNotVerified(state.tier);

  const merchant = await getMerchant(merchantId);
  const issuingPlanKey = planKeyFor(merchant, 'issuing', mode);
  await assertUnderCardLimit(merchantId, issuingPlanKey, mode);
  const pricingOverride = await getMerchantPricingOverride(merchantId);

  const creationFee = pricing.cardCreationFee(issuingPlanKey, pricingOverride);
  if (amountUsd != null && (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd) || amountUsd < 0)) {
    const err = new Error('amount doit être un nombre positif.');
    err.code = 'INVALID_AMOUNT';
    err.httpStatus = 400;
    throw err;
  }
  const preload = amountUsd || 0;
  const totalDebit = pricing.round2(preload + creationFee);
  await debitMasterWalletForCard(merchantId, totalDebit, ownReference, id, mode);

  const cents = toCents(preload);
  const row = await insertCardOrRefund(merchantId, totalDebit, ownReference, id, mode, {
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
    if (await markCardFailed(id, err.message)) await refundMasterWalletForFailedCard(merchantId, totalDebit, ownReference, id, mode);
    throw err;
  }

  return row;
}

async function createBusinessCard({ merchantId, id, ownReference, businessName, brand, amountUsd, mode }) {
  if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd) || !(amountUsd > 0)) {
    const err = new Error('Un montant de préfinancement est requis pour une carte entreprise.');
    err.code = 'INVALID_AMOUNT';
    err.httpStatus = 400;
    throw err;
  }

  const merchant = await getMerchant(merchantId);
  const issuingPlanKey = planKeyFor(merchant, 'issuing', mode);
  await assertUnderCardLimit(merchantId, issuingPlanKey, mode);
  const pricingOverride = await getMerchantPricingOverride(merchantId);

  const creationFee = pricing.cardCreationFee(issuingPlanKey, pricingOverride);
  const totalDebit = pricing.round2(amountUsd + creationFee);
  await debitMasterWalletForCard(merchantId, totalDebit, ownReference, id, mode);

  const cents = toCents(amountUsd);
  const row = await insertCardOrRefund(merchantId, totalDebit, ownReference, id, mode, {
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
    if (await markCardFailed(id, err.message)) await refundMasterWalletForFailedCard(merchantId, totalDebit, ownReference, id, mode);
    throw err;
  }

  return row;
}

/** Saves the new card row; if that fails after the wallet was debited, the debit is given back (no card, no charge). */
async function insertCardOrRefund(merchantId, totalDebit, ownReference, id, mode, fields) {
  try {
    return await supabase.insert('cards', fields);
  } catch (err) {
    await refundMasterWalletForFailedCard(merchantId, totalDebit, ownReference, id, mode);
    throw err;
  }
}

async function debitMasterWalletForCard(merchantId, amountUsd, reference, relatedId, mode) {
  // Enforces the platform-wide minimum Master Wallet reserve and sends a
  // low-balance email the first time a debit brings the balance down to it.
  await masterWallet.debitWithFloor(merchantId, amountUsd, reference, relatedId, mode);
}

async function refundMasterWalletForFailedCard(merchantId, amountUsd, reference, relatedId, mode) {
  await ledger.creditMasterWallet(merchantId, amountUsd, 'USD', `refund:${reference}`, relatedId, mode);
}

/**
 * Moves a card from `pending` to `failed`. It is a claim: the caller that wins it (true) is the only one who may refund,
 * so a creation failure reported twice (our own error AND the partner's webhook, or a re-delivered webhook) refunds once.
 */
async function markCardFailed(cardId, reason) {
  const rows = await supabase.update('cards', { id: cardId, status: 'pending' }, { status: 'failed', failure_reason: reason, updated_at: new Date().toISOString() });
  return !!(rows && rows.length);
}

/**
 * Adds `delta` (may be negative) to a card's local balance without losing a concurrent movement: the new value is
 * computed from a fresh read and written only if the balance is still that value, otherwise it is read again.
 */
async function adjustCardBalance(cardId, delta, extra) {
  for (let i = 0; i < 8; i += 1) {
    const fresh = await supabase.selectOne('cards', { id: cardId });
    if (!fresh) return null;
    const next = pricing.round2(Number(fresh.balance || 0) + Number(delta));
    const rows = await supabase.update('cards', { id: cardId, balance: Number(fresh.balance || 0) }, Object.assign({ balance: next, updated_at: new Date().toISOString() }, extra || {}));
    if (rows && rows.length) return rows[0];
  }
  const err = new Error('Le solde de la carte est en cours de modification. Réessayez dans un instant.');
  err.code = 'CARD_BUSY';
  err.httpStatus = 409;
  throw err;
}

/**
 * Called by the webhook handler when Maplerad confirms (or fails) card creation.
 */
async function applyCardCreationWebhook({ mapleradReference, mapleradCardId, maskedPan, holderName, status, currency, webhookMode, providerReason, verificationLink, linkExpireAt }) {
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
    // The creation fee is Freda Pay's revenue only once the card really exists. Logging it when the
    // request starts counted refunded (failed) attempts as income. Only on the pending -> active step,
    // so a redelivered webhook cannot count it twice.
    if (card.status === 'failed' || card.status === 'terminated') {
      // The creation was already reported as failed and refunded: this late confirmation must not bring the card back
      // (that would be a free card). The partner-side card needs a manual look.
      // eslint-disable-next-line no-console
      console.error(`Late "created" confirmation for card ${card.id} (${card.status}, refunded): NOT activated - close ${mapleradCardId} at the partner.`);
      return card;
    }
    const firstActivation = card.status !== 'active';
    // Already activated (re-delivered webhook or reconciliation): nothing to do. Re-applying it would reset the balance to the
    // initial amount, wiping every recharge, withdrawal and purchase since, and send card.created again.
    if (!firstActivation && card.maplerad_card_id) return card;
    const [updated] = await supabase.update(
      'cards',
      { id: card.id, status: card.status },
      {
        status: 'active',
        maplerad_card_id: mapleradCardId,
        masked_pan: maskedPan,
        holder_name: holderName || card.holder_name,
        balance: fromCents(card.initial_amount || 0),
        updated_at: new Date().toISOString(),
      }
    );
    if (!updated) return supabase.selectOne('cards', { id: card.id }); // a concurrent delivery already handled it
    if (firstActivation) await revenue.log(card.merchant_id, 'card_creation', Number(card.creation_fee || 0), 'USD', card.id, card.mode, config.issuingProviderCostsUSD.cardCreation);
    webhookDispatcher.dispatch(card.merchant_id, 'card.created', {
      id: updated.id, reference: updated.own_reference, kind: updated.kind, brand: updated.brand,
      status: 'active', masked_pan: updated.masked_pan, balance: Number(updated.balance),
    });
    return updated;
  }

  // Creation failed on Maplerad's side: refund whatever Master Wallet amount we debited
  // (the preload amount AND the creation fee, since the card never came into existence).
  // Only the delivery that wins the pending -> failed claim refunds: a re-delivered or duplicated failure event changes nothing.
  // The merchant sees the translated reason when the partner's message is a known one (identity, tier, country...); anything
  // else stays a generic sentence, and the raw text goes to the admin "Erreurs cartes" page only.
  const knownReason = providerReason ? maplerad.translateKnownMessage(providerReason) : null;
  const failureReason = `La création de la carte a échoué${knownReason ? ` : ${knownReason.replace(/\.$/, '')}` : ''}. Les montants débités ont été remboursés.`;
  if (!(await markCardFailed(card.id, failureReason))) {
    return supabase.selectOne('cards', { id: card.id });
  }
  const refundAmount = fromCents(card.initial_amount || 0) + Number(card.creation_fee || 0);
  if (refundAmount > 0) {
    await refundMasterWalletForFailedCard(card.merchant_id, refundAmount, card.own_reference, card.id, card.mode);
  }
  webhookDispatcher.dispatch(card.merchant_id, 'card.failed', {
    id: card.id, reference: card.own_reference, kind: card.kind, brand: card.brand,
    failure_reason: failureReason,
    // When the partner offers a retry of the identity check, the merchant can hand this link to the cardholder.
    ...(verificationLink ? { verification_link: verificationLink, verification_link_expires_at: linkExpireAt || null } : {}),
  });
  if (providerReason) {
    providerErrors.record({ mode: card.mode, merchant_id: card.merchant_id, route: 'webhook issuing.created.failed', method: 'WEBHOOK', path: mapleradReference, message: providerReason, shown_to_merchant: failureReason }).catch(() => {});
  }
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

/**
 * Idempotency for fund / withdraw: the caller may send a key (body.reference or the Idempotency-Key header).
 * The key is part of the ledger reference of the money movement, so a replay finds that the operation already
 * happened and returns its result instead of moving money twice. Two identical requests at the same time share one run.
 */
const inFlight = new Map();
async function once(merchantId, kind, cardId, key, run) {
  if (!key) return run();
  const id = `${merchantId}:${kind}:${cardId}:${key}`;
  if (inFlight.has(id)) return inFlight.get(id).then((r) => ({ ...r, replayed: true }));
  const p = run();
  inFlight.set(id, p);
  try { return await p; } finally { inFlight.delete(id); }
}

function mismatch() {
  const err = new Error('Cette clé d\'idempotence a déjà servi pour une opération avec un montant différent.');
  err.code = 'IDEMPOTENCY_MISMATCH';
  err.httpStatus = 409;
  return err;
}

async function fundCard(merchantId, cardId, amountUsd, key) {
  const card = await getCardOwned(merchantId, cardId);
  const res = await once(merchantId, 'fund', card.id, key, () => fundCardNow(merchantId, card, amountUsd, key));
  return Object.assign(res.card, { _op: { type: 'fund', amount: amountUsd, fee: res.fee, total_debited: res.total, replayed: !!res.replayed } });
}

async function fundCardNow(merchantId, card, amountUsd, key) {
  assertNotFrozen(card);
  const merchant = await getMerchant(merchantId);
  const issuingPlanKey = planKeyFor(merchant, 'issuing', card.mode);
  const rechargeFee = pricing.cardRechargeFee(issuingPlanKey, await getMerchantPricingOverride(merchantId), amountUsd);
  const totalDebit = pricing.round2(amountUsd + rechargeFee);
  const ref = key ? `fund:${card.id}:${key}` : `fund:${card.own_reference}:${Date.now()}`;

  if (key) {
    const rows = await supabase.select('ledger_entries', { merchant_id: merchantId, reference: ref });
    const debits = (rows || []).filter((r) => Number(r.amount) < 0);
    const refunds = await supabase.select('ledger_entries', { merchant_id: merchantId, reference: `refund:${ref}` });
    if (debits.length > (refunds || []).length) {
      if (pricing.round2(Math.abs(Number(debits[0].amount))) !== totalDebit) throw mismatch();
      const current = await getCardOwned(merchantId, card.id);
      return { card: current, fee: rechargeFee, total: totalDebit, replayed: true };
    }
  }

  await debitMasterWalletForCard(merchantId, totalDebit, ref, card.id, card.mode);
  try {
    await maplerad.forMode(card.mode).fundCard(card.maplerad_card_id, toCents(amountUsd));
  } catch (err) {
    await refundMasterWalletForFailedCard(merchantId, totalDebit, ref, card.id, card.mode);
    throw err;
  }
  // Outside the try: the partner already funded the card, so a bookkeeping failure must never refund the wallet.
  await revenue.log(merchantId, 'card_recharge', rechargeFee, 'USD', card.id, card.mode, config.issuingProviderCostsUSD.cardRecharge).catch(() => {});
  const updated = await adjustCardBalance(card.id, Number(amountUsd));
  webhookDispatcher.dispatch(merchantId, 'card.funded', {
    id: updated.id, reference: updated.own_reference, amount: Number(amountUsd), fee: rechargeFee, total_debited: totalDebit,
    balance: Number(updated.balance), currency: 'USD',
  });
  return { card: updated, fee: rechargeFee, total: totalDebit };
}

async function withdrawFromCard(merchantId, cardId, amountUsd, key) {
  const card = await getCardOwned(merchantId, cardId);
  const res = await once(merchantId, 'withdraw', card.id, key, () => withdrawNow(merchantId, card, amountUsd, key));
  return Object.assign(res.card, { _op: { type: 'withdraw', amount: amountUsd, fee: res.fee, net_credited: res.net, replayed: !!res.replayed } });
}

async function withdrawNow(merchantId, card, amountUsd, key) {
  assertNotFrozen(card);
  const merchant = await getMerchant(merchantId);
  const issuingPlanKey = planKeyFor(merchant, 'issuing', card.mode);
  const withdrawalFee = pricing.cardWithdrawalFee(issuingPlanKey, await getMerchantPricingOverride(merchantId));
  const netCredited = pricing.round2(amountUsd - withdrawalFee);
  const ref = key ? `card-withdraw:${card.id}:${key}` : `card-withdraw:${card.own_reference}`;

  if (key) {
    const rows = await supabase.select('ledger_entries', { merchant_id: merchantId, reference: ref });
    if (rows && rows.length) {
      if (pricing.round2(Number(rows[0].amount)) !== netCredited) throw mismatch();
      const current = await getCardOwned(merchantId, card.id);
      return { card: current, fee: withdrawalFee, net: netCredited, replayed: true };
    }
  }

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
  // The partner has already taken the money off the card: from here nothing may fail silently. The wallet credit is retried (the ledger
  // reference is checked first, so a retry never credits twice), and a failure is logged with the reference the team needs.
  let credited = false;
  let lastErr = null;
  for (let i = 0; i < 3 && !credited; i += 1) {
    try {
      const already = await supabase.select('ledger_entries', { merchant_id: merchantId, reference: ref }, { limit: 1 });
      if (!(already && already.length)) await ledger.creditMasterWallet(merchantId, netCredited, 'USD', ref, card.id, card.mode);
      credited = true;
    } catch (err) { lastErr = err; await new Promise((r) => setTimeout(r, 200 * (i + 1))); }
  }
  if (!credited) {
    console.error(`CARD WITHDRAWAL NOT CREDITED: card ${card.id}, ${netCredited} $ withdrawn at the partner, wallet credit "${ref}" failed: ${lastErr && lastErr.message}`); // eslint-disable-line no-console
    throw lastErr;
  }
  await revenue.log(merchantId, 'card_withdrawal', withdrawalFee, 'USD', card.id, card.mode, config.issuingProviderCostsUSD.cardWithdrawal).catch(() => {});
  let updated;
  try { updated = await adjustCardBalance(card.id, -Number(amountUsd)); } catch (err) {
    // The money is moved: the card balance is aligned with the partner's figure instead of failing the request.
    console.error(`Card ${card.id}: balance adjustment after withdrawal failed (${err.message}), aligning with the partner.`); // eslint-disable-line no-console
    await syncCardBalanceFromPartner(card).catch(() => {});
    updated = (await supabase.selectOne('cards', { id: card.id })) || card;
  }
  webhookDispatcher.dispatch(merchantId, 'card.withdrawn', {
    id: updated.id, reference: updated.own_reference, amount: Number(amountUsd), fee: withdrawalFee, net_credited: netCredited,
    balance: Number(updated.balance), currency: 'USD',
  });
  return { card: updated, fee: withdrawalFee, net: netCredited };
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

/**
 * "Delete a card", for real:
 *   - a card that never came into existence at the partner (its creation failed): nothing to close there, it is just removed;
 *   - a card closed earlier: removed from the lists;
 *   - a live card: it is CLOSED AT THE PARTNER first (if that fails, nothing changes and the error is returned), its remaining
 *     balance goes back to the Master Wallet, then it disappears from the merchant's lists.
 * The row is kept (deleted_at) so the ledger, the fees and the audit trail stay consistent.
 */
async function terminateCard(merchantId, cardId) {
  const card = await getById(merchantId, cardId);
  if (!card) {
    const err = new Error('Carte introuvable.');
    err.code = 'NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  const now = new Date().toISOString();

  if (card.status === 'pending') {
    const err = new Error("Cette carte est en cours de création : attendez qu'elle soit active ou échouée avant de la supprimer.");
    err.code = 'CARD_NOT_READY';
    err.httpStatus = 409;
    throw err;
  }
  if (card.status === 'failed' || card.status === 'terminated' || !card.maplerad_card_id) {
    const [removed] = await supabase.update('cards', { id: card.id }, { deleted_at: now, updated_at: now });
    return removed;
  }

  await maplerad.forMode(card.mode).terminateCard(card.maplerad_card_id); // must succeed: the card is really closed
  // The balance follows purchases and refunds (applyCardSpendToBalance), so what is left on the card is what goes back to the Master Wallet.
  const remaining = Math.max(0, pricing.round2(Number(card.balance || 0)));
  const closureFee = Math.min(remaining, Math.max(0, pricing.round2(config.cardClosureFeeUsd || 0)));
  const refundable = pricing.round2(remaining - closureFee);
  const [claimed] = await supabase.update('cards', { id: card.id, status: card.status }, { status: 'terminated', balance: 0, updated_at: now });
  if (claimed && refundable > 0) {
    await ledger.creditMasterWallet(merchantId, refundable, 'USD', `card-terminate-refund:${card.own_reference}`, card.id, card.mode);
  }
  if (claimed && closureFee > 0) await revenue.log(merchantId, 'card_closure', closureFee, 'USD', card.id, card.mode, 0);
  const [updated] = await supabase.update('cards', { id: card.id }, { deleted_at: now });
  webhookDispatcher.dispatch(merchantId, 'card.terminated', { id: card.id, reference: card.own_reference, refunded_usd: refundable, closure_fee_usd: closureFee });
  return Object.assign({}, updated || card, { refunded_usd: refundable, closure_fee_usd: closureFee });
}

/**
 * Fetches a card's full sensitive details (full number, CVV, expiry) directly
 * from Maplerad, on demand - only for the merchant who owns the card.
 * NEVER stored in our database, NEVER written to a log (the value itself,
 * not even on error - only field NAMES are logged for diagnosis).
 */
async function revealCardDetails(merchantId, cardId, { fromDashboard = false } = {}) {
  const card = await getCardOwned(merchantId, cardId);
  if (fromDashboard && card.kind === 'individual') {
    // The number, CVV and expiry of an end user's card are for that user alone, never for the merchant's staff.
    const err = new Error("Les détails d'une carte individuelle ne sont visibles que par son titulaire.");
    err.code = 'INDIVIDUAL_CARD_DETAILS_HIDDEN';
    err.httpStatus = 403;
    throw err;
  }
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
  const card = await getById(merchantId, cardId);
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

async function list(merchantId, limit, offset, mode, kind) {
  const filters = { merchant_id: merchantId, deleted_at: supabase.isNull() }; // a deleted card is gone for its owner
  if (mode) filters.mode = mode;
  if (kind) filters.kind = kind;
  return supabase.select('cards', filters, { order: 'created_at.desc', limit: limit || 50, offset: offset || 0 });
}

async function getById(merchantId, cardId) {
  const card = await supabase.selectOne('cards', { id: cardId, merchant_id: merchantId });
  return card && !card.deleted_at ? card : null;
}

async function getByOwnReference(merchantId, ownReference) {
  return supabase.selectOne('cards', { merchant_id: merchantId, own_reference: ownReference });
}

/**
 * A card use rejected for LOW BALANCE costs the merchant the decline fee (their plan's
 * declineUSD, or the admin's custom value), taken from the Master Wallet of the SAME
 * environment as the card. Maplerad reports it as `issuing.transaction` with
 * `type: "DECLINE"`; other kinds of decline (blocked merchant category, country...) are not charged.
 *
 * Guarantees:
 *   - once per provider transaction (a redelivered or repeated event never charges twice);
 *   - never makes a wallet negative: if the wallet holds less than the fee, only what is there is taken;
 *   - an event from one environment can never charge a card of the other.
 */
const LOW_BALANCE = /insufficient|not enough|low balance|solde|fonds|funds/i;

async function applyCardDeclineWebhook(event, webhookMode) {
  if (!event || String(event.type || '').toUpperCase() !== 'DECLINE') return { charged: 0, reason: 'not-a-decline' };
  const card = event.card_id ? await supabase.selectOne('cards', { maplerad_card_id: event.card_id }) : null;
  if (!card) return { charged: 0, reason: 'unknown-card' };
  if (webhookMode && (card.mode || 'sandbox') !== webhookMode) {
    // eslint-disable-next-line no-console
    console.error(`Ignoring a ${webhookMode} decline for a ${card.mode || 'sandbox'} card (${card.id}): environments must never cross.`);
    return { charged: 0, reason: 'wrong-environment' };
  }

  const text = [event.description, event.reason, event.decline_reason, event.message, event.status].filter(Boolean).join(' | ');
  if (!LOW_BALANCE.test(text)) {
    // eslint-disable-next-line no-console
    console.log(`Card decline ${event.reference || ''} not charged: reason is not low balance (${String(text).slice(0, 120) || 'no reason given'}).`);
    return { charged: 0, reason: 'not-low-balance' };
  }

  const mode = card.mode === 'live' ? 'live' : 'sandbox';
  const ref = `card-decline-fee:${event.reference || `${event.card_id}:${event.created_at || ''}`}`;
  if (await supabase.selectOne('ledger_entries', { merchant_id: card.merchant_id, reference: ref })) return { charged: 0, reason: 'already-charged' };

  const merchant = await getMerchant(card.merchant_id);
  const fee = pricing.cardDeclineFee(planKeyFor(merchant, 'issuing', mode), await getMerchantPricingOverride(card.merchant_id));
  if (!(fee > 0)) return { charged: 0, reason: 'no-fee-on-plan' };

  const available = await ledger.getBalance(card.merchant_id, 'master_wallet', 'USD', mode);
  const charge = pricing.round2(Math.min(fee, Math.max(0, available)));
  if (!(charge > 0)) {
    // eslint-disable-next-line no-console
    console.log(`Decline fee for card ${card.id} not collected: the ${mode} Master Wallet is empty.`);
    return { charged: 0, reason: 'empty-wallet' };
  }
  await ledger.debitMasterWallet(card.merchant_id, charge, 'USD', ref, card.id, mode);
  await revenue.log(card.merchant_id, 'card_decline', charge, 'USD', card.id, mode, 0);
  return { charged: charge, reason: 'charged' };
}

/**
 * Stores one card-transaction notification from the card partner (purchase, decline, refund...), so the admin can
 * show what the cards really spend. Amounts arrive in cents. The partner's own reference is the identity: the same
 * event delivered twice (or re-sent later) is stored once. An event of the other environment never touches this card.
 */
async function recordCardTransaction(event, webhookMode) {
  const card = event && event.card_id ? await supabase.selectOne('cards', { maplerad_card_id: event.card_id }) : null;
  if (!card) return null;
  if (webhookMode && (card.mode || 'sandbox') !== webhookMode) return null;
  const type = String(event.type || '').toUpperCase();
  const ref = event.reference ? String(event.reference) : `${event.card_id}:${type}:${event.amount}:${event.created_at || ''}`;
  if (await supabase.selectOne('card_transactions', { card_id: card.id, provider_reference: ref })) return null;
  const cents = Number(event.amount);
  // The unique index (card_id, provider_reference) settles a race between two copies of the same event: the loser stops here.
  const row = await supabase.insert('card_transactions', {
    id: `ctx_${randomHex(10)}`,
    merchant_id: card.merchant_id,
    card_id: card.id,
    mode: card.mode === 'live' ? 'live' : 'sandbox',
    provider_reference: ref,
    type,
    status: event.status ? String(event.status).toUpperCase() : null,
    direction: event.mode ? String(event.mode).toUpperCase() : null,
    amount_usd: Number.isFinite(cents) ? Math.round(cents) / 100 : null,
    currency: event.currency || 'USD',
    description: event.description ? String(event.description).slice(0, 200) : null,
    merchant_name: event.merchant && event.merchant.name ? String(event.merchant.name).slice(0, 120) : null,
    occurred_at: event.created_at || new Date().toISOString(),
  }).catch(async (err) => {
    if (await supabase.selectOne('card_transactions', { card_id: card.id, provider_reference: ref }).catch(() => null)) return null;
    throw err;
  });
  if (!row) return null;
  // The money the customer just spent (or got back) changes the card's balance: before this, the balance only ever moved on our own
  // recharge / withdrawal, so a purchase left it untouched.
  const updated = await applyCardSpendToBalance(card, row).catch((err) => { console.error(`Card balance update failed for ${card.id}: ${err.message}`); return card; }); // eslint-disable-line no-console
  syncCardBalanceFromPartner(updated).catch(() => {});
  webhookDispatcher.dispatch(card.merchant_id, 'card.transaction', transactionWebhookData(updated, row)); // the merchant's server learns of every card movement
  await chargeCardSpendFee(card, row).catch((err) => console.error(`Card spend fee failed for ${card.id}: ${err.message}`)); // eslint-disable-line no-console
  return row;
}

/**
 * A successful purchase (AUTHORIZATION, DEBIT) lowers the card's balance; a REVERSAL or REFUND (credit) gives money back. Funding and
 * withdrawals are applied by our own endpoints, and a SETTLEMENT repeats a purchase already taken at authorization, so those do not
 * move it. Runs once per partner event (recordCardTransaction stores each event once), never below zero.
 */
/**
 * The partner closed a card by itself (for instance for insufficient funds): the card is marked terminated here too, so it stops showing
 * as active and usable. A closure we asked for already left the card terminated: nothing happens then. The remaining money is NOT
 * credited back (the partner's event does not say where it went); the team is told so it can look at the card.
 */
async function applyCardTerminationWebhook(event, webhookMode) {
  const card = event && event.card_id ? await supabase.selectOne('cards', { maplerad_card_id: event.card_id }) : null;
  if (!card) return null;
  if (webhookMode && (card.mode || 'sandbox') !== webhookMode) return null;
  if (card.status === 'terminated' || card.status === 'failed') return card;
  const reason = event.reason ? String(event.reason).slice(0, 200) : null;
  const [done] = await supabase.update('cards', { id: card.id, status: card.status }, { status: 'terminated', failure_reason: reason ? `Carte fermée : ${reason}` : 'Carte fermée par le service de cartes.', updated_at: new Date().toISOString() });
  if (!done) return card;
  webhookDispatcher.dispatch(card.merchant_id, 'card.terminated', { id: card.id, reference: card.own_reference, reason });
  require('./adminAlerts').cardClosedByPartner({ card, reason, balance: Number(card.balance || 0) }).catch(() => {});
  return done;
}

/**
 * Safety net for card creation. The partner confirms a new card by notification; when that notification never arrives the card stays
 * "pending" for ever (money debited, no card shown). Pending cards older than 10 minutes are looked up at the partner by their
 * reference: if the card exists it is activated exactly like the notification would do; one still unknown after 30 minutes alerts the team.
 */
/**
 * A card that stays "pending" WITHOUT a partner reference never reached the partner: the server restarted between saving the card and
 * sending the request, or the request did not get through. Nothing can ever confirm it, so after 15 minutes it is closed as failed and what
 * the merchant was debited (preload + creation fee) is given back, once (markCardFailed is the claim). The team is told, in case the
 * partner did create a card whose answer was lost (it then shows at the partner without a match here).
 */
const UNSENT_AFTER_MS = 15 * 60 * 1000;
async function failUnsentPendingCards() {
  const now = Date.now();
  const rows = (await supabase.select('cards', { status: 'pending', maplerad_reference: supabase.isNull(), created_at: supabase.gt(new Date(now - 14 * 24 * 3600 * 1000).toISOString()) }, { order: 'created_at.asc', limit: 100 }))
    .filter((c) => !c.deleted_at && now - new Date(c.created_at).getTime() > UNSENT_AFTER_MS);
  let failed = 0;
  for (const c of rows) {
    const reason = "La demande de création n'a pas pu être envoyée au fournisseur de cartes. Les montants débités ont été remboursés : vous pouvez réessayer.";
    if (!(await markCardFailed(c.id, reason))) continue;
    const refund = fromCents(c.initial_amount || 0) + Number(c.creation_fee || 0);
    if (refund > 0) await refundMasterWalletForFailedCard(c.merchant_id, refund, c.own_reference, c.id, c.mode);
    webhookDispatcher.dispatch(c.merchant_id, 'card.failed', { id: c.id, reference: c.own_reference, kind: c.kind, brand: c.brand, failure_reason: reason });
    require('./adminAlerts').cardCreationStuck({ card: c, why: "Aucune référence du fournisseur : la demande n'est jamais partie. La carte a été fermée et le marchand remboursé. Vérifiez chez le fournisseur qu'aucune carte orpheline n'a été créée." }).catch(() => {});
    failed += 1;
  }
  return { failed };
}

async function reconcilePendingCardCreations(limit) {
  await failUnsentPendingCards().catch((e) => console.error('Unsent card clean-up:', e.message)); // eslint-disable-line no-console
  const now = Date.now();
  const rows = (await supabase.select('cards', { status: 'pending', created_at: supabase.gt(new Date(now - 3 * 24 * 3600 * 1000).toISOString()) }, { order: 'created_at.asc', limit: 100 }))
    .filter((c) => c.maplerad_reference && now - new Date(c.created_at).getTime() > 10 * 60 * 1000)
    .slice(0, limit || 10);
  let activated = 0;
  for (const c of rows) {
    try {
      const res = await maplerad.forMode(c.mode).getCard(c.maplerad_reference);
      const d = (res && (res.data || res)) || {};
      if (d.id && /^(ACTIVE|DISABLED)$/i.test(String(d.status || 'ACTIVE'))) {
        const done = await applyCardCreationWebhook({ mapleradReference: c.maplerad_reference, mapleradCardId: d.id, maskedPan: d.masked_pan || null, holderName: d.name || null, status: 'ACTIVE', currency: d.currency || 'USD', webhookMode: c.mode || 'sandbox' });
        if (done && done.status === 'active') activated += 1;
      }
    } catch (err) {
      if (now - new Date(c.created_at).getTime() > 30 * 60 * 1000) require('./adminAlerts').cardCreationStuck({ card: c, why: err.message }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return { checked: rows.length, activated };
}

/** Tells the merchant's server the card's real balance (after a correction, an alignment with the partner, or a team request). */
function balanceWebhookData(card, previous, reason) {
  return { id: card.id, reference: card.own_reference, kind: card.kind, brand: card.brand, status: card.status, balance: Number(card.balance || 0), previous_balance: previous == null ? null : Number(previous), reason };
}

/** How one stored card transaction moves the card's balance: negative for a purchase, positive for a reversal or refund, 0 otherwise. */
function balanceDeltaOf(row) {
  const amount = Number(row.amount_usd);
  if (!(amount > 0)) return 0;
  if (/DECLIN|FAIL|REJECT/.test(String(row.status || ''))) return 0;
  if ((row.type === 'AUTHORIZATION' || row.type === 'CHARGE') && row.direction === 'DEBIT') return -amount;
  if ((row.type === 'REVERSAL' || row.type === 'REFUND') && row.direction !== 'DEBIT') return amount;
  return 0;
}

async function applyCardSpendToBalance(card, row) {
  const delta = balanceDeltaOf(row);
  if (!delta) return card;
  for (let i = 0; i < 8; i += 1) {
    const fresh = await supabase.selectOne('cards', { id: card.id });
    if (!fresh) return card;
    const current = Number(fresh.balance || 0);
    const next = Math.max(0, pricing.round2(current + delta));
    if (current + delta < 0) console.warn(`Card ${card.id}: ${row.provider_reference} (${delta} $) would take the balance below zero (${current} $): set to 0, ${Math.abs(current + delta).toFixed(2)} $ not covered.`); // eslint-disable-line no-console
    const rows = await supabase.update('cards', { id: card.id, balance: current }, { balance: next, updated_at: new Date().toISOString() });
    if (rows && rows.length) return rows[0];
  }
  console.error(`Card ${card.id}: balance NOT updated for transaction ${row.provider_reference} (${delta} $) after 8 attempts; the partner alignment will correct it.`); // eslint-disable-line no-console
  return card;
}

/**
 * One-time correction, run when this version first starts: purchases recorded BEFORE the balance followed them were never taken off
 * the cards, so every active card still shows what was loaded. The moment of the first start is saved (platform_settings) and every
 * transaction stored before it is applied once; the ones after it were applied live. Safe to call again: it does nothing the second time.
 */
async function backfillCardBalances() {
  const key = 'card_balance_cutover';
  if (await supabase.selectOne('platform_settings', { key })) return { skipped: true };
  const cutover = new Date().toISOString();
  try {
    await supabase.insert('platform_settings', { key, value: cutover, updated_by: 'system', updated_at: cutover });
  } catch (err) { return { skipped: true }; } // another instance (or a table problem): never run twice
  const rows = await supabase.select('card_transactions', { created_at: supabase.lt(cutover) }, { limit: 100000 });
  const perCard = new Map();
  for (const r of rows) {
    const d = balanceDeltaOf(r);
    if (d) perCard.set(r.card_id, (perCard.get(r.card_id) || 0) + d);
  }
  let corrected = 0;
  for (const [cardId, delta] of perCard) {
    for (let i = 0; i < 8; i += 1) {
      const fresh = await supabase.selectOne('cards', { id: cardId });
      if (!fresh || fresh.status === 'terminated') break;
      const current = Number(fresh.balance || 0);
      const next = Math.max(0, pricing.round2(current + delta));
      const done = await supabase.update('cards', { id: cardId, balance: current }, { balance: next, updated_at: new Date().toISOString() });
      if (done && done.length) { corrected += 1; webhookDispatcher.dispatch(done[0].merchant_id, 'card.balance_updated', balanceWebhookData(done[0], current, 'correction')); break; }
    }
  }
  // eslint-disable-next-line no-console
  console.log(`Card balances corrected for past purchases: ${corrected} card(s) from ${rows.length} stored transaction(s).`);
  return { corrected, transactions: rows.length };
}

/**
 * The partner holds the real balance (fees such as cross-border charges move it too). After each transaction its figure is read and
 * kept ONLY when it is close to ours (within 2 $): that corrects small drifts, while a figure in another unit or from a stale answer can
 * never rewrite the balance by a large amount. A bigger gap is only reported in the server log.
 */
async function syncCardBalanceFromPartner(card) {
  if (!card || !card.maplerad_card_id) return;
  const res = await maplerad.forMode(card.mode).getCard(card.maplerad_card_id);
  const data = (res && (res.data || res)) || {};
  const cents = Number(data.balance);
  if (!Number.isFinite(cents) || cents < 0) return;
  const partner = pricing.round2(cents / 100);
  const fresh = await supabase.selectOne('cards', { id: card.id });
  if (!fresh) return;
  const ours = Number(fresh.balance || 0);
  if (Math.abs(partner - ours) < 0.005) return;
  if (Math.abs(partner - ours) <= 2) {
    const [fixed] = await supabase.update('cards', { id: card.id, balance: ours }, { balance: partner, updated_at: new Date().toISOString() });
    if (fixed) webhookDispatcher.dispatch(fixed.merchant_id, 'card.balance_updated', balanceWebhookData(fixed, ours, 'partner_sync'));
  } else {
    // eslint-disable-next-line no-console
    console.warn(`Card ${card.id}: the partner shows ${partner} $ but our balance is ${ours} $ (gap above 2 $): left unchanged, check this card.`);
  }
}

/**
 * Stores the partner transactions we never received by webhook for one card and takes them off (or gives them back to) its balance,
 * then aligns the balance with the partner's. A stored transaction is one already applied, so an unstored one is exactly a movement
 * the balance missed. No fee and no webhook to the merchant here: those belong to the live notification.
 * `sinceMs` limits how far back it looks (the partner lists the newest first).
 */
async function syncCardTransactionsFromPartner(card, opts) {
  if (!card || !card.maplerad_card_id) return { imported: 0 };
  const since = opts && opts.sinceMs ? Date.now() - opts.sinceMs : 0;
  const res = await maplerad.forMode(card.mode).getCardTransactions(card.maplerad_card_id, { page: 1, page_size: 100 });
  const raw = (res && (res.data || res.transactions || res.result)) || [];
  let imported = 0;
  let current = card;
  for (const t of Array.isArray(raw) ? raw : []) {
    const ref = String(t.reference || t.id || '');
    if (!ref) continue;
    if (since && t.created_at && new Date(t.created_at).getTime() < since) continue;
    if (await supabase.selectOne('card_transactions', { card_id: card.id, provider_reference: ref })) continue;
    const cents = Number(t.amount);
    const row = await supabase.insert('card_transactions', {
      id: `ctx_${randomHex(10)}`, merchant_id: card.merchant_id, card_id: card.id, mode: card.mode === 'live' ? 'live' : 'sandbox', provider_reference: ref,
      type: String(t.type || '').toUpperCase() || 'UNKNOWN', status: t.status ? String(t.status).toUpperCase() : null, direction: t.mode ? String(t.mode).toUpperCase() : null,
      amount_usd: Number.isFinite(cents) ? Math.round(cents) / 100 : null, currency: t.currency || 'USD', description: t.description ? String(t.description).slice(0, 200) : null,
      merchant_name: t.merchant && t.merchant.name ? String(t.merchant.name).slice(0, 120) : null, occurred_at: t.created_at || new Date().toISOString(),
    }).catch(() => null);
    if (!row) continue; // inserted meanwhile by the webhook
    current = await applyCardSpendToBalance(current, row).catch(() => current);
    imported += 1;
  }
  if (imported) await syncCardBalanceFromPartner(current).catch(() => {});
  return { imported };
}

/** Background safety net: webhooks can be lost, so a few cards per run (rotating through all of them) are read against the partner. */
let cardSyncCursor = 0;
async function reconcileCardTransactions(limit) {
  const all = await supabase.select('cards', { status: supabase.inList(['active', 'disabled']), mode: 'live', deleted_at: supabase.isNull() }, { order: 'created_at.asc', limit: 500 });
  const n = limit || 10;
  if (cardSyncCursor >= all.length) cardSyncCursor = 0;
  const cards = all.slice(cardSyncCursor, cardSyncCursor + n);
  cardSyncCursor += n;
  let imported = 0;
  for (const c of cards) {
    try { imported += (await syncCardTransactionsFromPartner(c, { sinceMs: 7 * 24 * 3600 * 1000 })).imported; } catch (err) { console.error(`Card transaction sync ${c.id}: ${err.message}`); } // eslint-disable-line no-console
  }
  return { cards: cards.length, imported };
}

/**
 * Plans that bill each card purchase (Startup: 0.10 $) take that fee from the Master Wallet, once per purchase
 * (the partner's reference is the key, so a re-delivered event never charges twice). Only a successful purchase
 * authorization counts; refusals have their own fee. Never takes more than the wallet holds.
 */
async function chargeCardSpendFee(card, row) {
  if (row.type !== 'AUTHORIZATION' || row.direction !== 'DEBIT') return { charged: 0, reason: 'not-a-purchase' };
  if (/DECLIN|FAIL|REJECT/.test(String(row.status || ''))) return { charged: 0, reason: 'not-successful' };
  const mode = card.mode === 'live' ? 'live' : 'sandbox';
  const merchant = await getMerchant(card.merchant_id);
  const fee = pricing.cardSpendFee(planKeyFor(merchant, 'issuing', mode));
  if (!(fee > 0)) return { charged: 0, reason: 'no-fee-on-plan' };
  const ref = `card-spend-fee:${row.provider_reference}`;
  if (await supabase.selectOne('ledger_entries', { merchant_id: card.merchant_id, reference: ref })) return { charged: 0, reason: 'already-charged' };
  const available = await ledger.getBalance(card.merchant_id, 'master_wallet', 'USD', mode);
  const charge = pricing.round2(Math.min(fee, Math.max(0, available)));
  if (!(charge > 0)) return { charged: 0, reason: 'empty-wallet' };
  await ledger.debitMasterWallet(card.merchant_id, charge, 'USD', ref, card.id, mode);
  await revenue.log(card.merchant_id, 'card_spend', charge, 'USD', card.id, mode, 0);
  return { charged: charge, reason: 'charged' };
}

/** Webhook payload for one card transaction (also used when an admin re-sends it). Never carries card numbers. */
function transactionWebhookData(card, t) {
  return {
    id: t.id, card_id: card.id, card_reference: card.own_reference, type: t.type, status: t.status, direction: t.direction,
    amount: t.amount_usd == null ? null : Number(t.amount_usd), currency: t.currency || 'USD',
    description: t.description, merchant_name: require('../utils/partnerNames').publicMerchantName(t.merchant_name), occurred_at: t.occurred_at,
    card_balance: card.balance == null ? null : Number(card.balance),
  };
}

module.exports = {
  partnerCustomerState,
  failUnsentPendingCards,
  lookupProviderCustomerId,
  isAlreadyEnrolledError,
  transactionWebhookData,
  recordCardTransaction,
  syncCardTransactionsFromPartner,
  reconcileCardTransactions,
  backfillCardBalances,
  balanceWebhookData,
  reconcilePendingCardCreations,
  applyCardTerminationWebhook,
  applyCardDeclineWebhook,
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
