'use strict';
const config = require('../config');

/**
 * Card issuing provider client: virtual Visa/Mastercard cards, business
 * cards. Freda Pay holds ONE provider account (config.maplerad.secretKey) and
 * issues cards on behalf of all Freda Pay merchants (same pooled-account
 * pattern as PlopPlop).
 *
 * Error policy: a merchant only ever sees a SHORT, SIMPLE French message. It
 * never names the provider and never leaks raw provider text (English,
 * field names, stack-like strings). Messages we recognise get a precise
 * simple sentence; everything else gets a neutral one. The raw provider
 * response is always logged server-side (see request()) for the operator.
 */

function baseUrl() {
  return config.maplerad.baseUrl.replace(/\/+$/, '');
}

/**
 * Picks the provider key for a platform mode. Maplerad uses one base URL for
 * both environments, so the KEY is the only thing separating play money from
 * real money. Two hard guarantees live here:
 *   - 'live' never silently falls back to the sandbox key (and vice versa);
 *     a missing live key is a clear error, not a quiet switch of environment.
 *   - a key that looks like the wrong environment is refused outright, so a
 *     pasted-in-the-wrong-variable live key can't make "Sandbox" spend real money.
 */
function credentialsFor(mode) {
  if (mode === 'live') {
    const key = config.maplerad.liveSecretKey;
    if (!key) {
      const err = new Error("L'émission de cartes en mode Live n'est pas encore disponible. Réessayez plus tard.");
      err.code = 'CARD_LIVE_NOT_CONFIGURED';
      err.httpStatus = 503;
      throw err;
    }
    if (/^mpr_sandbox_/i.test(key)) {
      const err = new Error('Configuration Live invalide.');
      err.code = 'CARD_LIVE_MISCONFIGURED';
      err.httpStatus = 503;
      // eslint-disable-next-line no-console
      console.error('MAPLERAD_LIVE_SECRET_KEY looks like a SANDBOX key - refusing to use it for Live.');
      throw err;
    }
    return { secretKey: key };
  }
  const key = config.maplerad.secretKey;
  if (/^mpr_sk_/i.test(key)) {
    const err = new Error('Configuration Sandbox invalide.');
    err.code = 'CARD_SANDBOX_MISCONFIGURED';
    err.httpStatus = 503;
    // eslint-disable-next-line no-console
    console.error('MAPLERAD_SECRET_KEY looks like a LIVE key - refusing to use it for Sandbox so real money cannot be spent by test traffic.');
    throw err;
  }
  return { secretKey: key };
}

/**
 * Server log of a provider response. Sandbox: the full body (useful for
 * diagnosing integration issues). Live: only non-personal identifiers and the
 * status line - real customer data never lands in logs.
 */
function logRaw(mode, label, res) {
  if (mode !== 'live') {
    // eslint-disable-next-line no-console
    console.log(`Maplerad ${label} raw response:`, JSON.stringify(res));
    return;
  }
  const d = (res && res.data) || {};
  // eslint-disable-next-line no-console
  console.log(`Maplerad[LIVE] ${label}:`, JSON.stringify({ status: res && res.status, message: res && res.message, id: d.id || null, reference: d.reference || (res && res.reference) || null }));
}

const GENERIC_FAILURE = "L'opération n'a pas pu être effectuée. Vérifiez les informations et réessayez.";
const TEMPORARY_FAILURE = 'Service momentanément indisponible. Réessayez dans un instant.';

/** Last-resort explanation, used ONLY when the provider gave no message at all. */
function translateStatus(httpStatus) {
  const table = {
    400: GENERIC_FAILURE,
    401: TEMPORARY_FAILURE, // our own server-side credentials problem: nothing the merchant can act on
    403: "Cette action n'est pas autorisée.",
    404: 'Élément introuvable.',
    409: 'Cette opération a peut-être déjà été effectuée.',
    422: 'Certaines informations sont invalides.',
    429: 'Trop de requêtes envoyées. Réessayez dans un instant.',
  };
  if (table[httpStatus]) return table[httpStatus];
  if (httpStatus >= 500) return TEMPORARY_FAILURE;
  return GENERIC_FAILURE;
}

