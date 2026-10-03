'use strict';
/**
 * Mock Maplerad server - mimics https://api.maplerad.com/v1 closely enough
 * to test our card-issuing integration end-to-end without network access.
 * Crucially, it reproduces the ASYNC card creation flow: the initial POST
 * just accepts the request, and a separate call (triggered here after a
 * short delay, like Maplerad would) delivers a signed webhook to our own
 * backend - exactly like production. NOT for production use.
 */
const http = require('http');
const crypto = require('crypto');

const PORT = parseInt(process.env.MOCK_MAPLERAD_PORT || '4504', 10);
const SECRET_KEY = process.env.MOCK_MAPLERAD_SECRET_KEY || 'sk_test_mock_maplerad_key';
// A SECOND key for the live environment, exactly like the real provider: same URL, the key decides which world you are in.
const LIVE_SECRET_KEY = process.env.MOCK_MAPLERAD_LIVE_SECRET_KEY || 'mpr_sk_mock_live_key';
const LIVE_WEBHOOK_SECRET = process.env.MOCK_MAPLERAD_LIVE_WEBHOOK_SECRET || 'whsec_' + Buffer.from('mock_LIVE_webhook_signing_key').toString('base64');
// Every authenticated request, so tests can prove which key a given action really used.
const calls = [];
const WEBHOOK_SECRET = process.env.MOCK_MAPLERAD_WEBHOOK_SECRET || 'whsec_' + Buffer.from('mock_webhook_signing_key_bytes').toString('base64');
// Where THIS mock delivers webhooks to - our own backend under test.
const WEBHOOK_TARGET = process.env.MOCK_MAPLERAD_WEBHOOK_TARGET || 'http://localhost:4000/webhooks/maplerad';

const customers = new Map(); // maplerad_customer_id -> record
const cards = new Map(); // maplerad_card_id -> record

const behavior = {
  failNextCardCreation: false,
  softErrorNextCard: false,
  cardCreationDelayMs: 30,
};

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); }
    });
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Which environment the presented key belongs to: 'sandbox', 'live', or null (unauthorized). */
function authEnv(req) {
  const header = req.headers['authorization'] || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  if (match[1] === SECRET_KEY) return 'sandbox';
  if (match[1] === LIVE_SECRET_KEY) return 'live';
  return null;
}

/** Cards/customers belong to one environment; the other environment's key cannot see them. */
function cardFor(env, id) {
  const c = cards.get(id);
  return c && c.env === env ? c : undefined;
}
function customerFor(env, id) {
  const c = customers.get(id);
  return c && c.env === env ? c : undefined;
}

/** Sends a Svix-style signed webhook to our backend, like the real Maplerad would. */
async function deliverWebhook(payload, env) {
  const id = randomId('msg');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify(payload);
  const secretB64 = (env === 'live' ? LIVE_WEBHOOK_SECRET : WEBHOOK_SECRET).replace(/^whsec_/, '');
  const secretBytes = Buffer.from(secretB64, 'base64');
  const signature = crypto.createHmac('sha256', secretBytes).update(`${id}.${timestamp}.${body}`).digest('base64');

  try {
    await fetch(WEBHOOK_TARGET, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'svix-id': id,
        'svix-timestamp': timestamp,
        'svix-signature': `v1,${signature}`,
      },
      body,
    });
  } catch (e) {
    // In real life Maplerad would retry; tests can inspect via /__control if needed.
  }
}

const server = http.createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (err) {
    send(res, 500, { message: `mock maplerad error: ${err.message}` });
  }
});