/**
 * Recognises raw English fragments the provider sends back and returns a
 * simple French sentence. Returns null when nothing matches (the caller then
 * uses a neutral message; the raw text stays in the server log only).
 */
function translateKnownMessage(rawMessage) {
  if (!rawMessage || typeof rawMessage !== 'string') return null;
  const m = rawMessage.toLowerCase();

  if (m.includes('already') && (m.includes('enrolled') || m.includes('registered') || (m.includes('customer') && m.includes('exist')))) return 'Ce titulaire existe déjà.';
  if (m.includes('insufficient') && m.includes('balance')) return 'Solde insuffisant pour cette opération.';
  if (m.includes('customer') && m.includes('not found')) return 'Titulaire introuvable.';
  if (m.includes('card') && m.includes('not found')) return 'Carte introuvable.';
  if (m.includes('card') && m.includes('declin')) return 'La carte a refusé la transaction.';
  if (m.includes('already') && (m.includes('frozen') || m.includes('disabled'))) return 'Cette carte est déjà gelée.';
  if (m.includes('already') && m.includes('active')) return 'Cette carte est déjà active.';
  if (m.includes('already') && m.includes('terminat')) return 'Cette carte est déjà fermée.';
  if (m.includes('duplicate') && m.includes('reference')) return 'Cette référence a déjà été utilisée.';
  if ((m.includes('invalid') || m.includes('unsupported')) && m.includes('currency')) return 'Devise non prise en charge.';
  if (m.includes('invalid') && m.includes('country')) return 'Code pays invalide.';
  if (m.includes('dob') || m.includes('date of birth')) return 'Date de naissance invalide.';
  if (m.includes('invalid') && m.includes('phone')) return 'Numéro de téléphone invalide.';
  if (m.includes('invalid') && m.includes('email')) return 'Adresse email invalide.';
  if (m.includes('invalid') && (m.includes('amount') || m.includes('min') || m.includes('max'))) return 'Montant invalide.';
  if (m.includes('invalid') && m.includes('brand')) return 'Marque de carte invalide (VISA ou MASTERCARD).';
  if (m.includes('field validation') || m.includes("'required' tag") || m.includes('is required') || m.includes('missing')) return 'Une information obligatoire est manquante ou invalide.';
  if (m.includes('kyc') || (m.includes('tier') && (m.includes('required') || m.includes('upgrade')))) return "Le titulaire doit d'abord compléter sa vérification d'identité.";
  if (m.includes('rate limit') || m.includes('too many requests')) return 'Trop de requêtes envoyées. Réessayez dans un instant.';
  if (m.includes('unauthorized') || m.includes('invalid key') || m.includes('invalid secret') || m.includes('invalid token') || (m.includes('ip') && (m.includes('not allowed') || m.includes('whitelist')))) return TEMPORARY_FAILURE;
  if (m.includes('not active') || (m.includes('account') && m.includes('suspend'))) return TEMPORARY_FAILURE;

  return null;
}

/** Builds the merchant-safe error for a failed provider response and throws it. */
function throwProviderError(mode, method, path, httpStatus, data) {
  const rawMessage = data && (data.message || data.error || data.msg);
  // The raw provider text is for the operator only.
  // eslint-disable-next-line no-console
  console.error(`Provider[${mode === 'live' ? 'LIVE' : 'sandbox'}] ${method} ${path} -> HTTP ${httpStatus}:`, JSON.stringify(data));

  const message = translateKnownMessage(rawMessage) || (rawMessage ? GENERIC_FAILURE : translateStatus(httpStatus));
  const err = new Error(message);
  err.code = 'CARD_SERVICE_ERROR';
  err.httpStatus = httpStatus >= 500 ? 502 : 400;
  err.providerStatus = httpStatus;
  err.providerRawMessage = typeof rawMessage === 'string' ? rawMessage : null; // internal only, never sent to clients
  throw err;
}

async function request(mode, method, path, body) {
  const { secretKey } = credentialsFor(mode);
  let res;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (networkErr) {
    const err = new Error(TEMPORARY_FAILURE);
    err.code = 'CARD_SERVICE_UNAVAILABLE';
    err.httpStatus = 502;
    throw err;
  }

  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }

  if (!res.ok) throwProviderError(mode, method, path, res.status, data);

  // The provider can answer HTTP 200 with { "status": false, "message": ... }.
  // That is a failure, not a success: treating it as success is what left
  // cards "pending" forever and holders "verified" with no id.
  if (data && data.status === false) throwProviderError(mode, method, path, 400, data);

  return data;
}

function qs(params) {
  const clean = Object.entries(params || {}).filter(([, v]) => v != null && v !== '');
  if (!clean.length) return '';
  return '?' + new URLSearchParams(clean).toString();
}

/**
 * Documented card-issuing flow: 1) create the customer (Tier 0), 2) upgrade
 * to Tier 1, 3) create the card.
 */
async function createCustomer(mode, { firstName, lastName, email, country }) {
  const res = await request(mode, 'POST', '/customers', {
    first_name: firstName,
    last_name: lastName,
    email,
    country,
  });
  logRaw(mode, 'POST /customers', res);
  return res;
}

/** dob must be DD-MM-YYYY here (the provider's documented format). */
async function upgradeCustomerTier1(mode, { customerId, dob, phone, address, identificationNumber, photo }) {
  const res = await request(mode, 'PATCH', '/customers/upgrade/tier1', {
    customer_id: customerId,
    dob,
    phone,
    address,
    identification_number: identificationNumber,
    photo,
  });
  logRaw(mode, 'PATCH /customers/upgrade/tier1', res);
  return res;
}

/** Finds an already-registered customer by email (used to recover from "already enrolled"). */
async function findCustomersByEmail(mode, email, status) {
  return request(mode, 'GET', `/customers${qs({ email, status, page: 1, page_size: 10 })}`);
}

async function enrollCustomer(mode, { firstName, lastName, email, country, identificationNumber, dob, phone, identity, address, photo }) {
  const res = await request(mode, 'POST', '/customers/enroll', {
    first_name: firstName,
    last_name: lastName,
    email,
    country,
    identification_number: identificationNumber,
    dob,
    phone,
    identity,
    address,
    photo,
  });
  logRaw(mode, 'POST /customers/enroll', res);
  return res;
}

/** Create a virtual card for an individual customer. */
async function createCard(mode, { customerId, currency, type, autoApprove, brand, amount, isContactless }) {
  const res = await request(mode, 'POST', '/issuing', {
    customer_id: customerId,
    currency: currency || 'USD',
    type: type || 'VIRTUAL',
    auto_approve: autoApprove !== false,
    brand: brand || 'VISA',
    amount,
    is_contactless: !!isContactless,
  });
  logRaw(mode, 'POST /issuing', res);
  return res;
}

/** Create a business card (not tied to a single customer_id). */
async function createBusinessCard(mode, { name, type, brand, amount, autoApprove, currency, isContactless }) {
  const res = await request(mode, 'POST', '/issuing/business', {
    name,
    type: type || 'VIRTUAL',
    brand: brand || 'MASTERCARD',
    amount,
    auto_approve: autoApprove !== false,
    currency: currency || 'USD',
    is_contactless: !!isContactless,
  });
  logRaw(mode, 'POST /issuing/business', res);
  return res;
}

async function fundCard(mode, cardId, amount) {
  return request(mode, 'POST', `/issuing/${encodeURIComponent(cardId)}/fund`, { amount });
}

async function withdrawFromCard(mode, cardId, amount) {
  return request(mode, 'POST', `/issuing/${encodeURIComponent(cardId)}/withdraw`, { amount });
}