async function handle(req, res) {
  const url = new URL(req.url, 'http://internal');

  if (url.pathname === '/__control/reset') {
    customers.clear();
    cards.clear();
    calls.length = 0;
    behavior.failNextCardCreation = false;
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/__control/fail-next-card') {
    behavior.failNextCardCreation = true;
    return send(res, 200, { ok: true });
  }

  const env = authEnv(req);
  if (!env) {
    return send(res, 401, { status: false, message: 'Unauthorized' });
  }
  calls.push({ env, method: req.method, path: url.pathname });

  const body = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' ? await readJson(req) : {};

  // ---- POST /customers/enroll ----
  if (url.pathname === '/customers/enroll' && req.method === 'POST') {
    if (!body.first_name || !body.last_name || !body.email) {
      return send(res, 400, { status: false, message: 'Missing required fields' });
    }
    const id = randomId('cus');
    customers.set(id, { id, env, ...body });
    return send(res, 200, { status: true, message: 'success', id, first_name: body.first_name, last_name: body.last_name, email: body.email });
  }

  // ---- POST /customers (Tier 0: first_name, last_name, email, country) ----
  if (url.pathname === '/customers' && req.method === 'POST') {
    if (!body.first_name || !body.last_name || !body.email || !body.country) {
      return send(res, 400, { status: false, message: "Key: 'CreateCustomerRequest' Error:Field validation failed on the 'required' tag" });
    }
    for (const c of customers.values()) {
      if (c.env === env && c.email && c.email.toLowerCase() === String(body.email).toLowerCase()) {
        return send(res, 200, { status: false, message: 'customer is already enrolled' });
      }
    }
    const id = randomId('cus');
    customers.set(id, { id, env, tier: 0, ...body });
    return send(res, 200, { status: true, message: 'customer created successfully', data: { id, first_name: body.first_name, last_name: body.last_name, email: body.email } });
  }

  // ---- GET /customers?email=... ----
  if (url.pathname === '/customers' && req.method === 'GET') {
    const email = (url.searchParams.get('email') || '').toLowerCase();
    const found = Array.from(customers.values()).filter((c) => !email || (c.email || '').toLowerCase() === email);
    return send(res, 200, { status: true, message: 'ok', data: found.map((c) => ({ id: c.id, email: c.email, first_name: c.first_name, last_name: c.last_name })) });
  }

  // ---- PATCH /customers/upgrade/tier1 (dob must be DD-MM-YYYY) ----
  if (url.pathname === '/customers/upgrade/tier1' && req.method === 'PATCH') {
    const c = customerFor(env, body.customer_id);
    if (!c) return send(res, 400, { status: false, message: 'Customer not found' });
    if (!/^\d{2}-\d{2}-\d{4}$/.test(body.dob || '')) {
      return send(res, 400, { status: false, message: 'dob must be in the format DD-MM-YYYY' });
    }
    const missing = [];
    if (!body.phone || !body.phone.phone_country_code) missing.push("Key: 'TierOneCustomerUpgradeRequest.Phone.PhoneCountryCode' Error:Field validation for 'PhoneCountryCode' failed on the 'required' tag");
    if (!body.address || !body.address.street) missing.push("Key: 'TierOneCustomerUpgradeRequest.Address.Street' Error:Field validation for 'Street' failed on the 'required' tag");
    if (!body.address || !body.address.state) missing.push("Key: 'TierOneCustomerUpgradeRequest.Address.State' Error:Field validation for 'State' failed on the 'required' tag");
    if (!body.address || !body.address.postal_code) missing.push("Key: 'TierOneCustomerUpgradeRequest.Address.PostalCode' Error:Field validation for 'PostalCode' failed on the 'required' tag");
    if (!body.identification_number) missing.push("Key: 'TierOneCustomerUpgradeRequest.IdentificationNumber' Error:Field validation for 'IdentificationNumber' failed on the 'required' tag");
    if (missing.length) {
      return send(res, 200, { status: false, message: missing.join('\\n') });
    }
    Object.assign(c, { tier: 1 }, body);
    return send(res, 200, { status: true, message: 'customer upgraded successfully' });
  }

  // ---- POST /issuing (individual card) ----
  if (url.pathname === '/issuing' && req.method === 'POST') {
    if (behavior.softErrorNextCard) {
      behavior.softErrorNextCard = false;
      return send(res, 200, { status: false, message: "Key: 'CreateCardRequest.CustomerID' Error:Field validation for 'CustomerID' failed on the 'required' tag" });
    }
    if (!body.customer_id || !customerFor(env, body.customer_id)) {
      return send(res, 400, { status: false, message: 'Customer not found' });
    }
    const reference = randomId('ref');
    const cardId = randomId('card');
    const shouldFail = behavior.failNextCardCreation;
    behavior.failNextCardCreation = false;

    cards.set(cardId, {
      id: cardId,
      env,
      customer_id: body.customer_id,
      brand: body.brand || 'VISA',
      currency: body.currency || 'USD',
      status: shouldFail ? 'FAILED' : 'ACTIVE',
      masked_pan: `4242**${Math.floor(1000 + Math.random() * 9000)}`,
      card_number: '4242424242424242',
      cvv: '123',
      expiry: `12/${new Date().getFullYear() + 3}`,
      address: { street: '1 Main St', city: 'Wilmington', state: 'DE', postal_code: '19801', country: 'US' },
      name: 'CARDHOLDER',
    });

    setTimeout(() => {
      if (shouldFail) {
        deliverWebhook({ event: 'issuing.created.failed', reference }, env);
      } else {
        const card = cardFor(env, cardId);
        deliverWebhook({
          event: 'issuing.created.successful',
          reference,
          card: { id: cardId, name: card.name, masked_pan: card.masked_pan, type: 'VIRTUAL', issuer: card.brand, currency: card.currency, status: 'ACTIVE', balance: 0, auto_approve: true },
        }, env);
      }
    }, behavior.cardCreationDelayMs);

    return send(res, 200, { status: true, message: 'Card creation initiated', reference });
  }

  // ---- POST /issuing/business ----
  if (url.pathname === '/issuing/business' && req.method === 'POST') {
    if (behavior.softErrorNextCard) {
      behavior.softErrorNextCard = false;
      return send(res, 200, { status: false, message: "Key: 'CreateBusinessCardRequest.Name' Error:Field validation for 'Name' failed on the 'required' tag" });
    }
    if (!body.name || !body.amount) {
      return send(res, 400, { status: false, message: 'Missing required fields' });
    }
    const reference = randomId('ref');
    const cardId = randomId('card');
    const shouldFail = behavior.failNextCardCreation;
    behavior.failNextCardCreation = false;

    cards.set(cardId, {
      id: cardId,
      env,
      brand: body.brand || 'MASTERCARD',
      currency: body.currency || 'USD',
      status: shouldFail ? 'FAILED' : 'ACTIVE',
      masked_pan: `5399**${Math.floor(1000 + Math.random() * 9000)}`,
      card_number: '5399539953995399',
      cvv: '456',
      expiry: `${new Date().getFullYear() + 3}-11`,
      address: { street: '1 Main St', city: 'Wilmington', state: 'DE', postal_code: '19801', country: 'US' },
      name: body.name,
    });

    setTimeout(() => {
      if (shouldFail) {
        deliverWebhook({ event: 'issuing.created.failed', reference }, env);
      } else {
        const card = cardFor(env, cardId);
        deliverWebhook({
          event: 'issuing.created.successful',
          reference,
          card: { id: cardId, name: card.name, masked_pan: card.masked_pan, type: body.type || 'VIRTUAL', issuer: card.brand, currency: card.currency, status: 'ACTIVE', balance: 0, auto_approve: true },
        }, env);
      }
    }, behavior.cardCreationDelayMs);

    return send(res, 200, { status: true, message: 'Business card creation initiated', reference });
  }

  // ---- POST /issuing/{id}/fund ----
  let m = url.pathname.match(/^\/issuing\/([^/]+)\/fund$/);
  if (m && req.method === 'POST') {
    const card = cardFor(env, m[1]);
    if (!card) return send(res, 404, { status: false, message: 'Card not found' });
    return send(res, 200, { status: true, message: 'success', card_id: m[1], amount: body.amount });
  }

  // ---- POST /issuing/{id}/withdraw ----
  m = url.pathname.match(/^\/issuing\/([^/]+)\/withdraw$/);
  if (m && req.method === 'POST') {
    const card = cardFor(env, m[1]);
    if (!card) return send(res, 404, { status: false, message: 'Card not found' });
    return send(res, 200, { status: true, message: 'success', card_id: m[1], amount: body.amount });
  }

  // ---- PATCH /issuing/{id}/freeze ----
  m = url.pathname.match(/^\/issuing\/([^/]+)\/freeze$/);
  if (m && req.method === 'PATCH') {
    const card = cardFor(env, m[1]);
    if (!card) return send(res, 404, { status: false, message: 'Card not found' });
    card.status = 'DISABLED';
    return send(res, 200, { status: true, message: 'Card frozen' });
  }

  // ---- PATCH /issuing/{id}/unfreeze ----
  m = url.pathname.match(/^\/issuing\/([^/]+)\/unfreeze$/);
  if (m && req.method === 'PATCH') {
    const card = cardFor(env, m[1]);
    if (!card) return send(res, 404, { status: false, message: 'Card not found' });
    card.status = 'ACTIVE';
    return send(res, 200, { status: true, message: 'Card unfrozen' });
  }

  // ---- PUT /issuing/{id}/terminate ----
  m = url.pathname.match(/^\/issuing\/([^/]+)\/terminate$/);
  if (m && req.method === 'PUT') {
    const card = cardFor(env, m[1]);
    if (!card) return send(res, 404, { status: false, message: 'Card not found' });
    card.status = 'TERMINATED';
    return send(res, 200, { status: true, message: 'Card terminated' });
  }

  // ---- POST /test/issuing/{id}/mock-transaction ----
  m = url.pathname.match(/^\/test\/issuing\/([^/]+)\/mock-transaction$/);
  if (m && req.method === 'POST') {
    const card = cardFor(env, m[1]);
    if (!card) return send(res, 404, { status: false, message: 'Card not found' });
    if (!body.amount || !['CREDIT', 'DEBIT'].includes(body.type)) {
      return send(res, 400, { status: false, message: 'amount and type (CREDIT|DEBIT) are required' });
    }
    return send(res, 200, { status: true, message: 'Mock transaction created', reference: randomId('mocktxn') });
  }

  // ---- GET /issuing/{id}/transactions ----
  m = url.pathname.match(/^\/issuing\/([^/]+)\/transactions$/);
  if (m && req.method === 'GET') {
    const card = cardFor(env, m[1]);
    if (!card) return send(res, 404, { status: false, message: 'Card not found' });
    const now = new Date().toISOString();
    return send(res, 200, {
      status: true,
      data: [
        { id: 'txn_mock_1', type: 'AUTHORIZATION', mode: 'DEBIT', status: 'SUCCESS', amount: 1250, currency: 'USD', merchant: { name: 'Amazon', city: 'Seattle' }, created_at: now },
        { id: 'txn_mock_2', type: 'FUNDING', mode: 'CREDIT', status: 'SUCCESS', amount: 2000, currency: 'USD', merchant: null, created_at: now },
      ],
    });
  }

  // ---- GET /issuing/{id} ----
  m = url.pathname.match(/^\/issuing\/([^/]+)$/);
  if (m && req.method === 'GET') {
    const card = cardFor(env, m[1]);
    if (!card) return send(res, 404, { status: false, message: 'Card not found' });
    return send(res, 200, { status: true, data: card });
  }

  // ---- GET /issuing ----
  if (url.pathname === '/issuing' && req.method === 'GET') {
    return send(res, 200, { status: true, data: Array.from(cards.values()) });
  }

  send(res, 404, { status: false, message: 'Not found (mock)' });
}

if (require.main === module) {
  server.listen(PORT, () => console.log(`Mock Maplerad server on http://localhost:${PORT}`));
}

module.exports = { server, SECRET_KEY, WEBHOOK_SECRET, LIVE_SECRET_KEY, LIVE_WEBHOOK_SECRET, calls, behavior };