async function getCard(mode, cardId) {
  return request(mode, 'GET', `/issuing/${encodeURIComponent(cardId)}`);
}

async function listCards(mode, params) {
  return request(mode, 'GET', `/issuing${qs(params)}`);
}

async function getCardTransactions(mode, cardId, params) {
  return request(mode, 'GET', `/issuing/${encodeURIComponent(cardId)}/transactions${qs(params)}`);
}

/**
 * Sandbox-only: simulates a real card transaction (a purchase or a credit)
 * so the Issuing integration - and the transaction history it produces - can
 * be tested end-to-end without a real merchant charge.
 * https://maplerad.dev/reference/mock-card-transaction
 */
async function mockCardTransaction(mode, cardId, amountCents, type) {
  return request(mode, 'POST', `/test/issuing/${encodeURIComponent(cardId)}/mock-transaction`, {
    amount: amountCents,
    type: type === 'DEBIT' ? 'DEBIT' : 'CREDIT',
  });
}

async function freezeCard(mode, cardId) {
  return request(mode, 'PATCH', `/issuing/${encodeURIComponent(cardId)}/freeze`);
}

async function unfreezeCard(mode, cardId) {
  return request(mode, 'PATCH', `/issuing/${encodeURIComponent(cardId)}/unfreeze`);
}

async function terminateCard(mode, cardId) {
  return request(mode, 'PUT', `/issuing/${encodeURIComponent(cardId)}/terminate`);
}

/**
 * Issuing a card needs MORE than an API key: the card only becomes usable when
 * the provider's confirmation webhook arrives, and that webhook is rejected
 * unless its signing secret is configured. Creating a real card (and debiting
 * real money) with no way to receive the confirmation would leave the money
 * taken and the card stuck "pending" - so we refuse up front, before any debit.
 */
function assertReadyForIssuance(mode) {
  credentialsFor(mode);
  const secret = mode === 'live' ? config.maplerad.liveWebhookSecret : config.maplerad.webhookSecret;
  if (!secret) {
    const err = new Error("L'émission de cartes en mode Live n'est pas encore disponible. Réessayez plus tard.");
    err.code = 'CARD_LIVE_NOT_CONFIGURED';
    err.httpStatus = 503;
    // eslint-disable-next-line no-console
    console.error(`Refusing to issue a ${mode} card: the ${mode} webhook signing secret is not configured (MAPLERAD_${mode === 'live' ? 'LIVE_' : ''}WEBHOOK_SECRET).`);
    throw err;
  }
}

const IMPL = {
  enrollCustomer, createCustomer, findCustomersByEmail, upgradeCustomerTier1,
  createCard, createBusinessCard, fundCard, withdrawFromCard, getCard, listCards,
  getCardTransactions, mockCardTransaction, freezeCard, unfreezeCard, terminateCard,
};

const clients = {};

/**
 * Provider client bound to one environment: forMode('live') talks to the
 * production account with the live key, forMode('sandbox') (or anything else)
 * to the test account. Callers pick the mode from the CARD / HOLDER they are
 * acting on - never from a global switch - so a sandbox record can never end
 * up driving a live call.
 */
function forMode(mode) {
  const m = mode === 'live' ? 'live' : 'sandbox';
  if (!clients[m]) {
    clients[m] = Object.fromEntries(Object.entries(IMPL).map(([name, fn]) => [name, (...args) => {
      if (m === 'live' && name === 'mockCardTransaction') {
        const err = new Error('La simulation de transactions est réservée au mode Sandbox.');
        err.code = 'SANDBOX_ONLY';
        err.httpStatus = 400;
        return Promise.reject(err);
      }
      return fn(m, ...args);
    }]));
  }
  return clients[m];
}

module.exports = {
  forMode,
  // Backward-compatible default: the sandbox client, so existing code and tests keep working.
  ...forMode('sandbox'),
  credentialsFor,
  assertReadyForIssuance,
  translateStatus,
  translateKnownMessage,
};
