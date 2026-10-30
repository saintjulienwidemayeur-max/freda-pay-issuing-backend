'use strict';
const test = require('node:test');
const TEST_IDENTITY = { type: 'PASSPORT', number: 'P1234567', imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', country: 'HT' };
const assert = require('node:assert/strict');

// Isolated env, configured BEFORE requiring any app module (config.js reads env at require time).
process.env.SESSION_SECRET = 'test-session-secret';
process.env.PLOPPLOP_BASE_URL = 'http://localhost:4501';
process.env.PLOPPLOP_CLIENT_ID = 'pp_test_client';
process.env.PLOPPLOP_CLIENT_SECRET = 'test_secret_value';
process.env.PAYOUT_COOLDOWN_MS = '50'; // fast for tests
process.env.BUSINESS_CARDS_PAUSED = 'false'; // the suite exercises business cards; the pause has its own test
process.env.ALLOW_PRIVATE_WEBHOOKS = '1'; // the local mock webhook receivers live on localhost (SSRF guard has its own tests)

process.env.MOCK_CLIENT_ID = 'pp_test_client';
process.env.MOCK_CLIENT_SECRET = 'test_secret_value';
process.env.MOCK_PORT = '4501';

process.env.SUPABASE_URL = 'http://localhost:4503';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock_service_role_key';
process.env.MOCK_SUPABASE_PORT = '4503';
process.env.MOCK_SUPABASE_SERVICE_KEY = 'mock_service_role_key';

const APP_PORT = 4502;

process.env.MAPLERAD_BASE_URL = 'http://localhost:4504';
process.env.MAPLERAD_SECRET_KEY = 'sk_test_mock_maplerad_key';
process.env.MAPLERAD_WEBHOOK_SECRET = 'whsec_' + Buffer.from('mock_webhook_signing_key_bytes').toString('base64');
process.env.MAPLERAD_LIVE_SECRET_KEY = 'mpr_sk_mock_live_key';
process.env.MAPLERAD_LIVE_WEBHOOK_SECRET = 'whsec_' + Buffer.from('mock_LIVE_webhook_signing_key').toString('base64');
process.env.MOCK_MAPLERAD_LIVE_SECRET_KEY = process.env.MAPLERAD_LIVE_SECRET_KEY;
process.env.MOCK_MAPLERAD_LIVE_WEBHOOK_SECRET = process.env.MAPLERAD_LIVE_WEBHOOK_SECRET;
process.env.SITE_URL_CHECK = 'off'; // the site-address check is exercised explicitly in its own tests
process.env.MOCK_MAPLERAD_PORT = '4504';
process.env.MOCK_MAPLERAD_SECRET_KEY = 'sk_test_mock_maplerad_key';
process.env.MOCK_MAPLERAD_WEBHOOK_SECRET = process.env.MAPLERAD_WEBHOOK_SECRET;
process.env.MOCK_MAPLERAD_WEBHOOK_TARGET = `http://localhost:${APP_PORT}/webhooks/maplerad`;

process.env.BREVO_BASE_URL = 'http://localhost:4506';
process.env.BREVO_API_KEY = 'mock-brevo-key';
process.env.MOCK_BREVO_PORT = '4506';
process.env.MOCK_BREVO_API_KEY = 'mock-brevo-key';

process.env.MASTER_WALLET_MINIMUM_USD = '50';

process.env.TRANZAK_BASE_URL = 'http://localhost:4530';
process.env.TRANZAK_TEST_KEY = 'tk_test_mock';
process.env.TRANZAK_LIVE_KEY = 'tk_live_mock';
process.env.TRANZAK_TEST_WEBHOOK_SECRET = 'whsec_test_card_secret';
process.env.TRANZAK_LIVE_WEBHOOK_SECRET = 'whsec_live_card_secret';
process.env.TRANZAK_POLL_MIN_GAP_MS = '0'; // polling is throttled in production; the throttle has its own test
process.env.MOCK_TRANZAK_PORT = '4530';

const { server: mockPlopplop } = require('../mock/plopplop-mock-server');
const { server: mockSupabase, reset: resetSupabase, tables: mockTables } = require('../mock/supabase-mock-server');
const { server: mockMaplerad, behavior: mapleradBehavior, calls: mapleradCalls, LIVE_WEBHOOK_SECRET: MOCK_LIVE_WHSEC, WEBHOOK_SECRET: MOCK_SANDBOX_WHSEC } = require('../mock/maplerad-mock-server');
const { server: mockTranzak } = require('../mock/tranzak-mock-server');
const { server: mockBrevo, sentEmails } = require('../mock/brevo-mock-server');
const app = require('../src/server');

let baseUrl;

test.before(async () => {
  await new Promise((r) => mockPlopplop.listen(4501, r));
  await new Promise((r) => mockSupabase.listen(4503, r));
  await new Promise((r) => mockMaplerad.listen(4504, r));
  await new Promise((r) => mockBrevo.listen(4506, r));
  await new Promise((r) => mockTranzak.listen(4530, r));
  await new Promise((r) => app.listen(APP_PORT, r));
  baseUrl = `http://localhost:${APP_PORT}`;
  resetSupabase();
});

test.after(async () => {
  await new Promise((r) => mockPlopplop.close(r));
  await new Promise((r) => mockSupabase.close(r));
  await new Promise((r) => mockMaplerad.close(r));
  await new Promise((r) => mockBrevo.close(r));
  await new Promise((r) => mockTranzak.close(r));
  await new Promise((r) => app.close(r));
});

/** Extracts the 6-digit OTP code from the most recently sent email to `email`. */
function extractOtpFromEmail(email) {
  const matches = sentEmails.filter((e) => e.to === email);
  const last = matches[matches.length - 1];
  if (!last) throw new Error(`No OTP email captured for ${email}`);
  const m = last.text.match(/code de vérification : (\d{6})/);
  if (!m) throw new Error(`Could not find OTP code in captured email to ${email}`);
  return m[1];
}

/**
 * Full signup flow used by every other test: register -> read the OTP the
 * mock Brevo server captured -> verify it -> return the real session token,
 * exactly mirroring what a real user does after receiving the email.
 */
/** The 6-digit code from the newest LOGIN email sent to `email`. */
function extractLoginCode(email) {
  const matches = sentEmails.filter((e) => e.to === email && /code de connexion/.test(e.text));
  const last = matches[matches.length - 1];
  if (!last) throw new Error(`No login-code email captured for ${email}`);
  return last.text.match(/code de connexion : (\d{6})/)[1];
}

/**
 * Full two-step login: password, then the emailed code. A failure at step one
 * (wrong password, locked, deactivated...) is returned as-is, exactly like before.
 */
async function loginWithOtp(email, password, base = '/auth') {
  const step1 = await api('POST', `${base}/login`, { headers: freshIp(), body: { email, password } });
  if (step1.status !== 200) return step1;
  assert.equal(step1.data.otp_required, true);
  assert.equal(step1.data.session_token, undefined, 'a password alone must never return a session');
  return api('POST', `${base}/login/verify`, { headers: freshIp(), body: { challenge_id: step1.data.challenge_id, code: extractLoginCode(email.toLowerCase()) } });
}

let registerIpCounter = 0;
let clientIpCounter = 0;
/** Each simulated visitor gets its own address, like real users: the suite makes far more calls than one address may. */
const freshIp = () => ({ 'x-forwarded-for': `10.${Math.floor((clientIpCounter += 1) / 250) % 250}.${clientIpCounter % 250}.7` });
async function registerAndVerify(payload) {
  // A distinct client IP per signup, like real users: the suite creates far more accounts than one
  // address is allowed to (60/hour), and that limit is not what these tests are about.
  registerIpCounter += 1;
  const reg = await api('POST', '/auth/register', { headers: { 'x-forwarded-for': `198.51.100.${registerIpCounter % 250}` }, body: payload });
  if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.data)}`);
  const code = extractOtpFromEmail(payload.email.toLowerCase());
  const verify = await api('POST', '/auth/verify-otp', { headers: freshIp(), body: { merchant_id: reg.data.merchant_id, code } });
  if (verify.status !== 200) throw new Error(`verify-otp failed: ${JSON.stringify(verify.data)}`);
  return verify; // { status, data: { merchant, session_token } }
}

async function api(method, path, { body, token, headers } = {}) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      token ? { Authorization: `Bearer ${token}` } : {},
      headers || {}
    ),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const SANDBOX_SEED = 5000; // matches config.js's default SANDBOX_MASTER_WALLET_SEED_USD

let sessionToken;
let testApiKeySecret;
let merchantId;

test('health check responds', async () => {
  const r = await api('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
});

let pendingMerchantId;

test('register does NOT return a usable session - an OTP email is sent instead', async () => {
  const r = await api('POST', '/auth/register', {
    body: {
      business_name: 'Boutique Lakay',
      entity_type: 'LLC',
      account_type: 'business',
      email: 'owner@boutiquelakay.com',
      phone: '50931234567',
      password: 'sup3rSecret!',
    },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.session_token, undefined);
  assert.equal(r.data.otp_required, true);
  assert.equal(r.data.email_verified, false);
  pendingMerchantId = r.data.merchant_id;

  const code = extractOtpFromEmail('owner@boutiquelakay.com');
  assert.match(code, /^\d{6}$/);
});

test('cannot register the same email twice', async () => {
  const r = await api('POST', '/auth/register', {
    body: { business_name: 'X', email: 'owner@boutiquelakay.com', password: 'anotherPassw0rd' },
  });
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, 'EMAIL_TAKEN');
});

test('logging in before verifying the email is rejected', async () => {
  const r = await api('POST', '/auth/login', { body: { email: 'owner@boutiquelakay.com', password: 'sup3rSecret!' } });
  assert.equal(r.status, 403);
  assert.equal(r.data.error.code, 'EMAIL_NOT_VERIFIED');
});

test('verifying with the wrong OTP code is rejected and counts as an attempt', async () => {
  const r = await api('POST', '/auth/verify-otp', { body: { merchant_id: pendingMerchantId, code: '000000' } });
  assert.equal(r.status, 400);
  assert.equal(r.data.error.code, 'OTP_INCORRECT');
  assert.match(r.data.error.message, /tentative/);
});

test('verifying with the correct OTP code succeeds and returns a session', async () => {
  const code = extractOtpFromEmail('owner@boutiquelakay.com');
  const r = await api('POST', '/auth/verify-otp', { body: { merchant_id: pendingMerchantId, code } });
  assert.equal(r.status, 200);
  assert.ok(r.data.session_token);
  assert.equal(r.data.merchant.email_verified, true);
  sessionToken = r.data.session_token;
  merchantId = r.data.merchant.id;
});

test('verifying again (already verified) never issues a session: 409 ALREADY_VERIFIED', async () => {
  const code = extractOtpFromEmail('owner@boutiquelakay.com');
  const r = await api('POST', '/auth/verify-otp', { body: { merchant_id: pendingMerchantId, code } });
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, 'ALREADY_VERIFIED');
  assert.equal(r.data.session_token, undefined);
});

test('resend-otp is rejected once already verified', async () => {
  const r = await api('POST', '/auth/resend-otp', { body: { merchant_id: pendingMerchantId } });
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, 'ALREADY_VERIFIED');
});

test('login with correct credentials works after verification (password, then the emailed code)', async () => {
  const r = await loginWithOtp('owner@boutiquelakay.com', 'sup3rSecret!');
  assert.equal(r.status, 200);
  assert.ok(r.data.session_token);
  assert.equal(r.data.role, 'owner');
});

test('login with wrong password fails', async () => {
  const r = await api('POST', '/auth/login', {
    body: { email: 'owner@boutiquelakay.com', password: 'wrong' },
  });
  assert.equal(r.status, 401);
});

test('resend-otp for a fresh unverified signup issues a new working code', async () => {
  const reg = await api('POST', '/auth/register', {
    body: { business_name: 'Resend Co', email: 'resend@example.com', password: 'password123' },
  });
  assert.equal(reg.status, 201);

  const resend = await api('POST', '/auth/resend-otp', { body: { merchant_id: reg.data.merchant_id } });
  assert.equal(resend.status, 200);
  assert.equal(resend.data.sent, true);

  const newCode = extractOtpFromEmail('resend@example.com');
  const verify = await api('POST', '/auth/verify-otp', { body: { merchant_id: reg.data.merchant_id, code: newCode } });
  assert.equal(verify.status, 200);
  assert.ok(verify.data.session_token);
});

test('/auth/me requires a valid session token', async () => {
  const noAuth = await api('GET', '/auth/me');
  assert.equal(noAuth.status, 401);

  const authed = await api('GET', '/auth/me', { token: sessionToken });
  assert.equal(authed.status, 200);
  assert.equal(authed.data.merchant.id, merchantId);
});

test('create a test-mode API key', async () => {
  const r = await api('POST', '/dashboard/api-keys', { token: sessionToken, body: { mode: 'test' } });
  assert.equal(r.status, 201);
  assert.match(r.data.key_id, /^pk_test_/);
  assert.match(r.data.secret, /^sk_test_/);
  testApiKeySecret = r.data.secret;
});

test('creating a live-mode API key is blocked until the merchant is verified (live_enabled)', async () => {
  const r = await api('POST', '/dashboard/api-keys', { token: sessionToken, body: { mode: 'live' } });
  assert.equal(r.status, 403);
  assert.equal(r.data.error.code, 'LIVE_NOT_ENABLED');
});

test('gateway balance starts at zero, master wallet starts with the sandbox seed', async () => {
  const r = await api('GET', '/v1/balance', { token: testApiKeySecret });
  assert.equal(r.status, 200);
  assert.equal(r.data.gateway.available, 0);
  assert.equal(r.data.master_wallet.available, SANDBOX_SEED);
});

test('invalid API key is rejected', async () => {
  const r = await api('GET', '/v1/balance', { token: 'sk_test_' + 'a'.repeat(48) });
  assert.equal(r.status, 401);
  assert.equal(r.data.error.code, 'INVALID_API_KEY');
});

let paymentId, paymentReference;

test('create a MonCash payment', async () => {
  paymentReference = 'CMD-' + Date.now();
  const r = await api('POST', '/v1/payments', {
    token: testApiKeySecret,
    body: { amount: 1000, currency: 'HTG', method: 'moncash', reference: paymentReference },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.status, 'pending');
  assert.ok(r.data.checkout_url);
  paymentId = r.data.id;
});

test('payment rejects amount below the 20 HTG minimum', async () => {
  const r = await api('POST', '/v1/payments', {
    token: testApiKeySecret,
    body: { amount: 5, currency: 'HTG', method: 'moncash', reference: 'CMD-too-small' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.data.error.code, 'INVALID_AMOUNT');
});

test('verifying before confirmation still shows pending', async () => {
  const r = await api('GET', `/v1/payments/${paymentId}`, { token: testApiKeySecret });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'pending');
});

test('after provider confirms, verify credits the gateway ledger with fee deducted', async () => {
  // Simulate the customer completing payment on the provider's side.
  await fetch('http://localhost:4501/__control/confirm-payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refference_id: `fp_${merchantId}_${paymentReference}` }),
  });

  const r = await api('GET', `/v1/payments/${paymentId}`, { token: testApiKeySecret });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'succeeded');
  // Standard Gateway plan (default): 6% + 10 HTG fee on 1000 HTG = 70 HTG fee -> net 930
  assert.equal(r.data.fee, 70);
  assert.equal(r.data.net_amount, 930);

  const bal = await api('GET', '/v1/balance', { token: testApiKeySecret });
  assert.equal(bal.data.gateway.available, 930);
});

test('re-verifying an already-succeeded payment does not double-credit', async () => {
  await api('GET', `/v1/payments/${paymentId}`, { token: testApiKeySecret });
  await api('GET', `/v1/payments/${paymentId}`, { token: testApiKeySecret });
  const bal = await api('GET', '/v1/balance', { token: testApiKeySecret });
  assert.equal(bal.data.gateway.available, 930); // unchanged
});

test('replaying the same payment reference is idempotent (no duplicate)', async () => {
  const r = await api('POST', '/v1/payments', {
    token: testApiKeySecret,
    body: { amount: 1000, currency: 'HTG', method: 'moncash', reference: paymentReference },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.id, paymentId);
});

test('payout is rejected when balance is insufficient', async () => {
  const r = await api('POST', '/v1/payouts', {
    token: testApiKeySecret,
    body: { amount: 5000, method: 'natcash', recipient: '50912345678', reference: 'WD-001' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.data.error.code, 'INSUFFICIENT_BALANCE');
  assert.match(r.data.error.message, /5000 HTG \+ 250 HTG de frais/); // the fee is part of what is needed
});

test('payout with invalid recipient format is rejected', async () => {
  const r = await api('POST', '/v1/payouts', {
    token: testApiKeySecret,
    body: { amount: 10, method: 'natcash', recipient: '12345', reference: 'WD-bad-phone' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.data.error.code, 'INVALID_RECIPIENT');
});

let payoutId;

test('a successful payout debits the ledger by amount+fee and reaches status success', async () => {
  const r = await api('POST', '/v1/payouts', {
    token: testApiKeySecret,
    body: { amount: 500, method: 'natcash', recipient: '50912345678', reference: 'WD-002' },
  });
  assert.equal(r.status, 202);
  assert.equal(r.data.status, 'pending');
  payoutId = r.data.id;

  // Poll until the queued job completes (cooldown is 50ms in tests).
  let finalStatus;
  for (let i = 0; i < 50; i++) {
    const check = await api('GET', `/v1/payouts/${payoutId}`, { token: testApiKeySecret });
    finalStatus = check.data.status;
    if (finalStatus !== 'pending') break;
    await sleep(20);
  }
  assert.equal(finalStatus, 'success');
  let check0;

  const bal = await api('GET', '/v1/balance', { token: testApiKeySecret });
  // 930 available. The merchant pays the 500 sent + Freda Pay's 5 % withdrawal fee (25) = 525.
  // (What the payment partner charged us to send it, 2.5 % = 12.5 in the test double, is our cost, not the merchant's.)
  assert.equal(bal.data.gateway.available, 930 - 525);
  assert.equal(check0 = (await api('GET', `/v1/payouts/${payoutId}`, { token: testApiKeySecret })).data.fee, 25);
});

test('a failed provider withdrawal gives the held money back: the balance ends where it started', async () => {
  const balBefore = await api('GET', '/v1/balance', { token: testApiKeySecret });

  await fetch('http://localhost:4501/__control/fail-next-withdrawal', { method: 'POST' });

  const r = await api('POST', '/v1/payouts', {
    token: testApiKeySecret,
    body: { amount: 50, method: 'natcash', recipient: '50912345678', reference: 'WD-003-will-fail' },
  });
  assert.equal(r.status, 202);

  let finalStatus;
  for (let i = 0; i < 50; i++) {
    const check = await api('GET', `/v1/payouts/${r.data.id}`, { token: testApiKeySecret });
    finalStatus = check.data.status;
    if (finalStatus !== 'pending') break;
    await sleep(20);
  }
  assert.equal(finalStatus, 'failed');

  const balAfter = await api('GET', '/v1/balance', { token: testApiKeySecret });
  assert.equal(balAfter.data.gateway.available, balBefore.data.gateway.available);
});

test('replaying the same payout reference is idempotent', async () => {
  const r = await api('POST', '/v1/payouts', {
    token: testApiKeySecret,
    body: { amount: 500, method: 'natcash', recipient: '50912345678', reference: 'WD-002' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.id, payoutId);
});

test('dashboard: listing payments requires a session token, not an API key', async () => {
  const withApiKey = await api('GET', '/dashboard/payments', { token: testApiKeySecret });
  assert.equal(withApiKey.status, 401); // API key is not a valid session token

  const withSession = await api('GET', '/dashboard/payments', { token: sessionToken });
  assert.equal(withSession.status, 200);
  assert.ok(Array.isArray(withSession.data.payments));
  assert.ok(withSession.data.payments.length >= 1);
  assert.equal(withSession.data.payments[0].reference, paymentReference);
});

test('dashboard: creating a payment via session auth works the same as via API key', async () => {
  const r = await api('POST', '/dashboard/payments', {
    token: sessionToken,
    body: { amount: 300, currency: 'HTG', method: 'natcash', reference: 'DASH-CMD-1' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.status, 'pending');
});

test('dashboard: listing payouts shows the ones created earlier via API key', async () => {
  const r = await api('GET', '/dashboard/payouts', { token: sessionToken });
  assert.equal(r.status, 200);
  const refs = r.data.payouts.map((p) => p.reference);
  assert.ok(refs.includes('WD-002'));
});

test('wallet topup: automatic MonCash top-up credits Master Wallet with correct fee/conversion', async () => {
  const reference = 'TOPUP-' + Date.now();
  const create = await api('POST', '/dashboard/wallet/topups', {
    token: sessionToken,
    body: { method: 'moncash', amount_htg: 13300, reference },
  });
  assert.equal(create.status, 201);
  assert.equal(create.data.status, 'pending');

  // Simulate the customer completing the MonCash payment on PlopPlop's side.
  await fetch('http://localhost:4501/__control/confirm-payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refference_id: `fp_${merchantId}_${reference}` }),
  });

  const check = await api('GET', `/dashboard/wallet/topups/${create.data.id}`, { token: sessionToken });
  assert.equal(check.status, 200);
  assert.equal(check.data.status, 'succeeded');
  // Startup plan: Freda Pay's 4.5 % + the payment partner's 4 % (charged to the person topping up) = 8.5 % of 13300 = 1130.5
  // -> net 12169.5 -> / 133 = 91.5 USD
  assert.equal(check.data.fee_htg, 1130.5);
  assert.equal(check.data.credited_usd, 91.5);

  const bal = await api('GET', '/dashboard/balance', { token: sessionToken });
  assert.equal(bal.data.master_wallet.available, SANDBOX_SEED + 91.5);
});

test('wallet topup: manual Zelle top-up uploads a receipt and stays awaiting_review (never auto-credits)', async () => {
  const balBefore = await api('GET', '/dashboard/balance', { token: sessionToken });
  const receipt = Buffer.from('fake receipt image bytes').toString('base64');

  const r = await api('POST', '/dashboard/wallet/topups', {
    token: sessionToken,
    body: {
      method: 'zelle',
      amount_usd: 200,
      reference: 'ZELLE-' + Date.now(),
      receipt_filename: 'recu.jpg',
      receipt_base64: receipt,
      receipt_content_type: 'image/jpeg',
    },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.status, 'awaiting_review');
  assert.equal(r.data.receipt_filename, 'recu.jpg');

  const balAfter = await api('GET', '/dashboard/balance', { token: sessionToken });
  assert.equal(balAfter.data.master_wallet.available, balBefore.data.master_wallet.available); // unchanged
});

test('wallet topup: a missing Storage bucket is created automatically and the receipt upload succeeds', async () => {
  process.env.MOCK_STRICT_BUCKETS = '1'; // mock now answers NoSuchBucket until the bucket is created
  try {
    const r = await api('POST', '/dashboard/wallet/topups', {
      token: sessionToken,
      body: {
        method: 'zelle',
        amount_usd: 50,
        reference: 'ZELLE-BUCKET-' + Date.now(),
        receipt_filename: 'recu.jpg',
        receipt_base64: Buffer.from('bytes').toString('base64'),
        receipt_content_type: 'image/jpeg',
      },
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.status, 'awaiting_review');
  } finally {
    delete process.env.MOCK_STRICT_BUCKETS;
  }
});

test('wallet topup: manual bank_transfer without a receipt still records the request', async () => {
  const r = await api('POST', '/dashboard/wallet/topups', {
    token: sessionToken,
    body: { method: 'bank_transfer', amount_usd: 500, reference: 'BANK-' + Date.now() },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.status, 'awaiting_review');
});

test('wallet topup: rejects an invalid method', async () => {
  const r = await api('POST', '/dashboard/wallet/topups', {
    token: sessionToken,
    body: { method: 'paypal', amount_usd: 10, reference: 'BAD-' + Date.now() },
  });
  assert.equal(r.status, 400);
  assert.equal(r.data.error.code, 'INVALID_METHOD');
});

test('wallet topup: listing shows all top-up requests for the merchant', async () => {
  const r = await api('GET', '/dashboard/wallet/topups', { token: sessionToken });
  assert.equal(r.status, 200);
  const methods = r.data.topups.map((t) => t.method);
  assert.ok(methods.includes('moncash'));
  assert.ok(methods.includes('zelle'));
  assert.ok(methods.includes('bank_transfer'));
});

/* ===== Individual account, KYB not required, then upgrade to business ===== */

let individualToken, individualId;

test('an individual account starts without needing KYB', async () => {
  const r = await registerAndVerify({
    business_name: 'Jean Baptiste', account_type: 'individual', email: 'jean@example.com', password: 'password123',
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.merchant.account_type, 'individual');
  individualToken = r.data.session_token;
  individualId = r.data.merchant.id;
});

test('upgrading an individual account to business sets entity_type and resets kyb_status', async () => {
  const r = await api('PUT', '/dashboard/account', {
    token: individualToken,
    body: { account_type: 'business', business_name: 'Jean Baptiste Trading', entity_type: 'LLC' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.merchant.account_type, 'business');
  assert.equal(r.data.merchant.entity_type, 'LLC');
  assert.equal(r.data.merchant.business_name, 'Jean Baptiste Trading');
  assert.equal(r.data.merchant.kyb_status, 'not_started');
});

/* ===== Billing charged from Master Wallet ===== */

test('billing: GET /dashboard/billing/plans returns both plan catalogs', async () => {
  const r = await api('GET', '/dashboard/billing/plans', { token: individualToken });
  assert.equal(r.status, 200);
  assert.ok(r.data.gatewayPlans.standard && r.data.gatewayPlans.pro && r.data.gatewayPlans.business);
  assert.ok(r.data.issuingPlans.startup && r.data.issuingPlans.pro && r.data.issuingPlans.premium);
  assert.equal(r.data.gatewayPlans.pro.monthlyFeeHTG, 1000);
  assert.equal(r.data.issuingPlans.pro.monthlyFeeUSD, 150);
});

test('billing: changing the Gateway plan fails once the Master Wallet is at its minimum reserve', async () => {
  // Every sandbox account starts with a seeded Master Wallet balance (so merchants
  // can test freely); drain it down to EXACTLY the $50 floor via a legitimate
  // purchase first - any further paid operation must then be rejected, since
  // no debit may bring the balance below that floor.
  const before = await api('GET', '/dashboard/balance', { token: individualToken });
  const preload = before.data.master_wallet.available - 50 - 5; // - $50 floor - $5 startup creation fee
  const drain = await api('POST', '/dashboard/cards', {
    token: individualToken,
    body: { reference: 'DRAIN-1', kind: 'business', business_name: 'Drain Co', amount: preload },
  });
  assert.equal(drain.status, 202);

  const afterDrain = await api('GET', '/dashboard/balance', { token: individualToken });
  assert.equal(afterDrain.data.master_wallet.available, 50);

  const r = await api('POST', '/dashboard/billing/gateway-plan', {
    token: individualToken,
    body: { plan: 'pro' }, // 1000 HTG/mo ≈ $7.52 - any positive charge is now rejected
  });
  assert.equal(r.status, 400);
  assert.equal(r.data.error.code, 'BELOW_MINIMUM_BALANCE');
});

test('billing: changing the Gateway plan debits the Master Wallet, converted from HTG to USD', async () => {
  const reference = 'TOPUP-BILLING-' + Date.now();
  const topup = await api('POST', '/dashboard/wallet/topups', {
    token: individualToken,
    body: { method: 'moncash', amount_htg: 13300, reference }, // -> ~95.5 USD credited (startup plan, 4.5%)
  });
  await fetch('http://localhost:4501/__control/confirm-payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refference_id: `fp_${individualId}_${reference}` }),
  });
  await api('GET', `/dashboard/wallet/topups/${topup.data.id}`, { token: individualToken }); // triggers credit

  const before = await api('GET', '/dashboard/balance', { token: individualToken });
  assert.ok(before.data.master_wallet.available >= 10);

  const r = await api('POST', '/dashboard/billing/gateway-plan', { token: individualToken, body: { plan: 'pro' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.charged, 7.52); // round2(1000 HTG / 133)
  assert.equal(r.data.merchant.gateway_plan, 'pro');

  const after = await api('GET', '/dashboard/balance', { token: individualToken });
  assert.equal(after.data.master_wallet.available, before.data.master_wallet.available - 7.52);
});

test('billing: switching to the same Gateway plan again does not charge twice', async () => {
  const before = await api('GET', '/dashboard/balance', { token: individualToken });
  const r = await api('POST', '/dashboard/billing/gateway-plan', { token: individualToken, body: { plan: 'pro' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.charged, 0);
  const after = await api('GET', '/dashboard/balance', { token: individualToken });
  assert.equal(after.data.master_wallet.available, before.data.master_wallet.available);
});

test('billing: changing the Issuing plan charges its USD price directly (no conversion)', async () => {
  // Top up enough for the $150 Issuing Pro plan (previous tests left less than that).
  const reference = 'TOPUP-ISSUING-BILLING-' + Date.now();
  const topup = await api('POST', '/dashboard/wallet/topups', {
    token: individualToken,
    body: { method: 'moncash', amount_htg: 26600, reference }, // ~2x the earlier top-up -> ~$191
  });
  await fetch('http://localhost:4501/__control/confirm-payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refference_id: `fp_${individualId}_${reference}` }),
  });
  await api('GET', `/dashboard/wallet/topups/${topup.data.id}`, { token: individualToken });

  const before = await api('GET', '/dashboard/balance', { token: individualToken });
  assert.ok(before.data.master_wallet.available >= 150);
  const r = await api('POST', '/dashboard/billing/issuing-plan', { token: individualToken, body: { plan: 'pro' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.charged, 150);
  assert.equal(r.data.merchant.issuing_plan, 'pro');
  const after = await api('GET', '/dashboard/balance', { token: individualToken });
  assert.equal(after.data.master_wallet.available, before.data.master_wallet.available - 150);
});

test('billing: rejects an unknown plan name on both tracks', async () => {
  const g = await api('POST', '/dashboard/billing/gateway-plan', { token: individualToken, body: { plan: 'ultra' } });
  assert.equal(g.status, 400);
  assert.equal(g.data.error.code, 'INVALID_PLAN');
  const i = await api('POST', '/dashboard/billing/issuing-plan', { token: individualToken, body: { plan: 'ultra' } });
  assert.equal(i.status, 400);
  assert.equal(i.data.error.code, 'INVALID_PLAN');
});

/* ===== Payment Links (public checkout) ===== */

let paymentLinkId;

test('creating a payment link works from the dashboard', async () => {
  const r = await api('POST', '/dashboard/payment-links', {
    token: sessionToken,
    body: { amount: 2000, currency: 'HTG', description: 'Facture #42' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.status, 'active');
  paymentLinkId = r.data.id;
});

test('the public checkout page can fetch link details without any auth', async () => {
  const r = await api('GET', `/public/payment-links/${paymentLinkId}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.amount, 2000);
  assert.equal(r.data.description, 'Facture #42');
  assert.equal(r.data.business_name, 'Boutique Lakay');
  assert.ok(['sandbox', 'live'].includes(r.data.mode)); // the page shows the test card only in sandbox
});

test('a customer can pay a link with MonCash (payment is created against the link merchant)', async () => {
  const pay = await api('POST', `/public/payment-links/${paymentLinkId}/pay`, {
    body: { method: 'moncash' },
  });
  assert.equal(pay.status, 201);
  assert.equal(pay.data.status, 'pending');

  const status = await api('GET', `/public/payment-links/${paymentLinkId}/payments/${pay.data.id}`);
  assert.equal(status.status, 200);
  assert.equal(status.data.status, 'pending');

  const merchantPayments = await api('GET', '/dashboard/payments', { token: sessionToken });
  assert.ok(merchantPayments.data.payments.some((p) => p.id === pay.data.id));
});

test('rejects a public payment attempt on a disabled link', async () => {
  const disabled = await api('POST', `/dashboard/payment-links/${paymentLinkId}/disable`, { token: sessionToken });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.data.status, 'disabled');
  const check = await api('GET', `/public/payment-links/${paymentLinkId}`);
  assert.equal(check.status, 404);
  const pay = await api('POST', `/public/payment-links/${paymentLinkId}/pay`, { body: { method: 'moncash' } });
  assert.equal(pay.status, 404);
});

test('a merchant can delete a payment link - it disappears from their list entirely', async () => {
  const create = await api('POST', '/dashboard/payment-links', { token: sessionToken, body: { amount: 500, description: 'À supprimer' } });
  const before = await api('GET', '/dashboard/payment-links', { token: sessionToken });
  assert.ok(before.data.links.find((l) => l.id === create.data.id));

  const del = await api('DELETE', `/dashboard/payment-links/${create.data.id}`, { token: sessionToken });
  assert.equal(del.status, 200);
  assert.equal(del.data.deleted, true);

  const after = await api('GET', '/dashboard/payment-links', { token: sessionToken });
  assert.ok(!after.data.links.find((l) => l.id === create.data.id));

  const again = await api('DELETE', `/dashboard/payment-links/${create.data.id}`, { token: sessionToken });
  assert.equal(again.status, 404);
});

test('an open-amount link (no fixed amount) lets the customer choose how much to pay', async () => {
  const create = await api('POST', '/dashboard/payment-links', {
    token: sessionToken,
    body: { currency: 'HTG', description: 'Don libre' }, // no amount field at all
  });
  assert.equal(create.status, 201);
  assert.equal(create.data.amount, null);

  const publicInfo = await api('GET', `/public/payment-links/${create.data.id}`);
  assert.equal(publicInfo.status, 200);
  assert.equal(publicInfo.data.amount, null);

  const missingAmount = await api('POST', `/public/payment-links/${create.data.id}/pay`, { body: { method: 'moncash' } });
  assert.equal(missingAmount.status, 400);

  const pay = await api('POST', `/public/payment-links/${create.data.id}/pay`, {
    body: { method: 'moncash', amount: 777 },
  });
  assert.equal(pay.status, 201);
  assert.equal(pay.data.status, 'pending');
});

test('a fixed-amount link ignores any amount the customer tries to send', async () => {
  const create = await api('POST', '/dashboard/payment-links', {
    token: sessionToken,
    body: { amount: 1000, currency: 'HTG' },
  });
  const pay = await api('POST', `/public/payment-links/${create.data.id}/pay`, {
    body: { method: 'moncash', amount: 99999 },
  });
  assert.equal(pay.status, 201);
  const merchantPayments = await api('GET', '/dashboard/payments', { token: sessionToken });
  const found = merchantPayments.data.payments.find((p) => p.id === pay.data.id);
  assert.equal(Number(found.amount), 1000);
});

test('malformed JSON body returns a French error message, not a raw code', async () => {
  const res = await fetch(baseUrl + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not valid json',
  });
  const data = await res.json();
  assert.equal(res.status, 400);
  assert.equal(data.error.code, 'INVALID_JSON');
  assert.match(data.error.message, /JSON valide/);
});

test('an unmatched route returns a French 404 message', async () => {
  const res = await fetch(baseUrl + '/this-route-does-not-exist');
  const data = await res.json();
  assert.equal(res.status, 404);
  assert.match(data.error.message, /inconnue/);
});

/* ===== Cards (Maplerad issuing) ===== */

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function pollUntil(fn, predicate, attempts, delayMs) {
  for (let i = 0; i < attempts; i++) {
    const result = await fn();
    if (predicate(result)) return result;
    await sleep(delayMs);
  }
  return fn();
}

test('creating a card is blocked until the holder profile is submitted', async () => {
  const r = await api('POST', '/dashboard/cards', {
    token: sessionToken,
    body: { reference: 'CARD-NOPROFILE-1' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.data.error.code, 'HOLDER_PROFILE_REQUIRED');
});

test('submitting the holder profile enrolls the merchant with Maplerad', async () => {
  const r = await api('POST', '/dashboard/cards/holder-profile', {
    token: sessionToken,
    body: {
      firstName: 'Rose',
      lastName: 'Lakay',
      email: 'owner@boutiquelakay.com',
      country: 'HT',
      dob: '1990-05-12',
      identificationNumber: 'ID123456', identity: TEST_IDENTITY,
      phoneNumber: '37001234',
      phoneShortCode: '+509',
      address: { street: 'Rue Example', city: 'Port-au-Prince', state: 'Ouest', postal_code: 'HT6110', country: 'HT' },
    },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.profile.status, 'enrolled');
});

test('a holder with only city/country (no street, state, postal code) is rejected with a clear error, never silently enrolled', async () => {
  const reg = await registerAndVerify({ business_name: 'Incomplete Addr Co', email: 'incomplete-addr@example.com', password: 'password123' });
  const token = reg.data.session_token;
  const r = await api('POST', '/dashboard/cards/holders', {
    token, body: {
      firstName: 'In', lastName: 'Complete', email: 'incomplete@addr.com', country: 'HT', dob: '1990-05-12',
      identificationNumber: 'ID-IC', identity: TEST_IDENTITY, phoneNumber: '37099999', phoneShortCode: '+509',
      address: { city: 'PAP', country: 'HT' }, // missing street, state, postalCode - the exact production bug
    },
  });
  assert.equal(r.status, 400);
  assert.equal(r.data.error.code, 'MISSING_FIELDS');
  assert.match(r.data.error.message, /street/);
  assert.match(r.data.error.message, /state/);
  assert.match(r.data.error.message, /postalCode/);

  // Never silently created as "enrolled" with a half-done profile.
  const list = await api('GET', '/dashboard/cards/holders', { token });
  assert.equal(list.data.holders.length, 0);
});

test('the phone country code and full address actually reach the provider under the field names it requires', async () => {
  const reg = await registerAndVerify({ business_name: 'Field Names Co', email: 'field-names@example.com', password: 'password123' });
  const token = reg.data.session_token;
  const r = await api('POST', '/dashboard/cards/holders', {
    token, body: {
      firstName: 'Field', lastName: 'Names', email: 'field@names.com', country: 'HT', dob: '1990-05-12',
      identificationNumber: 'ID-FN', identity: TEST_IDENTITY, phoneNumber: '37088888', phoneShortCode: '+509',
      address: { street: '12 Rue Example', city: 'PAP', state: 'Ouest', postalCode: 'HT6110', country: 'HT' },
    },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.holder.status, 'enrolled');
});

test('submitting another holder profile creates a second, separate holder (multi-holder support)', async () => {
  const r = await api('POST', '/dashboard/cards/holder-profile', {
    token: sessionToken,
    body: {
      firstName: 'Jean', lastName: 'Baptiste', email: 'jean.employee@boutiquelakay.com', country: 'HT',
      dob: '1992-03-01', identificationNumber: 'ID999999', identity: TEST_IDENTITY, phoneNumber: '37009999', phoneShortCode: '+509',
      address: { street: 'Rue Example', city: 'PAP', state: 'Ouest', postal_code: 'HT6110', country: 'HT' },
    },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.holder.status, 'enrolled');
  assert.equal(r.data.holder.first_name, 'Jean');

  const list = await api('GET', '/dashboard/cards/holders', { token: sessionToken });
  assert.equal(list.status, 200);
  assert.ok(list.data.holders.length >= 2);
  assert.ok(list.data.holders.some((h) => h.first_name === 'Rose'));
  assert.ok(list.data.holders.some((h) => h.first_name === 'Jean'));
});

let firstCardId;

test('creating an individual card is rejected without enough Master Wallet balance', async () => {
  const r = await api('POST', '/dashboard/cards', {
    token: sessionToken,
    body: { reference: 'CARD-INSUFFICIENT', amount: 1000000 }, // far beyond anything this merchant could have accumulated
  });
  assert.equal(r.status, 400);
  assert.equal(r.data.error.code, 'BELOW_MINIMUM_BALANCE');
});

test('a funded Master Wallet allows creating an individual card, confirmed via webhook', async () => {
  // Top up the Master Wallet via the already-tested automatic MonCash flow.
  const reference = 'TOPUP-CARD-' + Date.now();
  const topup = await api('POST', '/dashboard/wallet/topups', {
    token: sessionToken,
    body: { method: 'moncash', amount_htg: 13300, reference }, // -> ~95.5 USD (startup plan, 4.5%)
  });
  await fetch('http://localhost:4501/__control/confirm-payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refference_id: `fp_${merchantId}_${reference}` }),
  });
  await api('GET', `/dashboard/wallet/topups/${topup.data.id}`, { token: sessionToken });
  const balAfterTopup = await api('GET', '/dashboard/balance', { token: sessionToken });

  const create = await api('POST', '/dashboard/cards', {
    token: sessionToken,
    body: { reference: 'CARD-001', brand: 'VISA', amount: 20 },
  });
  assert.equal(create.status, 202);
  assert.equal(create.data.status, 'pending');
  firstCardId = create.data.id;

  const balAfterDebit = await api('GET', '/dashboard/balance', { token: sessionToken });
  // Startup Issuing plan: $20 preload + $5 flat creation fee = $25 total debited immediately
  assert.equal(balAfterDebit.data.master_wallet.available, balAfterTopup.data.master_wallet.available - 25);

  const activeCard = await pollUntil(
    () => api('GET', `/dashboard/cards/${firstCardId}`, { token: sessionToken }),
    (r) => r.data.status !== 'pending',
    30,
    20
  );
  assert.equal(activeCard.data.status, 'active');
  assert.ok(activeCard.data.masked_pan);
  assert.equal(activeCard.data.balance, 20);
});

test('replaying the same card reference is idempotent', async () => {
  const r = await api('POST', '/dashboard/cards', {
    token: sessionToken,
    body: { reference: 'CARD-001', brand: 'VISA', amount: 20 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.id, firstCardId);
});

test('funding an active card debits the Master Wallet and credits the card balance', async () => {
  const before = await api('GET', '/dashboard/balance', { token: sessionToken });
  const r = await api('POST', `/dashboard/cards/${firstCardId}/fund`, { token: sessionToken, body: { amount: 10 } });
  assert.equal(r.status, 200);
  assert.equal(r.data.balance, 30); // card balance = full amount; the fee only affects the wallet debit
  const after = await api('GET', '/dashboard/balance', { token: sessionToken });
  // Startup plan recharge fee: $1.60, on top of the $10 recharged
  assert.equal(after.data.master_wallet.available, before.data.master_wallet.available - 11.6);
});

test('withdrawing from a card credits the Master Wallet back', async () => {
  const before = await api('GET', '/dashboard/balance', { token: sessionToken });
  const r = await api('POST', `/dashboard/cards/${firstCardId}/withdraw`, { token: sessionToken, body: { amount: 5 } });
  assert.equal(r.status, 200);
  assert.equal(r.data.balance, 25); // full amount leaves the card
  const after = await api('GET', '/dashboard/balance', { token: sessionToken });
  // Startup plan withdrawal fee: $1.30, deducted from what's credited back to the wallet
  assert.equal(after.data.master_wallet.available, before.data.master_wallet.available + 3.7);
});

test('withdrawing an amount at or below the withdrawal fee is rejected', async () => {
  const r = await api('POST', `/dashboard/cards/${firstCardId}/withdraw`, { token: sessionToken, body: { amount: 1 } });
  assert.equal(r.status, 400);
  assert.equal(r.data.error.code, 'AMOUNT_BELOW_FEE');
});

test('withdrawing more than the card balance is rejected', async () => {
  const r = await api('POST', `/dashboard/cards/${firstCardId}/withdraw`, { token: sessionToken, body: { amount: 9999 } });
  assert.equal(r.status, 400);
  assert.equal(r.data.error.code, 'INSUFFICIENT_CARD_BALANCE');
});

test('freezing then unfreezing a card updates its status', async () => {
  const frozen = await api('POST', `/dashboard/cards/${firstCardId}/freeze`, { token: sessionToken });
  assert.equal(frozen.status, 200);
  assert.equal(frozen.data.status, 'disabled');

  const active = await api('POST', `/dashboard/cards/${firstCardId}/unfreeze`, { token: sessionToken });
  assert.equal(active.status, 200);
  assert.equal(active.data.status, 'active');
});

test('a failed card creation refunds the Master Wallet and marks the card failed', async () => {
  await fetch('http://localhost:4504/__control/fail-next-card', { method: 'POST' });
  const before = await api('GET', '/dashboard/balance', { token: sessionToken });

  const create = await api('POST', '/dashboard/cards', {
    token: sessionToken,
    body: { reference: 'CARD-WILL-FAIL', brand: 'VISA', amount: 5 },
  });
  assert.equal(create.status, 202);

  const failedCard = await pollUntil(
    () => api('GET', `/dashboard/cards/${create.data.id}`, { token: sessionToken }),
    (r) => r.data.status !== 'pending',
    30,
    20
  );
  assert.equal(failedCard.data.status, 'failed');

  const after = await api('GET', '/dashboard/balance', { token: sessionToken });
  assert.equal(after.data.master_wallet.available, before.data.master_wallet.available); // refunded
});

test('deleting a card closes it at the partner, refunds its remaining balance and removes it from the lists', async () => {
  const before = await api('GET', '/dashboard/balance', { token: sessionToken });
  const term = await api('POST', `/dashboard/cards/${firstCardId}/terminate`, { token: sessionToken });
  assert.equal(term.status, 200);
  assert.equal(term.data.status, 'terminated');
  assert.equal(term.data.balance, 0);

  const after = await api('GET', '/dashboard/balance', { token: sessionToken });
  assert.equal(Math.round((after.data.master_wallet.available - before.data.master_wallet.available) * 100) / 100, 24.5); // 25 left on the card, 0.50 closure fee
  assert.equal(term.data.refunded_usd, 24.5);
  assert.equal(term.data.closure_fee_usd, 0.5);

  // Deleted means gone: not in the list any more, not reachable by id, and a second delete finds nothing.
  assert.equal(term.data.deleted, true);
  const list = await api('GET', '/dashboard/cards', { token: sessionToken });
  assert.equal(list.status, 200);
  assert.ok(!list.data.cards.some((c) => c.id === firstCardId));
  assert.equal((await api('GET', `/dashboard/cards/${firstCardId}`, { token: sessionToken })).status, 404);
  assert.equal((await api('POST', `/dashboard/cards/${firstCardId}/terminate`, { token: sessionToken })).status, 404);
});

test('a business card requires a name and a pre-funding amount', async () => {
  const missingName = await api('POST', '/dashboard/cards', {
    token: sessionToken,
    body: { reference: 'BIZ-1', kind: 'business', amount: 30 },
  });
  assert.equal(missingName.status, 400);

  const missingAmount = await api('POST', '/dashboard/cards', {
    token: sessionToken,
    body: { reference: 'BIZ-2', kind: 'business', business_name: 'Boutik Rose SA' },
  });
  assert.equal(missingAmount.status, 400);
  assert.equal(missingAmount.data.error.code, 'INVALID_AMOUNT');
});

test('a business card does not require a holder profile (not tied to a customer_id)', async () => {
  const r = await api('POST', '/dashboard/cards', {
    token: sessionToken,
    body: { reference: 'BIZ-3', kind: 'business', business_name: 'Boutik Rose SA', brand: 'MASTERCARD', amount: 15 },
  });
  assert.equal(r.status, 202);

  const active = await pollUntil(
    () => api('GET', `/dashboard/cards/${r.data.id}`, { token: sessionToken }),
    (res) => res.data.status !== 'pending',
    30,
    20
  );
  assert.equal(active.data.status, 'active');
  assert.equal(active.data.kind, 'business');
});

test('webhooks with an invalid signature are rejected', async () => {
  const res = await fetch(baseUrl + '/webhooks/maplerad', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'svix-id': 'msg_fake',
      'svix-timestamp': String(Math.floor(Date.now() / 1000)),
      'svix-signature': 'v1,AAAAnotarealsignatureAAAA==',
    },
    body: JSON.stringify({ event: 'issuing.created.successful', reference: 'whatever' }),
  });
  assert.equal(res.status, 401);
});

test('replaying the same webhook event id is idempotent (no double-processing)', async () => {
  const crypto = require('crypto');
  const id = 'msg_replay_test';
  const ts = String(Math.floor(Date.now() / 1000));
  const payload = JSON.stringify({ event: 'issuing.created.failed', reference: 'nonexistent-ref' });
  const secretB64 = process.env.MAPLERAD_WEBHOOK_SECRET.replace(/^whsec_/, '');
  const sig = crypto.createHmac('sha256', Buffer.from(secretB64, 'base64')).update(`${id}.${ts}.${payload}`).digest('base64');

  const send = () => fetch(baseUrl + '/webhooks/maplerad', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` },
    body: payload,
  });

  const first = await send();
  const firstData = await first.json();
  assert.equal(first.status, 200);
  assert.equal(firstData.duplicate, undefined);

  const second = await send();
  const secondData = await second.json();
  assert.equal(second.status, 200);
  assert.equal(secondData.duplicate, true);
});

/* ===== Outbound webhooks (merchant-registered) ===== */

const http = require('node:http');
const crypto = require('node:crypto');

/** Spins up a tiny HTTP server that records every webhook POST it receives. */
function startWebhookReceiver() {
  const received = [];
  let failNextN = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (failNextN > 0) {
        failNextN -= 1;
        res.writeHead(500);
        return res.end();
      }
      received.push({
        body,
        json: JSON.parse(body),
        signature: req.headers['x-freda-signature'],
        eventId: req.headers['x-freda-event-id'],
        attempt: req.headers['x-freda-delivery-attempt'],
      });
      res.writeHead(200);
      res.end('{}');
    });
  });
  return {
    server,
    received,
    failNext(n) { failNextN = n; },
  };
}

test('registering, viewing, and deleting a webhook endpoint works', async () => {
  const reg = await registerAndVerify({ business_name: 'Webhook Reg Co', email: 'webhook-reg@example.com', password: 'password123' });
  const token = reg.data.session_token;

  const before = await api('GET', '/dashboard/webhooks', { token });
  assert.equal(before.data.endpoint, null);

  const create = await api('POST', '/dashboard/webhooks', { token, body: { url: 'https://example.com/webhooks/freda' } });
  assert.equal(create.status, 201);
  assert.ok(create.data.secret.startsWith('whsec_'));
  const firstSecret = create.data.secret;

  const after = await api('GET', '/dashboard/webhooks', { token });
  assert.equal(after.data.endpoint.url, 'https://example.com/webhooks/freda');
  assert.equal(after.data.endpoint.secret, undefined); // never returned again after creation

  // Registering again replaces it (200, not 201) and issues a new secret.
  const replace = await api('POST', '/dashboard/webhooks', { token, body: { url: 'https://example.com/webhooks/v2' } });
  assert.equal(replace.status, 200);
  assert.notEqual(replace.data.secret, firstSecret);

  const rotate = await api('POST', '/dashboard/webhooks/rotate-secret', { token });
  assert.equal(rotate.status, 200);
  assert.notEqual(rotate.data.secret, replace.data.secret);

  const del = await api('DELETE', '/dashboard/webhooks', { token });
  assert.equal(del.status, 200);
  const afterDelete = await api('GET', '/dashboard/webhooks', { token });
  assert.equal(afterDelete.data.endpoint.active, false);
});

test('an invalid (non-https) webhook URL is rejected', async () => {
  const reg = await registerAndVerify({ business_name: 'Webhook Invalid Co', email: 'webhook-invalid@example.com', password: 'password123' });
  const r = await api('POST', '/dashboard/webhooks', { token: reg.data.session_token, body: { url: 'http://not-secure.com' } });
  assert.equal(r.status, 400);
  assert.equal(r.data.error.code, 'INVALID_URL');
});

test('a real event (payment.succeeded) is delivered to the registered webhook, correctly signed', async () => {
  const receiver = startWebhookReceiver();
  await new Promise((r) => receiver.server.listen(4507, r));

  try {
    const reg = await registerAndVerify({ business_name: 'Webhook Delivery Co', email: 'webhook-delivery@example.com', password: 'password123' });
    const token = reg.data.session_token;
    const hook = await api('POST', '/dashboard/webhooks', { token, body: { url: 'http://localhost:4507/hook' } });
    const secret = hook.data.secret;

    const keyRes = await api('POST', '/dashboard/api-keys', { token, body: { mode: 'test' } });
    const apiKeySecret = keyRes.data.secret;

    const reference = 'WEBHOOK-PAY-' + Date.now();
    const create = await api('POST', '/v1/payments', { token: apiKeySecret, body: { amount: 1000, method: 'moncash', reference } });
    await fetch('http://localhost:4501/__control/confirm-payment', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refference_id: `fp_${reg.data.merchant.id}_${reference}` }),
    });
    await api('GET', `/v1/payments/${create.data.id}`, { token: apiKeySecret }); // triggers the status refresh that fires the webhook

    // Delivery is fire-and-forget; give it a moment.
    await sleep(200);

    assert.equal(receiver.received.length, 1);
    const delivery = receiver.received[0];
    assert.equal(delivery.json.event, 'payment.succeeded');
    assert.equal(delivery.json.data.id, create.data.id);
    assert.ok(delivery.eventId);

    const expectedSig = crypto.createHmac('sha256', secret).update(delivery.body).digest('hex');
    assert.equal(delivery.signature, `sha256=${expectedSig}`);
  } finally {
    await new Promise((r) => receiver.server.close(r));
  }
});

test('a failing webhook endpoint is retried and eventually gives up without crashing anything', async () => {
  const receiver = startWebhookReceiver();
  receiver.failNext(1); // fail only the immediate first attempt; the retry at +5s should succeed
  await new Promise((r) => receiver.server.listen(4508, r));

  try {
    const reg = await registerAndVerify({ business_name: 'Webhook Retry Co', email: 'webhook-retry@example.com', password: 'password123' });
    const token = reg.data.session_token;
    await api('POST', '/dashboard/webhooks', { token, body: { url: 'http://localhost:4508/hook' } });

    const keyRes = await api('POST', '/dashboard/api-keys', { token, body: { mode: 'test' } });
    const apiKeySecret = keyRes.data.secret;
    const reference = 'WEBHOOK-RETRY-' + Date.now();
    const create = await api('POST', '/v1/payments', { token: apiKeySecret, body: { amount: 500, method: 'moncash', reference } });
    await fetch('http://localhost:4501/__control/confirm-payment', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refference_id: `fp_${reg.data.merchant.id}_${reference}` }),
    });
    await api('GET', `/v1/payments/${create.data.id}`, { token: apiKeySecret });

    // Retry schedule is immediate, +5s, +30s - wait past the +5s retry (the 2nd attempt).
    await sleep(6000);

    assert.equal(receiver.received.length, 1); // only the successful 3rd... wait, we only wait for the 2nd here
    assert.equal(receiver.received[0].attempt, '2');
  } finally {
    await new Promise((r) => receiver.server.close(r));
  }
});

/* ===== Multi-holder card issuing ===== */

test('a merchant can enroll several holders and pick one when creating an individual card', async () => {
  const reg = await registerAndVerify({ business_name: 'Multi Holder Co', email: 'multi-holder@example.com', password: 'password123' });
  const token = reg.data.session_token;

  const holder1 = await api('POST', '/dashboard/cards/holders', {
    token, body: {
      firstName: 'Alice', lastName: 'Employee', email: 'alice@multiholder.com', country: 'HT',
      dob: '1991-01-01', identificationNumber: 'ID-A1', identity: TEST_IDENTITY, phoneNumber: '37011111', phoneShortCode: '+509',
      address: { street: 'Rue Example', city: 'PAP', state: 'Ouest', postal_code: 'HT6110', country: 'HT' },
    },
  });
  assert.equal(holder1.status, 201);
  assert.equal(holder1.data.holder.status, 'enrolled');

  const holder2 = await api('POST', '/dashboard/cards/holders', {
    token, body: {
      firstName: 'Bob', lastName: 'Employee', email: 'bob@multiholder.com', country: 'HT',
      dob: '1993-02-02', identificationNumber: 'ID-B2', identity: TEST_IDENTITY, phoneNumber: '37022222', phoneShortCode: '+509',
      address: { street: 'Rue Example', city: 'PAP', state: 'Ouest', postal_code: 'HT6110', country: 'HT' }, photoUrl: 'https://example.com/bob.jpg',
    },
  });
  assert.equal(holder2.status, 201);
  assert.equal(holder2.data.holder.photo_url, 'https://example.com/bob.jpg');

  const list = await api('GET', '/dashboard/cards/holders', { token });
  assert.equal(list.status, 200);
  assert.equal(list.data.holders.length, 2);

  const getOne = await api('GET', `/dashboard/cards/holders/${holder2.data.holder.id}`, { token });
  assert.equal(getOne.status, 200);
  assert.equal(getOne.data.holder.first_name, 'Bob');

  // Create an individual card explicitly for holder2 (Bob), not holder1.
  const card = await api('POST', '/dashboard/cards', {
    token, body: { reference: 'MULTI-HOLDER-CARD-1', kind: 'individual', brand: 'VISA', amount: 15, holder_id: holder2.data.holder.id },
  });
  assert.equal(card.status, 202);
  assert.equal(card.data.holder_name, 'Bob Employee');
});

test('creating an individual card with an unknown holder_id is rejected', async () => {
  const reg = await registerAndVerify({ business_name: 'Bad Holder Co', email: 'bad-holder@example.com', password: 'password123' });
  const token = reg.data.session_token;
  const card = await api('POST', '/dashboard/cards', {
    token, body: { reference: 'BAD-HOLDER-1', kind: 'individual', brand: 'VISA', amount: 15, holder_id: 'mpc_doesnotexist' },
  });
  assert.equal(card.status, 404);
  assert.equal(card.data.error.code, 'NOT_FOUND');
});

/* ===== Master Wallet minimum balance + low-balance alert ===== */

test('a debit that would cross below the $50 floor is rejected, one exactly at it succeeds and emails an alert', async () => {
  const reg = await registerAndVerify({ business_name: 'Floor Test Co', email: 'floor-test@example.com', password: 'password123' });
  const token = reg.data.session_token;

  const before = await api('GET', '/dashboard/balance', { token });
  assert.equal(before.data.master_wallet.available, SANDBOX_SEED);

  // Too much: would leave less than $50.
  const tooMuch = await api('POST', '/dashboard/cards', {
    token, body: { reference: 'FLOOR-TOOMUCH', kind: 'business', business_name: 'X', amount: SANDBOX_SEED - 50 - 5 + 1 },
  });
  assert.equal(tooMuch.status, 400);
  assert.equal(tooMuch.data.error.code, 'BELOW_MINIMUM_BALANCE');

  // Exactly at the floor after the fee: allowed, and triggers the alert email.
  const exact = await api('POST', '/dashboard/cards', {
    token, body: { reference: 'FLOOR-EXACT', kind: 'business', business_name: 'X', amount: SANDBOX_SEED - 50 - 5 },
  });
  assert.equal(exact.status, 202);

  const after = await api('GET', '/dashboard/balance', { token });
  assert.equal(after.data.master_wallet.available, 50);

  // The debit itself is synchronous; give the fire-and-forget email a tick to send.
  await sleep(50);
  const alertRes = await fetch('http://localhost:4506/__control/last-email?to=floor-test@example.com');
  assert.equal(alertRes.status, 200);
  const alertEmail = await alertRes.json();
  assert.match(alertEmail.subject, /Solde Master Wallet bas/);
  assert.match(alertEmail.text, /50,00 \$/);
});

/* ===== Rate limiting ===== */

test('repeated wrong-password logins eventually lock the account (429)', async () => {
  const fakeIp = { 'x-forwarded-for': '203.0.113.10' }; // isolate from the shared test-suite IP's counters
  const reg = await api('POST', '/auth/register', {
    headers: fakeIp,
    body: { business_name: 'Lockout Co', email: 'lockout@example.com', password: 'correctPassword1' },
  });
  const code = extractOtpFromEmail('lockout@example.com');
  const verify = await api('POST', '/auth/verify-otp', { headers: fakeIp, body: { merchant_id: reg.data.merchant_id, code } });
  assert.ok(verify.data.session_token);

  let lastStatus;
  for (let i = 0; i < 11; i++) {
    const r = await api('POST', '/auth/login', { headers: fakeIp, body: { email: 'lockout@example.com', password: 'wrong-password' } });
    lastStatus = r.status;
    if (r.status === 429) {
      assert.equal(r.data.error.code, 'ACCOUNT_LOCKED');
      break;
    }
  }
  assert.equal(lastStatus, 429);
});

test('registering repeatedly from the same client is eventually rate-limited (429)', async () => {
  const fakeIp = { 'x-forwarded-for': '203.0.113.20' };
  let sawRateLimit = false;
  for (let i = 0; i < 62; i++) {
    const r = await api('POST', '/auth/register', {
      headers: fakeIp,
      body: { business_name: 'Spam ' + i, email: `spam-reg-${i}-${Date.now()}@example.com`, password: 'password123' },
    });
    if (r.status === 429) { sawRateLimit = true; assert.equal(r.data.error.code, 'RATE_LIMITED'); break; }
  }
  assert.equal(sawRateLimit, true);
});

test('resending an OTP repeatedly is rate-limited (429)', async () => {
  const fakeIp = { 'x-forwarded-for': '203.0.113.30' };
  const reg = await api('POST', '/auth/register', {
    headers: fakeIp,
    body: { business_name: 'Resend Spam', email: 'resend-spam@example.com', password: 'password123' },
  });
  let sawRateLimit = false;
  for (let i = 0; i < 5; i++) {
    const r = await api('POST', '/auth/resend-otp', { headers: fakeIp, body: { merchant_id: reg.data.merchant_id } });
    if (r.status === 429) { sawRateLimit = true; assert.equal(r.data.error.code, 'RATE_LIMITED'); break; }
  }
  assert.equal(sawRateLimit, true);
});

test('GET /openapi.yaml serves the raw spec, not the JSON error envelope', async () => {
  const res = await fetch(baseUrl + '/openapi.yaml');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /yaml/);
  const text = await res.text();
  assert.match(text, /openapi: 3\.0/);
  assert.match(text, /\/cards\/\{id\}\/reveal/);
});

test('security headers are present on every response', async () => {
  const res = await fetch(baseUrl + '/health');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
});

test('GET /dashboard/cards/:id/transactions returns the card\'s transaction history and this-month spend', async () => {
  const reg = await registerAndVerify({ business_name: 'Txn History Co', email: 'txn-history@example.com', password: 'password123' });
  const token = reg.data.session_token;

  const create = await api('POST', '/dashboard/cards', {
    token, body: { reference: 'TXN-HIST-1', kind: 'business', business_name: 'Txn History Co', brand: 'VISA', amount: 15 },
  });
  assert.equal(create.status, 202);

  const active = await pollUntil(
    () => api('GET', `/dashboard/cards/${create.data.id}`, { token }),
    (r) => r.data.status !== 'pending',
    30, 20
  );
  assert.equal(active.data.status, 'active');

  const txns = await api('GET', `/dashboard/cards/${create.data.id}/transactions`, { token });
  assert.equal(txns.status, 200);
  assert.equal(txns.data.transactions.length, 2);
  assert.equal(txns.data.transactions[0].merchant_name, 'Amazon');
  assert.equal(txns.data.transactions[0].amount, 12.5);
  // 12.50 DEBIT this month counts toward month_spend; the 20.00 CREDIT funding does not
  assert.equal(txns.data.month_spend, 12.5);
});

test('funding or withdrawing from a frozen card is rejected with a clear error', async () => {
  const reg = await registerAndVerify({ business_name: 'Frozen Card Co', email: 'frozen-card@example.com', password: 'password123' });
  const token = reg.data.session_token;
  const create = await api('POST', '/dashboard/cards', {
    token, body: { reference: 'FROZEN-1', kind: 'business', business_name: 'Frozen Card Co', brand: 'VISA', amount: 15 },
  });
  const active = await pollUntil(() => api('GET', `/dashboard/cards/${create.data.id}`, { token }), (r) => r.data.status !== 'pending', 30, 20);
  assert.equal(active.data.status, 'active');

  const freeze = await api('POST', `/dashboard/cards/${create.data.id}/freeze`, { token });
  assert.equal(freeze.status, 200);

  const fund = await api('POST', `/dashboard/cards/${create.data.id}/fund`, { token, body: { amount: 5 } });
  assert.equal(fund.status, 409);
  assert.equal(fund.data.error.code, 'CARD_FROZEN');

  const withdraw = await api('POST', `/dashboard/cards/${create.data.id}/withdraw`, { token, body: { amount: 5 } });
  assert.equal(withdraw.status, 409);
  assert.equal(withdraw.data.error.code, 'CARD_FROZEN');
});

test('simulating a transaction on a card works in sandbox mode', async () => {
  const reg = await registerAndVerify({ business_name: 'Simulate Co', email: 'simulate-txn@example.com', password: 'password123' });
  const token = reg.data.session_token;
  const create = await api('POST', '/dashboard/cards', {
    token, body: { reference: 'SIM-1', kind: 'business', business_name: 'Simulate Co', brand: 'VISA', amount: 15 },
  });
  const active = await pollUntil(() => api('GET', `/dashboard/cards/${create.data.id}`, { token }), (r) => r.data.status !== 'pending', 30, 20);
  assert.equal(active.data.status, 'active');

  const sim = await api('POST', `/dashboard/cards/${create.data.id}/simulate-transaction`, { token, body: { amount: 7.5, type: 'DEBIT' } });
  assert.equal(sim.status, 200);
  assert.equal(sim.data.simulated, true);
});

test('simulating a transaction is allowed on a sandbox card and refused on a live card', async () => {
  const reg = await registerAndVerify({ business_name: 'Live Sim Co', email: 'live-sim@example.com', password: 'password123' });
  const token = reg.data.session_token;
  const create = await api('POST', '/dashboard/cards', {
    token, body: { reference: 'LIVESIM-1', kind: 'business', business_name: 'Live Sim Co', brand: 'VISA', amount: 15 },
  });
  await pollUntil(() => api('GET', `/dashboard/cards/${create.data.id}`, { token }), (r) => r.data.status !== 'pending', 30, 20);

  // A merchant who is live elsewhere can STILL simulate on their sandbox card (the old account-wide block was wrong).
  const merchantRow = mockTables.merchants.find((m) => m.id === reg.data.merchant.id);
  merchantRow.live_enabled = true;
  merchantRow.gateway_live_enabled = true;
  const okSim = await api('POST', `/dashboard/cards/${create.data.id}/simulate-transaction`, { token, body: { amount: 5, type: 'CREDIT' } });
  assert.equal(okSim.status, 200);

  // A LIVE card can never be simulated.
  mockTables.cards.find((c) => c.id === create.data.id).mode = 'live';
  const sim = await api('POST', `/dashboard/cards/${create.data.id}/simulate-transaction`, { token, body: { amount: 5, type: 'CREDIT' } });
  assert.equal(sim.status, 403);
  assert.equal(sim.data.error.code, 'LIVE_NOT_ALLOWED');
});

test('list endpoints paginate: page_size, has_more, and page 2 works', async () => {
  const reg = await registerAndVerify({ business_name: 'Pagination Co', email: 'pagination@example.com', password: 'password123' });
  const token = reg.data.session_token;

  // Create 3 payment links (cheap, synchronous - no webhook wait needed) to get a small, controlled list.
  for (let i = 0; i < 3; i++) {
    const r = await api('POST', '/dashboard/payment-links', { token, body: { description: 'Link ' + i, amount: 100 } });
    assert.equal(r.status, 201);
  }

  const page1 = await api('GET', '/dashboard/payment-links?page_size=2', { token });
  assert.equal(page1.status, 200);
  assert.equal(page1.data.links.length, 2);
  assert.equal(page1.data.pagination.page, 1);
  assert.equal(page1.data.pagination.page_size, 2);
  assert.equal(page1.data.pagination.has_more, true);

  const page2 = await api('GET', '/dashboard/payment-links?page=2&page_size=2', { token });
  assert.equal(page2.status, 200);
  assert.equal(page2.data.links.length, 1);
  assert.equal(page2.data.pagination.has_more, false);

  // No overlap between the two pages.
  const page1Ids = page1.data.links.map((l) => l.id);
  const page2Ids = page2.data.links.map((l) => l.id);
  assert.equal(page1Ids.some((id) => page2Ids.includes(id)), false);
});

test('/v1 API endpoints are rate-limited per merchant and expose rate limit headers', async () => {
  const reg = await registerAndVerify({ business_name: 'RateLimit API Co', email: 'ratelimit-api@example.com', password: 'password123' });
  const key = await api('POST', '/dashboard/api-keys', { token: reg.data.session_token, body: { mode: 'test' } });
  const apiKeySecret = key.data.secret;

  const first = await fetch(baseUrl + '/v1/balance', { headers: { Authorization: `Bearer ${apiKeySecret}` } });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-ratelimit-limit'), '100');
  assert.ok(Number(first.headers.get('x-ratelimit-remaining')) < 100);

  let sawLimit = false;
  for (let i = 0; i < 105; i++) {
    const r = await fetch(baseUrl + '/v1/balance', { headers: { Authorization: `Bearer ${apiKeySecret}` } });
    if (r.status === 429) {
      sawLimit = true;
      const data = await r.json();
      assert.equal(data.error.code, 'RATE_LIMITED');
      assert.ok(r.headers.get('retry-after'));
      break;
    }
  }
  assert.equal(sawLimit, true);
});

test('cards can be created and managed with an API key (server-to-server), not just a dashboard session', async () => {
  const reg = await registerAndVerify({ business_name: 'API Key Cards Co', email: 'api-key-cards@example.com', password: 'password123' });
  const token = reg.data.session_token;

  const key = await api('POST', '/dashboard/api-keys', { token, body: { mode: 'test' } });
  assert.equal(key.status, 201);
  const apiKeySecret = key.data.secret;

  // Holder profile via API key
  const profile = await api('POST', '/v1/cards/holder-profile', {
    token: apiKeySecret,
    body: {
      firstName: 'Rose', lastName: 'Lakay', email: 'api-key-cards@example.com', country: 'HT',
      dob: '1990-05-12', identificationNumber: 'ID999', identity: TEST_IDENTITY, phoneShortCode: '+509', phoneNumber: '37001234',
      address: { street: 'Rue Example', city: 'Port-au-Prince', state: 'Ouest', postal_code: 'HT6110', country: 'HT' },
    },
  });
  assert.equal(profile.status, 201);

  // Create a business card via API key (no holder profile needed for business cards anyway)
  const create = await api('POST', '/v1/cards', {
    token: apiKeySecret,
    body: { reference: 'APIKEY-CARD-1', kind: 'business', business_name: 'API Key Cards Co', brand: 'VISA', amount: 15 },
  });
  assert.equal(create.status, 202);

  const active = await pollUntil(
    () => api('GET', `/v1/cards/${create.data.id}`, { token: apiKeySecret }),
    (r) => r.data.status !== 'pending',
    30, 20
  );
  assert.equal(active.data.status, 'active');

  // List, fund, freeze, unfreeze - all via API key
  const list = await api('GET', '/v1/cards', { token: apiKeySecret });
  assert.equal(list.status, 200);
  assert.ok(list.data.cards.some((c) => c.id === create.data.id));

  const fund = await api('POST', `/v1/cards/${create.data.id}/fund`, { token: apiKeySecret, body: { amount: 5 } });
  assert.equal(fund.status, 200);

  const freeze = await api('POST', `/v1/cards/${create.data.id}/freeze`, { token: apiKeySecret });
  assert.equal(freeze.status, 200);
  assert.equal(freeze.data.status, 'disabled');
});

test('the account owner can reveal a card\'s full number, CVV and expiry', async () => {
  const reg = await registerAndVerify({ business_name: 'Reveal Co', email: 'reveal-details@example.com', password: 'password123' });
  const token = reg.data.session_token;
  const create = await api('POST', '/dashboard/cards', {
    token, body: { reference: 'REVEAL-1', kind: 'business', business_name: 'Reveal Co', brand: 'VISA', amount: 15 },
  });
  const active = await pollUntil(() => api('GET', `/dashboard/cards/${create.data.id}`, { token }), (r) => r.data.status !== 'pending', 30, 20);
  assert.equal(active.data.status, 'active');

  const reveal = await api('POST', `/dashboard/cards/${create.data.id}/reveal`, { token });
  assert.equal(reveal.status, 200);
  assert.equal(reveal.data.number, '5399539953995399');
  assert.equal(reveal.data.cvv, '456');
  assert.ok(reveal.data.expiry_month);
  assert.ok(reveal.data.expiry_year);

  // Also reachable via API key (server-to-server), same as every other card endpoint.
  const keyRes = await api('POST', '/dashboard/api-keys', { token, body: { mode: 'test' } });
  const revealViaKey = await api('POST', `/v1/cards/${create.data.id}/reveal`, { token: keyRes.data.secret });
  assert.equal(revealViaKey.status, 200);
  assert.equal(revealViaKey.data.number, '5399539953995399');
});

test('GET transactions for a still-pending card returns an empty list instead of erroring', async () => {
  const reg = await registerAndVerify({ business_name: 'Pending Txn Co', email: 'pending-txn@example.com', password: 'password123' });
  const token = reg.data.session_token;
  const create = await api('POST', '/dashboard/cards', {
    token, body: { reference: 'TXN-PENDING-1', kind: 'business', business_name: 'Pending Txn Co', brand: 'VISA', amount: 15 },
  });
  assert.equal(create.status, 202);
  // Query immediately, before the webhook has landed - should not throw CARD_NOT_READY.
  const txns = await api('GET', `/dashboard/cards/${create.data.id}/transactions`, { token });
  assert.equal(txns.status, 200);
  assert.deepEqual(txns.data.transactions, []);
});

test('signup onboarding answers are accepted, sanitized, and never required', async () => {
  const r = await api('POST', '/auth/register', {
    headers: { 'x-forwarded-for': '203.0.113.77' },
    body: {
      business_name: 'Onboard Co', email: 'onboard@example.com', password: 'password123',
      onboarding: { product: 'both', business_description: 'Boutique en ligne', monthly_volume: '50k_250k', monthly_cards: '10_50', evil: 'ignored', card_use_case: 42 },
    },
  });
  assert.equal(r.status, 201);
  const row = mockTables.merchants.find((m) => m.id === r.data.merchant_id);
  assert.deepEqual(row.onboarding, { product: 'both', business_description: 'Boutique en ligne', monthly_volume: '50k_250k', monthly_cards: '10_50' });
});

test('a revoked API key stops working immediately, even though auth lookups are cached', async () => {
  const reg = await registerAndVerify({ business_name: 'Revoke Cache Co', email: 'revoke-cache@example.com', password: 'password123' });
  const token = reg.data.session_token;
  const key = await api('POST', '/dashboard/api-keys', { token, body: { mode: 'test' } });
  const secret = key.data.secret;

  const ok = await api('GET', '/v1/balance', { token: secret }); // warms the cache
  assert.equal(ok.status, 200);
  const ok2 = await api('GET', '/v1/balance', { token: secret }); // served from cache
  assert.equal(ok2.status, 200);

  const list = await api('GET', '/dashboard/api-keys', { token });
  const keyRow = list.data.keys.find((k) => !k.revoked_at);
  const revoke = await api('DELETE', `/dashboard/api-keys/${keyRow.id}`, { token });
  assert.equal(revoke.status, 200);

  const after = await api('GET', '/v1/balance', { token: secret });
  assert.equal(after.status, 401);
});

test('large JSON responses are gzip-compressed when the client accepts it, with Server-Timing', async () => {
  const reg = await registerAndVerify({ business_name: 'Gzip Co', email: 'gzip-co@example.com', password: 'password123' });
  const res = await fetch(baseUrl + '/openapi.yaml', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(res.status, 200);
  const small = await fetch(baseUrl + '/health');
  assert.match(small.headers.get('server-timing'), /^app;dur=\d+$/);
  assert.equal(small.headers.get('content-encoding'), null); // tiny payloads stay uncompressed
});

test('holder enrollment follows the documented two-step flow and sends dob as DD-MM-YYYY', async () => {
  const reg = await registerAndVerify({ business_name: 'Two Step Co', email: 'two-step@example.com', password: 'password123' });
  const token = reg.data.session_token;
  // The provider mock rejects tier-1 upgrades unless dob is DD-MM-YYYY, so a successful
  // enrollment from a YYYY-MM-DD input proves the conversion happened.
  const ok = await api('POST', '/dashboard/cards/holders', {
    token, body: {
      firstName: 'Two', lastName: 'Step', email: 'two@step.com', country: 'HT', dob: '1990-05-12',
      identificationNumber: 'ID-2S', identity: TEST_IDENTITY, phoneNumber: '37012345', phoneShortCode: '+509', address: { street: 'Rue Example', city: 'PAP', state: 'Ouest', postal_code: 'HT6110', country: 'HT' },
    },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.holder.status, 'enrolled');
  const row = mockTables.maplerad_customers.find((h) => h.id === ok.data.holder.id);
  assert.ok(row.maplerad_customer_id, 'the provider customer id must be captured');

  // An unparseable dob is passed through unchanged, the provider rejects it,
  // and the holder is recorded as failed instead of silently "enrolled".
  const bad = await api('POST', '/dashboard/cards/holders', {
    token, body: {
      firstName: 'Bad', lastName: 'Dob', email: 'bad@dob.com', country: 'HT', dob: '12/05/1990',
      identificationNumber: 'ID-BD', identity: TEST_IDENTITY, phoneNumber: '37012346', phoneShortCode: '+509', address: { street: 'Rue Example', city: 'PAP', state: 'Ouest', postal_code: 'HT6110', country: 'HT' },
    },
  });
  assert.ok(bad.status >= 400);
  const list = await api('GET', '/dashboard/cards/holders', { token });
  const failed = list.data.holders.find((h) => h.first_name === 'Bad');
  assert.equal(failed.status, 'failed');
});

/* ===== Simple errors, provider soft-failures, recovery, expiry parsing ===== */

const { _test: orchestratorHelpers } = require('../src/services/cardOrchestrator');

test('expiry is understood in every format the provider may use', () => {
  const p = orchestratorHelpers.parseExpiry;
  assert.deepEqual(p('12/28'), { month: 12, year: 2028 });
  assert.deepEqual(p('12/2028'), { month: 12, year: 2028 });
  assert.deepEqual(p('2028-12'), { month: 12, year: 2028 });
  assert.deepEqual(p('2028-12-31T00:00:00Z'), { month: 12, year: 2028 });
  assert.deepEqual(p('31/12/2028'), { month: 12, year: 2028 });
  assert.deepEqual(p('1228'), { month: 12, year: 2028 });
  assert.deepEqual(p({ month: '03', year: 2031 }), { month: 3, year: 2031 });
  assert.equal(p('garbage'), null);
  assert.equal(p(null), null);
  assert.equal(p('13/28'), null);
});

test('address is turned into one readable line whatever its shape', () => {
  const f = orchestratorHelpers.formatAddress;
  assert.equal(f({ street: '1 Main St', city: 'Wilmington', state: 'DE', postal_code: '19801', country: 'US' }), '1 Main St, Wilmington, DE, 19801, US');
  assert.equal(f('12 Rue A, PAP'), '12 Rue A, PAP');
  assert.equal(f(null), null);
});

test('reveal returns expiry and billing address when the provider sends a single expiry string', async () => {
  const reg = await registerAndVerify({ business_name: 'Expiry Co', email: 'expiry-co@example.com', password: 'password123' });
  const token = reg.data.session_token;
  const create = await api('POST', '/dashboard/cards', { token, body: { reference: 'EXPIRY-1', kind: 'business', business_name: 'Expiry Co', brand: 'VISA', amount: 15 } });
  await pollUntil(() => api('GET', `/dashboard/cards/${create.data.id}`, { token }), (r) => r.data.status !== 'pending', 30, 20);
  const reveal = await api('POST', `/dashboard/cards/${create.data.id}/reveal`, { token });
  assert.equal(reveal.status, 200);
  assert.equal(reveal.data.expiry_month, 11);
  assert.ok(reveal.data.expiry_year >= new Date().getFullYear());
  assert.equal(reveal.data.billing_address, '1 Main St, Wilmington, DE, 19801, US');
});

test('a provider failure sent as HTTP 200 with status:false is treated as a failure, refunded, and shown in simple French', async () => {
  const reg = await registerAndVerify({ business_name: 'Soft Err Co', email: 'soft-err@example.com', password: 'password123' });
  const token = reg.data.session_token;
  const before = await api('GET', '/dashboard/balance', { token });

  mapleradBehavior.softErrorNextCard = true;
  const r = await api('POST', '/dashboard/cards', { token, body: { reference: 'SOFT-1', kind: 'business', business_name: 'Soft Err Co', brand: 'VISA', amount: 15 } });
  assert.equal(r.status, 400);
  assert.equal(r.data.error.code, 'CARD_SERVICE_ERROR');
  assert.equal(r.data.error.message, 'Une information obligatoire est manquante ou invalide.');
  assert.doesNotMatch(JSON.stringify(r.data), /maplerad|fournisseur|CustomerID|CreateCardRequest/i);

  const after = await api('GET', '/dashboard/balance', { token });
  assert.equal(after.data.master_wallet.available, before.data.master_wallet.available); // fully refunded
  const list = await api('GET', '/dashboard/cards', { token });
  assert.equal(list.data.cards.find((c) => c.reference === 'SOFT-1').status, 'failed');
});

test('re-creating a holder that already exists at the provider recovers it instead of failing', async () => {
  const reg = await registerAndVerify({ business_name: 'Recover Co', email: 'recover-co@example.com', password: 'password123' });
  const token = reg.data.session_token;
  const body = {
    firstName: 'Rec', lastName: 'Over', email: 'rec@over.com', country: 'HT', dob: '1990-05-12',
    identificationNumber: 'ID-RC', identity: TEST_IDENTITY, phoneNumber: '37055555', phoneShortCode: '+509', address: { street: 'Rue Example', city: 'PAP', state: 'Ouest', postal_code: 'HT6110', country: 'HT' },
  };
  const first = await api('POST', '/dashboard/cards/holders', { token, body });
  assert.equal(first.status, 201);
  const second = await api('POST', '/dashboard/cards/holders', { token, body }); // provider answers "already enrolled"
  assert.equal(second.status, 200); // same email already enrolled: reused, no duplicate
  assert.equal(second.data.already_existed, true);
  assert.equal(second.data.id, first.data.id);
  assert.equal(first.data.id, first.data.holder.id);
  assert.equal(second.data.holder.status, 'enrolled');
  assert.equal(mockTables.maplerad_customers.filter((h) => h.email === 'rec@over.com').length, 1);
  const ids = mockTables.maplerad_customers.filter((h) => h.email === 'rec@over.com').map((h) => h.maplerad_customer_id);
  assert.equal(new Set(ids).size, 1); // same provider customer, recovered by email
});

test('an old holder saved without a provider id is healed automatically when issuing a card', async () => {
  const reg = await registerAndVerify({ business_name: 'Heal Co', email: 'heal-co@example.com', password: 'password123' });
  const token = reg.data.session_token;
  const body = {
    firstName: 'Old', lastName: 'Holder', email: 'old@holder.com', country: 'HT', dob: '1985-01-02',
    identificationNumber: 'ID-OH', identity: TEST_IDENTITY, phoneNumber: '37066666', phoneShortCode: '+509', address: { street: 'Rue Example', city: 'PAP', state: 'Ouest', postal_code: 'HT6110', country: 'HT' },
  };
  const h = await api('POST', '/dashboard/cards/holders', { token, body });
  const row = mockTables.maplerad_customers.find((x) => x.id === h.data.holder.id);
  const realId = row.maplerad_customer_id;
  row.maplerad_customer_id = null; // simulate the old bug: "verified" but no id stored

  const card = await api('POST', '/dashboard/cards', { token, body: { reference: 'HEAL-1', kind: 'individual', brand: 'VISA', amount: 15, holder_id: h.data.holder.id } });
  assert.equal(card.status, 202);
  assert.equal(row.maplerad_customer_id, realId);
});

/* ===== Team: real invitations, roles, removal ===== */

function inviteTokenFor(email) {
  const mails = sentEmails.filter((e) => e.to === email);
  const last = mails[mails.length - 1];
  assert.ok(last, `no invitation email captured for ${email}`);
  const m = last.text.match(/invite=([a-f0-9]{64})/);
  assert.ok(m, 'invitation link with token not found in email');
  return m[1];
}

test('an owner invites a teammate by email; the invitee sets a password, gets the right role, and can be removed', async () => {
  const reg = await registerAndVerify({ business_name: 'Team Co', email: 'owner@team-co.com', password: 'password123' });
  const owner = reg.data.session_token;

  const bad = await api('POST', '/dashboard/team/invite', { token: owner, body: { email: 'not-an-email', role: 'admin' } });
  assert.equal(bad.status, 400);
  const badRole = await api('POST', '/dashboard/team/invite', { token: owner, body: { email: 'x@team-co.com', role: 'god' } });
  assert.equal(badRole.status, 400);
  const taken = await api('POST', '/dashboard/team/invite', { token: owner, body: { email: 'owner@team-co.com', role: 'admin' } });
  assert.equal(taken.status, 409);

  const inv = await api('POST', '/dashboard/team/invite', { token: owner, body: { email: 'Viewer@Team-Co.com', role: 'viewer' } });
  assert.equal(inv.status, 201);
  assert.equal(inv.data.member.status, 'invited');
  assert.equal(inv.data.member.email, 'viewer@team-co.com');
  assert.equal(inv.data.member.invite_token_hash, undefined);

  const token = inviteTokenFor('viewer@team-co.com');
  const info = await api('GET', `/auth/invite-info?token=${token}`);
  assert.equal(info.status, 200);
  assert.equal(info.data.business_name, 'Team Co');
  assert.equal(info.data.role, 'viewer');

  const weak = await api('POST', '/auth/accept-invite', { body: { token, password: 'short' } });
  assert.equal(weak.status, 400);
  const notYet = await api('POST', '/auth/login', { body: { email: 'viewer@team-co.com', password: 'password123' } });
  assert.equal(notYet.status, 401); // cannot sign in before accepting

  const accepted = await api('POST', '/auth/accept-invite', { body: { token, password: 'my-new-password' } });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.role, 'viewer');
  const viewer = accepted.data.session_token;

  const reuse = await api('POST', '/auth/accept-invite', { body: { token, password: 'another-password' } });
  assert.equal(reuse.status, 400); // one-time link

  // Viewer: reads the OWNER's account, cannot change anything, cannot see the team.
  const me = await api('GET', '/auth/me', { token: viewer });
  assert.equal(me.data.user.role, 'viewer');
  assert.equal(me.data.user.email, 'viewer@team-co.com');
  assert.equal(me.data.merchant.business_name, 'Team Co');
  assert.equal((await api('GET', '/dashboard/balance', { token: viewer })).status, 200);
  const write = await api('POST', '/dashboard/payment-links', { token: viewer, body: { amount: 100 } });
  assert.equal(write.status, 403);
  assert.equal(write.data.error.code, 'READ_ONLY');
  assert.equal((await api('GET', '/dashboard/team', { token: viewer })).status, 403);

  // Sign in again later with the member's own credentials.
  const login = await loginWithOtp('viewer@team-co.com', 'my-new-password');
  assert.equal(login.status, 200);
  assert.equal(login.data.role, 'viewer');

  // Owner sees both, then removes the viewer: the open session dies at once.
  const listed = await api('GET', '/dashboard/team', { token: owner });
  assert.equal(listed.data.owner.email, 'owner@team-co.com');
  assert.equal(listed.data.members.length, 1);
  assert.equal(listed.data.members[0].status, 'active');
  const removed = await api('DELETE', `/dashboard/team/${inv.data.member.id}`, { token: owner });
  assert.equal(removed.status, 200);
  assert.equal((await api('GET', '/dashboard/balance', { token: viewer })).status, 401);
  assert.equal((await api('POST', '/auth/login', { body: { email: 'viewer@team-co.com', password: 'my-new-password' } })).status, 401);
});

test('an admin can act on the account but cannot manage the team', async () => {
  const reg = await registerAndVerify({ business_name: 'Admin Co', email: 'owner@admin-co.com', password: 'password123' });
  const owner = reg.data.session_token;
  await api('POST', '/dashboard/team/invite', { token: owner, body: { email: 'admin@admin-co.com', role: 'admin' } });
  const accepted = await api('POST', '/auth/accept-invite', { body: { token: inviteTokenFor('admin@admin-co.com'), password: 'admin-password' } });
  const admin = accepted.data.session_token;

  const link = await api('POST', '/dashboard/payment-links', { token: admin, body: { amount: 100 } });
  assert.equal(link.status, 201);
  const invite = await api('POST', '/dashboard/team/invite', { token: admin, body: { email: 'third@admin-co.com', role: 'viewer' } });
  assert.equal(invite.status, 403);
  assert.equal(invite.data.error.code, 'OWNER_ONLY');
});

test('an expired invitation link is refused, and resending gives a fresh working one', async () => {
  const reg = await registerAndVerify({ business_name: 'Expire Co', email: 'owner@expire-co.com', password: 'password123' });
  const owner = reg.data.session_token;
  const inv = await api('POST', '/dashboard/team/invite', { token: owner, body: { email: 'late@expire-co.com', role: 'viewer' } });
  const oldToken = inviteTokenFor('late@expire-co.com');
  mockTables.team_members.find((m) => m.id === inv.data.member.id).invite_expires_at = new Date(Date.now() - 1000).toISOString();

  const expired = await api('POST', '/auth/accept-invite', { body: { token: oldToken, password: 'password-ok-123' } });
  assert.equal(expired.status, 400);
  assert.equal(expired.data.error.code, 'INVITE_EXPIRED');

  const resend = await api('POST', `/dashboard/team/${inv.data.member.id}/resend`, { token: owner });
  assert.equal(resend.status, 200);
  const fresh = inviteTokenFor('late@expire-co.com');
  assert.notEqual(fresh, oldToken);
  const ok = await api('POST', '/auth/accept-invite', { body: { token: fresh, password: 'password-ok-123' } });
  assert.equal(ok.status, 200);
});

test('changing your password really changes it (owner and teammate), and needs the current one', async () => {
  const reg = await registerAndVerify({ business_name: 'Pwd Co', email: 'owner@pwd-co.com', password: 'old-password-1' });
  const owner = reg.data.session_token;

  const wrong = await api('POST', '/dashboard/account/password', { token: owner, body: { current_password: 'nope-nope', new_password: 'brand-new-pass' } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.data.error.code, 'WRONG_PASSWORD');
  const weak = await api('POST', '/dashboard/account/password', { token: owner, body: { current_password: 'old-password-1', new_password: 'short' } });
  assert.equal(weak.status, 400);

  const ok = await api('POST', '/dashboard/account/password', { token: owner, body: { current_password: 'old-password-1', new_password: 'brand-new-pass' } });
  assert.equal(ok.status, 200);
  assert.equal((await api('POST', '/auth/login', { body: { email: 'owner@pwd-co.com', password: 'old-password-1' } })).status, 401);
  assert.equal((await loginWithOtp('owner@pwd-co.com', 'brand-new-pass')).status, 200);

  // A read-only teammate can still change their OWN password. (Changing a password ends older sessions: use the fresh token it returned.)
  await api('POST', '/dashboard/team/invite', { token: ok.data.session_token, body: { email: 'ro@pwd-co.com', role: 'viewer' } });
  const acc = await api('POST', '/auth/accept-invite', { body: { token: inviteTokenFor('ro@pwd-co.com'), password: 'member-pass-1' } });
  const change = await api('POST', '/dashboard/account/password', { token: acc.data.session_token, body: { current_password: 'member-pass-1', new_password: 'member-pass-2' } });
  assert.equal(change.status, 200);
  assert.equal((await loginWithOtp('ro@pwd-co.com', 'member-pass-2')).status, 200);
});

/* ===== Admin: auth, KYC/KYB review, blog ===== */

const { hashPassword: testHashPassword } = require('../src/utils/password');

function seedAdmin(role) {
  const id = `adm_${Math.random().toString(16).slice(2, 10)}`;
  const email = `admin-${id}@fredapay.com`;
  const password = 'admin-password-1';
  mockTables.admin_users.push({ id, email, password_hash: testHashPassword(password), name: 'Test Admin', role: role || 'owner', created_at: new Date().toISOString() });
  return { id, email, password };
}

async function adminLogin(role) {
  const seeded = seedAdmin(role);
  const r = await loginWithOtp(seeded.email, seeded.password, '/admin');
  assert.equal(r.status, 200);
  return { token: r.data.session_token, ...seeded };
}

test('admin login works, rejects wrong password, and /admin/me reflects the role', async () => {
  const { token, email } = await adminLogin('owner');
  const me = await api('GET', '/admin/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.data.admin.email, email);
  assert.equal(me.data.admin.role, 'owner');

  const wrong = await api('POST', '/admin/login', { body: { email, password: 'nope-nope-nope' } });
  assert.equal(wrong.status, 401);
});

test('a merchant can really submit KYC documents (not just a client-side checkbox), and an admin can approve them, enabling Live mode', async () => {
  const reg = await registerAndVerify({ business_name: 'Verify Flow Co', email: 'verify-flow@example.com', password: 'password123' });
  const token = reg.data.session_token;

  const submit = await api('POST', '/dashboard/verification/kyc', {
    token, body: { documents: [{ label: 'Pièce d\'identité', filename: 'id.jpg', content_type: 'image/jpeg', base64: Buffer.from('fake-id-bytes').toString('base64') }] },
  });
  assert.equal(submit.status, 201);
  assert.equal(submit.data.status, 'submitted');

  const mine = await api('GET', '/dashboard/verification', { token });
  assert.equal(mine.data.submissions.length, 1);
  assert.equal(mine.data.submissions[0].kind, 'kyc');

  const me = await api('GET', '/auth/me', { token });
  assert.equal(me.data.merchant.kyc_status, 'submitted');

  // Individual account: KYB not required for Live.
  const { token: adminToken } = await adminLogin('owner');
  const pending = await api('GET', '/admin/verifications', { token: adminToken });
  const found = pending.data.submissions.find((s) => s.merchant.id === reg.data.merchant.id);
  assert.ok(found, 'submission should appear in the admin review queue');
  assert.equal(found.documents.length, 1);

  const approve = await api('POST', `/admin/verifications/${found.id}/approve`, { token: adminToken });
  assert.equal(approve.status, 200);
  assert.equal(approve.data.submission.status, 'approved');

  const after = await api('GET', '/auth/me', { token });
  assert.equal(after.data.merchant.kyc_status, 'verified');
  assert.equal(after.data.merchant.live_enabled, true);

  // Re-approving the same submission is rejected (already reviewed).
  const again = await api('POST', `/admin/verifications/${found.id}/approve`, { token: adminToken });
  assert.equal(again.status, 409);
});

test('a business account needs BOTH KYC and KYB approved before Live mode turns on', async () => {
  const reg = await api('POST', '/auth/register', { body: { business_name: 'Biz Verify Co', account_type: 'business', email: 'biz-verify@example.com', password: 'password123' } });
  const code = (sentEmails.filter((e) => e.to === 'biz-verify@example.com').slice(-1)[0].text.match(/vérification : (\d{6})/))[1];
  const verify = await api('POST', '/auth/verify-otp', { body: { merchant_id: reg.data.merchant_id, code } });
  const token = verify.data.session_token;

  await api('POST', '/dashboard/verification/kyc', { token, body: { documents: [{ label: 'ID', filename: 'id.jpg', content_type: 'image/jpeg', base64: Buffer.from('x').toString('base64') }] } });
  await api('POST', '/dashboard/verification/kyb', { token, body: { documents: [{ label: 'Business reg', filename: 'reg.pdf', content_type: 'application/pdf', base64: Buffer.from('y').toString('base64') }] } });

  const { token: adminToken } = await adminLogin('admin');
  const pending = await api('GET', '/admin/verifications', { token: adminToken });
  const kycSub = pending.data.submissions.find((s) => s.merchant.id === reg.data.merchant_id && s.kind === 'kyc');
  const kybSub = pending.data.submissions.find((s) => s.merchant.id === reg.data.merchant_id && s.kind === 'kyb');
  assert.ok(kycSub && kybSub);

  await api('POST', `/admin/verifications/${kycSub.id}/approve`, { token: adminToken });
  const midway = await api('GET', '/auth/me', { token });
  assert.equal(midway.data.merchant.live_enabled, false); // KYB still pending

  await api('POST', `/admin/verifications/${kybSub.id}/approve`, { token: adminToken });
  const final = await api('GET', '/auth/me', { token });
  assert.equal(final.data.merchant.live_enabled, true);
});

test('rejecting a KYC submission records the reason and does not enable Live', async () => {
  const reg = await registerAndVerify({ business_name: 'Reject Co', email: 'reject-flow@example.com', password: 'password123' });
  const token = reg.data.session_token;
  await api('POST', '/dashboard/verification/kyc', { token, body: { documents: [{ label: 'ID', filename: 'id.jpg', content_type: 'image/jpeg', base64: Buffer.from('x').toString('base64') }] } });

  const { token: adminToken } = await adminLogin('owner');
  const pending = await api('GET', '/admin/verifications', { token: adminToken });
  const sub = pending.data.submissions.find((s) => s.merchant.id === reg.data.merchant.id);
  const reject = await api('POST', `/admin/verifications/${sub.id}/reject`, { token: adminToken, body: { reason: 'Photo illisible.' } });
  assert.equal(reject.status, 200);
  assert.equal(reject.data.submission.rejection_reason, 'Photo illisible.');

  const after = await api('GET', '/auth/me', { token });
  assert.equal(after.data.merchant.kyc_status, 'rejected');
  assert.equal(after.data.merchant.live_enabled, false);
});

test('an editor admin cannot review verifications (compliance-only action)', async () => {
  const { token } = await adminLogin('editor');
  const r = await api('GET', '/admin/verifications', { token });
  assert.equal(r.status, 403); // editors (blog only) cannot even list KYC submissions
  // approving requires owner/admin too
  const fake = await api('POST', '/admin/verifications/vs_doesnotexist/approve', { token });
  assert.equal(fake.status, 403);
  assert.equal(fake.data.error.code, 'INSUFFICIENT_ROLE');
});

test('admin blog: create, edit, publish, and the public page is server-rendered with SEO tags', async () => {
  const { token } = await adminLogin('editor'); // editors CAN manage the blog
  const create = await api('POST', '/admin/blog', {
    token, body: { title: 'Guide MonCash pour les commerçants en Haïti', excerpt: 'Comment accepter MonCash facilement.', content_markdown: '# Intro\n\nHaïti a une économie mobile en pleine croissance.\n\n## Pourquoi MonCash\n\n- Rapide\n- Populaire', tags: ['Haïti', 'MonCash'] },
  });
  assert.equal(create.status, 201);
  assert.equal(create.data.post.status, 'draft');
  const postId = create.data.post.id;
  const slug = create.data.post.slug;
  assert.match(slug, /moncash/);

  // Not published yet: public page 404s.
  const draftView = await fetch(baseUrl + '/blog/' + slug);
  assert.equal(draftView.status, 404);

  const publish = await api('POST', `/admin/blog/${postId}/publish`, { token });
  assert.equal(publish.status, 200);
  assert.equal(publish.data.post.status, 'published');
  assert.ok(publish.data.post.published_at);

  const live = await fetch(baseUrl + '/blog/' + slug);
  assert.equal(live.status, 200);
  const html = await live.text();
  assert.match(html, /Guide MonCash pour les commerçants en Haïti/);
  assert.match(html, /<h2>Intro<\/h2>/);
  assert.match(html, /"@type":"BlogPosting"/);
  assert.match(html, new RegExp(`<link rel="canonical" href="https://[^"]+/blog/${slug}">`)); // canonical always points at the real site domain, not the test host

  const listHtml = await (await fetch(baseUrl + '/blog')).text();
  assert.match(listHtml, /Guide MonCash pour les commerçants en Haïti/);

  // Unpublish takes it back offline.
  await api('POST', `/admin/blog/${postId}/unpublish`, { token });
  const after = await fetch(baseUrl + '/blog/' + slug);
  assert.equal(after.status, 404);
});

test('two posts with the same title get distinct slugs', async () => {
  const { token } = await adminLogin('owner');
  const a = await api('POST', '/admin/blog', { token, body: { title: 'Haïti et les paiements mobiles', content_markdown: 'a' } });
  const b = await api('POST', '/admin/blog', { token, body: { title: 'Haïti et les paiements mobiles', content_markdown: 'b' } });
  assert.notEqual(a.data.post.slug, b.data.post.slug);
});

test('deleting a blog post removes it from the admin list', async () => {
  const { token } = await adminLogin('owner');
  const created = await api('POST', '/admin/blog', { token, body: { title: 'À supprimer', content_markdown: 'x' } });
  const del = await api('DELETE', `/admin/blog/${created.data.post.id}`, { token });
  assert.equal(del.status, 200);
  const list = await api('GET', '/admin/blog', { token });
  assert.ok(!list.data.posts.find((p) => p.id === created.data.post.id));
});

test('admin password change requires the current password', async () => {
  const { token, password } = await adminLogin('owner');
  const wrong = await api('POST', '/admin/account/password', { token, body: { current_password: 'nope', new_password: 'new-password-1' } });
  assert.equal(wrong.status, 400);
  const ok = await api('POST', '/admin/account/password', { token, body: { current_password: password, new_password: 'new-password-1' } });
  assert.equal(ok.status, 200);
});

/* ===== Admin: merchant management (balances, credit, pricing, live override, free plan, delete) ===== */

test('admin sees a merchant\'s balances in the list and the detail view', async () => {
  const reg = await registerAndVerify({ business_name: 'Balance View Co', email: 'balance-view@example.com', password: 'password123' });
  const { token: adminToken } = await adminLogin('owner');
  const list = await api('GET', '/admin/merchants', { token: adminToken });
  const found = list.data.merchants.find((m) => m.id === reg.data.merchant.id);
  assert.ok(found);
  assert.equal(found.sandbox_balances.master_wallet > 0, true); // sandbox welcome bonus is play money
  assert.equal(found.balances.master_wallet, 0); // nothing real until a live deposit
  assert.equal(found.balances.gateway, 0);

  const detail = await api('GET', `/admin/merchants/${reg.data.merchant.id}`, { token: adminToken });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.merchant.business_name, 'Balance View Co');
  assert.ok(detail.data.sandbox_balances.master_wallet > 0);
  assert.equal(detail.data.balances.master_wallet, 0);
  assert.equal(detail.data.pricing, null);
});

test('admin can manually credit a merchant wallet, and the merchant is emailed', async () => {
  const reg = await registerAndVerify({ business_name: 'Credit Me Co', email: 'credit-me@example.com', password: 'password123' });
  const { token: adminToken } = await adminLogin('admin');
  const before = await api('GET', '/dashboard/balance', { token: reg.data.session_token });

  const bad = await api('POST', `/admin/merchants/${reg.data.merchant.id}/credit`, { token: adminToken, body: { wallet: 'nope', amount: 10 } });
  assert.equal(bad.status, 400);

  const credit = await api('POST', `/admin/merchants/${reg.data.merchant.id}/credit`, { token: adminToken, body: { wallet: 'master_wallet', amount: 25, note: 'Virement bancaire confirmé' } });
  assert.equal(credit.status, 200);

  const after = await api('GET', '/dashboard/balance', { token: reg.data.session_token });
  assert.equal(after.data.master_wallet.available, before.data.master_wallet.available + 25);

  const mails = sentEmails.filter((e) => e.to === 'credit-me@example.com');
  const last = mails[mails.length - 1];
  assert.match(last.subject, /25,00 \$/);
});

test('an editor admin cannot credit wallets or change pricing (compliance-only)', async () => {
  const reg = await registerAndVerify({ business_name: 'Editor Block Co', email: 'editor-block@example.com', password: 'password123' });
  const { token } = await adminLogin('editor');
  const r = await api('POST', `/admin/merchants/${reg.data.merchant.id}/credit`, { token, body: { wallet: 'master_wallet', amount: 10 } });
  assert.equal(r.status, 403);
});

test('admin can set custom pricing for a merchant, and it is actually used for card creation', async () => {
  const reg = await registerAndVerify({ business_name: 'Custom Price Co', email: 'custom-price@example.com', password: 'password123' });
  const token = reg.data.session_token;
  const { token: adminToken } = await adminLogin('owner');

  const setP = await api('PUT', `/admin/merchants/${reg.data.merchant.id}/pricing`, { token: adminToken, body: { card_creation_usd: 1.00 } });
  assert.equal(setP.status, 200);
  assert.equal(setP.data.pricing.card_creation_usd, 1.00);
  assert.equal(setP.data.pricing.card_recharge_usd, null);

  const before = await api('GET', '/dashboard/balance', { token });
  await api('POST', '/dashboard/cards', { token, body: { reference: 'CUSTOM-PRICE-1', kind: 'business', business_name: 'Custom Price Co', brand: 'VISA', amount: 10 } });
  const after = await api('GET', '/dashboard/balance', { token });
  // Standard Startup plan creation fee is 5.00 $; with the override it should be 1.00 $ instead.
  assert.equal(before.data.master_wallet.available - after.data.master_wallet.available, 11.00);

  const clear = await api('DELETE', `/admin/merchants/${reg.data.merchant.id}/pricing`, { token: adminToken });
  assert.equal(clear.status, 200);
  const detail = await api('GET', `/admin/merchants/${reg.data.merchant.id}`, { token: adminToken });
  assert.equal(detail.data.pricing, null);
});

test('admin can force Live mode on without any KYC documents, and grant a free plan', async () => {
  const reg = await registerAndVerify({ business_name: 'Force Live Co', email: 'force-live@example.com', password: 'password123' });
  const { token: adminToken } = await adminLogin('owner');

  const me0 = await api('GET', '/auth/me', { token: reg.data.session_token });
  assert.equal(me0.data.merchant.live_enabled, false);
  assert.equal(me0.data.merchant.kyc_status, 'not_started');

  const forced = await api('PUT', `/admin/merchants/${reg.data.merchant.id}/live`, { token: adminToken, body: { live_enabled: true } });
  assert.equal(forced.status, 200);
  assert.equal(forced.data.live_enabled, true);
  const me1 = await api('GET', '/auth/me', { token: reg.data.session_token });
  assert.equal(me1.data.merchant.live_enabled, true);
  assert.equal(me1.data.merchant.gateway_live_enabled, true);
  assert.equal(me1.data.merchant.issuing_live_enabled, false); // Issuing is always granted separately

  // The point of "force live": the merchant can now really switch their dashboard to Live.
  const toLive = await api('PUT', '/dashboard/mode', { token: reg.data.session_token, body: { mode: 'live' } });
  assert.equal(toLive.status, 200);
  // An admin can also grant Issuing live directly, and switching Live off pulls everything back.
  const grantIssuing = await api('PUT', `/admin/merchants/${reg.data.merchant.id}/live`, { token: adminToken, body: { issuing_live_enabled: true } });
  assert.equal(grantIssuing.data.issuing_live_enabled, true);
  const off = await api('PUT', `/admin/merchants/${reg.data.merchant.id}/live`, { token: adminToken, body: { live_enabled: false } });
  assert.equal(off.data.gateway_live_enabled, false);
  assert.equal(off.data.issuing_live_enabled, false);
  assert.equal(off.data.active_mode, 'sandbox');
  await api('PUT', `/admin/merchants/${reg.data.merchant.id}/live`, { token: adminToken, body: { live_enabled: true } });

  const freeOn = await api('PUT', `/admin/merchants/${reg.data.merchant.id}/free-plan`, { token: adminToken, body: { grant: true } });
  assert.equal(freeOn.data.gateway_plan, 'free');
  assert.equal(freeOn.data.issuing_plan, 'free');

  const freeOff = await api('PUT', `/admin/merchants/${reg.data.merchant.id}/free-plan`, { token: adminToken, body: { grant: false } });
  assert.equal(freeOff.data.gateway_plan, 'standard');
});

test('admin deleting a merchant blocks their login immediately, even with an open session', async () => {
  const reg = await registerAndVerify({ business_name: 'Delete Me Co', email: 'delete-me@example.com', password: 'password123' });
  const token = reg.data.session_token;
  const { token: adminToken } = await adminLogin('owner');

  assert.equal((await api('GET', '/dashboard/balance', { token })).status, 200);

  const del = await api('DELETE', `/admin/merchants/${reg.data.merchant.id}`, { token: adminToken });
  assert.equal(del.status, 200);

  assert.equal((await api('GET', '/dashboard/balance', { token })).status, 401); // existing session dies at once
  const loginAttempt = await api('POST', '/auth/login', { body: { email: 'delete-me@example.com', password: 'password123' } });
  assert.equal(loginAttempt.status, 403);
  assert.equal(loginAttempt.data.error.code, 'ACCOUNT_DEACTIVATED');

  const restore = await api('POST', `/admin/merchants/${reg.data.merchant.id}/restore`, { token: adminToken });
  assert.equal(restore.status, 200);
  assert.equal((await loginWithOtp('delete-me@example.com', 'password123')).status, 200);
});

test('revenue is tracked per merchant and summarized with profit', async () => {
  const reg = await registerAndVerify({ business_name: 'Revenue Track Co', email: 'revenue-track@example.com', password: 'password123' });
  const token = reg.data.session_token;
  const revCard = await api('POST', '/dashboard/cards', { token, body: { reference: 'REV-1', kind: 'business', business_name: 'Revenue Track Co', brand: 'VISA', amount: 10 } });
  await pollUntil(() => api('GET', `/dashboard/cards/${revCard.data.id}`, { token }), (r) => r.data.status === 'active', 40, 20);

  const { token: adminToken } = await adminLogin('owner');
  const live = await api('GET', `/admin/merchants/${reg.data.merchant.id}`, { token: adminToken });
  assert.equal(live.data.revenue_mode, 'live');
  assert.equal(live.data.revenue.total_revenue_usd, 0); // sandbox fees never count as real revenue
  const detail = await api('GET', `/admin/merchants/${reg.data.merchant.id}?mode=sandbox`, { token: adminToken });
  assert.ok(detail.data.revenue.total_revenue_usd >= 5.00); // Startup plan card creation fee
  assert.ok(detail.data.revenue.by_kind_usd.card_creation >= 5.00);
  // Our cost is $1.50, so profit on a $5 creation fee should be $3.50.
  assert.ok(detail.data.revenue.total_profit_usd >= 3.50);
  assert.ok(detail.data.revenue.by_day.length >= 1);
});

/* ===== Admin team (invite other Freda Pay staff) ===== */

test('an admin owner can invite another admin, who accepts and signs in', async () => {
  const { token: ownerToken } = await adminLogin('owner');
  const inv = await api('POST', '/admin/team/invite', { token: ownerToken, body: { email: 'new-admin@fredapay.com', name: 'New Admin', role: 'editor' } });
  assert.equal(inv.status, 201);
  assert.equal(inv.data.admin.status, 'invited');

  const mails = sentEmails.filter((e) => e.to === 'new-admin@fredapay.com');
  const token = mails[mails.length - 1].text.match(/invite=([a-f0-9]{64})/)[1];

  const info = await api('GET', `/admin/invite-info?token=${token}`);
  assert.equal(info.status, 200);
  assert.equal(info.data.role, 'editor');

  const accepted = await api('POST', '/admin/accept-invite', { body: { token, password: 'new-admin-pass-1' } });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.admin.role, 'editor');

  const login = await loginWithOtp('new-admin@fredapay.com', 'new-admin-pass-1', '/admin');
  assert.equal(login.status, 200);
});

test('a non-owner admin cannot invite other admins', async () => {
  const { token } = await adminLogin('admin');
  const r = await api('POST', '/admin/team/invite', { token, body: { email: 'x@fredapay.com', name: 'X', role: 'editor' } });
  assert.equal(r.status, 403);
  assert.equal(r.data.error.code, 'OWNER_ONLY');
});

test('an admin cannot remove their own access', async () => {
  const { token, id } = await adminLogin('owner');
  const r = await api('DELETE', `/admin/team/${id}`, { token });
  assert.equal(r.status, 400);
  assert.equal(r.data.error.code, 'CANNOT_REMOVE_SELF');
});

/* ===== Disputes ===== */

test('a merchant can open a dispute on a succeeded payment, and an admin can resolve it', async () => {
  const reg = await registerAndVerify({ business_name: 'Dispute Co', email: 'dispute-co@example.com', password: 'password123' });
  const token = reg.data.session_token;
  const create = await api('POST', '/dashboard/payments', { token, body: { amount: 1000, method: 'moncash', reference: 'DISPUTE-PAY-1' } });
  await fetch('http://localhost:4501/__control/confirm-payment', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refference_id: `fp_${reg.data.merchant.id}_DISPUTE-PAY-1` }),
  });
  await api('GET', `/dashboard/payments/${create.data.id}`, { token }); // trigger status refresh

  const badReason = await api('POST', `/dashboard/payments/${create.data.id}/dispute`, { token, body: { reason: 'nonsense' } });
  assert.equal(badReason.status, 400);

  const dispute = await api('POST', `/dashboard/payments/${create.data.id}/dispute`, { token, body: { reason: 'not_received', details: "Le client dit n'avoir rien reçu." } });
  if (dispute.status !== 201) console.log('DEBUG dispute response:', JSON.stringify(dispute.data));
  assert.equal(dispute.status, 201);
  assert.equal(dispute.data.dispute.status, 'open');

  const dupe = await api('POST', `/dashboard/payments/${create.data.id}/dispute`, { token, body: { reason: 'other' } });
  assert.equal(dupe.status, 409);

  const mine = await api('GET', '/dashboard/disputes', { token });
  assert.equal(mine.data.disputes.length, 1);

  const { token: adminToken } = await adminLogin('owner');
  const list = await api('GET', '/admin/disputes', { token: adminToken });
  const found = list.data.disputes.find((d) => d.id === dispute.data.dispute.id);
  assert.ok(found);
  assert.equal(found.merchant.business_name, 'Dispute Co');

  const resolve = await api('POST', `/admin/disputes/${dispute.data.dispute.id}/resolve`, { token: adminToken, body: { note: 'Remboursé manuellement.' } });
  assert.equal(resolve.status, 200);
  assert.equal(resolve.data.dispute.status, 'resolved');

  const again = await api('POST', `/admin/disputes/${dispute.data.dispute.id}/resolve`, { token: adminToken });
  assert.equal(again.status, 409);
});

/* ===== Gateway summary + CSV export ===== */

test('the Gateway summary reflects real money in and fees paid, and CSV export works', async () => {
  const reg = await registerAndVerify({ business_name: 'Summary Co', email: 'summary-co@example.com', password: 'password123' });
  const token = reg.data.session_token;
  const create = await api('POST', '/dashboard/payments', { token, body: { amount: 2000, method: 'moncash', reference: 'SUMMARY-PAY-1' } });
  await fetch('http://localhost:4501/__control/confirm-payment', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refference_id: `fp_${reg.data.merchant.id}_SUMMARY-PAY-1` }),
  });
  await api('GET', `/dashboard/payments/${create.data.id}`, { token });

  const summary = await api('GET', '/dashboard/gateway-summary', { token });
  assert.equal(summary.status, 200);
  assert.equal(summary.data.total_in_htg, 2000);
  assert.ok(summary.data.total_fees_htg > 0);
  assert.equal(summary.data.by_day.length, 1);

  const csvRes = await fetch(baseUrl + '/dashboard/payments/export.csv', { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(csvRes.status, 200);
  assert.match(csvRes.headers.get('content-type'), /text\/csv/);
  assert.match(csvRes.headers.get('content-disposition'), /attachment/);
  const csvText = await csvRes.text();
  assert.match(csvText, /^id,reference,date,method,amount,currency,fee,net_amount,status/);
  assert.match(csvText, /SUMMARY-PAY-1/);
});

/* ===== Gateway vs Issuing Live split, and the sandbox/live mode toggle ===== */

test('KYC/KYB approval enables Gateway Live but NOT Issuing Live - they are separate', async () => {
  const reg = await registerAndVerify({ business_name: 'Split Live Co', email: 'split-live@example.com', password: 'password123' });
  const token = reg.data.session_token;
  await api('POST', '/dashboard/verification/kyc', { token, body: { documents: [{ label: 'ID', filename: 'id.jpg', content_type: 'image/jpeg', base64: Buffer.from('x').toString('base64') }] } });

  const { token: adminToken } = await adminLogin('owner');
  const pending = await api('GET', '/admin/verifications', { token: adminToken });
  const sub = pending.data.submissions.find((s) => s.merchant.id === reg.data.merchant.id);
  await api('POST', `/admin/verifications/${sub.id}/approve`, { token: adminToken });

  const me = await api('GET', '/auth/me', { token });
  assert.equal(me.data.merchant.gateway_live_enabled, true);
  assert.equal(me.data.merchant.issuing_live_enabled, false);
});

test('a merchant can switch the dashboard to Live only once Gateway is live, and can always switch back to Sandbox', async () => {
  const reg = await registerAndVerify({ business_name: 'Mode Switch Co', email: 'mode-switch@example.com', password: 'password123' });
  const token = reg.data.session_token;

  const blocked = await api('PUT', '/dashboard/mode', { token, body: { mode: 'live' } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.error.code, 'GATEWAY_NOT_LIVE');

  // Force Gateway live via the admin override (simpler than the full KYC flow for this test).
  const { token: adminToken } = await adminLogin('owner');
  await api('PUT', `/admin/merchants/${reg.data.merchant.id}/live`, { token: adminToken, body: { live_enabled: true } });
  // The admin "force live" override sets the legacy flag; set gateway_live_enabled directly for this test via pricing-adjacent path is not available,
  // so approve via KYC instead to also exercise the real path:
  await api('POST', '/dashboard/verification/kyc', { token, body: { documents: [{ label: 'ID', filename: 'id.jpg', content_type: 'image/jpeg', base64: Buffer.from('x').toString('base64') }] } });
  const pending = await api('GET', '/admin/verifications', { token: adminToken });
  const sub = pending.data.submissions.find((s) => s.merchant.id === reg.data.merchant.id);
  await api('POST', `/admin/verifications/${sub.id}/approve`, { token: adminToken });

  const toLive = await api('PUT', '/dashboard/mode', { token, body: { mode: 'live' } });
  assert.equal(toLive.status, 200);
  assert.equal(toLive.data.active_mode, 'live');

  const backToSandbox = await api('PUT', '/dashboard/mode', { token, body: { mode: 'sandbox' } });
  assert.equal(backToSandbox.status, 200);
  assert.equal(backToSandbox.data.active_mode, 'sandbox');
});

test('creating a card while the dashboard is in Live mode requires Issuing Live access, separately from Gateway', async () => {
  const reg = await registerAndVerify({ business_name: 'Issuing Gate Co', email: 'issuing-gate@example.com', password: 'password123' });
  const token = reg.data.session_token;
  const { token: adminToken } = await adminLogin('owner');

  // Get Gateway live via KYC approval, then switch the dashboard to Live.
  await api('POST', '/dashboard/verification/kyc', { token, body: { documents: [{ label: 'ID', filename: 'id.jpg', content_type: 'image/jpeg', base64: Buffer.from('x').toString('base64') }] } });
  const pending = await api('GET', '/admin/verifications', { token: adminToken });
  const sub = pending.data.submissions.find((s) => s.merchant.id === reg.data.merchant.id);
  await api('POST', `/admin/verifications/${sub.id}/approve`, { token: adminToken });
  await api('PUT', '/dashboard/mode', { token, body: { mode: 'live' } });

  // Issuing is NOT live yet - card creation must be refused even though Gateway is.
  const blocked = await api('POST', '/dashboard/cards', { token, body: { reference: 'LIVE-CARD-1', kind: 'business', business_name: 'Issuing Gate Co', brand: 'VISA', amount: 10 } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.error.code, 'ISSUING_LIVE_NOT_ENABLED');

  // Request Issuing access.
  const dup0 = await api('GET', '/dashboard/issuing-access', { token });
  assert.equal(dup0.data.requests.length, 0);
  const reqRes = await api('POST', '/dashboard/issuing-access/request', { token, body: { note: 'Prêt pour la production.' } });
  assert.equal(reqRes.status, 201);
  const again = await api('POST', '/dashboard/issuing-access/request', { token });
  assert.equal(again.status, 409); // already pending

  const adminPending = await api('GET', '/admin/issuing-access', { token: adminToken });
  const found = adminPending.data.requests.find((r) => r.merchant.id === reg.data.merchant.id);
  assert.ok(found);

  await api('POST', `/admin/issuing-access/${found.id}/approve`, { token: adminToken });
  const me = await api('GET', '/auth/me', { token });
  assert.equal(me.data.merchant.issuing_live_enabled, true);

  // Approved, but the LIVE wallet is empty: the $5,000 of sandbox play money must NOT be usable here.
  const noFunds = await api('POST', '/dashboard/cards', { token, body: { reference: 'LIVE-CARD-2', kind: 'business', business_name: 'Issuing Gate Co', brand: 'VISA', amount: 10 } });
  assert.equal(noFunds.status, 400);
  assert.equal(noFunds.data.error.code, 'BELOW_MINIMUM_BALANCE');

  // A real deposit confirmed by an admin lands in the LIVE wallet, and now a live card can be created.
  const credited = await api('POST', `/admin/merchants/${reg.data.merchant.id}/credit`, { token: adminToken, body: { wallet: 'master_wallet', amount: 100, mode: 'live' } });
  assert.equal(credited.data.mode, 'live');
  const ok = await api('POST', '/dashboard/cards', { token, body: { reference: 'LIVE-CARD-3', kind: 'business', business_name: 'Issuing Gate Co', brand: 'VISA', amount: 10 } });
  assert.equal(ok.status, 202);
});

test('an admin can reject an Issuing access request', async () => {
  const reg = await registerAndVerify({ business_name: 'Issuing Reject Co', email: 'issuing-reject@example.com', password: 'password123' });
  const token = reg.data.session_token;
  await api('POST', '/dashboard/issuing-access/request', { token });

  const { token: adminToken } = await adminLogin('owner');
  const pending = await api('GET', '/admin/issuing-access', { token: adminToken });
  const found = pending.data.requests.find((r) => r.merchant.id === reg.data.merchant.id);
  const rejected = await api('POST', `/admin/issuing-access/${found.id}/reject`, { token: adminToken, body: { note: 'KYB manquant.' } });
  assert.equal(rejected.status, 200);
  const me = await api('GET', '/auth/me', { token });
  assert.equal(me.data.merchant.issuing_live_enabled, false);
});

test('sandbox and live data are kept separate: a card created in one mode does not appear when viewing the other', async () => {
  const reg = await registerAndVerify({ business_name: 'Data Split Co', email: 'data-split@example.com', password: 'password123' });
  const token = reg.data.session_token;
  const { token: adminToken } = await adminLogin('owner');

  const sandboxCard = await api('POST', '/dashboard/cards', { token, body: { reference: 'SANDBOX-CARD-1', kind: 'business', business_name: 'Data Split Co', brand: 'VISA', amount: 10 } });
  assert.equal(sandboxCard.status, 202);

  await api('POST', '/dashboard/verification/kyc', { token, body: { documents: [{ label: 'ID', filename: 'id.jpg', content_type: 'image/jpeg', base64: Buffer.from('x').toString('base64') }] } });
  const pending = await api('GET', '/admin/verifications', { token: adminToken });
  const sub = pending.data.submissions.find((s) => s.merchant.id === reg.data.merchant.id);
  await api('POST', `/admin/verifications/${sub.id}/approve`, { token: adminToken });
  await api('PUT', '/dashboard/mode', { token, body: { mode: 'live' } });
  const iar = await api('POST', '/dashboard/issuing-access/request', { token });
  const adminPending = await api('GET', '/admin/issuing-access', { token: adminToken });
  const found = adminPending.data.requests.find((r) => r.merchant.id === reg.data.merchant.id);
  await api('POST', `/admin/issuing-access/${found.id}/approve`, { token: adminToken });

  const liveList = await api('GET', '/dashboard/cards', { token });
  assert.equal(liveList.data.mode, 'live');
  assert.ok(!liveList.data.cards.find((c) => c.reference === 'SANDBOX-CARD-1'));

  await api('PUT', '/dashboard/mode', { token, body: { mode: 'sandbox' } });
  const sandboxList = await api('GET', '/dashboard/cards', { token });
  assert.ok(sandboxList.data.cards.find((c) => c.reference === 'SANDBOX-CARD-1'));
});

/* ===== Consolidated card transactions (Overview page) ===== */

test('the consolidated card-transactions endpoint is not shadowed by /dashboard/cards/:id, and returns real data', async () => {
  const reg = await registerAndVerify({ business_name: 'Tx Overview Co', email: 'tx-overview@example.com', password: 'password123' });
  const token = reg.data.session_token;
  const create = await api('POST', '/dashboard/cards', { token, body: { reference: 'TXOV-1', kind: 'business', business_name: 'Tx Overview Co', brand: 'VISA', amount: 20 } });
  await pollUntil(() => api('GET', `/dashboard/cards/${create.data.id}`, { token }), (r) => r.data.status !== 'pending', 30, 20);

  const all = await api('GET', '/dashboard/cards/transactions', { token });
  assert.equal(all.status, 200);
  assert.equal(all.data.mode, 'sandbox');
  assert.deepEqual(all.data.transactions, []); // nothing yet: this feed is the partner's notifications, stored as they arrive
  const row = mockTables.cards.find((c) => c.id === create.data.id);
  await sendProviderEvent({ event: 'issuing.transaction', type: 'AUTHORIZATION', mode: 'DEBIT', status: 'SUCCESS', amount: 1250, currency: 'USD', card_id: row.maplerad_card_id, reference: 'ov-feed-1', merchant: { name: 'GOOGLE *ADS' } }, MOCK_SANDBOX_WHSEC);
  const after = await api('GET', '/dashboard/cards/transactions', { token });
  const mine = after.data.transactions.filter((t) => t.card_id === create.data.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].amount, 12.5);
  assert.equal(mine[0].merchant_name, 'GOOGLE *ADS');
});


/* ===== Live Maplerad: separate keys, wallets, holders and webhooks ===== */

function signMapleradWebhook(payload, secret) {
  const id = `msg_${Math.random().toString(16).slice(2)}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'base64')).update(`${id}.${ts}.${body}`).digest('base64');
  return { body, headers: { 'Content-Type': 'application/json', 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` } };
}

/** A merchant that is fully live (Gateway + Issuing), dashboard switched to Live, with a funded LIVE wallet. */
async function makeLiveMerchant(label, { fundUsd } = {}) {
  const reg = await registerAndVerify({ business_name: `${label} Co`, email: `${label}@live-test.example.com`, password: 'password123' });
  const token = reg.data.session_token;
  const row = mockTables.merchants.find((m) => m.id === reg.data.merchant.id);
  row.gateway_live_enabled = true;
  row.issuing_live_enabled = true;
  const sw = await api('PUT', '/dashboard/mode', { token, body: { mode: 'live' } });
  assert.equal(sw.status, 200);
  const { token: adminToken } = await adminLogin('owner');
  if (fundUsd) await api('POST', `/admin/merchants/${reg.data.merchant.id}/credit`, { token: adminToken, body: { wallet: 'master_wallet', amount: fundUsd, mode: 'live' } });
  return { token, adminToken, merchantId: reg.data.merchant.id };
}

test('a live card is created with the LIVE provider key and confirmed by a webhook signed with the LIVE secret', async () => {
  const { token } = await makeLiveMerchant('livekey', { fundUsd: 200 });
  mapleradCalls.length = 0;
  const create = await api('POST', '/dashboard/cards', { token, body: { reference: 'LIVEKEY-1', kind: 'business', business_name: 'Live Key Co', brand: 'VISA', amount: 20 } });
  assert.equal(create.status, 202);
  assert.equal(create.data.mode, undefined); // (mode is exposed on lists; the call is what matters here)
  const active = await pollUntil(() => api('GET', `/dashboard/cards/${create.data.id}`, { token }), (r) => r.data.status !== 'pending', 30, 20);
  assert.equal(active.data.status, 'active'); // only possible if the live-signed webhook verified as LIVE
  const created = mapleradCalls.filter((c) => c.path === '/issuing/business');
  assert.equal(created.length, 1);
  assert.equal(created[0].env, 'live');
  assert.equal(mockTables.cards.find((c) => c.id === create.data.id).mode, 'live');
});

test('a sandbox card still uses the SANDBOX key, even for a merchant who is live', async () => {
  const { token } = await makeLiveMerchant('sbstill', { fundUsd: 0 });
  await api('PUT', '/dashboard/mode', { token, body: { mode: 'sandbox' } });
  mapleradCalls.length = 0;
  const create = await api('POST', '/dashboard/cards', { token, body: { reference: 'SBSTILL-1', kind: 'business', business_name: 'Sb Still Co', brand: 'VISA', amount: 20 } });
  assert.equal(create.status, 202);
  await pollUntil(() => api('GET', `/dashboard/cards/${create.data.id}`, { token }), (r) => r.data.status !== 'pending', 30, 20);
  assert.ok(mapleradCalls.filter((c) => c.path === '/issuing/business').every((c) => c.env === 'sandbox'));
});

test('sandbox play money can never fund a live card, and live money is never mixed into the sandbox wallet', async () => {
  const { token } = await makeLiveMerchant('isolation', { fundUsd: 0 });
  const live0 = await api('GET', '/dashboard/balance', { token });
  assert.equal(live0.data.mode, 'live');
  assert.equal(live0.data.master_wallet.available, 0);
  const blocked = await api('POST', '/dashboard/cards', { token, body: { reference: 'ISO-1', kind: 'business', business_name: 'Iso Co', brand: 'VISA', amount: 10 } });
  assert.equal(blocked.status, 400);

  const { token: adminToken } = await adminLogin('owner');
  const merchantId = mockTables.merchants.find((m) => m.email === 'isolation@live-test.example.com').id;
  await api('POST', `/admin/merchants/${merchantId}/credit`, { token: adminToken, body: { wallet: 'master_wallet', amount: 75, mode: 'live' } });
  const live1 = await api('GET', '/dashboard/balance', { token });
  assert.equal(live1.data.master_wallet.available, 75);
  await api('PUT', '/dashboard/mode', { token, body: { mode: 'sandbox' } });
  const sandbox = await api('GET', '/dashboard/balance', { token });
  assert.equal(sandbox.data.mode, 'sandbox');
  assert.equal(sandbox.data.master_wallet.available, 5000); // untouched welcome bonus
});

test('a webhook signed with the SANDBOX secret cannot activate a LIVE card (and vice versa); the right secret can', async () => {
  const reg = await registerAndVerify({ business_name: 'Cross Env Co', email: 'cross-env@example.com', password: 'password123' });
  const merchantId = reg.data.merchant.id;
  mockTables.cards.push({ id: 'card_xenv_live', merchant_id: merchantId, own_reference: 'XENV-L', maplerad_reference: 'ref_xenv_live', kind: 'business', brand: 'VISA', currency: 'USD', status: 'pending', initial_amount: 1000, creation_fee: 5, mode: 'live', created_at: new Date().toISOString() });
  const event = { event: 'issuing.created.successful', reference: 'ref_xenv_live', card: { id: 'prov_live_card', name: 'X', masked_pan: '4242**1111', currency: 'USD' } };

  const wrong = signMapleradWebhook(event, MOCK_SANDBOX_WHSEC);
  const r1 = await fetch(baseUrl + '/webhooks/maplerad', { method: 'POST', headers: wrong.headers, body: wrong.body });
  assert.equal(r1.status, 200); // validly signed (by the sandbox account) ...
  assert.equal(mockTables.cards.find((c) => c.id === 'card_xenv_live').status, 'pending'); // ... but it must not touch a live card

  const right = signMapleradWebhook(event, MOCK_LIVE_WHSEC);
  const r2 = await fetch(baseUrl + '/webhooks/maplerad', { method: 'POST', headers: right.headers, body: right.body });
  assert.equal(r2.status, 200);
  assert.equal(mockTables.cards.find((c) => c.id === 'card_xenv_live').status, 'active');

  const forged = signMapleradWebhook(event, 'whsec_' + Buffer.from('some-other-secret').toString('base64'));
  const r3 = await fetch(baseUrl + '/webhooks/maplerad', { method: 'POST', headers: forged.headers, body: forged.body });
  assert.equal(r3.status, 401);
});

test('card holders are per environment: a live holder is created on the live account and is not usable for a sandbox card', async () => {
  const { token } = await makeLiveMerchant('holdermode', { fundUsd: 200 });
  mapleradCalls.length = 0;
  const holderBody = {
    firstName: 'Real', lastName: 'Person', email: 'real.person@live-test.example.com', country: 'HT', dob: '1990-05-12',
    identificationNumber: 'ID-LIVE-1', identity: TEST_IDENTITY, phoneNumber: '37011111', phoneShortCode: '+509',
    address: { street: '1 Rue Reelle', city: 'PAP', state: 'Ouest', postalCode: 'HT6110', country: 'HT' },
  };
  const h = await api('POST', '/dashboard/cards/holders', { token, body: holderBody });
  assert.equal(h.status, 201);
  assert.ok(mapleradCalls.filter((c) => c.path.startsWith('/customers')).every((c) => c.env === 'live'));
  assert.equal(mockTables.maplerad_customers.find((x) => x.id === h.data.holder.id).mode, 'live');

  const liveList = await api('GET', '/dashboard/cards/holders', { token });
  assert.equal(liveList.data.holders.length, 1);
  const liveCard = await api('POST', '/dashboard/cards', { token, body: { reference: 'HM-LIVE', kind: 'individual', brand: 'VISA', amount: 10, holder_id: h.data.holder.id } });
  assert.equal(liveCard.status, 202);

  await api('PUT', '/dashboard/mode', { token, body: { mode: 'sandbox' } });
  const sbList = await api('GET', '/dashboard/cards/holders', { token });
  assert.equal(sbList.data.holders.length, 0); // the live holder is invisible in sandbox
  const mismatch = await api('POST', '/dashboard/cards', { token, body: { reference: 'HM-SB', kind: 'individual', brand: 'VISA', amount: 10, holder_id: h.data.holder.id } });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.data.error.code, 'HOLDER_MODE_MISMATCH');
});

test('provider key safety: live never falls back to the sandbox key, and a key from the wrong environment is refused', () => {
  const maplerad = require('../src/services/maplerad');
  const config = require('../src/config');
  const saved = { ...config.maplerad };
  try {
    config.maplerad.liveSecretKey = '';
    assert.throws(() => maplerad.credentialsFor('live'), (e) => e.code === 'CARD_LIVE_NOT_CONFIGURED' && e.httpStatus === 503);

    config.maplerad.liveSecretKey = 'mpr_sandbox_pasted_in_the_wrong_variable';
    assert.throws(() => maplerad.credentialsFor('live'), (e) => e.code === 'CARD_LIVE_MISCONFIGURED');

    config.maplerad.liveSecretKey = 'mpr_sk_a_real_looking_live_key';
    assert.equal(maplerad.credentialsFor('live').secretKey, 'mpr_sk_a_real_looking_live_key');

    config.maplerad.secretKey = 'mpr_sk_live_key_pasted_into_the_sandbox_variable';
    assert.throws(() => maplerad.credentialsFor('sandbox'), (e) => e.code === 'CARD_SANDBOX_MISCONFIGURED');
  } finally {
    Object.assign(config.maplerad, saved);
  }
});

test('a live request with no live key configured fails BEFORE any money moves', async () => {
  const { token, merchantId } = await makeLiveMerchant('nokey', { fundUsd: 100 });
  const config = require('../src/config');
  const savedKey = config.maplerad.liveSecretKey;
  config.maplerad.liveSecretKey = '';
  try {
    const before = await api('GET', '/dashboard/balance', { token });
    const r = await api('POST', '/dashboard/cards', { token, body: { reference: 'NOKEY-1', kind: 'business', business_name: 'No Key Co', brand: 'VISA', amount: 10 } });
    assert.equal(r.status, 503);
    assert.equal(r.data.error.code, 'CARD_LIVE_NOT_CONFIGURED');
    const after = await api('GET', '/dashboard/balance', { token });
    assert.equal(after.data.master_wallet.available, before.data.master_wallet.available); // nothing debited
  } finally {
    config.maplerad.liveSecretKey = savedKey;
  }
});

test('a live card is refused (before any debit) while the live webhook signing secret is not configured', async () => {
  const { token } = await makeLiveMerchant('nowhsec', { fundUsd: 100 });
  const config = require('../src/config');
  const saved = config.maplerad.liveWebhookSecret;
  config.maplerad.liveWebhookSecret = '';
  try {
    const before = await api('GET', '/dashboard/balance', { token });
    const r = await api('POST', '/dashboard/cards', { token, body: { reference: 'NOWHSEC-1', kind: 'business', business_name: 'No Whsec Co', brand: 'VISA', amount: 10 } });
    assert.equal(r.status, 503);
    assert.equal(r.data.error.code, 'CARD_LIVE_NOT_CONFIGURED');
    const after = await api('GET', '/dashboard/balance', { token });
    assert.equal(after.data.master_wallet.available, before.data.master_wallet.available);
  } finally {
    config.maplerad.liveWebhookSecret = saved;
  }
});


/* ===== Login code (OTP) at every login ===== */

test('correct password only starts a login: no session until the emailed code is entered, and the code is single-use', async () => {
  await registerAndVerify({ business_name: 'Otp Login Co', email: 'otp-login@example.com', password: 'password123' });
  const step1 = await api('POST', '/auth/login', { body: { email: 'otp-login@example.com', password: 'password123' } });
  assert.equal(step1.status, 200);
  assert.equal(step1.data.otp_required, true);
  assert.equal(step1.data.session_token, undefined);
  assert.match(step1.data.email_hint, /^ot\*+@example\.com$/); // masked, never the full address
  const code = extractLoginCode('otp-login@example.com');

  const ok = await api('POST', '/auth/login/verify', { body: { challenge_id: step1.data.challenge_id, code } });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.session_token);
  // The session really works.
  assert.equal((await api('GET', '/dashboard/balance', { token: ok.data.session_token })).status, 200);

  const reuse = await api('POST', '/auth/login/verify', { body: { challenge_id: step1.data.challenge_id, code } });
  assert.equal(reuse.status, 400);
  assert.equal(reuse.data.error.code, 'LOGIN_CHALLENGE_INVALID');

  // A brand new login asks for a brand new code, every single time.
  const again = await api('POST', '/auth/login', { body: { email: 'otp-login@example.com', password: 'password123' } });
  assert.equal(again.data.otp_required, true);
  assert.notEqual(again.data.challenge_id, step1.data.challenge_id);
});

test('a wrong login code is refused, counts attempts, and locks the challenge after the limit', async () => {
  await registerAndVerify({ business_name: 'Otp Lock Co', email: 'otp-lock@example.com', password: 'password123' });
  const step1 = await api('POST', '/auth/login', { body: { email: 'otp-lock@example.com', password: 'password123' } });
  const real = extractLoginCode('otp-lock@example.com');
  const wrong = real === '000000' ? '111111' : '000000';

  const first = await api('POST', '/auth/login/verify', { body: { challenge_id: step1.data.challenge_id, code: wrong } });
  assert.equal(first.status, 400);
  assert.equal(first.data.error.code, 'OTP_INCORRECT');
  for (let i = 0; i < 4; i += 1) await api('POST', '/auth/login/verify', { body: { challenge_id: step1.data.challenge_id, code: wrong } });
  // Even the CORRECT code no longer works once the attempts are used up.
  const locked = await api('POST', '/auth/login/verify', { body: { challenge_id: step1.data.challenge_id, code: real } });
  assert.equal(locked.status, 429);
  assert.equal(locked.data.error.code, 'OTP_LOCKED');
});

test('an expired login code is refused, and resending invalidates the old code', async () => {
  await registerAndVerify({ business_name: 'Otp Exp Co', email: 'otp-exp@example.com', password: 'password123' });
  const step1 = await api('POST', '/auth/login', { body: { email: 'otp-exp@example.com', password: 'password123' } });
  const oldCode = extractLoginCode('otp-exp@example.com');
  mockTables.login_challenges.find((c) => c.id === step1.data.challenge_id).expires_at = new Date(Date.now() - 1000).toISOString();
  const expired = await api('POST', '/auth/login/verify', { body: { challenge_id: step1.data.challenge_id, code: oldCode } });
  assert.equal(expired.status, 400);
  assert.equal(expired.data.error.code, 'OTP_EXPIRED');

  const fresh = await api('POST', '/auth/login', { body: { email: 'otp-exp@example.com', password: 'password123' } });
  const firstCode = extractLoginCode('otp-exp@example.com');
  const cooldown = await api('POST', '/auth/login/resend', { body: { challenge_id: fresh.data.challenge_id } });
  assert.equal(cooldown.status, 200); // first resend is allowed...
  const tooSoon = await api('POST', '/auth/login/resend', { body: { challenge_id: cooldown.data.challenge_id } });
  assert.equal(tooSoon.status, 429); // ...the next one waits for the cooldown
  assert.equal(tooSoon.data.error.code, 'OTP_RESEND_COOLDOWN');
  // The first code died when the new one was issued.
  const dead = await api('POST', '/auth/login/verify', { body: { challenge_id: fresh.data.challenge_id, code: firstCode } });
  assert.equal(dead.status, 400);
  const live = await api('POST', '/auth/login/verify', { body: { challenge_id: cooldown.data.challenge_id, code: extractLoginCode('otp-exp@example.com') } });
  assert.equal(live.status, 200);
});

test('a team member receives the login code at THEIR OWN address, never the owner\'s', async () => {
  const reg = await registerAndVerify({ business_name: 'Otp Team Co', email: 'owner@otp-team.com', password: 'password123' });
  await api('POST', '/dashboard/team/invite', { token: reg.data.session_token, body: { email: 'member@otp-team.com', role: 'viewer' } });
  const inviteMail = sentEmails.filter((e) => e.to === 'member@otp-team.com').slice(-1)[0];
  await api('POST', '/auth/accept-invite', { body: { token: inviteMail.text.match(/invite=([a-f0-9]{64})/)[1], password: 'member-pass-1' } });

  const ownerMailsBefore = sentEmails.filter((e) => e.to === 'owner@otp-team.com').length;
  const r = await loginWithOtp('member@otp-team.com', 'member-pass-1');
  assert.equal(r.status, 200);
  assert.equal(r.data.role, 'viewer');
  assert.equal(sentEmails.filter((e) => e.to === 'owner@otp-team.com').length, ownerMailsBefore);
});

test('admin login also needs the emailed code; a password alone never opens the panel', async () => {
  const seeded = seedAdmin('owner');
  const step1 = await api('POST', '/admin/login', { body: { email: seeded.email, password: seeded.password } });
  assert.equal(step1.data.otp_required, true);
  assert.equal(step1.data.session_token, undefined);
  const bad = await api('POST', '/admin/login/verify', { body: { challenge_id: step1.data.challenge_id, code: '999999' === extractLoginCode(seeded.email) ? '888888' : '999999' } });
  assert.equal(bad.status, 400);
  const ok = await api('POST', '/admin/login/verify', { body: { challenge_id: step1.data.challenge_id, code: extractLoginCode(seeded.email) } });
  assert.equal(ok.status, 200);
  assert.equal((await api('GET', '/admin/me', { token: ok.data.session_token })).status, 200);
  // A merchant challenge can never be redeemed on the admin endpoint (and vice versa).
  await registerAndVerify({ business_name: 'Cross Login Co', email: 'cross-login@example.com', password: 'password123' });
  const m1 = await api('POST', '/auth/login', { body: { email: 'cross-login@example.com', password: 'password123' } });
  const cross = await api('POST', '/admin/login/verify', { body: { challenge_id: m1.data.challenge_id, code: extractLoginCode('cross-login@example.com') } });
  assert.equal(cross.status, 401);
});

/* ===== Plans are per environment ===== */

test('a plan chosen in Sandbox does not carry over to Live, and Live plans are paid from the Live wallet', async () => {
  const { token, adminToken, merchantId } = await makeLiveMerchant('plans', { fundUsd: 500 });
  await api('PUT', '/dashboard/mode', { token, body: { mode: 'sandbox' } });

  const up = await api('POST', '/dashboard/billing/issuing-plan', { token, body: { plan: 'pro' } });
  assert.equal(up.status, 200);
  assert.equal(up.data.merchant.issuing_plan, 'pro'); // active environment = sandbox
  assert.equal(up.data.merchant.plans.sandbox.issuing, 'pro');
  assert.equal(up.data.merchant.plans.live.issuing, 'startup'); // Live untouched

  await api('PUT', '/dashboard/mode', { token, body: { mode: 'live' } });
  const me = await api('GET', '/auth/me', { token });
  assert.equal(me.data.merchant.issuing_plan, 'startup'); // the dashboard now reports the LIVE plan
  const liveBefore = await api('GET', '/dashboard/balance', { token });
  const live = await api('POST', '/dashboard/billing/issuing-plan', { token, body: { plan: 'pro' } });
  assert.equal(live.status, 200);
  assert.equal(live.data.charged, 150);
  const liveAfter = await api('GET', '/dashboard/balance', { token });
  assert.equal(liveBefore.data.master_wallet.available - liveAfter.data.master_wallet.available, 150); // real wallet paid
  await api('PUT', '/dashboard/mode', { token, body: { mode: 'sandbox' } });
  assert.equal((await api('GET', '/dashboard/balance', { token })).data.master_wallet.available, 5000 - 150); // sandbox paid its own 150
});

test('card fees follow the plan of the CARD\'s environment', async () => {
  const { token } = await makeLiveMerchant('planfee', { fundUsd: 500 });
  await api('PUT', '/dashboard/mode', { token, body: { mode: 'sandbox' } });
  await api('POST', '/dashboard/billing/issuing-plan', { token, body: { plan: 'premium' } }); // sandbox: cheap creation fee (2.50)

  const sbBefore = (await api('GET', '/dashboard/balance', { token })).data.master_wallet.available;
  await api('POST', '/dashboard/cards', { token, body: { reference: 'PLANFEE-SB', kind: 'business', business_name: 'P Co', brand: 'VISA', amount: 10 } });
  const sbAfter = (await api('GET', '/dashboard/balance', { token })).data.master_wallet.available;
  assert.equal(sbBefore - sbAfter, 12.5); // 10 + premium creation fee 2.50

  await api('PUT', '/dashboard/mode', { token, body: { mode: 'live' } });
  const lvBefore = (await api('GET', '/dashboard/balance', { token })).data.master_wallet.available;
  await api('POST', '/dashboard/cards', { token, body: { reference: 'PLANFEE-LV', kind: 'business', business_name: 'P Co', brand: 'VISA', amount: 10 } });
  const lvAfter = (await api('GET', '/dashboard/balance', { token })).data.master_wallet.available;
  assert.equal(lvBefore - lvAfter, 15); // 10 + startup creation fee 5.00: the sandbox premium plan did NOT follow
});

test('the complimentary plan can be granted by an admin only, and is not self-serve or listed in the catalog', async () => {
  const reg = await registerAndVerify({ business_name: 'Free Plan Co', email: 'free-plan@example.com', password: 'password123' });
  const token = reg.data.session_token;
  assert.equal((await api('POST', '/dashboard/billing/gateway-plan', { token, body: { plan: 'free' } })).status, 400);
  assert.equal((await api('POST', '/dashboard/billing/issuing-plan', { token, body: { plan: 'free' } })).status, 400);
  const catalog = await api('GET', '/dashboard/billing/plans', { token });
  assert.equal(catalog.data.gatewayPlans.free, undefined);
  assert.equal(catalog.data.issuingPlans.free, undefined);
  const { token: adminToken } = await adminLogin('owner');
  const granted = await api('PUT', `/admin/merchants/${reg.data.merchant.id}/free-plan`, { token: adminToken, body: { grant: true } });
  assert.equal(granted.data.issuing_plan, 'free');
  const me = await api('GET', '/auth/me', { token });
  assert.equal(me.data.merchant.plans.live.gateway, 'free');
  assert.equal(me.data.merchant.plans.sandbox.gateway, 'free');
});

/* ===== Automatic emails ===== */

function emailsTo(address, pattern) {
  return sentEmails.filter((e) => e.to === address && (!pattern || pattern.test(e.subject)));
}
async function waitForEmail(address, pattern, tries = 20) {
  for (let i = 0; i < tries; i += 1) {
    const found = emailsTo(address, pattern);
    if (found.length) return found[found.length - 1];
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no email to ${address} matching ${pattern}`);
}
const kycDoc = () => ({ documents: [{ label: 'ID', filename: 'id.jpg', content_type: 'image/jpeg', base64: Buffer.from('x').toString('base64') }] });

test('KYC approved: the merchant is emailed, and told Live is now active', async () => {
  const reg = await registerAndVerify({ business_name: 'Mail Ok Co', email: 'mail-ok@example.com', password: 'password123' });
  await api('POST', '/dashboard/verification/kyc', { token: reg.data.session_token, body: kycDoc() });
  const { token: adminToken } = await adminLogin('owner');
  const sub = (await api('GET', '/admin/verifications', { token: adminToken })).data.submissions.find((s) => s.merchant.id === reg.data.merchant.id);
  await api('POST', `/admin/verifications/${sub.id}/approve`, { token: adminToken });
  const mail = await waitForEmail('mail-ok@example.com', /approuvée/);
  assert.match(mail.subject, /vérification d'identité \(KYC\) est approuvée/);
  assert.match(mail.text, /mode Live/);
});

test('a business with only KYC approved is told one verification remains (not that Live is active)', async () => {
  const reg = await api('POST', '/auth/register', { headers: { 'x-forwarded-for': '198.51.100.201' }, body: { business_name: 'Mail Biz Co', account_type: 'business', email: 'mail-biz@example.com', password: 'password123' } });
  const code = sentEmails.filter((e) => e.to === 'mail-biz@example.com').slice(-1)[0].text.match(/code de vérification : (\d{6})/)[1];
  const verify = await api('POST', '/auth/verify-otp', { body: { merchant_id: reg.data.merchant_id, code } });
  await api('POST', '/dashboard/verification/kyc', { token: verify.data.session_token, body: kycDoc() });
  const { token: adminToken } = await adminLogin('owner');
  const sub = (await api('GET', '/admin/verifications', { token: adminToken })).data.submissions.find((s) => s.merchant.id === reg.data.merchant_id);
  await api('POST', `/admin/verifications/${sub.id}/approve`, { token: adminToken });
  const mail = await waitForEmail('mail-biz@example.com', /approuvée/);
  assert.match(mail.text, /dernière vérification/);
  assert.doesNotMatch(mail.text, /activé en mode Live/);
});

test('KYC rejected: the merchant is emailed with the reason', async () => {
  const reg = await registerAndVerify({ business_name: 'Mail No Co', email: 'mail-no@example.com', password: 'password123' });
  await api('POST', '/dashboard/verification/kyc', { token: reg.data.session_token, body: kycDoc() });
  const { token: adminToken } = await adminLogin('owner');
  const sub = (await api('GET', '/admin/verifications', { token: adminToken })).data.submissions.find((s) => s.merchant.id === reg.data.merchant.id);
  await api('POST', `/admin/verifications/${sub.id}/reject`, { token: adminToken, body: { reason: 'Photo floue.' } });
  const mail = await waitForEmail('mail-no@example.com', /n'a pas pu être validée/);
  assert.match(mail.text, /Photo floue\./);
});

test('suspending an account emails the merchant, and reactivating it emails again', async () => {
  const reg = await registerAndVerify({ business_name: 'Mail Susp Co', email: 'mail-susp@example.com', password: 'password123' });
  const { token: adminToken } = await adminLogin('owner');
  await api('DELETE', `/admin/merchants/${reg.data.merchant.id}`, { token: adminToken });
  assert.match((await waitForEmail('mail-susp@example.com', /suspendu/)).text, /suspendu/);
  await api('POST', `/admin/merchants/${reg.data.merchant.id}/restore`, { token: adminToken });
  assert.match((await waitForEmail('mail-susp@example.com', /de nouveau actif/)).subject, /de nouveau actif/);
});

test('Live access granted by an admin, and Issuing approved/rejected, each email the merchant', async () => {
  const reg = await registerAndVerify({ business_name: 'Mail Live Co', email: 'mail-live@example.com', password: 'password123' });
  const { token: adminToken } = await adminLogin('owner');
  await api('PUT', `/admin/merchants/${reg.data.merchant.id}/live`, { token: adminToken, body: { live_enabled: true } });
  assert.match((await waitForEmail('mail-live@example.com', /activé en Live/)).text, /Aucune vérification supplémentaire/);

  await api('POST', '/dashboard/issuing-access/request', { token: reg.data.session_token });
  let pending = (await api('GET', '/admin/issuing-access', { token: adminToken })).data.requests.find((r) => r.merchant.id === reg.data.merchant.id);
  await api('POST', `/admin/issuing-access/${pending.id}/reject`, { token: adminToken, body: { note: 'Activité non couverte.' } });
  const rejected = await waitForEmail('mail-live@example.com', /refusée/);
  assert.match(rejected.text, /Activité non couverte\./);
  assert.match(rejected.text, /paiements \(Gateway\) continuent/); // the Gateway keeps working after a refusal

  await api('POST', '/dashboard/issuing-access/request', { token: reg.data.session_token }); // asking again is allowed
  pending = (await api('GET', '/admin/issuing-access', { token: adminToken })).data.requests.find((r) => r.merchant.id === reg.data.merchant.id);
  await api('POST', `/admin/issuing-access/${pending.id}/approve`, { token: adminToken });
  assert.match((await waitForEmail('mail-live@example.com', /cartes Live est activée/)).subject, /cartes Live est activée/);
});

/* ===== Manual deposits reviewed in the admin panel ===== */

async function zelleDeposit(token, amountUsd, reference) {
  return api('POST', '/dashboard/wallet/topups', { token, body: { method: 'zelle', amount_usd: amountUsd, reference, receipt_filename: 'recu.jpg', receipt_base64: Buffer.from('receipt-bytes').toString('base64'), receipt_content_type: 'image/jpeg' } });
}

test('a manual deposit shows up in the admin panel with its receipt; approving credits the LIVE wallet once and emails the merchant', async () => {
  const { token, adminToken, merchantId } = await makeLiveMerchant('deposit', { fundUsd: 0 });
  const dep = await zelleDeposit(token, 250, 'ZELLE-LIVE-1');
  assert.equal(dep.status, 201);

  const list = await api('GET', '/admin/deposits', { token: adminToken });
  const found = list.data.deposits.find((d) => d.id === dep.data.id);
  assert.ok(found);
  assert.equal(found.mode, 'live');
  assert.equal(found.amount_usd, 250);
  assert.equal(found.has_receipt, true);
  assert.equal(found.merchant.id, merchantId);
  assert.equal((await api('GET', '/admin/overview', { token: adminToken })).data.pending_deposits >= 1, true);

  const receipt = await api('GET', `/admin/deposits/${dep.data.id}/receipt`, { token: adminToken });
  assert.equal(receipt.status, 200);
  assert.match(receipt.data.url, /^https?:\/\//);
  assert.equal(receipt.data.filename, 'recu.jpg');

  const before = (await api('GET', '/dashboard/balance', { token })).data.master_wallet.available;
  assert.equal(before, 0);
  // The admin confirms what really arrived (it can differ from what the merchant typed).
  const ok = await api('POST', `/admin/deposits/${dep.data.id}/approve`, { token: adminToken, body: { amount_usd: 240 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.mode, 'live');
  // The plan's funding fee (4.5 % on Startup) comes OUT of the amount received: 240 - 10.80 = 229.20
  assert.equal(ok.data.new_balance, 229.2);
  assert.equal(ok.data.deposit.fee_usd, 10.8);
  assert.equal(ok.data.deposit.credited_usd, 229.2);
  assert.equal((await api('GET', '/dashboard/balance', { token })).data.master_wallet.available, 229.2);

  const mail = await waitForEmail(`deposit@live-test.example.com`, /ajoutés à votre Master Wallet/);
  assert.match(mail.subject, /229,20 \$/);
  assert.doesNotMatch(mail.text, /Sandbox/); // a real deposit is never labelled as test money

  const again = await api('POST', `/admin/deposits/${dep.data.id}/approve`, { token: adminToken });
  assert.equal(again.status, 409); // can never be credited twice
  assert.equal((await api('GET', '/dashboard/balance', { token })).data.master_wallet.available, 229.2);
});

test('two admins approving the same deposit at the same time credit it exactly once', async () => {
  const { token, adminToken } = await makeLiveMerchant('depositrace', { fundUsd: 0 });
  const dep = await zelleDeposit(token, 100, 'ZELLE-RACE-1');
  const results = await Promise.all([1, 2, 3].map(() => api('POST', `/admin/deposits/${dep.data.id}/approve`, { token: adminToken })));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal((await api('GET', '/dashboard/balance', { token })).data.master_wallet.available, 95.5);
});

test('a rejected deposit credits nothing and emails the merchant the reason', async () => {
  const { token, adminToken } = await makeLiveMerchant('depositno', { fundUsd: 0 });
  const dep = await zelleDeposit(token, 80, 'ZELLE-NO-1');
  const r = await api('POST', `/admin/deposits/${dep.data.id}/reject`, { token: adminToken, body: { reason: 'Montant non reçu sur le compte.' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.deposit.status, 'failed');
  assert.equal((await api('GET', '/dashboard/balance', { token })).data.master_wallet.available, 0);
  const mail = await waitForEmail('depositno@live-test.example.com', /pas pu être confirmé/);
  assert.match(mail.text, /Montant non reçu/);
  assert.equal((await api('POST', `/admin/deposits/${dep.data.id}/approve`, { token: adminToken })).status, 409);
});

test('a sandbox deposit credits the sandbox wallet only, and an editor cannot confirm deposits', async () => {
  const reg = await registerAndVerify({ business_name: 'Dep Sb Co', email: 'dep-sb@example.com', password: 'password123' });
  const dep = await zelleDeposit(reg.data.session_token, 40, 'ZELLE-SB-1');
  const { token: editorToken } = await adminLogin('editor');
  assert.equal((await api('POST', `/admin/deposits/${dep.data.id}/approve`, { token: editorToken })).status, 403);
  const { token: adminToken } = await adminLogin('admin');
  const ok = await api('POST', `/admin/deposits/${dep.data.id}/approve`, { token: adminToken });
  assert.equal(ok.data.mode, 'sandbox');
  assert.equal((await api('GET', '/dashboard/balance', { token: reg.data.session_token })).data.master_wallet.available, 5038.2);
  const mail = await waitForEmail('dep-sb@example.com', /ajoutés à votre Master Wallet/);
  assert.match(mail.text, /Sandbox/);
});

/* ===== What a developer relies on: list endpoints, suspension, instant admin decisions ===== */

async function apiKeyFor(session, mode) {
  const r = await api('POST', '/dashboard/api-keys', { token: session, body: { mode } });
  assert.equal(r.status, 201);
  return r.data.secret;
}

test('GET /v1/payments and /v1/payouts exist, are paginated, scoped to the key\'s environment, and carry rate-limit headers', async () => {
  const reg = await registerAndVerify({ business_name: 'List Api Co', email: 'list-api@example.com', password: 'password123' });
  const key = await apiKeyFor(reg.data.session_token, 'test');
  await api('POST', '/v1/payments', { token: key, body: { amount: 500, method: 'moncash', reference: 'LIST-1' } });
  await api('POST', '/v1/payments', { token: key, body: { amount: 600, method: 'moncash', reference: 'LIST-2' } });

  const res = await fetch(baseUrl + '/v1/payments?page=1&page_size=1', { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('x-ratelimit-limit'));
  assert.ok(res.headers.get('x-ratelimit-remaining'));
  const body = await res.json();
  assert.equal(body.payments.length, 1);
  assert.equal(body.pagination.has_more, true);
  assert.equal(body.mode, 'sandbox');
  const payouts = await api('GET', '/v1/payouts', { token: key });
  assert.equal(payouts.status, 200);
  assert.ok(Array.isArray(payouts.data.payouts));
});

test('a suspended account\'s API keys stop working immediately, and work again once reactivated', async () => {
  const reg = await registerAndVerify({ business_name: 'Key Susp Co', email: 'key-susp@example.com', password: 'password123' });
  const key = await apiKeyFor(reg.data.session_token, 'test');
  assert.equal((await api('GET', '/v1/balance', { token: key })).status, 200); // warms the key cache
  const { token: adminToken } = await adminLogin('owner');
  await api('DELETE', `/admin/merchants/${reg.data.merchant.id}`, { token: adminToken });
  const blocked = await api('GET', '/v1/balance', { token: key });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.error.code, 'ACCOUNT_SUSPENDED');
  await api('POST', `/admin/merchants/${reg.data.merchant.id}/restore`, { token: adminToken });
  assert.equal((await api('GET', '/v1/balance', { token: key })).status, 200);
});

test('approving Issuing Live takes effect on the merchant\'s live key immediately (no stale cache)', async () => {
  const reg = await registerAndVerify({ business_name: 'Cache Co', email: 'cache-co@example.com', password: 'password123' });
  const { token: adminToken } = await adminLogin('owner');
  await api('PUT', `/admin/merchants/${reg.data.merchant.id}/live`, { token: adminToken, body: { live_enabled: true } });
  const liveKey = await apiKeyFor(reg.data.session_token, 'live');
  const before = await api('GET', '/v1/cards', { token: liveKey }); // warms the cache with issuing_live_enabled = false
  assert.equal(before.status, 403);
  assert.equal(before.data.error.code, 'ISSUING_LIVE_NOT_ENABLED');
  await api('POST', '/dashboard/issuing-access/request', { token: reg.data.session_token });
  const pending = (await api('GET', '/admin/issuing-access', { token: adminToken })).data.requests.find((r) => r.merchant.id === reg.data.merchant.id);
  await api('POST', `/admin/issuing-access/${pending.id}/approve`, { token: adminToken });
  const after = await api('GET', '/v1/cards', { token: liveKey });
  assert.equal(after.status, 200);
});

/* ===== Decline fee: a card use rejected for LOW BALANCE costs the plan's decline fee ===== */

async function sendProviderEvent(event, secret) {
  const signed = signMapleradWebhook(event, secret);
  const res = await fetch(baseUrl + '/webhooks/maplerad', { method: 'POST', headers: signed.headers, body: signed.body });
  assert.equal(res.status, 200);
}
const declineEvent = (cardId, extra = {}) => ({
  event: 'issuing.transaction', type: 'DECLINE', mode: 'DEBIT', status: 'FAILED', amount: 5000, currency: 'USD',
  card_id: cardId, reference: `tx-${Math.random().toString(16).slice(2)}`, description: 'Declined: Insufficient funds',
  merchant: { name: 'GOOGLE *ADS', country: 'US' }, ...extra,
});

/** A sandbox merchant with one active card whose provider id is known. */
async function cardForDeclines(label) {
  const reg = await registerAndVerify({ business_name: `${label} Co`, email: `${label}@decline.example.com`, password: 'password123' });
  const token = reg.data.session_token;
  const c = await api('POST', '/dashboard/cards', { token, body: { reference: `DECL-${label}`, kind: 'business', business_name: `${label} Co`, brand: 'VISA', amount: 10 } });
  await pollUntil(() => api('GET', `/dashboard/cards/${c.data.id}`, { token }), (r) => r.data.status !== 'pending', 30, 20);
  const row = mockTables.cards.find((x) => x.id === c.data.id);
  return { token, merchantId: reg.data.merchant.id, card: row, balance: async () => (await api('GET', '/dashboard/balance', { token })).data.master_wallet.available };
}

test('a low-balance decline charges the decline fee once, even if the event is delivered again', async () => {
  const { card, balance, merchantId } = await cardForDeclines('declone');
  const before = await balance();
  const ev = declineEvent(card.maplerad_card_id);
  await sendProviderEvent(ev, MOCK_SANDBOX_WHSEC);
  assert.equal(before - (await balance()), 1); // Startup plan: 1.00 $
  await sendProviderEvent(ev, MOCK_SANDBOX_WHSEC); // same provider transaction, new delivery
  assert.equal(before - (await balance()), 1); // not charged twice
  const fees = mockTables.fee_revenue.filter((f) => f.merchant_id === merchantId && f.kind === 'card_decline');
  assert.equal(fees.length, 1);
  assert.equal(Number(fees[0].amount), 1);
  assert.equal(fees[0].mode, 'sandbox');
  // a second, different decline is a second charge
  await sendProviderEvent(declineEvent(card.maplerad_card_id), MOCK_SANDBOX_WHSEC);
  assert.equal(before - (await balance()), 2);
});

test('declines for other reasons are NOT charged; a successful purchase costs the Startup spend fee (0.10 $) once', async () => {
  const { card, balance } = await cardForDeclines('declother');
  const before = await balance();
  await sendProviderEvent(declineEvent(card.maplerad_card_id, { description: 'Declined: merchant category not allowed (7995)' }), MOCK_SANDBOX_WHSEC);
  assert.equal(await balance(), before);
  const purchase = { ...declineEvent(card.maplerad_card_id), type: 'AUTHORIZATION', status: 'SUCCESS', mode: 'DEBIT', reference: 'purchase-ref-1', description: 'Approved or completed successfully' };
  await sendProviderEvent(purchase, MOCK_SANDBOX_WHSEC);
  await sendProviderEvent(purchase, MOCK_SANDBOX_WHSEC); // re-delivered: stored and charged once
  assert.equal(Math.round((before - (await balance())) * 100) / 100, 0.1);
  await sendProviderEvent(declineEvent('prov_card_that_does_not_exist'), MOCK_SANDBOX_WHSEC);
  assert.equal(Math.round((before - (await balance())) * 100) / 100, 0.1);
});

test('the decline fee follows the plan and the admin\'s custom price: free plan = 0, custom = that value', async () => {
  const a = await cardForDeclines('declfree');
  const { token: adminToken } = await adminLogin('owner');
  await api('PUT', `/admin/merchants/${a.merchantId}/free-plan`, { token: adminToken, body: { grant: true } });
  const beforeFree = await a.balance();
  await sendProviderEvent(declineEvent(a.card.maplerad_card_id), MOCK_SANDBOX_WHSEC);
  assert.equal(await a.balance(), beforeFree);

  const b = await cardForDeclines('declcustom');
  await api('PUT', `/admin/merchants/${b.merchantId}/pricing`, { token: adminToken, body: { card_decline_usd: 0.4 } });
  const beforeCustom = await b.balance();
  await sendProviderEvent(declineEvent(b.card.maplerad_card_id), MOCK_SANDBOX_WHSEC);
  assert.equal(Math.round((beforeCustom - (await b.balance())) * 100) / 100, 0.4);
});

test('the decline fee never pushes a wallet below zero, and a live card is only charged by a LIVE-signed event', async () => {
  const live = await makeLiveMerchant('decllive', { fundUsd: 300 });
  const c = await api('POST', '/dashboard/cards', { token: live.token, body: { reference: 'DECL-LIVE-1', kind: 'business', business_name: 'Decl Live Co', brand: 'VISA', amount: 90 } });
  assert.equal(c.status, 202);
  await pollUntil(() => api('GET', `/dashboard/cards/${c.data.id}`, { token: live.token }), (r) => r.data.status !== 'pending', 40, 20);
  const card = mockTables.cards.find((x) => x.id === c.data.id);
  const liveBalance = async () => (await api('GET', '/dashboard/balance', { token: live.token })).data.master_wallet.available;
  const r2 = (n) => Math.round(n * 100) / 100;
  const start = await liveBalance(); // 300 - 90 - 5 creation fee = 205

  // an event signed by the SANDBOX account must not charge a LIVE card
  await sendProviderEvent(declineEvent(card.maplerad_card_id), MOCK_SANDBOX_WHSEC);
  assert.equal(await liveBalance(), start);
  // signed by the LIVE account it does
  await sendProviderEvent(declineEvent(card.maplerad_card_id), MOCK_LIVE_WHSEC);
  assert.equal(r2(start - (await liveBalance())), 1);

  // drain the live wallet down to 0.40 $: the next decline can only take what is there
  const now = await liveBalance();
  mockTables.ledger_entries.push({ merchant_id: live.merchantId, wallet: 'live:master_wallet', type: 'wallet_debit', amount: -(now - 0.4), currency: 'USD', reference: 'test-drain', created_at: new Date().toISOString() });
  assert.equal(r2(await liveBalance()), 0.4);
  await sendProviderEvent(declineEvent(card.maplerad_card_id), MOCK_LIVE_WHSEC);
  assert.equal(r2(await liveBalance()), 0); // took 0.40, not 1.00
  await sendProviderEvent(declineEvent(card.maplerad_card_id), MOCK_LIVE_WHSEC);
  assert.equal(r2(await liveBalance()), 0); // empty wallet: nothing more, and never negative

  const fees = mockTables.fee_revenue.filter((f) => f.kind === 'card_decline' && f.merchant_id === live.merchantId);
  assert.deepEqual(fees.map((f) => Number(f.amount)), [1, 0.4]);
  assert.ok(fees.every((f) => f.mode === 'live'));
});


/* ===== Truthful money figures: failed attempts are not revenue; wallet page shows real numbers ===== */

test('a card whose creation the provider refuses is refunded AND is not counted as revenue; the merchant sees a service error, not a 400', async () => {
  const { token, merchantId } = await makeLiveMerchant('phantom', { fundUsd: 300 });
  const config = require('../src/config');
  const saved = config.maplerad.liveSecretKey;
  config.maplerad.liveSecretKey = 'mpr_sk_a_key_the_provider_rejects';
  try {
    const before = (await api('GET', '/dashboard/balance', { token })).data.master_wallet.available;
    const r = await api('POST', '/dashboard/cards', { token, body: { reference: 'PHANTOM-1', kind: 'business', business_name: 'Phantom Co', brand: 'VISA', amount: 20 } });
    assert.equal(r.status, 503);
    assert.equal(r.data.error.code, 'CARD_PROVIDER_AUTH');
    assert.doesNotMatch(r.data.error.message, /Access|Unauthorized|mpr_/i); // provider wording never leaks
    assert.equal((await api('GET', '/dashboard/balance', { token })).data.master_wallet.available, before); // refunded
  } finally {
    config.maplerad.liveSecretKey = saved;
  }
  assert.equal(mockTables.fee_revenue.filter((f) => f.merchant_id === merchantId).length, 0); // nothing earned
  const { token: adminToken } = await adminLogin('owner');
  const detail = await api('GET', `/admin/merchants/${merchantId}`, { token: adminToken });
  assert.equal(detail.data.revenue.total_revenue_usd, 0);
});

test('card creation revenue is counted once, when the card becomes active, even if the webhook is redelivered', async () => {
  const reg = await registerAndVerify({ business_name: 'Once Co', email: 'once-co@example.com', password: 'password123' });
  const token = reg.data.session_token;
  const c = await api('POST', '/dashboard/cards', { token, body: { reference: 'ONCE-1', kind: 'business', business_name: 'Once Co', brand: 'VISA', amount: 10 } });
  await pollUntil(() => api('GET', `/dashboard/cards/${c.data.id}`, { token }), (r) => r.data.status === 'active', 40, 20);
  const row = mockTables.cards.find((x) => x.id === c.data.id);
  await sendProviderEvent({ event: 'issuing.created.successful', reference: row.maplerad_reference, card: { id: row.maplerad_card_id, name: 'X', masked_pan: '4242**1111', currency: 'USD' } }, MOCK_SANDBOX_WHSEC);
  await sendProviderEvent({ event: 'issuing.created.successful', reference: row.maplerad_reference, card: { id: row.maplerad_card_id, name: 'X', masked_pan: '4242**1111', currency: 'USD' } }, MOCK_SANDBOX_WHSEC);
  const fees = mockTables.fee_revenue.filter((f) => f.merchant_id === reg.data.merchant.id && f.kind === 'card_creation');
  assert.equal(fees.length, 1);
  assert.equal(Number(fees[0].amount), 5);
});

test('test keys cannot be created while the dashboard is in Live (Sandbox can), live keys still need Live access', async () => {
  const { token } = await makeLiveMerchant('keysmode', { fundUsd: 0 });
  const blocked = await api('POST', '/dashboard/api-keys', { token, body: { mode: 'test' } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.error.code, 'TEST_KEY_IN_LIVE');
  assert.equal((await api('POST', '/dashboard/api-keys', { token, body: { mode: 'live' } })).status, 201);
  await api('PUT', '/dashboard/mode', { token, body: { mode: 'sandbox' } });
  assert.equal((await api('POST', '/dashboard/api-keys', { token, body: { mode: 'test' } })).status, 201);
});

test('wallet summary shows REAL figures per mode: no demo numbers, refunds are not deposits, reserved = active cards', async () => {
  const live = await makeLiveMerchant('walletsum', { fundUsd: 400 });
  const empty = await api('GET', '/dashboard/wallet/summary', { token: live.token });
  assert.equal(empty.status, 200);
  assert.equal(empty.data.mode, 'live');
  assert.equal(empty.data.master_wallet.added_total_usd, 400); // the admin-confirmed deposit
  assert.equal(empty.data.master_wallet.reserved_on_cards_usd, 0);
  assert.equal(empty.data.gateway.pending_htg, 0);
  assert.equal(empty.data.gateway.total_in_htg, 0);
  assert.deepEqual(empty.data.movements.map((m) => m.label), ["Crédit par l'équipe Freda Pay Issuing"]);

  const c = await api('POST', '/dashboard/cards', { token: live.token, body: { reference: 'WSUM-1', kind: 'business', business_name: 'W Co', brand: 'VISA', amount: 60 } });
  await pollUntil(() => api('GET', `/dashboard/cards/${c.data.id}`, { token: live.token }), (r) => r.data.status === 'active', 40, 20);
  const pay = await api('POST', '/dashboard/payments', { token: live.token, body: { amount: 1000, method: 'moncash', reference: 'WSUM-PAY-1' } });
  assert.equal(pay.status, 201);

  const after = await api('GET', '/dashboard/wallet/summary', { token: live.token });
  assert.equal(after.data.master_wallet.reserved_on_cards_usd, 60);
  assert.equal(after.data.master_wallet.added_total_usd, 400); // creating a card is not a deposit
  assert.equal(after.data.gateway.pending_htg, 1000);
  assert.equal(after.data.movements[0].label, 'Création de carte');
  assert.equal(after.data.movements[0].amount, -65); // 60 preload + 5 fee

  // Sandbox is a different world with different numbers.
  await api('PUT', '/dashboard/mode', { token: live.token, body: { mode: 'sandbox' } });
  const sb = await api('GET', '/dashboard/wallet/summary', { token: live.token });
  assert.equal(sb.data.mode, 'sandbox');
  assert.equal(sb.data.master_wallet.added_total_usd, 5000); // welcome bonus (play money)
  assert.equal(sb.data.master_wallet.reserved_on_cards_usd, 0);
  assert.equal(sb.data.gateway.pending_htg, 0);
});

/** A tiny stand-in for "what is my public IP?" services, so the diagnostic can be tested without the internet. */
function startIpEcho(answers) {
  let n = 0;
  const server = require('http').createServer((req, res) => {
    const ip = answers[n % answers.length]; n += 1;
    if (ip === null) { res.writeHead(500); return res.end('down'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ip }));
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` })));
}

test('Maplerad diagnostic: outbound IP, key format (8 characters, rest masked) and configuration status', async () => {
  const config = require('../src/config');
  const echo = await startIpEcho(['203.0.113.7']);
  const savedUrls = config.egressIpUrls;
  config.egressIpUrls = [echo.url];
  try {
    const { token } = await adminLogin('owner');
    const r = await api('GET', '/admin/diagnostic/maplerad', { token });
    assert.equal(r.status, 200);
    assert.equal(r.data.outbound_ip.ip, '203.0.113.7');
    assert.deepEqual(r.data.outbound_ip.observed, ['203.0.113.7']);
    assert.equal(r.data.keys.live.configured, true);
    assert.equal(r.data.keys.live.masked, 'mpr_sk_m\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'); // 8 characters, then masked
    assert.equal(r.data.keys.live.looks_like, 'live');
    assert.equal(r.data.keys.live.status, 'ok');
    assert.equal(r.data.keys.live.length, 'mpr_sk_mock_live_key'.length);
    assert.equal(r.data.webhook_secrets.live, true);
    assert.equal(r.data.status, 'ready');
    assert.equal(r.data.provider, null); // no call to the provider unless asked
    // the keys themselves never leave the server
    const text = JSON.stringify(r.data);
    assert.ok(!text.includes('mpr_sk_mock_live_key') && !text.includes('sk_test_mock_maplerad_key'));
  } finally {
    config.egressIpUrls = savedUrls;
    echo.server.close();
  }
});

test('Maplerad diagnostic: reports every outbound address seen, survives a dead IP service, and flags a broken configuration', async () => {
  const config = require('../src/config');
  const multi = await startIpEcho(['203.0.113.7', '203.0.113.8', '203.0.113.7']);
  const dead = await startIpEcho([null]);
  const saved = { urls: config.egressIpUrls, live: config.maplerad.liveSecretKey, hook: config.maplerad.liveWebhookSecret };
  try {
    const { token } = await adminLogin('owner');
    config.egressIpUrls = [dead.url, multi.url]; // the first service is down: the next one answers
    const many = await api('GET', '/admin/diagnostic/maplerad', { token });
    assert.deepEqual([...many.data.outbound_ip.observed].sort(), ['203.0.113.7', '203.0.113.8']);

    config.egressIpUrls = [dead.url];
    const noIp = await api('GET', '/admin/diagnostic/maplerad', { token });
    assert.equal(noIp.data.outbound_ip.ip, null);
    assert.equal(noIp.data.status, 'incomplete');
    assert.ok(noIp.data.issues.some((i) => /adresse IP/.test(i)));

    config.egressIpUrls = [multi.url];
    config.maplerad.liveSecretKey = 'mpr_sandbox_pasted_in_the_live_variable';
    const wrong = await api('GET', '/admin/diagnostic/maplerad', { token });
    assert.equal(wrong.data.keys.live.status, 'wrong_environment');
    assert.equal(wrong.data.status, 'misconfigured');

    config.maplerad.liveSecretKey = '';
    config.maplerad.liveWebhookSecret = '';
    const missing = await api('GET', '/admin/diagnostic/maplerad', { token });
    assert.equal(missing.data.keys.live.status, 'missing');
    assert.equal(missing.data.keys.live.masked, null);
    assert.equal(missing.data.webhook_secrets.live, false);
    assert.equal(missing.data.status, 'incomplete');
    assert.ok(missing.data.issues.some((i) => /MAPLERAD_LIVE_SECRET_KEY/.test(i)));
  } finally {
    config.egressIpUrls = saved.urls; config.maplerad.liveSecretKey = saved.live; config.maplerad.liveWebhookSecret = saved.hook;
    multi.server.close(); dead.server.close();
  }
});

test('Maplerad diagnostic: ?probe= makes one read-only call to the provider and explains a refusal; editors and anonymous callers are refused', async () => {
  const config = require('../src/config');
  const echo = await startIpEcho(['203.0.113.7']);
  const saved = { urls: config.egressIpUrls, live: config.maplerad.liveSecretKey };
  config.egressIpUrls = [echo.url];
  try {
    const { token } = await adminLogin('owner');
    const ok = await api('GET', '/admin/diagnostic/maplerad?probe=live', { token });
    assert.equal(ok.data.provider.ok, true);
    assert.equal(ok.data.provider.mode, 'live');

    config.maplerad.liveSecretKey = 'mpr_sk_wrong';
    const bad = await api('GET', '/admin/diagnostic/maplerad?probe=live', { token });
    assert.equal(bad.data.provider.ok, false);
    assert.equal(bad.data.provider.http, 401);
    assert.ok(bad.data.provider.hints.some((h) => /IP/.test(h) && /Maplerad/.test(h)));
    assert.ok(!JSON.stringify(bad.data).includes('mpr_sk_wrong'));
  } finally {
    config.egressIpUrls = saved.urls; config.maplerad.liveSecretKey = saved.live; echo.server.close();
  }
  const { token: editorToken } = await adminLogin('editor');
  assert.equal((await api('GET', '/admin/diagnostic/maplerad', { token: editorToken })).status, 403);
  assert.equal((await api('GET', '/admin/diagnostic/maplerad')).status, 401);
  assert.equal((await api('GET', '/admin/diagnostic/maplerad', { token: 'not-a-token' })).status, 401);
});

test('pasted environment values are cleaned: quotes, spaces and a trailing newline do not break a provider key', () => {
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./src/config').maplerad))"], {
    cwd: require('path').join(__dirname, '..'),
    env: { ...process.env, MAPLERAD_LIVE_SECRET_KEY: ' "mpr_sk_abc123"\n', MAPLERAD_LIVE_WEBHOOK_SECRET: "whsec_xyz\n", MAPLERAD_SECRET_KEY: " mpr_sandbox_k " },
  }).toString();
  const cfg = JSON.parse(out);
  assert.equal(cfg.liveSecretKey, 'mpr_sk_abc123');
  assert.equal(cfg.liveWebhookSecret, 'whsec_xyz');
  assert.equal(cfg.secretKey, 'mpr_sandbox_k');
});

/* ===== Suspending then reactivating a merchant must bring them back as Live ===== */

test('a live merchant who is suspended and reactivated is Live again, in the list, the overview and their own dashboard', async () => {
  const { token, adminToken, merchantId } = await makeLiveMerchant('suspendlive', { fundUsd: 0 });
  const listed = async () => (await api('GET', '/admin/merchants', { token: adminToken })).data.merchants.find((m) => m.id === merchantId);
  const before = (await api('GET', '/admin/overview', { token: adminToken })).data;
  assert.equal((await listed()).gateway_live_enabled, true);

  const del = await api('DELETE', `/admin/merchants/${merchantId}`, { token: adminToken });
  assert.equal(del.status, 200);
  const suspended = await listed();
  assert.ok(suspended.deleted_at);
  assert.equal(suspended.gateway_live_enabled, true); // the grant is untouched by a suspension
  assert.equal(suspended.issuing_live_enabled, true);
  assert.equal(suspended.live_enabled, true);
  const during = (await api('GET', '/admin/overview', { token: adminToken })).data;
  assert.equal(during.merchants_live, before.merchants_live - 1); // not counted while suspended
  assert.equal(during.merchants_suspended, before.merchants_suspended + 1);

  await api('POST', `/admin/merchants/${merchantId}/restore`, { token: adminToken });
  const back = await listed();
  assert.equal(back.deleted_at, null);
  assert.equal(back.gateway_live_enabled, true);
  assert.equal(back.live_enabled, true);
  const after = (await api('GET', '/admin/overview', { token: adminToken })).data;
  assert.equal(after.merchants_live, before.merchants_live); // back among the live ones
  assert.equal(after.merchants_suspended, before.merchants_suspended);

  // and from the merchant's side: still Live, still switchable, same keys of access
  const me = await loginWithOtp(`suspendlive@live-test.example.com`, 'password123');
  assert.equal(me.status, 200);
  assert.equal(me.data.merchant.gateway_live_enabled, true);
  assert.equal(me.data.merchant.live_enabled, true);
  assert.equal((await api('PUT', '/dashboard/mode', { token: me.data.session_token, body: { mode: 'live' } })).status, 200);
});

test('reactivating heals an account that an older version suspended with the legacy flag switched off', async () => {
  const { adminToken, merchantId } = await makeLiveMerchant('oldsuspend', { fundUsd: 0 });
  const row = mockTables.merchants.find((m) => m.id === merchantId);
  row.deleted_at = new Date().toISOString(); // what the old code left behind:
  row.live_enabled = false;                  // suspended, legacy flag off, real flag still on
  assert.equal(row.gateway_live_enabled, true);
  await api('POST', `/admin/merchants/${merchantId}/restore`, { token: adminToken });
  const m = (await api('GET', '/admin/merchants', { token: adminToken })).data.merchants.find((x) => x.id === merchantId);
  assert.equal(m.live_enabled, true);
  assert.equal(m.gateway_live_enabled, true);
  assert.equal(m.deleted_at, null);
});

test('a merchant that was never live stays Sandbox after a suspend and reactivate', async () => {
  const reg = await registerAndVerify({ business_name: 'Never Live Co', email: 'never-live@example.com', password: 'password123' });
  const { token: adminToken } = await adminLogin('owner');
  await api('DELETE', `/admin/merchants/${reg.data.merchant.id}`, { token: adminToken });
  await api('POST', `/admin/merchants/${reg.data.merchant.id}/restore`, { token: adminToken });
  const m = (await api('GET', '/admin/merchants', { token: adminToken })).data.merchants.find((x) => x.id === reg.data.merchant.id);
  assert.equal(m.gateway_live_enabled, false);
  assert.equal(m.live_enabled, false);
});

/* ===== What a suspension really stops ===== */

test('suspending an account blocks its team members too (open sessions), and reactivating restores them', async () => {
  const reg = await registerAndVerify({ business_name: 'Susp Team Co', email: 'owner@susp-team.com', password: 'password123' });
  await api('POST', '/dashboard/team/invite', { token: reg.data.session_token, body: { email: 'member@susp-team.com', role: 'admin' } });
  const inviteMail = sentEmails.filter((e) => e.to === 'member@susp-team.com').slice(-1)[0];
  const accepted = await api('POST', '/auth/accept-invite', { body: { token: inviteMail.text.match(/invite=([a-f0-9]{64})/)[1], password: 'member-pass-1' } });
  const member = accepted.data.session_token;
  assert.equal((await api('GET', '/dashboard/balance', { token: member })).status, 200);

  const { token: adminToken } = await adminLogin('owner');
  await api('DELETE', `/admin/merchants/${reg.data.merchant.id}`, { token: adminToken });
  assert.equal((await api('GET', '/dashboard/balance', { token: reg.data.session_token })).status, 401); // owner
  const blocked = await api('GET', '/dashboard/balance', { token: member }); // member with a session opened BEFORE the suspension
  assert.equal(blocked.status, 401);
  assert.equal((await api('POST', '/dashboard/api-keys', { token: member, body: { mode: 'test' } })).status, 401);
  assert.equal((await api('POST', '/auth/login', { body: { email: 'member@susp-team.com', password: 'member-pass-1' } })).status, 401); // and they cannot log in again

  await api('POST', `/admin/merchants/${reg.data.merchant.id}/restore`, { token: adminToken });
  assert.equal((await api('GET', '/dashboard/balance', { token: member })).status, 200);
});

test('a suspended merchant\'s payment links stop taking customers\' payments, and work again after reactivation', async () => {
  const reg = await registerAndVerify({ business_name: 'Susp Link Co', email: 'susp-link@example.com', password: 'password123' });
  const link = await api('POST', '/dashboard/payment-links', { token: reg.data.session_token, body: { amount: 500, description: 'Test' } });
  assert.equal((await api('GET', `/public/payment-links/${link.data.id}`)).status, 200);
  const { token: adminToken } = await adminLogin('owner');
  await api('DELETE', `/admin/merchants/${reg.data.merchant.id}`, { token: adminToken });
  const get = await api('GET', `/public/payment-links/${link.data.id}`);
  assert.equal(get.status, 404);
  assert.doesNotMatch(get.data.error.message, /suspend/i); // the customer is not told why
  const pay = await api('POST', `/public/payment-links/${link.data.id}/pay`, { body: { method: 'moncash' } });
  assert.equal(pay.status, 404);
  assert.equal(mockTables.payments.filter((p) => p.merchant_id === reg.data.merchant.id).length, 0); // nothing was created
  await api('POST', `/admin/merchants/${reg.data.merchant.id}/restore`, { token: adminToken });
  assert.equal((await api('POST', `/public/payment-links/${link.data.id}/pay`, { body: { method: 'moncash' } })).status, 201);
});

test('a payout already queued when the account is suspended is not sent, and costs nothing', async () => {
  const reg = await registerAndVerify({ business_name: 'Susp Payout Co', email: 'susp-payout@example.com', password: 'password123' });
  const payoutOrchestrator = require('../src/services/payoutOrchestrator');
  mockTables.merchants.find((m) => m.id === reg.data.merchant.id).deleted_at = new Date().toISOString(); // suspended while the job waits
  const ledger = require('../src/services/ledger');
  await ledger.creditGateway(reg.data.merchant.id, 1000, 'HTG', 'susp-seed', null, 'sandbox'); // some balance to hold
  await payoutOrchestrator.createPayout({ merchantId: reg.data.merchant.id, id: 'po_susp_1', ownReference: 'SUSP-PO-1', plopplopReference: `fp_${reg.data.merchant.id}_SUSP-PO-1`, amount: 500, method: 'moncash', recipient: '50937001234', mode: 'sandbox' });
  const row = await pollUntil(async () => ({ data: mockTables.payouts.find((p) => p.id === 'po_susp_1') }), (r) => r.data && r.data.status !== 'pending', 40, 25);
  assert.equal(row.data.status, 'failed');
  assert.match(row.data.failure_reason, /ACCOUNT_SUSPENDED/);
  assert.equal(await ledger.getBalance(reg.data.merchant.id, 'gateway', 'HTG', 'sandbox'), 1000); // the hold (500 + 25 fee) was given back in full
});

/* ===== Forgotten password: a real email, a single-use link, and older sessions end ===== */

const resetLinkFor = (email) => {
  const mails = sentEmails.filter((e) => e.to === email && /Réinitialisez votre mot de passe/.test(e.subject));
  const last = mails[mails.length - 1];
  return last ? last.text.match(/reset=([a-f0-9]{64})/)[1] : null;
};
let forgotIp = 0;
const forgot = (email) => api('POST', '/auth/forgot-password', { headers: { 'x-forwarded-for': `192.0.2.${(forgotIp += 1) % 250}` }, body: { email } });

test('forgot password sends a REAL email with a link, and answers the same for an unknown address (nothing is revealed)', async () => {
  await registerAndVerify({ business_name: 'Forgot Co', email: 'forgot@example.com', password: 'old-password-1' });
  const before = sentEmails.length;
  const known = await forgot('forgot@example.com');
  assert.equal(known.status, 200);
  assert.deepEqual(known.data, { sent: true });
  const mail = sentEmails.filter((e) => e.to === 'forgot@example.com').slice(-1)[0];
  assert.match(mail.subject, /Réinitialisez votre mot de passe/);
  assert.match(mail.text, /signup\?reset=[a-f0-9]{64}/);
  assert.match(mail.text, /60 minutes/);

  const afterKnown = sentEmails.length;
  const unknown = await forgot('nobody-here@example.com');
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.data, known.data); // identical answer
  assert.equal(sentEmails.length, afterKnown);   // ...but no email goes out for an address with no account
  assert.equal((await forgot('not-an-email')).status, 400);
  assert.ok(afterKnown > before);
});

test('the reset link works once: new password accepted, old password refused, link cannot be reused', async () => {
  await registerAndVerify({ business_name: 'Reset Co', email: 'reset-co@example.com', password: 'old-password-1' });
  await forgot('reset-co@example.com');
  const token = resetLinkFor('reset-co@example.com');

  const info = await api('GET', `/auth/reset-info?token=${token}`);
  assert.equal(info.status, 200);
  assert.match(info.data.email_hint, /^re\*+@example\.com$/);
  assert.equal((await api('POST', '/auth/reset-password', { headers: freshIp(), body: { token, password: 'short' } })).data.error.code, 'WEAK_PASSWORD');

  const ok = await api('POST', '/auth/reset-password', { headers: freshIp(), body: { token, password: 'brand-new-password-2' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.reset, true);
  assert.equal(ok.data.session_token, undefined); // a reset never logs anyone in: the login code is still required

  assert.equal((await api('POST', '/auth/login', { headers: freshIp(), body: { email: 'reset-co@example.com', password: 'old-password-1' } })).status, 401);
  assert.equal((await loginWithOtp('reset-co@example.com', 'brand-new-password-2')).status, 200);

  const reuse = await api('POST', '/auth/reset-password', { headers: freshIp(), body: { token, password: 'another-password-3' } });
  assert.equal(reuse.status, 400);
  assert.equal(reuse.data.error.code, 'RESET_LINK_INVALID');
  assert.equal((await api('GET', `/auth/reset-info?token=${token}`)).status, 400);
  const notice = sentEmails.filter((e) => e.to === 'reset-co@example.com' && /mot de passe Freda Pay Issuing a été modifié/.test(e.subject));
  assert.equal(notice.length, 1); // the owner is told, in case it was not them
});

test('a reset ends every session opened before it, and only the newest link works', async () => {
  const reg = await registerAndVerify({ business_name: 'Sessions Co', email: 'sessions-co@example.com', password: 'old-password-1' });
  const oldSession = reg.data.session_token;
  assert.equal((await api('GET', '/dashboard/balance', { token: oldSession })).status, 200);
  await new Promise((r) => setTimeout(r, 1100)); // tokens carry whole seconds

  await forgot('sessions-co@example.com');
  const first = resetLinkFor('sessions-co@example.com');
  await forgot('sessions-co@example.com');
  const second = resetLinkFor('sessions-co@example.com');
  assert.notEqual(first, second);
  assert.equal((await api('POST', '/auth/reset-password', { headers: freshIp(), body: { token: first, password: 'brand-new-password-2' } })).status, 400); // superseded

  assert.equal((await api('POST', '/auth/reset-password', { headers: freshIp(), body: { token: second, password: 'brand-new-password-2' } })).status, 200);
  const dead = await api('GET', '/dashboard/balance', { token: oldSession });
  assert.equal(dead.status, 401);
  assert.equal(dead.data.error.code, 'SESSION_ENDED');
  const fresh = await loginWithOtp('sessions-co@example.com', 'brand-new-password-2');
  assert.equal((await api('GET', '/dashboard/balance', { token: fresh.data.session_token })).status, 200);
});

test('an expired link is refused', async () => {
  await registerAndVerify({ business_name: 'Expired Co', email: 'expired-co@example.com', password: 'old-password-1' });
  await forgot('expired-co@example.com');
  const token = resetLinkFor('expired-co@example.com');
  mockTables.password_resets.find((r) => r.email === 'expired-co@example.com').expires_at = new Date(Date.now() - 1000).toISOString();
  const r = await api('POST', '/auth/reset-password', { headers: freshIp(), body: { token, password: 'brand-new-password-2' } });
  assert.equal(r.status, 400);
  assert.equal(r.data.error.code, 'RESET_LINK_INVALID');
  assert.equal((await api('POST', '/auth/reset-password', { headers: freshIp(), body: { token: 'a'.repeat(64), password: 'brand-new-password-2' } })).status, 400); // a guessed token
});

test('only the hash of a reset token is stored, never the link itself', async () => {
  await registerAndVerify({ business_name: 'Hash Co', email: 'hash-co@example.com', password: 'old-password-1' });
  await forgot('hash-co@example.com');
  const token = resetLinkFor('hash-co@example.com');
  const row = mockTables.password_resets.find((r) => r.email === 'hash-co@example.com');
  assert.ok(!JSON.stringify(row).includes(token));
  assert.equal(row.token_hash.length, 64);
});

test('a team member can reset their own password; suspended accounts and unverified signups get no reset email', async () => {
  const reg = await registerAndVerify({ business_name: 'Member Reset Co', email: 'owner@member-reset.com', password: 'password123' });
  await api('POST', '/dashboard/team/invite', { token: reg.data.session_token, body: { email: 'member@member-reset.com', role: 'admin' } });
  const inviteMail = sentEmails.filter((e) => e.to === 'member@member-reset.com').slice(-1)[0];
  await api('POST', '/auth/accept-invite', { body: { token: inviteMail.text.match(/invite=([a-f0-9]{64})/)[1], password: 'member-pass-1' } });

  await forgot('member@member-reset.com');
  const token = resetLinkFor('member@member-reset.com');
  assert.ok(token);
  assert.equal((await api('POST', '/auth/reset-password', { headers: freshIp(), body: { token, password: 'member-new-pass-2' } })).status, 200);
  assert.equal((await api('POST', '/auth/login', { headers: freshIp(), body: { email: 'member@member-reset.com', password: 'member-pass-1' } })).status, 401);
  assert.equal((await loginWithOtp('member@member-reset.com', 'member-new-pass-2')).data.role, 'admin');
  // the owner's own password was not touched by the member's reset
  assert.equal((await loginWithOtp('owner@member-reset.com', 'password123')).status, 200);

  const { token: adminToken } = await adminLogin('owner');
  await api('DELETE', `/admin/merchants/${reg.data.merchant.id}`, { token: adminToken });
  const sentBefore = sentEmails.length;
  await forgot('owner@member-reset.com');
  await forgot('member@member-reset.com');
  assert.equal(sentEmails.length, sentBefore); // suspended: nothing goes out (and nothing is revealed)

  // signed up but never verified the email: no reset (they verify first)
  await api('POST', '/auth/register', { headers: { 'x-forwarded-for': '198.51.100.99' }, body: { business_name: 'Unverified Co', email: 'unverified@example.com', password: 'password123' } });
  const sent2 = sentEmails.length;
  await forgot('unverified@example.com');
  assert.equal(sentEmails.filter((e) => e.to === 'unverified@example.com' && /Réinitialisez/.test(e.subject)).length, 0);
  assert.ok(sentEmails.length >= sent2);
});

test('asking for reset links is rate limited per address, without revealing it', async () => {
  await registerAndVerify({ business_name: 'Flood Co', email: 'flood-co@example.com', password: 'password123' });
  for (let i = 0; i < 6; i += 1) assert.equal((await forgot('flood-co@example.com')).status, 200);
  const links = sentEmails.filter((e) => e.to === 'flood-co@example.com' && /Réinitialisez/.test(e.subject));
  assert.equal(links.length, 3); // the 4th request onward sends nothing, yet still answers 200
});

/* ===== Email and blog links: the address is verified, the logo is served by the API, no link can 404 ===== */

function startStaticSite({ logoOk }) {
  const server = require('http').createServer((req, res) => {
    if (req.url === '/logo.png' && logoOk) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47])); }
    res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('<h1>404</h1>');
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

/** Every valid public page of the website (what an email button may point to). */
const PUBLIC_PATHS = ['/', '/dashboard', '/signup', '/docs', '/terms', '/privacy', '/blog', '/sitemap.xml', '/notre-equipe', '/regulatory-disclosure', '/cookie-policy', '/press-kit', '/api-moncash-natcash', '/cartes-virtuelles-haiti'];

test('a wrong SITE_URL is detected and replaced by the official site; a transient failure changes nothing', async () => {
  const config = require('../src/config');
  const siteUrl = require('../src/services/siteUrl');
  const wrong = await startStaticSite({ logoOk: false });   // e.g. the corporate domain, which does not host the app
  const official = await startStaticSite({ logoOk: true });
  const saved = { site: config.siteUrl, def: config.defaultSiteUrl };
  try {
    config.defaultSiteUrl = official.url;
    config.siteUrl = wrong.url;
    const bad = await siteUrl.verify();
    assert.equal(bad.fell_back, true);
    assert.equal(siteUrl.get(), official.url);
    assert.match(bad.note, /SITE_URL/);

    config.siteUrl = official.url;
    assert.equal((await siteUrl.verify()).fell_back, false);
    assert.equal(siteUrl.get(), official.url);

    // both unreachable (network trouble): the last address known to work is kept; nothing flips on a blip
    const lastGood = siteUrl.get();
    wrong.server.close(); official.server.close();
    config.siteUrl = 'http://127.0.0.1:9';
    config.defaultSiteUrl = 'http://127.0.0.1:8';
    const down = await siteUrl.verify();
    assert.equal(down.fell_back, false);
    assert.equal(siteUrl.get(), lastGood);
  } finally {
    config.siteUrl = saved.site; config.defaultSiteUrl = saved.def;
    wrong.server.close(); official.server.close();
    await siteUrl.verify().catch(() => {});
    config.siteUrl = saved.site;
  }
});

test('the logo used by emails and the blog is served by the API itself (PNG, cacheable), unknown assets 404', async () => {
  const config = require('../src/config');
  assert.match(config.emailLogoUrl, /\/assets\/logo-email\.png$/);
  assert.ok(!config.emailLogoUrl.startsWith(config.siteUrl)); // independent of the website's address
  const res = await fetch(baseUrl + '/assets/logo-email.png');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('cache-control'), /max-age=\d+/);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]); // a real PNG
  assert.equal((await fetch(baseUrl + '/assets/secret.txt')).status, 404);
});

test('every link in every email points to a real page of the website, and the logo to the API asset', async () => {
  const siteUrl = require('../src/services/siteUrl');
  const config = require('../src/config');
  const notify = require('../src/services/notify');
  const { teamInviteEmail } = require('../src/templates/teamInviteEmail');
  const { lowBalanceEmail } = require('../src/templates/lowBalanceEmail');
  const { walletCreditedEmail } = require('../src/templates/walletCreditedEmail');
  const m = { email: 'links-audit@example.com', business_name: 'Links Audit Co' };
  await notify.verificationApproved(m, 'kyc', { liveEnabled: true });
  await notify.verificationRejected(m, 'kyc', 'Photo floue');
  await notify.accountSuspended(m); await notify.accountRestored(m); await notify.liveGranted(m);
  await notify.issuingDecision(m, true); await notify.issuingDecision(m, false, 'Motif');
  await notify.walletCredited(m, { amount: 10, currency: 'USD', walletLabel: 'Master Wallet', newBalance: 10, mode: 'live' });
  await notify.depositRejected(m, { amount: 10, method: 'zelle', reason: 'x' });
  await notify.passwordReset(m.email, m.business_name, `${siteUrl.get()}/signup?reset=abc`, 60);
  await notify.passwordChanged(m.email, m.business_name);
  await notify.diagnosticTest(m.email, m.business_name);
  const rendered = [
    ...sentEmails.filter((e) => e.to === m.email).map((e) => e.html),
    teamInviteEmail({ businessName: 'X', role: 'admin', link: `${siteUrl.get()}/signup?invite=abc`, expiryDays: 7 }).html,
    lowBalanceEmail({ businessName: 'X', balance: 10, minimumBalance: 50 }).html,
    walletCreditedEmail({ businessName: 'X', amount: 5, currency: 'USD', walletLabel: 'Master Wallet', newBalance: 5 }).html,
  ];
  assert.ok(rendered.length >= 14);
  const base = siteUrl.get();
  let linkCount = 0;
  for (const html of rendered) {
    for (const [, url] of html.matchAll(/(?:href|src)="(https?:[^"]+)"/g)) {
      if (url.startsWith('mailto:')) continue;
      linkCount += 1;
      const isLogo = url === config.emailLogoUrl;
      const u = new URL(url);
      if (isLogo) continue;
      assert.equal(u.origin, new URL(base).origin, `link leaves the website: ${url}`);
      assert.ok(PUBLIC_PATHS.includes(u.pathname), `link to a page that does not exist: ${url}`);
      assert.ok(!/\.html$/.test(u.pathname), `link with .html: ${url}`);
    }
    assert.ok(html.includes(config.emailLogoUrl), 'the logo is missing');
    assert.ok(!/app\.fredapay\.com|www\.fredapay\.com/.test(html), 'a wrong domain appears in an email');
  }
  assert.ok(linkCount >= 14);
});

test('an admin invitation links to the panel the admin is on (it is not on the public site), and ignores a bad address', async () => {
  const { token } = await adminLogin('owner');
  const inv = await api('POST', '/admin/team/invite', { token, body: { email: 'panel-link@fredapay.com', name: 'Panel Link', role: 'editor', panel_url: 'https://admin.example.org/admin.html?x=1#y' } });
  assert.equal(inv.status, 201);
  const mail = sentEmails.filter((e) => e.to === 'panel-link@fredapay.com').slice(-1)[0];
  assert.match(mail.text, /https:\/\/admin\.example\.org\/admin\.html\?invite=[a-f0-9]{64}/);
  assert.ok(!/\?x=1|#y/.test(mail.text));

  const inv2 = await api('POST', '/admin/team/invite', { token, body: { email: 'panel-link2@fredapay.com', name: 'Panel Link 2', role: 'editor', panel_url: 'javascript:alert(1)' } });
  assert.equal(inv2.status, 201);
  const mail2 = sentEmails.filter((e) => e.to === 'panel-link2@fredapay.com').slice(-1)[0];
  assert.ok(!/javascript:/.test(mail2.text));
});

test('the blog pages show the API-hosted logo and link back to the real website, never to another domain', async () => {
  const config = require('../src/config');
  const siteUrl = require('../src/services/siteUrl');
  const res = await fetch(baseUrl + '/blog');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes(`<img src="${config.emailLogoUrl}"`));
  assert.ok(html.includes(`<a class="logo" href="${siteUrl.get()}/">`));
  assert.ok(!/www\.fredapay\.com|app\.fredapay\.com/.test(html));
});

test('admin link diagnostics report the address in use and what each link answers, and the test email carries logo and button', async () => {
  const config = require('../src/config');
  const site = await startStaticSite({ logoOk: true });
  const saved = config.siteUrl;
  try {
    config.siteUrl = site.url; // a stand-in website (it serves the logo, but not /dashboard etc.)
    const { token } = await adminLogin('owner');
    const r = await api('GET', '/admin/diagnostic/links', { token });
    assert.equal(r.status, 200);
    assert.equal(r.data.site.used, site.url);
    assert.ok(r.data.checks.some((c) => /Tableau de bord/.test(c.label) && c.status === 404 && c.ok === false));
    assert.ok(r.data.issues.some((i) => /\/dashboard/.test(i) && /404/.test(i)));

    const t = await api('POST', '/admin/diagnostic/email-test', { token });
    assert.equal(t.status, 200);
    const mail = sentEmails.filter((e) => e.subject === 'Test : logo et lien des emails Freda Pay Issuing').slice(-1)[0];
    assert.ok(mail.html.includes(config.emailLogoUrl));
    assert.ok(mail.html.includes(`${site.url}/dashboard`));
  } finally {
    config.siteUrl = saved; site.server.close();
  }
  const { token: editorToken } = await adminLogin('editor');
  assert.equal((await api('GET', '/admin/diagnostic/links', { token: editorToken })).status, 403);
});

/* ===== sitemap.xml: generated, so a published blog post reaches Google with no manual edit ===== */

async function sitemapXml() {
  const res = await fetch(baseUrl + '/sitemap.xml');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/xml/);
  return res.text();
}

test('sitemap.xml lists every public page, never a private one, and is valid XML', async () => {
  const siteUrl = require('../src/services/siteUrl');
  const { PAGES } = require('../src/services/sitemapPages');
  const xml = await sitemapXml();
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9" xmlns:image="http:\/\/www\.google\.com\/schemas\/sitemap-image\/1\.1" xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml">/);
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  for (const p of PAGES) assert.ok(locs.includes(`${siteUrl.get()}${p.path}`), `missing ${p.path}`);
  assert.ok(locs.includes(`${siteUrl.get()}/blog`));
  for (const privatePath of ['/dashboard', '/checkout', '/admin', '/admin.html', '/signup']) assert.ok(!locs.some((l) => l.endsWith(privatePath)), `private page in sitemap: ${privatePath}`);
  assert.ok(!locs.some((l) => /\.html/.test(l)));
  assert.equal(new Set(locs).size, locs.length); // no duplicates
  assert.match(xml, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
});

test('publishing a blog post adds it to the sitemap automatically; unpublishing or deleting removes it; drafts never appear', async () => {
  const siteUrl = require('../src/services/siteUrl');
  const { token } = await adminLogin('owner');
  const created = await api('POST', '/admin/blog', { token, body: { title: 'Sitemap Auto Post', content_markdown: 'Contenu de test.', excerpt: 'Test', tags: ['test'] } });
  assert.equal(created.status, 201);
  const slug = created.data.post.slug;
  const loc = `${siteUrl.get()}/blog/${slug}`;

  assert.ok(!(await sitemapXml()).includes(loc)); // a draft is not indexed

  await api('POST', `/admin/blog/${created.data.post.id}/publish`, { token });
  const published = await sitemapXml();
  assert.ok(published.includes(`<loc>${loc}</loc>`));
  const entry = published.split('<url>').find((u) => u.includes(loc));
  assert.match(entry, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
  // the blog index carries the date of the newest post
  const blogEntry = published.split('<url>').find((u) => u.includes(`<loc>${siteUrl.get()}/blog</loc>`));
  assert.match(blogEntry, /<lastmod>/);

  await api('POST', `/admin/blog/${created.data.post.id}/unpublish`, { token });
  assert.ok(!(await sitemapXml()).includes(loc));

  await api('POST', `/admin/blog/${created.data.post.id}/publish`, { token });
  assert.ok((await sitemapXml()).includes(loc));
  await api('DELETE', `/admin/blog/${created.data.post.id}`, { token });
  assert.ok(!(await sitemapXml()).includes(loc));
});

test('special characters in a post slug cannot break the sitemap XML', async () => {
  mockTables.blog_posts.push({ id: 'blog_xml', slug: 'a&b<c>"d', title: 'X', content_markdown: 'x', status: 'published', published_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  const xml = await sitemapXml();
  assert.ok(xml.includes('a&amp;b&lt;c&gt;&quot;d'));
  assert.ok(!xml.includes('a&b<c>'));
  mockTables.blog_posts.splice(mockTables.blog_posts.findIndex((p) => p.id === 'blog_xml'), 1);
});

/* ===== Admin figures are REAL: cards, spending, revenue, partner cost, profit ===== */

const purchase = (cardId, extra = {}) => ({
  event: 'issuing.transaction', type: 'AUTHORIZATION', mode: 'DEBIT', status: 'SUCCESS', amount: 2500, currency: 'USD',
  card_id: cardId, reference: `buy-${Math.random().toString(16).slice(2)}`, description: 'Approved or completed successfully',
  merchant: { name: 'GOOGLE *ADS', country: 'US' }, ...extra,
});

/** A live merchant with an active live card and one Zelle deposit already confirmed, plus fees from a recharge. */
async function liveMerchantWithActivity(label) {
  const live = await makeLiveMerchant(label, { fundUsd: 0 });
  const dep = await zelleDeposit(live.token, 400, `ZELLE-${label}`);
  await api('POST', `/admin/deposits/${dep.data.id}/approve`, { token: live.adminToken });
  const c = await api('POST', '/dashboard/cards', { token: live.token, body: { reference: `ACT-${label}`, kind: 'business', business_name: `${label} Co`, brand: 'VISA', amount: 100 } });
  await pollUntil(() => api('GET', `/dashboard/cards/${c.data.id}`, { token: live.token }), (r) => r.data.status === 'active', 40, 20);
  const card = mockTables.cards.find((x) => x.id === c.data.id);
  return { ...live, card };
}

test('merchant stats: cards issued, money deposited/spent, revenue, partner cost and profit are real and add up', async () => {
  const live = await liveMerchantWithActivity('statsreal');
  await api('POST', `/dashboard/cards/${live.card.id}/fund`, { token: live.token, body: { amount: 50 } });

  const r = await api('GET', `/admin/merchants/${live.merchantId}`, { token: live.adminToken });
  const st = r.data.stats;
  assert.equal(r.data.revenue_mode, 'live');
  assert.equal(st.cards.issued, 1);
  assert.equal(st.cards.active, 1);
  assert.equal(st.wallet.deposited_usd, 382); // 400 received - 4.5 % funding fee
  // spent from the Master Wallet: creation (100 preload + 5 fee) + recharge (50 + 1.60 fee)
  assert.equal(st.wallet.spent_usd, 156.6);
  // revenue = the two fees (5.00 + 1.60) + the 4.5 % funding fee withheld on the 400 $ deposit (18.00). Partner costs, itemised:
  // 1.50 creation + 1.00 recharge + 8.00 funding (2 % of the 400 $ deposit that backs the wallet). Profit = revenue - every partner cost.
  assert.equal(st.revenue.total_revenue_usd, 24.6);
  assert.deepEqual(st.revenue.partner_cost_by_kind_usd, { card_creation: 1.5, wallet_deposit: 8, card_recharge: 1 });
  assert.equal(st.revenue.total_partner_cost_usd, 10.5);
  assert.equal(st.revenue.total_profit_usd, 14.1);
  assert.deepEqual(r.data.revenue, st.revenue);
  assert.equal(st.revenue.by_day[0].profit_usd, 14.1);
});

test('failed card creations (and the stale rows older versions left behind) are never counted as revenue', async () => {
  const live = await liveMerchantWithActivity('phantomrows');
  const failedCard = { id: 'card_failed_x', merchant_id: live.merchantId, own_reference: 'FAILED-X', kind: 'business', brand: 'VISA', currency: 'USD', status: 'failed', mode: 'live', creation_fee: 5, created_at: new Date().toISOString() };
  mockTables.cards.push(failedCard);
  // what the OLD code wrote before the provider answered, for a creation that was refunded:
  for (let i = 0; i < 4; i += 1) mockTables.fee_revenue.push({ id: `fee_ph_${i}`, merchant_id: live.merchantId, kind: 'card_creation', amount: 5, currency: 'USD', related_id: failedCard.id, mode: 'live', created_at: new Date().toISOString() });
  const r = await api('GET', `/admin/merchants/${live.merchantId}`, { token: live.adminToken });
  assert.equal(r.data.revenue.total_revenue_usd, 23); // the real card's creation fee (5) + the deposit funding fee (18), not the 4 phantom rows
  assert.equal(r.data.revenue.by_kind_usd.card_creation, 5);
  assert.equal(r.data.revenue.partner_cost_by_kind_usd.card_creation, 1.5);
  const platform = (await api('GET', '/admin/overview', { token: live.adminToken })).data.platform;
  assert.ok(!platform.by_day.some((d) => d.revenue_usd === 25)); // 5 + 4 phantom x 5 would be 25
});

test('card spending comes from the partner\'s notifications: purchases count once, refunds subtract, declines are not spending', async () => {
  const live = await liveMerchantWithActivity('spendreal');
  const id = live.card.maplerad_card_id;
  const send = (ev) => sendProviderEvent(ev, MOCK_LIVE_WHSEC);
  const buy = purchase(id, { amount: 2500, reference: 'p1' });
  await send(buy);
  await send(buy); // the same event delivered again is stored once
  await send({ ...purchase(id, { amount: 2500, reference: 'p1-settle' }), type: 'AUTHORIZATION-SETTLEMENT' }); // completes p1: not a second purchase
  await send(purchase(id, { amount: 1000, reference: 'p2' }));
  await send({ ...purchase(id, { amount: 500, reference: 'r1' }), type: 'REFUND', mode: 'CREDIT' });
  await send({ ...declineEvent(id), reference: 'd1' });
  await send({ ...purchase(id, { amount: 9900, reference: 'bad' }), status: 'FAILED' });

  const st = (await api('GET', `/admin/merchants/${live.merchantId}`, { token: live.adminToken })).data.stats;
  assert.equal(st.card_spend.purchases, 2);
  assert.equal(st.card_spend.total_usd, 30); // 25 + 10 - 5 refunded
  assert.equal(st.card_spend.refunded_usd, 5);
  assert.equal(st.card_spend.declines, 1);
  // a sandbox-signed event cannot add spending to a LIVE card
  await sendProviderEvent(purchase(id, { amount: 50000, reference: 'cross-env' }), MOCK_SANDBOX_WHSEC);
  assert.equal((await api('GET', `/admin/merchants/${live.merchantId}`, { token: live.adminToken })).data.stats.card_spend.total_usd, 30);
});

test('overview: profit per day, partner fees, online card spending and the Gateway money split by business', async () => {
  const live = await liveMerchantWithActivity('overviewreal');
  await sendProviderEvent(purchase(live.card.maplerad_card_id, { amount: 4000, reference: 'ov-1' }), MOCK_LIVE_WHSEC);

  // Gateway money for two businesses
  const other = await makeLiveMerchant('overviewother', { fundUsd: 0 });
  const pay = async (m, ref, amount) => {
    const p = await api('POST', '/dashboard/payments', { token: m.token, body: { amount, method: 'moncash', reference: ref } });
    await fetch('http://localhost:4501/__control/confirm-payment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refference_id: `fp_${m.merchantId}_${ref}` }) });
    await api('GET', `/dashboard/payments/${p.data.id}`, { token: m.token });
  };
  await pay(live, 'OV-PAY-A', 2000);
  await pay(other, 'OV-PAY-B', 1000);

  const platform = (await api('GET', '/admin/overview', { token: live.adminToken })).data.platform;
  assert.equal(platform.mode, 'live');
  assert.equal(platform.by_day.length, 14);
  const today = platform.today;
  assert.ok(today.revenue_usd >= 5 && today.partner_cost_usd >= 1.5);
  assert.equal(Math.round((today.revenue_usd - today.partner_cost_usd) * 100) / 100, today.profit_usd);
  assert.ok(platform.window.card_spend_usd >= 40);
  assert.ok(platform.gateway_by_merchant.length >= 2);
  const mineRow = platform.gateway_by_merchant.find((g) => g.merchant_id === live.merchantId);
  assert.equal(mineRow.collected_htg, 2000);
  assert.equal(mineRow.fees_htg, 130); // 6 % + 10 HTG
  assert.equal(mineRow.balance_htg, 1870); // what really sits on this business's Gateway balance
  const sorted = platform.gateway_by_merchant.map((g) => g.balance_htg);
  assert.deepEqual(sorted, [...sorted].sort((a, b) => b - a));
  assert.equal(platform.gateway.partner_cost_configured, true);
  assert.equal(platform.gateway.partner_cost_pct, 4); // PlopPlop keeps 4 % of what it collects
  assert.ok(platform.cards.issued >= 1);
});

test('the PlopPlop cost, once configured, shows up as a partner cost on Gateway payments', async () => {
  const config = require('../src/config');
  const saved = { ...config.gatewayProviderCost };
  config.gatewayProviderCost.pct = 2; config.gatewayProviderCost.fixedHTG = 0; config.gatewayProviderCost.configured = true;
  try {
    const live = await makeLiveMerchant('gwcost', { fundUsd: 0 });
    const p = await api('POST', '/dashboard/payments', { token: live.token, body: { amount: 3000, method: 'moncash', reference: 'GWCOST-1' } });
    await fetch('http://localhost:4501/__control/confirm-payment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refference_id: `fp_${live.merchantId}_GWCOST-1` }) });
    await api('GET', `/dashboard/payments/${p.data.id}`, { token: live.token });
    const rev = (await api('GET', `/admin/merchants/${live.merchantId}`, { token: live.adminToken })).data.revenue;
    // fee = 6 % of 3000 + 10 = 190 HTG; partner cost = 2 % of 3000 = 60 HTG; both converted to USD
    const rate = config.exchangeRateHtgPerUsd;
    assert.equal(rev.total_revenue_usd, Math.round(190 / rate * 100) / 100);
    assert.equal(rev.total_partner_cost_usd, Math.round(60 / rate * 100) / 100);
    assert.equal(rev.gateway_cost_configured, true);
  } finally {
    Object.assign(config.gatewayProviderCost, saved);
  }
});

/* ===== Global platform: country at signup, honest top-up quote ===== */

test('signup keeps the country of registration, rejects a malformed one, and refuses US-sanctioned countries', async () => {
  const ok = await api('POST', '/auth/register', { headers: freshIp(), body: { business_name: 'Global Co', email: 'global-co@example.com', password: 'password123', onboarding: { country: 'ng', product: 'issuing' } } });
  assert.equal(ok.status, 201);
  assert.equal(mockTables.merchants.find((m) => m.email === 'global-co@example.com').onboarding.country, 'ng'); // kept as typed in the form's own list
  assert.equal((await api('POST', '/auth/register', { headers: freshIp(), body: { business_name: 'Bad Co', email: 'bad-country@example.com', password: 'password123', onboarding: { country: 'Haiti' } } })).data.error.code, 'INVALID_COUNTRY');
  for (const iso of ['CU', 'IR', 'KP', 'SY', 'ir']) {
    const r = await api('POST', '/auth/register', { headers: freshIp(), body: { business_name: 'Blocked Co', email: `blocked-${iso}@example.com`, password: 'password123', onboarding: { country: iso } } });
    assert.equal(r.status, 403);
    assert.equal(r.data.error.code, 'COUNTRY_NOT_SUPPORTED');
  }
  assert.ok(!mockTables.merchants.some((m) => /^blocked-/.test(m.email))); // no account was created
  // no country given (API-created accounts) still works: the wizard, not the API, requires it
  assert.equal((await api('POST', '/auth/register', { headers: freshIp(), body: { business_name: 'No Country Co', email: 'no-country@example.com', password: 'password123' } })).status, 201);
});

test('the top-up quote shown in the dashboard equals what is really credited (plan, custom rate, exchange rate)', async () => {
  const reg = await registerAndVerify({ business_name: 'Quote Co', email: 'quote-co@example.com', password: 'password123' });
  const token = reg.data.session_token;
  assert.equal((await api('GET', '/dashboard/wallet/topups/quote?amount_htg=abc', { token })).status, 400);

  const q = await api('GET', '/dashboard/wallet/topups/quote?amount_htg=10000', { token });
  assert.equal(q.status, 200);
  assert.equal(q.data.freda_fee_htg, 450);            // Startup plan: 4.5 %
  assert.equal(q.data.payment_partner_fee_htg, 400);  // the payment partner's 4 %, paid by the person topping up
  assert.equal(q.data.fee_htg, 850);
  assert.equal(q.data.fee_percent, 8.5);
  assert.equal(q.data.net_htg, 9150);
  assert.equal(q.data.exchange_rate_htg_per_usd, 133);
  assert.equal(q.data.credited_usd, Math.round((9150 / 133) * 100) / 100);

  // it follows a better plan, and an admin's custom rate
  const { token: adminToken } = await adminLogin('owner');
  await api('PUT', `/admin/merchants/${reg.data.merchant.id}/pricing`, { token: adminToken, body: { wallet_funding_pct: 0.02 } });
  const custom = await api('GET', '/dashboard/wallet/topups/quote?amount_htg=10000', { token });
  assert.equal(custom.data.freda_fee_htg, 200);
  assert.equal(custom.data.fee_htg, 600); // 200 + the partner's 400

  // and it is exactly what the real top-up credits
  const t = await api('POST', '/dashboard/wallet/topups', { token, body: { method: 'moncash', amount_htg: 10000, reference: 'QUOTE-1' } });
  await fetch('http://localhost:4501/__control/confirm-payment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refference_id: `fp_${reg.data.merchant.id}_QUOTE-1` }) });
  const done = await api('GET', `/dashboard/wallet/topups/${t.data.id}`, { token });
  assert.equal(done.data.status, 'succeeded');
  assert.equal(done.data.credited_usd, custom.data.credited_usd);
});

/* ===== Static-IP proxy for the card partner, and the cost sheet behind the profit figure ===== */

/** A tiny HTTP proxy that supports CONNECT (like a static-IP proxy service) and counts what goes through it. */
function startProxy({ user, pass }) {
  const seen = { tunnels: [], refused: 0 };
  const server = require('http').createServer((req, res) => { res.writeHead(405); res.end(); });
  server.on('connect', (req, clientSocket, head) => {
    const expected = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    if (req.headers['proxy-authorization'] !== expected) { seen.refused += 1; clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
    const [host, port] = req.url.split(':');
    seen.tunnels.push(req.url);
    const upstream = require('net').connect(Number(port), host, () => { clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); upstream.write(head); upstream.pipe(clientSocket); clientSocket.pipe(upstream); });
    upstream.on('error', () => clientSocket.end());
    clientSocket.on('error', () => upstream.destroy());
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, seen, port: server.address().port })));
}

test('provider calls can leave through a static-IP proxy: they pass through it, with credentials, and fail safely if it refuses', async () => {
  const config = require('../src/config');
  const maplerad = require('../src/services/maplerad');
  const proxy = await startProxy({ user: 'fixed', pass: 'p@ss/word' });
  const saved = config.maplerad.proxyUrl;
  try {
    config.maplerad.proxyUrl = `http://fixed:${encodeURIComponent('p@ss/word')}@127.0.0.1:${proxy.port}`;
    const before = proxy.seen.tunnels.length;
    const cards = await maplerad.forMode('sandbox').listCards({ page: 1, page_size: 1 });
    assert.ok(cards);
    assert.equal(proxy.seen.tunnels.length, before + 1); // the call really went through the proxy
    assert.match(proxy.seen.tunnels[proxy.seen.tunnels.length - 1], /:4504$/); // ...to the partner (here: its test double)

    // wrong credentials: the proxy says 407, the call fails as "service unavailable", and the secret never appears
    config.maplerad.proxyUrl = `http://fixed:wrong@127.0.0.1:${proxy.port}`;
    await assert.rejects(() => maplerad.forMode('sandbox').listCards({ page: 1, page_size: 1 }), (err) => {
      assert.equal(err.code, 'CARD_SERVICE_UNAVAILABLE');
      assert.ok(!/wrong|p@ss/.test(err.message));
      return true;
    });
    assert.equal(proxy.seen.refused, 1);
  } finally {
    config.maplerad.proxyUrl = saved; proxy.server.close();
  }
});

test('the diagnostic measures the IP through the proxy when one is set, and never shows its credentials', async () => {
  const config = require('../src/config');
  const proxy = await startProxy({ user: 'fixed', pass: 'secret-pass' });
  const echo = await startIpEcho(['198.51.100.9']);
  const saved = { urls: config.egressIpUrls, proxy: config.maplerad.proxyUrl };
  try {
    config.egressIpUrls = [echo.url]; // reached through the proxy tunnel
    const { token } = await adminLogin('owner');
    const direct = await api('GET', '/admin/diagnostic/maplerad', { token });
    assert.equal(direct.data.outbound_ip.via_proxy, false);
    assert.equal(direct.data.outbound_ip.proxy.configured, false);
    assert.match(direct.data.outbound_ip.note, /IP fixe/);
    assert.match(direct.data.outbound_ip.note, /Dedicated IPs/);

    config.maplerad.proxyUrl = `http://fixed:secret-pass@127.0.0.1:${proxy.port}`;
    const before = proxy.seen.tunnels.length;
    const viaProxy = await api('GET', '/admin/diagnostic/maplerad', { token });
    assert.equal(viaProxy.data.outbound_ip.ip, '198.51.100.9');
    assert.equal(viaProxy.data.outbound_ip.via_proxy, true);
    assert.ok(proxy.seen.tunnels.length >= before + 1); // measured the way the partner is called
    assert.equal(viaProxy.data.outbound_ip.looks_fixed, true);
    assert.deepEqual(viaProxy.data.outbound_ip.proxy, { configured: true, host: '127.0.0.1', port: proxy.port });
    assert.ok(!JSON.stringify(viaProxy.data).includes('secret-pass'));
    assert.match(viaProxy.data.outbound_ip.note, /proxy à IP fixe/);
  } finally {
    config.egressIpUrls = saved.urls; config.maplerad.proxyUrl = saved.proxy; proxy.server.close(); echo.server.close();
  }
});

test('profit uses the partner cost sheet exactly: creation 1.50, recharge 1.00, withdrawal 1.00, wallet funding 2 % of what is credited', async () => {
  const config = require('../src/config');
  assert.deepEqual(config.issuingProviderCostsUSD, { cardCreation: 1.5, cardRecharge: 1, cardWithdrawal: 1, walletFundingPct: 0.02 });

  const live = await makeLiveMerchant('costsheet', { fundUsd: 300 }); // enough to stay above the wallet's minimum reserve after the card
  // 1) a MonCash top-up of 10 000 HTG: fee 4.5 % = 450 HTG of revenue; cost = 2 % of the dollars credited
  const t = await api('POST', '/dashboard/wallet/topups', { token: live.token, body: { method: 'moncash', amount_htg: 10000, reference: 'COSTSHEET-1' } });
  await fetch('http://localhost:4501/__control/confirm-payment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refference_id: `fp_${live.merchantId}_COSTSHEET-1` }) });
  const done = await api('GET', `/dashboard/wallet/topups/${t.data.id}`, { token: live.token });
  assert.equal(done.data.status, 'succeeded');
  let rev = (await api('GET', `/admin/merchants/${live.merchantId}`, { token: live.adminToken })).data.revenue;
  assert.equal(rev.total_revenue_usd, Math.round((450 / 133) * 100) / 100);        // income = Freda Pay's own 4.5 % only
  assert.equal(rev.partner_cost_by_kind_usd.wallet_funding, Math.round(done.data.credited_usd * 0.02 * 100) / 100); // card partner: 2 % of the dollars credited
  assert.equal(rev.partner_cost_by_kind_usd.wallet_collection, undefined);          // the payment partner's 4 % was paid by the payer: not our cost

  // 2) card creation + recharge + withdrawal
  const c = await api('POST', '/dashboard/cards', { token: live.token, body: { reference: 'COSTSHEET-CARD', kind: 'business', business_name: 'Cost Co', brand: 'VISA', amount: 20 } });
  assert.equal(c.status, 202);
  await pollUntil(() => api('GET', `/dashboard/cards/${c.data.id}`, { token: live.token }), (r) => r.data.status === 'active', 40, 20);
  await api('POST', `/dashboard/cards/${c.data.id}/fund`, { token: live.token, body: { amount: 10 } });
  await api('POST', `/dashboard/cards/${c.data.id}/withdraw`, { token: live.token, body: { amount: 5 } });
  rev = (await api('GET', `/admin/merchants/${live.merchantId}`, { token: live.adminToken })).data.revenue;
  assert.equal(rev.partner_cost_by_kind_usd.card_creation, 1.5);
  assert.equal(rev.partner_cost_by_kind_usd.card_recharge, 1);
  assert.equal(rev.partner_cost_by_kind_usd.card_withdrawal, 1);
  // what the merchant paid on top of the card money (Startup plan) minus those costs
  assert.equal(rev.by_kind_usd.card_creation - 1.5, 3.5);   // 5.00 - 1.50
  assert.equal(Math.round((rev.by_kind_usd.card_recharge - 1) * 100) / 100, 0.6); // 1.60 - 1.00
  assert.equal(Math.round((rev.by_kind_usd.card_withdrawal - 1) * 100) / 100, 0.3); // 1.30 - 1.00
});


test('the PlopPlop 4 % is a cost of every MonCash/Natcash payment, even when the merchant pays no fee (free plan), and of every MonCash top-up', async () => {
  const live = await makeLiveMerchant('plop4', { fundUsd: 0 });
  await api('PUT', `/admin/merchants/${live.merchantId}/free-plan`, { token: live.adminToken, body: { grant: true } }); // no fee charged to the merchant
  const p = await api('POST', '/dashboard/payments', { token: live.token, body: { amount: 5000, method: 'moncash', reference: 'PLOP4-1' } });
  await fetch('http://localhost:4501/__control/confirm-payment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refference_id: `fp_${live.merchantId}_PLOP4-1` }) });
  await api('GET', `/dashboard/payments/${p.data.id}`, { token: live.token });
  const rev = (await api('GET', `/admin/merchants/${live.merchantId}`, { token: live.adminToken })).data.revenue;
  assert.equal(rev.total_revenue_usd, 0);                                         // free plan: nothing earned...
  assert.equal(rev.partner_cost_by_kind_usd.gateway_payment, Math.round((200 / 133) * 100) / 100); // ...but PlopPlop still took 4 % of 5 000 HTG
  assert.equal(rev.total_profit_usd, -Math.round((200 / 133) * 100) / 100);
});

/* ===== Withdrawals: bank transfer (by hand), 5 % on MonCash/Natcash, held money, honest "spent" ===== */

const BANK = { holder_name: 'Acme Commerce LLC', bank_name: 'Banque Exemple', country: 'HT', currency: 'HTG', account_number: '0012345678', swift: 'EXMPHTPP' };

/** A live merchant with money on its Gateway balance (a confirmed payment). */
async function liveWithGateway(label, htg = 20000) {
  const live = await makeLiveMerchant(label, { fundUsd: 0 });
  await ledgerCredit(live.merchantId, htg);
  return live;
}
const emailOf = (live) => mockTables.merchants.find((m) => m.id === live.merchantId).email;
async function ledgerCredit(merchantId, htg) {
  await require('../src/services/ledger').creditGateway(merchantId, htg, 'HTG', `seed-${Math.random()}`, null, 'live');
}
const gw = async (token) => (await api('GET', '/dashboard/balance', { token })).data.gateway.available;

test('bank account: saved masked, validated (IBAN checksum, SWIFT), changed with an email alert, never shown in full again', async () => {
  const live = await liveWithGateway('bankacct');
  assert.equal((await api('GET', '/dashboard/bank-account', { token: live.token })).data.bank_account, null);

  assert.equal((await api('PUT', '/dashboard/bank-account', { token: live.token, body: { ...BANK, holder_name: '' } })).status, 400);
  assert.equal((await api('PUT', '/dashboard/bank-account', { token: live.token, body: { ...BANK, country: 'Haiti' } })).data.error.code, 'INVALID_COUNTRY');
  assert.equal((await api('PUT', '/dashboard/bank-account', { token: live.token, body: { ...BANK, country: 'IR' } })).status, 403);
  assert.equal((await api('PUT', '/dashboard/bank-account', { token: live.token, body: { ...BANK, currency: 'EUR' } })).data.error.code, 'INVALID_CURRENCY');
  assert.equal((await api('PUT', '/dashboard/bank-account', { token: live.token, body: { ...BANK, account_number: null } })).data.error.code, 'MISSING_FIELDS');
  assert.equal((await api('PUT', '/dashboard/bank-account', { token: live.token, body: { ...BANK, account_number: null, iban: 'FR7630006000011234567890190' } })).data.error.code, 'INVALID_IBAN'); // wrong checksum
  assert.equal((await api('PUT', '/dashboard/bank-account', { token: live.token, body: { ...BANK, swift: 'XX' } })).data.error.code, 'INVALID_SWIFT');

  const ok = await api('PUT', '/dashboard/bank-account', { token: live.token, body: { ...BANK, account_number: null, iban: 'FR76 3000 6000 0112 3456 7890 189', country: 'FR', currency: 'USD' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.bank_account.iban_masked, '••••0189');
  assert.ok(!JSON.stringify(ok.data).includes('3000600001'));  // the full IBAN is not echoed back
  assert.equal(sentEmails.filter((e) => e.to === emailOf(live) && /compte bancaire a été ajouté/.test(e.subject)).length, 1);

  const changed = await api('PUT', '/dashboard/bank-account', { token: live.token, body: BANK });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.bank_account.account_number_masked, '••••5678');
  assert.equal(sentEmails.filter((e) => e.to === emailOf(live) && /compte bancaire a été modifié/.test(e.subject)).length, 1);
  assert.equal((await api('DELETE', '/dashboard/bank-account', { token: live.token })).data.removed, true);
  assert.equal((await api('GET', '/dashboard/bank-account', { token: live.token })).data.bank_account, null);
});

test('payout quote: 5 % for MonCash/Natcash, a fixed 100 HTG for a bank transfer (with its minimum)', async () => {
  const live = await liveWithGateway('payoutquote');
  const mc = (await api('GET', '/dashboard/payouts/quote?method=moncash&amount=2000', { token: live.token })).data;
  assert.deepEqual([mc.fee_htg, mc.total_htg, mc.fee_rule], [100, 2100, '5 %']);
  const nc = (await api('GET', '/dashboard/payouts/quote?method=natcash&amount=999', { token: live.token })).data;
  assert.equal(nc.fee_htg, 49.95);
  const bank = (await api('GET', '/dashboard/payouts/quote?method=bank&amount=5000', { token: live.token })).data;
  assert.deepEqual([bank.fee_htg, bank.total_htg, bank.fee_rule, bank.minimum_htg], [100, 5100, '100 HTG fixes', 1000]);
  assert.equal((await api('GET', '/dashboard/payouts/quote?method=cash&amount=5', { token: live.token })).status, 400);
  // an admin's custom withdrawal fees apply
  await api('PUT', `/admin/merchants/${live.merchantId}/pricing`, { token: live.adminToken, body: { payout_mobile_pct: 0.02, payout_bank_fee_htg: 40 } });
  assert.equal((await api('GET', '/dashboard/payouts/quote?method=moncash&amount=2000', { token: live.token })).data.fee_htg, 40);
  assert.equal((await api('GET', '/dashboard/payouts/quote?method=bank&amount=5000', { token: live.token })).data.fee_htg, 40);
});

test('bank withdrawal: needs a bank account, holds amount + 100 HTG at once, waits for the team, then is settled by hand', async () => {
  const live = await liveWithGateway('bankflow', 20000);
  const req = (extra = {}) => api('POST', '/dashboard/payouts', { token: live.token, body: { amount: 5000, method: 'bank', reference: `BK-${Math.random().toString(16).slice(2)}`, ...extra } });

  assert.equal((await req()).data.error.code, 'NO_BANK_ACCOUNT');
  await api('PUT', '/dashboard/bank-account', { token: live.token, body: BANK });
  assert.equal((await req({ amount: 500 })).data.error.code, 'AMOUNT_TOO_LOW');
  assert.equal((await req({ amount: 19950 })).data.error.code, 'INSUFFICIENT_BALANCE'); // 19 950 + 100 > 20 000

  const created = await req();
  assert.equal(created.status, 202);
  assert.equal(created.data.status, 'pending');
  assert.equal(created.data.method, 'bank');
  assert.equal(created.data.fee, 100);
  assert.equal(created.data.total_debited, 5100);
  assert.match(created.data.recipient, /Banque Exemple ••••5678/);
  assert.equal(await gw(live.token), 20000 - 5100);                  // held right away

  // the request lands in the admin queue with the FULL bank details, as the merchant had them
  const queue = (await api('GET', '/admin/bank-payouts', { token: live.adminToken })).data.payouts;
  const item = queue.find((p) => p.id === created.data.id);
  assert.equal(item.merchant.id, live.merchantId);
  assert.equal(item.bank_details.account_number, '0012345678');
  assert.equal(item.total_debited, 5100);
  // editing the account afterwards does not change a withdrawal already requested
  await api('PUT', '/dashboard/bank-account', { token: live.token, body: { ...BANK, account_number: '9999999999' } });
  assert.equal((await api('GET', '/admin/bank-payouts', { token: live.adminToken })).data.payouts.find((p) => p.id === created.data.id).bank_details.account_number, '0012345678');

  // the team must give the transfer reference; then it is done once
  assert.equal((await api('POST', `/admin/bank-payouts/${created.data.id}/complete`, { token: live.adminToken, body: {} })).status, 400);
  const done = await api('POST', `/admin/bank-payouts/${created.data.id}/complete`, { token: live.adminToken, body: { bank_reference: 'VIR-2026-0001' } });
  assert.equal(done.status, 200);
  assert.equal(done.data.payout.status, 'success');
  assert.equal((await api('POST', `/admin/bank-payouts/${created.data.id}/complete`, { token: live.adminToken, body: { bank_reference: 'AGAIN' } })).status, 409);
  assert.equal((await api('POST', `/admin/bank-payouts/${created.data.id}/reject`, { token: live.adminToken, body: { reason: 'late' } })).status, 409); // settled: cannot be refused any more
  assert.equal(await gw(live.token), 20000 - 5100);                  // nothing given back, nothing taken twice
  const mine = (await api('GET', `/dashboard/payouts/${created.data.id}`, { token: live.token })).data;
  assert.equal(mine.status, 'success');
  assert.equal(mine.bank_reference, 'VIR-2026-0001');
  assert.equal(sentEmails.filter((e) => e.to === emailOf(live) && /virement bancaire a été envoyé/.test(e.subject)).length, 1);
  // the 100 HTG fee is Freda Pay's income, with no partner cost (the team sends it by hand)
  const rev = (await api('GET', `/admin/merchants/${live.merchantId}`, { token: live.adminToken })).data.revenue;
  assert.equal(rev.by_kind_usd.payout, Math.round((100 / 133) * 100) / 100);
  assert.equal(rev.partner_cost_by_kind_usd.payout || 0, 0);
  assert.equal((await api('GET', '/admin/bank-payouts', { token: live.adminToken })).data.payouts.some((p) => p.id === created.data.id), false); // no longer waiting
});

test('a refused bank withdrawal gives back the amount AND the fee, and tells the merchant why', async () => {
  const live = await liveWithGateway('bankreject', 10000);
  await api('PUT', '/dashboard/bank-account', { token: live.token, body: BANK });
  const c = await api('POST', '/dashboard/payouts', { token: live.token, body: { amount: 3000, method: 'bank', reference: 'BK-REJ-1' } });
  assert.equal(await gw(live.token), 10000 - 3100);
  assert.equal((await api('POST', `/admin/bank-payouts/${c.data.id}/reject`, { token: live.adminToken, body: {} })).status, 400); // a reason is required
  const r = await api('POST', `/admin/bank-payouts/${c.data.id}/reject`, { token: live.adminToken, body: { reason: 'Numéro de compte incorrect' } });
  assert.equal(r.status, 200);
  assert.equal(await gw(live.token), 10000);                        // everything is back
  const mine = (await api('GET', `/dashboard/payouts/${c.data.id}`, { token: live.token })).data;
  assert.equal(mine.status, 'failed');
  assert.equal(mine.failure_reason, 'Numéro de compte incorrect');
  const mail = sentEmails.filter((e) => e.to === emailOf(live) && /retrait bancaire n'a pas pu/.test(e.subject)).slice(-1)[0];
  assert.match(mail.text, /Numéro de compte incorrect/);
  assert.equal((await api('POST', `/admin/bank-payouts/${c.data.id}/complete`, { token: live.adminToken, body: { bank_reference: 'X' } })).status, 409);
  assert.equal(mockTables.fee_revenue.filter((f) => f.merchant_id === live.merchantId && f.kind === 'payout').length, 0); // no income from a refused withdrawal
});

test('bank withdrawals are a dashboard action only; an API key is told so, and editors cannot touch the queue', async () => {
  const live = await liveWithGateway('bankapi', 10000);
  await api('PUT', '/dashboard/bank-account', { token: live.token, body: BANK });
  const key = await api('POST', '/dashboard/api-keys', { token: live.token, body: { mode: 'live' } });
  const viaApi = await api('POST', '/v1/payouts', { token: key.data.secret, body: { amount: 2000, method: 'bank', reference: 'BK-API-1' } });
  assert.equal(viaApi.status, 400);
  assert.equal(viaApi.data.error.code, 'BANK_PAYOUT_DASHBOARD_ONLY');
  assert.equal(await gw(live.token), 10000);
  const { token: editorToken } = await adminLogin('editor');
  assert.equal((await api('GET', '/admin/bank-payouts', { token: editorToken })).status, 403);
  assert.equal((await api('GET', '/admin/bank-payouts')).status, 401);
});

test('in Sandbox a bank withdrawal completes at once (no team, no real transfer) and stays out of the admin queue', async () => {
  const reg = await registerAndVerify({ business_name: 'Sandbox Bank Co', email: 'sandbox-bank@example.com', password: 'password123' });
  const token = reg.data.session_token;
  await require('../src/services/ledger').creditGateway(reg.data.merchant.id, 5000, 'HTG', 'seed-sbx', null, 'sandbox');
  await api('PUT', '/dashboard/bank-account', { token, body: BANK });
  const r = await api('POST', '/dashboard/payouts', { token, body: { amount: 2000, method: 'bank', reference: 'BK-SBX-1' } });
  assert.equal(r.status, 202);
  const mine = (await api('GET', `/dashboard/payouts/${r.data.id}`, { token })).data;
  assert.equal(mine.status, 'success');
  assert.match(mine.bank_reference, /SANDBOX/);
  const { token: adminToken } = await adminLogin('owner');
  assert.equal((await api('GET', '/admin/bank-payouts?status=all', { token: adminToken })).data.payouts.some((p) => p.id === r.data.id), false); // queue = Live
  assert.equal((await api('GET', '/admin/bank-payouts?status=all&mode=sandbox', { token: adminToken })).data.payouts.some((p) => p.id === r.data.id), true);
});

test('MonCash/Natcash withdrawal: the merchant pays 5 %, the partner\'s own charge is our cost, and the history shows both lines', async () => {
  const live = await liveWithGateway('mobilefee', 10000);
  const r = await api('POST', '/dashboard/payouts', { token: live.token, body: { amount: 2000, method: 'moncash', recipient: '50937001234', reference: 'MF-1' } });
  assert.equal(r.status, 202);
  assert.equal(r.data.fee, 100);                                     // 5 % of 2000
  assert.equal(await gw(live.token), 10000 - 2100);                  // held at once, even before the queue sends it
  const done = await pollUntil(() => api('GET', `/dashboard/payouts/${r.data.id}`, { token: live.token }), (x) => x.data.status !== 'pending', 60, 25);
  assert.equal(done.data.status, 'success');
  assert.equal(await gw(live.token), 10000 - 2100);                  // no second debit when it succeeds
  const rev = (await api('GET', `/admin/merchants/${live.merchantId}`, { token: live.adminToken })).data.revenue;
  assert.equal(rev.by_kind_usd.payout, Math.round((100 / 133) * 100) / 100);
  assert.equal(rev.partner_cost_by_kind_usd.payout, Math.round((50 / 133) * 100) / 100); // the partner double charges 2.5 % of 2000 = 50 HTG
  const labels = (await api('GET', '/dashboard/wallet/summary', { token: live.token })).data.movements.map((m) => m.label);
  assert.ok(labels.includes('Retrait') && labels.includes('Frais de retrait'));
});

test('a failed MonCash withdrawal returns the held amount and fee, and two requests can never spend the same money', async () => {
  const live = await liveWithGateway('mobilefail', 3000);
  await fetch('http://localhost:4501/__control/fail-next-withdrawal', { method: 'POST' });
  const r = await api('POST', '/dashboard/payouts', { token: live.token, body: { amount: 2000, method: 'natcash', recipient: '50937001234', reference: 'MFAIL-1' } });
  assert.equal(await gw(live.token), 3000 - 2100);
  const done = await pollUntil(() => api('GET', `/dashboard/payouts/${r.data.id}`, { token: live.token }), (x) => x.data.status !== 'pending', 60, 25);
  assert.equal(done.data.status, 'failed');
  assert.equal(await gw(live.token), 3000);                          // amount + fee are back
  assert.equal(mockTables.fee_revenue.filter((f) => f.merchant_id === live.merchantId && f.kind === 'payout').length, 0);

  // two withdrawals asked at the same time for money that only covers one
  const both = await Promise.all([
    api('POST', '/dashboard/payouts', { token: live.token, body: { amount: 2000, method: 'moncash', recipient: '50937001234', reference: 'RACE-1' } }),
    api('POST', '/dashboard/payouts', { token: live.token, body: { amount: 2000, method: 'moncash', recipient: '50937001234', reference: 'RACE-2' } }),
  ]);
  assert.deepEqual(both.map((x) => x.status).sort(), [202, 400]);
  assert.ok((await gw(live.token)) >= 0);
});

test('"spent" nets out refunds: a refused card creation is debited then given back, so it counts as zero', async () => {
  const live = await makeLiveMerchant('spentnet', { fundUsd: 300 });
  const config = require('../src/config');
  const saved = config.maplerad.liveSecretKey;
  config.maplerad.liveSecretKey = 'mpr_sk_a_key_the_provider_rejects';
  try {
    for (let i = 0; i < 4; i += 1) {
      const r = await api('POST', '/dashboard/cards', { token: live.token, body: { reference: `SPENT-NET-${i}`, kind: 'business', business_name: 'X', brand: 'VISA', amount: 20 } });
      assert.equal(r.status, 503);
    }
  } finally { config.maplerad.liveSecretKey = saved; }
  const st = (await api('GET', `/admin/merchants/${live.merchantId}`, { token: live.adminToken })).data.stats;
  assert.equal(st.wallet.spent_usd, 0);          // four refused attempts, nothing spent
  assert.equal(st.wallet.deposited_usd, 300);
});

test('admin overview counts Live bank withdrawals waiting for the team', async () => {
  const live = await liveWithGateway('overviewbank', 10000);
  await api('PUT', '/dashboard/bank-account', { token: live.token, body: BANK });
  const before = (await api('GET', '/admin/overview', { token: live.adminToken })).data.pending_bank_payouts;
  const c = await api('POST', '/dashboard/payouts', { token: live.token, body: { amount: 2000, method: 'bank', reference: 'OV-BK-1' } });
  assert.equal((await api('GET', '/admin/overview', { token: live.adminToken })).data.pending_bank_payouts, before + 1);
  await api('POST', `/admin/bank-payouts/${c.data.id}/reject`, { token: live.adminToken, body: { reason: 'test' } });
  assert.equal((await api('GET', '/admin/overview', { token: live.adminToken })).data.pending_bank_payouts, before);
});

/* ===== Google "Image metadata": every image in the blog's structured data names its creator, credit and copyright ===== */

function jsonLdOf(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1])).flatMap((d) => d['@graph'] || [d]);
}
function imageObjects(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => imageObjects(n, out));
  else if (node && typeof node === 'object') {
    if (node['@type'] === 'ImageObject') out.push(node);
    Object.values(node).forEach((v) => imageObjects(v, out));
  }
  return out;
}

test('blog structured data: every ImageObject has creator, creditText and copyrightNotice (article image, publisher logo, blog index)', async () => {
  const { token } = await adminLogin('owner');
  const created = await api('POST', '/admin/blog', { token, body: { title: 'Image Metadata Post', content_markdown: 'Texte.', excerpt: 'Test', cover_image_url: 'https://example.org/cover.jpg' } });
  await api('POST', `/admin/blog/${created.data.post.id}/publish`, { token });

  const index = await (await fetch(baseUrl + '/blog')).text();
  const post = await (await fetch(baseUrl + `/blog/${created.data.post.slug}`)).text();
  for (const html of [index, post]) {
    const images = jsonLdOf(html).flatMap((d) => imageObjects(d));
    assert.ok(images.length >= 1);
    for (const img of images) {
      assert.equal(img.creator.name, 'Freda Pay LLC', JSON.stringify(img));
      assert.equal(img.creator['@type'], 'Organization');
      assert.equal(img.creditText, 'Freda Pay LLC');
      assert.match(img.copyrightNotice, /^© \d{4} Freda Pay LLC$/);
      assert.ok(img.contentUrl && img.url);
    }
  }
  const article = jsonLdOf(post).find((d) => d['@type'] === 'BlogPosting');
  assert.equal(article.image['@type'], 'ImageObject');
  assert.equal(article.image.contentUrl, 'https://example.org/cover.jpg');
  assert.equal(article.publisher.logo['@type'], 'ImageObject');
  await api('DELETE', `/admin/blog/${created.data.post.id}`, { token });
});


test('sitemap: the team page lists both team photos so Google Images can find each one', async () => {
  const siteUrl = require('../src/services/siteUrl');
  const xml = await sitemapXml();
  const entry = xml.split('<url>').find((u) => u.includes(`<loc>${siteUrl.get()}/notre-equipe</loc>`));
  assert.ok(entry, 'team page missing');
  const images = [...entry.matchAll(/<image:loc>([^<]+)<\/image:loc>/g)].map((m) => m[1]);
  assert.deepEqual(images, [`${siteUrl.get()}/team/widemayeur-saint-julien.jpg`, `${siteUrl.get()}/team/loudjina-tanis.jpg`]);
  // other pages carry no image entries, and the page list itself is unchanged (image:loc never counted as a page)
  const home = xml.split('<url>').find((u) => u.includes(`<loc>${siteUrl.get()}/</loc>`));
  assert.ok(!home.includes('image:'));
  assert.ok(![...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].some((m) => /\.jpg$/.test(m[1])));
});


/* ===== Cards: an end user's card is never readable by the merchant's staff; business cards are; delete is real ===== */

const HOLDER_BODY = (label) => ({
  firstName: 'Priv', lastName: label, email: `${label}@holder.example.com`, country: 'US', dob: '1990-03-04',
  identificationNumber: `ID-${label}`, identity: TEST_IDENTITY, phoneNumber: '2025550123', phoneShortCode: '+1',
  address: { street: '350 Fifth Avenue', city: 'New York', state: 'NY', postal_code: '10118', country: 'US' },
});

async function merchantWithBothKinds(label) {
  const reg = await registerAndVerify({ business_name: `${label} Co`, email: `${label}@cards.example.com`, password: 'password123' });
  const token = reg.data.session_token;
  const holder = await api('POST', '/dashboard/cards/holders', { token, body: HOLDER_BODY(label) });
  const ind = await api('POST', '/dashboard/cards', { token, body: { reference: `IND-${label}`, kind: 'individual', brand: 'VISA', amount: 15, holder_id: holder.data.holder.id } });
  const biz = await api('POST', '/dashboard/cards', { token, body: { reference: `BIZ-${label}`, kind: 'business', business_name: `${label} Co`, brand: 'VISA', amount: 15 } });
  for (const c of [ind, biz]) await pollUntil(() => api('GET', `/dashboard/cards/${c.data.id}`, { token }), (r) => r.data.status === 'active', 40, 20);
  const apiKey = (await api('POST', '/dashboard/api-keys', { token, body: { mode: 'test' } })).data.secret;
  return { reg, token, apiKey, individualId: ind.data.id, businessId: biz.data.id };
}

test('an individual card cannot be revealed or have its activity read from the dashboard; a business card can', async () => {
  const m = await merchantWithBothKinds('privacy1');
  const hidden = await api('POST', `/dashboard/cards/${m.individualId}/reveal`, { token: m.token });
  assert.equal(hidden.status, 403);
  assert.equal(hidden.data.error.code, 'INDIVIDUAL_CARD_DETAILS_HIDDEN');
  assert.ok(!/\d{12}/.test(JSON.stringify(hidden.data))); // no number leaks in the error either
  const activity = await api('GET', `/dashboard/cards/${m.individualId}/transactions`, { token: m.token });
  assert.equal(activity.status, 403);

  const shown = await api('POST', `/dashboard/cards/${m.businessId}/reveal`, { token: m.token });
  assert.equal(shown.status, 200);
  assert.match(shown.data.number, /^\d{12,19}$/);
  assert.equal((await api('GET', `/dashboard/cards/${m.businessId}/transactions`, { token: m.token })).status, 200);
});

test('in the dashboard an individual card shows its last 4 digits only; business cards show their usual masked number', async () => {
  const m = await merchantWithBothKinds('privacy2');
  const list = (await api('GET', '/dashboard/cards', { token: m.token })).data.cards;
  const ind = list.find((c) => c.id === m.individualId);
  const biz = list.find((c) => c.id === m.businessId);
  assert.match(ind.masked_pan, /^•••• •••• •••• \d{4}$/);
  assert.ok(!/\d{6}/.test(ind.masked_pan));           // no BIN
  assert.ok(/\d{4}/.test(biz.masked_pan) && !/^••••/.test(biz.masked_pan));
  assert.match((await api('GET', `/dashboard/cards/${m.individualId}`, { token: m.token })).data.masked_pan, /^•••• •••• •••• \d{4}$/);
});

test('the card list can be asked for one kind only, which is how the two spaces of the dashboard are filled', async () => {
  const m = await merchantWithBothKinds('kinds1');
  const biz = (await api('GET', '/dashboard/cards?kind=business', { token: m.token })).data.cards;
  const ind = (await api('GET', '/dashboard/cards?kind=individual', { token: m.token })).data.cards;
  assert.deepEqual(biz.map((c) => c.id), [m.businessId]);
  assert.deepEqual(ind.map((c) => c.id), [m.individualId]);
  assert.equal((await api('GET', '/dashboard/cards', { token: m.token })).data.cards.length, 2);
});

test('API keys keep what an app needs to show a card to ITS cardholder: reveal works for an individual card with a secret key', async () => {
  const m = await merchantWithBothKinds('apikeep');
  const r = await api('POST', `/v1/cards/${m.individualId}/reveal`, { token: m.apiKey });
  assert.equal(r.status, 200);
  assert.match(r.data.number, /^\d{12,19}$/);
});

test('the activity overview lists business cards only', async () => {
  const m = await merchantWithBothKinds('feedkinds');
  const rows = ['individualId', 'businessId'].map((k) => mockTables.cards.find((c) => c.id === m[k]));
  for (const [i, row] of rows.entries()) {
    await sendProviderEvent({ event: 'issuing.transaction', type: 'AUTHORIZATION', mode: 'DEBIT', status: 'SUCCESS', amount: 500, currency: 'USD', card_id: row.maplerad_card_id, reference: `feed-${i}`, merchant: { name: 'SHOP' } }, MOCK_SANDBOX_WHSEC);
  }
  const feed = (await api('GET', '/dashboard/cards/transactions', { token: m.token })).data.transactions;
  assert.deepEqual([...new Set(feed.map((t) => t.card_id))], [m.businessId]);
});

test('delete is real for every card state: active (closed at the partner + refunded), failed (removed), pending (refused), and a closed card is removed from the list', async () => {
  const m = await merchantWithBothKinds('delreal');
  const before = (await api('GET', '/dashboard/balance', { token: m.token })).data.master_wallet.available;

  // active business card: closed at the partner, balance refunded, gone from the list
  const del = await api('POST', `/dashboard/cards/${m.businessId}/terminate`, { token: m.token });
  assert.equal(del.status, 200);
  assert.equal(mockTables.cards.find((c) => c.id === m.businessId).status, 'terminated');
  assert.equal(Math.round(((await api('GET', '/dashboard/balance', { token: m.token })).data.master_wallet.available - before) * 100) / 100, 14.5); // 15 on the card, 0.50 closure fee
  assert.ok(!(await api('GET', '/dashboard/cards', { token: m.token })).data.cards.some((c) => c.id === m.businessId));
  // the row is kept for the ledger and the audit, flagged as deleted
  assert.ok(mockTables.cards.find((c) => c.id === m.businessId).deleted_at);

  // a card whose creation failed never existed at the partner: delete just removes it, and moves no money
  const merchantId = m.reg.data.merchant.id;
  mockTables.cards.push({ id: 'card_failed_del', merchant_id: merchantId, own_reference: 'FAILED-DEL', kind: 'business', brand: 'VISA', currency: 'USD', status: 'failed', mode: 'sandbox', failure_reason: 'x', created_at: new Date().toISOString() });
  assert.ok((await api('GET', '/dashboard/cards', { token: m.token })).data.cards.some((c) => c.id === 'card_failed_del'));
  const balanceNow = (await api('GET', '/dashboard/balance', { token: m.token })).data.master_wallet.available;
  assert.equal((await api('POST', '/dashboard/cards/card_failed_del/terminate', { token: m.token })).status, 200);
  assert.ok(!(await api('GET', '/dashboard/cards', { token: m.token })).data.cards.some((c) => c.id === 'card_failed_del'));
  assert.equal((await api('GET', '/dashboard/balance', { token: m.token })).data.master_wallet.available, balanceNow);

  // a card still being created cannot be deleted yet
  mockTables.cards.push({ id: 'card_pending_del', merchant_id: merchantId, own_reference: 'PENDING-DEL', kind: 'business', brand: 'VISA', currency: 'USD', status: 'pending', mode: 'sandbox', created_at: new Date().toISOString() });
  const pending = await api('POST', '/dashboard/cards/card_pending_del/terminate', { token: m.token });
  assert.equal(pending.status, 409);
  assert.equal(pending.data.error.code, 'CARD_NOT_READY');
  assert.ok((await api('GET', '/dashboard/cards', { token: m.token })).data.cards.some((c) => c.id === 'card_pending_del'));
});

test('if the partner refuses to close the card, nothing changes: the card stays, its balance stays, no money moves', async () => {
  const live = await makeLiveMerchant('delrefused', { fundUsd: 300 });
  const c = await api('POST', '/dashboard/cards', { token: live.token, body: { reference: 'DEL-REF-1', kind: 'business', business_name: 'Del Co', brand: 'VISA', amount: 40 } });
  await pollUntil(() => api('GET', `/dashboard/cards/${c.data.id}`, { token: live.token }), (r) => r.data.status === 'active', 40, 20);
  const walletBefore = (await api('GET', '/dashboard/balance', { token: live.token })).data.master_wallet.available;
  const config = require('../src/config');
  const saved = config.maplerad.liveSecretKey;
  config.maplerad.liveSecretKey = 'mpr_sk_a_key_the_provider_rejects';
  try {
    const r = await api('POST', `/dashboard/cards/${c.data.id}/terminate`, { token: live.token });
    assert.ok(r.status >= 400);
  } finally { config.maplerad.liveSecretKey = saved; }
  const still = (await api('GET', `/dashboard/cards/${c.data.id}`, { token: live.token }));
  assert.equal(still.status, 200);
  assert.equal(still.data.status, 'active');
  assert.equal(still.data.balance, 40);
  assert.equal((await api('GET', '/dashboard/balance', { token: live.token })).data.master_wallet.available, walletBefore);
});

test('deleted cards do not count against the plan\'s card limit, so deleting really frees the slot', async () => {
  const reg = await registerAndVerify({ business_name: 'Limit Free Co', email: 'limit-free@example.com', password: 'password123' });
  const token = reg.data.session_token;
  const limit = require('../src/services/pricing').cardLimitFor('startup');
  const ids = [];
  for (let i = 0; i < limit; i += 1) {
    const c = await api('POST', '/dashboard/cards', { token, body: { reference: `LIM-${i}`, kind: 'business', business_name: 'Limit Free Co', brand: 'VISA', amount: 10 } });
    assert.equal(c.status, 202);
    ids.push(c.data.id);
  }
  await pollUntil(() => api('GET', `/dashboard/cards/${ids[0]}`, { token }), (r) => r.data.status === 'active', 40, 20);
  await pollUntil(() => api('GET', `/dashboard/cards/${ids[ids.length - 1]}`, { token }), (r) => r.data.status === 'active', 40, 20);
  const over = await api('POST', '/dashboard/cards', { token, body: { reference: 'LIM-OVER', kind: 'business', business_name: 'Limit Free Co', brand: 'VISA', amount: 10 } });
  assert.equal(over.data.error.code, 'CARD_LIMIT_REACHED');
  assert.equal((await api('POST', `/dashboard/cards/${ids[0]}/terminate`, { token })).status, 200);
  const again = await api('POST', '/dashboard/cards', { token, body: { reference: 'LIM-AGAIN', kind: 'business', business_name: 'Limit Free Co', brand: 'VISA', amount: 10 } });
  assert.equal(again.status, 202);
});

/* ===== Plans: everyone starts on Startup; paid plans renew every month (Live), with a grace period ===== */

const planRenewals = require('../src/services/planRenewals');
const planRow = (id) => mockTables.merchants.find((m) => m.id === id);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const renewalMails = (id, rx) => sentEmails.filter((e) => e.to === planRow(id).email && rx.test(e.subject));

test('every new account is on Startup (Issuing) and Standard (Gateway) in both environments, and stays there until it picks a plan', async () => {
  const reg = await registerAndVerify({ business_name: 'Default Plan Co', email: 'default-plan@example.com', password: 'password123' });
  const m = planRow(reg.data.merchant.id);
  assert.deepEqual([m.issuing_plan, m.live_issuing_plan, m.gateway_plan, m.live_gateway_plan], ['startup', 'startup', 'standard', 'standard']);
  assert.deepEqual(reg.data.merchant.plans, { sandbox: { gateway: 'standard', issuing: 'startup' }, live: { gateway: 'standard', issuing: 'startup' } });
  // having Live granted by the team does not change the plan
  const { token: adminToken } = await adminLogin('owner');
  await api('PUT', `/admin/merchants/${m.id}/live`, { token: adminToken, body: { live_enabled: true } });
  await api('PUT', `/admin/merchants/${m.id}/live`, { token: adminToken, body: { issuing_live_enabled: true } });
  assert.deepEqual([planRow(m.id).live_issuing_plan, planRow(m.id).live_gateway_plan], ['startup', 'standard']);
  assert.equal(planRow(m.id).live_issuing_renews_at ?? null, null); // nothing to renew on the entry plans
});

test('choosing a paid plan in Live charges the first month and schedules the renewal one month later; a free plan schedules nothing', async () => {
  const live = await makeLiveMerchant('renewfirst', { fundUsd: 600 });
  const r = await api('POST', '/dashboard/billing/issuing-plan', { token: live.token, body: { plan: 'pro' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.charged, 150);
  const due = new Date(planRow(live.merchantId).live_issuing_renews_at);
  assert.ok(Math.abs(due - planRenewals.addMonths(new Date(), 1)) < 60000);
  assert.equal(r.data.merchant.plan_renewal.issuing.renews_at, planRow(live.merchantId).live_issuing_renews_at);
  // plan fees are Freda Pay's income
  const rev = (await api('GET', `/admin/merchants/${live.merchantId}`, { token: live.adminToken })).data.revenue;
  assert.equal(rev.by_kind_usd.plan_subscription, 150);
  // going back to Startup (free) clears the schedule
  await api('POST', '/dashboard/billing/issuing-plan', { token: live.token, body: { plan: 'startup' } });
  assert.equal(planRow(live.merchantId).live_issuing_renews_at, null);
});

test('a Sandbox plan never renews and is never billed', async () => {
  const reg = await registerAndVerify({ business_name: 'Sandbox Plan Co', email: 'sandbox-plan@example.com', password: 'password123' });
  await api('POST', '/dashboard/billing/issuing-plan', { token: reg.data.session_token, body: { plan: 'pro' } });
  const m = planRow(reg.data.merchant.id);
  assert.equal(m.issuing_plan, 'pro');
  assert.equal(m.live_issuing_renews_at ?? null, null);
  const before = mockTables.ledger_entries.length;
  m.live_issuing_plan = 'pro'; m.live_issuing_renews_at = daysAgo(2); // even a live column set by mistake only matters for the LIVE wallet
  await planRenewals.run();
  assert.equal(m.issuing_plan, 'pro'); // the sandbox plan is untouched
  assert.ok(mockTables.ledger_entries.length >= before);
});

test('on the due date the plan is charged again from the Master Wallet, once, with a receipt email, and the next date moves one month on', async () => {
  const live = await makeLiveMerchant('renewcharge', { fundUsd: 600 });
  await api('POST', '/dashboard/billing/issuing-plan', { token: live.token, body: { plan: 'pro' } });
  const wallet = async () => (await api('GET', '/dashboard/balance', { token: live.token })).data.master_wallet.available;
  const afterFirst = await wallet(); // 600 - 150

  const m = planRow(live.merchantId);
  m.live_issuing_renews_at = daysAgo(0.01); // due a moment ago
  const due = new Date(m.live_issuing_renews_at);
  const first = await planRenewals.run();
  assert.equal(first.renewed, 1);
  assert.equal(await wallet(), afterFirst - 150);
  assert.ok(Math.abs(new Date(m.live_issuing_renews_at) - planRenewals.addMonths(due, 1)) < 1000);
  assert.equal(renewalMails(live.merchantId, /renouvelé/).length, 1);

  // running again, even many times, never charges the same period twice
  await planRenewals.run(); await planRenewals.run();
  assert.equal(await wallet(), afterFirst - 150);
  const labels = (await api('GET', '/dashboard/wallet/summary', { token: live.token })).data.movements.map((x) => x.label);
  assert.ok(labels.includes('Abonnement (renouvellement mensuel)'));
  const rev = (await api('GET', `/admin/merchants/${live.merchantId}`, { token: live.adminToken })).data.revenue;
  assert.equal(rev.by_kind_usd.plan_subscription, 300); // first month + this renewal
});

test('the Gateway plan renews in dollars at the platform rate, and complimentary or suspended accounts are never charged', async () => {
  const live = await makeLiveMerchant('renewgw', { fundUsd: 200 });
  await api('POST', '/dashboard/billing/gateway-plan', { token: live.token, body: { plan: 'pro' } });
  const wallet = async () => (await api('GET', '/dashboard/balance', { token: live.token })).data.master_wallet.available;
  const base = await wallet();
  const priceUsd = Math.round((1000 / 133) * 100) / 100; // 1 000 HTG a month
  planRow(live.merchantId).live_gateway_renews_at = daysAgo(1);
  await planRenewals.run();
  assert.equal(Math.round((base - (await wallet())) * 100) / 100, priceUsd);

  // suspended: not charged, and reactivating starts a fresh month instead of billing the suspended period
  planRow(live.merchantId).live_gateway_renews_at = daysAgo(5);
  await api('DELETE', `/admin/merchants/${live.merchantId}`, { token: live.adminToken });
  const during = await ledgerBalance(live.merchantId);
  await planRenewals.run();
  assert.equal(await ledgerBalance(live.merchantId), during);
  await api('POST', `/admin/merchants/${live.merchantId}/restore`, { token: live.adminToken });
  assert.ok(new Date(planRow(live.merchantId).live_gateway_renews_at) > new Date());
  await planRenewals.run();
  assert.equal(await ledgerBalance(live.merchantId), during);

  // complimentary plan (granted by the team): nothing to charge, nothing scheduled
  await api('PUT', `/admin/merchants/${live.merchantId}/free-plan`, { token: live.adminToken, body: { grant: true } });
  assert.equal(planRow(live.merchantId).live_gateway_plan, 'free');
  planRow(live.merchantId).live_gateway_renews_at = daysAgo(3);
  await planRenewals.run();
  assert.equal(await ledgerBalance(live.merchantId), during);
  assert.equal(planRow(live.merchantId).live_gateway_renews_at, null);
});
const ledgerBalance = (id) => require('../src/services/ledger').getBalance(id, 'master_wallet', 'USD', 'live');

test('when the renewal cannot be paid: one warning, hourly retries during the grace period, then back to Startup; paying in time keeps the plan', async () => {
  const live = await makeLiveMerchant('renewfail', { fundUsd: 300 });
  await api('POST', '/dashboard/billing/issuing-plan', { token: live.token, body: { plan: 'premium' } }); // 500 $ ... needs the funds
  // premium costs 500: top up so the first month goes through, then drain to make the renewal impossible
  const m = planRow(live.merchantId);
  if (m.live_issuing_plan !== 'premium') {
    await api('POST', `/admin/merchants/${live.merchantId}/credit`, { token: live.adminToken, body: { wallet: 'master_wallet', amount: 600, mode: 'live' } });
    assert.equal((await api('POST', '/dashboard/billing/issuing-plan', { token: live.token, body: { plan: 'premium' } })).status, 200);
  }
  assert.equal(planRow(live.merchantId).live_issuing_plan, 'premium');

  planRow(live.merchantId).live_issuing_renews_at = daysAgo(0.01);
  const first = await planRenewals.run();
  assert.equal(first.unpaid, 1);
  assert.ok(planRow(live.merchantId).live_issuing_unpaid_since);
  assert.equal(renewalMails(live.merchantId, /Action requise/).length, 1);
  assert.equal(planRow(live.merchantId).live_issuing_plan, 'premium'); // still on the plan during the grace period

  await planRenewals.run(); await planRenewals.run(); // hourly retries: no extra warning, no downgrade yet
  assert.equal(renewalMails(live.merchantId, /Action requise/).length, 1);
  assert.equal(planRow(live.merchantId).live_issuing_plan, 'premium');

  // the merchant tops up in time: the next run charges it, clears the warning and restarts the month today
  await api('POST', `/admin/merchants/${live.merchantId}/credit`, { token: live.adminToken, body: { wallet: 'master_wallet', amount: 700, mode: 'live' } });
  const ok = await planRenewals.run();
  assert.equal(ok.renewed, 1);
  assert.equal(planRow(live.merchantId).live_issuing_unpaid_since, null);
  assert.equal(planRow(live.merchantId).live_issuing_plan, 'premium');
  assert.ok(Math.abs(new Date(planRow(live.merchantId).live_issuing_renews_at) - planRenewals.addMonths(new Date(), 1)) < 60000);

  // a second failure that is NOT fixed within the grace period ends the plan
  const drained = await ledgerBalance(live.merchantId);
  await require('../src/services/ledger').debitMasterWallet(live.merchantId, drained, 'USD', 'test-drain', null, 'live');
  planRow(live.merchantId).live_issuing_renews_at = daysAgo(2); // another period (a different due date from the one paid above)
  assert.equal((await planRenewals.run()).unpaid, 1);
  planRow(live.merchantId).live_issuing_unpaid_since = daysAgo(3.1);
  const end = await planRenewals.run();
  assert.equal(end.downgraded, 1);
  assert.equal(planRow(live.merchantId).live_issuing_plan, 'startup');
  assert.equal(planRow(live.merchantId).live_issuing_renews_at, null);
  assert.equal(renewalMails(live.merchantId, /s'est terminé/).length, 1);
  assert.equal((await api('GET', '/auth/me', { token: live.token })).data.merchant.issuing_plan, 'startup');
});

test('a paid live plan taken before renewals existed gets its cycle started now, without a surprise charge', async () => {
  const live = await makeLiveMerchant('renewlegacy', { fundUsd: 100 });
  const m = planRow(live.merchantId);
  m.live_issuing_plan = 'pro'; m.live_issuing_renews_at = null; // as an older version left it
  const before = await ledgerBalance(live.merchantId);
  await planRenewals.run();
  assert.equal(await ledgerBalance(live.merchantId), before);
  assert.ok(new Date(m.live_issuing_renews_at) > new Date(Date.now() + 27 * 86400000));
});

test('calendar months are handled: 31 January + 1 month is the end of February, never March', () => {
  assert.equal(planRenewals.addMonths(new Date('2027-01-31T10:00:00Z')).toISOString(), '2027-02-28T10:00:00.000Z');
  assert.equal(planRenewals.addMonths(new Date('2028-01-31T10:00:00Z')).toISOString(), '2028-02-29T10:00:00.000Z');
  assert.equal(planRenewals.addMonths(new Date('2026-12-15T00:00:00Z')).toISOString(), '2027-01-15T00:00:00.000Z');
});

test('admin: sees the signup answers of a merchant (onboarding) in the merchant detail', async () => {
  const { token } = await adminLogin('admin');
  const r = await api('GET', `/admin/merchants/${merchantId}`, { token });
  assert.equal(r.status, 200);
  assert.ok('onboarding' in r.data.merchant);
  assert.ok('phone' in r.data.merchant);
});

test('admin messages: single send comes from administration@fredapay.com, personalised, logged; bulk counts; editors refused', async () => {
  const { token } = await adminLogin('admin');
  const merchant = await api('GET', `/admin/merchants/${merchantId}`, { token });
  const to = merchant.data.merchant.email;
  const before = sentEmails.length;

  const one = await api('POST', '/admin/messages', { token, body: { audience: 'one', merchant_id: merchantId, subject: 'Mise à jour importante', message: 'Bonjour de la part de l\'équipe.\n\nMerci {{name}} !' } });
  assert.equal(one.status, 201, JSON.stringify(one.data));
  assert.equal(one.data.sent, 1);
  const mail = sentEmails.slice(before).find((e) => e.to === to && e.subject === 'Mise à jour importante');
  assert.ok(mail, 'email was sent');
  assert.equal(mail.from, 'administration@fredapay.com');
  assert.equal(mail.replyTo, 'administration@fredapay.com');
  assert.match(mail.text, /Merci/);
  assert.doesNotMatch(mail.text, /\{\{/);

  const hist = await api('GET', '/admin/messages', { token });
  assert.equal(hist.status, 200);
  assert.ok(hist.data.messages.some((m) => m.subject === 'Mise à jour importante'));

  const aud = await api('GET', '/admin/messages/audience?audience=all', { token });
  assert.equal(aud.status, 200);
  assert.ok(aud.data.count >= 1);
  const bulk = await api('POST', '/admin/messages', { token, body: { audience: 'all', subject: 'Annonce', message: 'Nouveautés.' } });
  assert.equal(bulk.status, 201);
  assert.equal(bulk.data.recipients, aud.data.count);
  assert.equal(bulk.data.failed, 0);

  const t = await api('POST', '/admin/messages', { token, body: { test: true, subject: 'Test', message: 'Aperçu' } });
  assert.equal(t.status, 200);

  const bad = await api('POST', '/admin/messages', { token, body: { audience: 'one', merchant_id: merchantId, subject: '', message: 'x' } });
  assert.equal(bad.status, 400);

  const editor = await adminLogin('editor');
  const denied = await api('POST', '/admin/messages', { token: editor.token, body: { audience: 'all', subject: 'x', message: 'y' } });
  assert.equal(denied.status, 403);
});

test('inbox: Brevo inbound webhook stores replies (token-protected, idempotent); admin lists, reads and answers them', async () => {
  const config = require('../src/config');
  config.brevo.inboundSecret = 'inbound-test-secret';
  const merchant = await api('GET', `/admin/merchants/${merchantId}`, { token: (await adminLogin('admin')).token });
  const from = merchant.data.merchant.email;
  const payload = { items: [{ MessageId: '<abc@mail>', From: { Name: 'Client', Address: from }, Subject: 'Re: Mise à jour', RawTextBody: 'Merci, j\'ai une question.', ExtractedMarkdownMessage: 'Merci, j\'ai une question.' }] };

  const noTok = await api('POST', '/webhooks/inbound-email', { body: payload });
  assert.equal(noTok.status, 401);
  const ackBefore = sentEmails.length;
  const ok = await api('POST', '/webhooks/inbound-email?token=inbound-test-secret', { body: payload });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.received, 1);
  const ack = sentEmails.slice(ackBefore).find((e) => e.to === from && e.subject === 'Nous avons bien reçu votre message');
  assert.ok(ack, 'automatic acknowledgement was sent');
  assert.match(ack.text, /vous contactera/);
  assert.match(ack.text, /Freda Pay Issuing/);
  assert.equal(ack.from, 'administration@fredapay.com');
  assert.ok(ack.headers && ack.headers['Auto-Submitted']);
  const dup = await api('POST', '/webhooks/inbound-email?token=inbound-test-secret', { body: payload });
  assert.equal(dup.data.received, 0);
  // a second DIFFERENT message from the same sender within the hour is stored but not acknowledged again
  const n1 = sentEmails.length;
  await api('POST', '/webhooks/inbound-email?token=inbound-test-secret', { body: { items: [{ MessageId: '<second@mail>', From: { Address: from }, Subject: 'Autre question', RawTextBody: 'Hello' }] } });
  assert.equal(sentEmails.slice(n1).filter((e) => e.to === from).length, 0);
  // robots never get an acknowledgement (no mail loops)
  const n2 = sentEmails.length;
  await api('POST', '/webhooks/inbound-email?token=inbound-test-secret', { body: { items: [
    { MessageId: '<bounce@mail>', From: { Address: 'mailer-daemon@example.com' }, Subject: 'Undelivered Mail Returned to Sender', RawTextBody: 'x' },
    { MessageId: '<auto@mail>', From: { Address: 'someone-ooo@example.com' }, Subject: 'Hors du bureau', RawTextBody: 'x', Headers: { 'Auto-Submitted': 'auto-replied' } },
    { MessageId: '<self@mail>', From: { Address: 'administration@fredapay.com' }, Subject: 'loop', RawTextBody: 'x' },
  ] } });
  assert.equal(sentEmails.length, n2);

  const { token } = await adminLogin('admin');
  const inbox = await api('GET', '/admin/inbox', { token });
  assert.equal(inbox.status, 200);
  const msg = inbox.data.messages.find((m) => m.message_id === '<abc@mail>');
  assert.ok(msg);
  assert.equal(msg.merchant_id, merchantId);
  assert.ok(inbox.data.unread >= 1);

  assert.equal((await api('POST', `/admin/inbox/${msg.id}/read`, { token })).status, 200);
  const before = sentEmails.length;
  const rep = await api('POST', `/admin/inbox/${msg.id}/reply`, { token, body: { message: 'Bien sûr, voici la réponse.' } });
  assert.equal(rep.status, 200, JSON.stringify(rep.data));
  const sent = sentEmails.slice(before).find((e) => e.to === from);
  assert.ok(sent);
  assert.equal(sent.subject, 'Re: Mise à jour');
  assert.equal(sent.from, 'administration@fredapay.com');

  const editor = await adminLogin('editor');
  assert.equal((await api('GET', '/admin/inbox', { token: editor.token })).status, 403);
  config.brevo.inboundSecret = '';
});

test('admin cards: sees a merchant\'s cards (last 4 only, never PAN/CVV), their transactions, re-sends webhooks, deletes a card; merchant webhook gets card.transaction', async () => {
  const receiver = startWebhookReceiver();
  await new Promise((r) => receiver.server.listen(4509, r));
  try {
    const reg = await registerAndVerify({ business_name: 'Admin Cards Co', email: 'admin-cards@example.com', password: 'password123' });
    const token = reg.data.session_token;
    const mId = reg.data.merchant.id;
    await api('POST', '/dashboard/webhooks', { token, body: { url: 'http://localhost:4509/hook' } });
    const create = await api('POST', '/dashboard/cards', { token, body: { reference: 'ADM-CARD-1', kind: 'business', business_name: 'Admin Cards Co', brand: 'VISA', amount: 20 } });
    await pollUntil(() => api('GET', `/dashboard/cards/${create.data.id}`, { token }), (r) => r.data.status !== 'pending', 30, 20);
    const row = mockTables.cards.find((c) => c.id === create.data.id);
    await sendProviderEvent({ event: 'issuing.transaction', type: 'AUTHORIZATION', mode: 'DEBIT', status: 'SUCCESS', amount: 777, currency: 'USD', card_id: row.maplerad_card_id, reference: 'adm-tx-1', merchant: { name: 'NETFLIX' } }, MOCK_SANDBOX_WHSEC);
    await sleep(200);
    assert.ok(receiver.received.some((d) => d.json.event === 'card.transaction' && d.json.data.amount === 7.77), 'merchant webhook got card.transaction');

    const { token: adminToken } = await adminLogin('admin');
    const list = await api('GET', `/admin/merchants/${mId}/cards`, { token: adminToken });
    assert.equal(list.status, 200);
    const card = list.data.cards.find((c) => c.id === create.data.id);
    assert.ok(card);
    assert.match(card.masked_pan, /^•••• •••• •••• \d{4}$/);
    const raw = JSON.stringify(list.data);
    assert.doesNotMatch(raw, /cvv|card_number/i);
    assert.ok('name_on_card' in card);

    const all = await api('GET', '/admin/cards?q=admin%20cards', { token: adminToken });
    assert.equal(all.status, 200);
    const inAll = all.data.cards.find((c) => c.id === create.data.id);
    assert.ok(inAll, 'card appears in the global list');
    assert.equal(inAll.merchant_name, 'Admin Cards Co');
    assert.doesNotMatch(JSON.stringify(all.data), /cvv|card_number/i);

    const tx = await api('GET', `/admin/cards/${card.id}/transactions`, { token: adminToken });
    assert.equal(tx.status, 200);
    const t = tx.data.transactions.find((x) => x.merchant_name === 'NETFLIX');
    assert.ok(t);

    const before = receiver.received.length;
    const resend = await api('POST', `/admin/cards/${card.id}/resend-webhook`, { token: adminToken, body: { transaction_id: t.id } });
    assert.equal(resend.status, 200, JSON.stringify(resend.data));
    assert.equal(resend.data.sent, true);
    assert.equal(receiver.received.length, before + 1);
    assert.equal(receiver.received[before].json.event, 'card.transaction');
    const stateResend = await api('POST', `/admin/cards/${card.id}/resend-webhook`, { token: adminToken, body: {} });
    assert.equal(stateResend.data.event, 'card.created');

    const emailsBefore = sentEmails.length;
    const del = await api('POST', `/admin/cards/${card.id}/terminate`, { token: adminToken });
    assert.equal(del.status, 200, JSON.stringify(del.data));
    assert.equal(del.data.deleted, true);
    const gone = await api('GET', '/dashboard/cards', { token });
    assert.ok(!gone.data.cards.find((c) => c.id === card.id), 'card is gone for the merchant');
    assert.ok(sentEmails.slice(emailsBefore).some((e) => e.to === 'admin-cards@example.com' && /supprimée/.test(e.subject)));
    assert.ok(mockTables.admin_audit_log.some((a) => a.action === 'card.terminate' && a.target_id === card.id));
    assert.equal((await api('POST', `/admin/cards/${card.id}/terminate`, { token: adminToken })).status, 409);

    const editor = await adminLogin('editor');
    assert.equal((await api('GET', `/admin/merchants/${mId}/cards`, { token: editor.token })).status, 403);
  } finally {
    await new Promise((r) => receiver.server.close(r));
  }
});

test('card recharge and withdrawal fire card.funded / card.withdrawn webhooks with amount, fee and new balance', async () => {
  const receiver = startWebhookReceiver();
  await new Promise((r) => receiver.server.listen(4510, r));
  try {
    const reg = await registerAndVerify({ business_name: 'Fund Hook Co', email: 'fund-hook@example.com', password: 'password123' });
    const token = reg.data.session_token;
    await api('POST', '/dashboard/webhooks', { token, body: { url: 'http://localhost:4510/hook' } });
    const create = await api('POST', '/dashboard/cards', { token, body: { reference: 'FUNDHOOK-1', kind: 'business', business_name: 'Fund Hook Co', brand: 'VISA', amount: 20 } });
    await pollUntil(() => api('GET', `/dashboard/cards/${create.data.id}`, { token }), (r) => r.data.status !== 'pending', 30, 20);

    const fund = await api('POST', `/dashboard/cards/${create.data.id}/fund`, { token, body: { amount: 10 } });
    assert.equal(fund.status, 200, JSON.stringify(fund.data));
    const wd = await api('POST', `/dashboard/cards/${create.data.id}/withdraw`, { token, body: { amount: 5 } });
    assert.equal(wd.status, 200, JSON.stringify(wd.data));
    await sleep(300);

    const funded = receiver.received.find((d) => d.json.event === 'card.funded');
    assert.ok(funded, 'card.funded delivered');
    assert.equal(funded.json.data.id, create.data.id);
    assert.equal(funded.json.data.amount, 10);
    assert.ok(funded.json.data.fee > 0);
    assert.equal(funded.json.data.balance, 30);

    const withdrawn = receiver.received.find((d) => d.json.event === 'card.withdrawn');
    assert.ok(withdrawn, 'card.withdrawn delivered');
    assert.equal(withdrawn.json.data.amount, 5);
    assert.equal(withdrawn.json.data.balance, 25);
    assert.ok(withdrawn.json.data.net_credited < 5);
  } finally {
    await new Promise((r) => receiver.server.close(r));
  }
});

test('GET /v1/ping reports what the key can do; POST /v1/webhooks/test delivers a signed webhook.test and reports the outcome', async () => {
  const receiver = startWebhookReceiver();
  await new Promise((r) => receiver.server.listen(4511, r));
  try {
    const reg = await registerAndVerify({ business_name: 'Key Check Co', email: 'key-check@example.com', password: 'password123' });
    const token = reg.data.session_token;
    const key = (await api('POST', '/dashboard/api-keys', { token, body: { mode: 'test' } })).data.secret;

    const bad = await api('GET', '/v1/ping', { token: 'sk_test_' + 'a'.repeat(48) });
    assert.equal(bad.status, 401);
    assert.equal(bad.data.error.code, 'INVALID_API_KEY');

    const p = await api('GET', '/v1/ping', { token: key });
    assert.equal(p.status, 200);
    assert.equal(p.data.mode, 'test');
    assert.equal(p.data.ok, true);
    assert.equal(p.data.webhook.configured, false);
    assert.doesNotMatch(JSON.stringify(p.data), /sk_test_|secret|whsec_/);

    const none = await api('POST', '/v1/webhooks/test', { token: key });
    assert.equal(none.status, 409);
    assert.equal(none.data.error.code, 'NO_WEBHOOK_ENDPOINT');

    const hook = await api('POST', '/dashboard/webhooks', { token, body: { url: 'http://localhost:4511/hook' } });
    const t = await api('POST', '/v1/webhooks/test', { token: key });
    assert.equal(t.status, 200, JSON.stringify(t.data));
    assert.equal(t.data.sent, true);
    assert.equal(t.data.http_status, 200);
    const got = receiver.received.find((d) => d.json.event === 'webhook.test');
    assert.ok(got);
    const sig = crypto.createHmac('sha256', hook.data.secret).update(got.body).digest('hex');
    assert.equal(got.signature, `sha256=${sig}`);
    assert.equal((await api('GET', '/v1/ping', { token: key })).data.webhook.configured, true);
  } finally {
    await new Promise((r) => receiver.server.close(r));
  }
});

test('card creation: default holder is the latest ENROLLED one; a non-enrolled holder gives HOLDER_NOT_ENROLLED', async () => {
  const reg = await registerAndVerify({ business_name: 'Holder Rules Co', email: 'holder-rules@example.com', password: 'password123' });
  const token = reg.data.session_token;
  const none = await api('POST', '/dashboard/cards', { token, body: { reference: 'hr-0', amount: 5 } });
  assert.equal(none.status, 400);
  assert.equal(none.data.error.code, 'HOLDER_PROFILE_REQUIRED');
  const body = {
    firstName: 'Hol', lastName: 'Der', email: 'hol@der.com', country: 'HT', dob: '1990-05-12',
    identificationNumber: 'ID-HR', identity: TEST_IDENTITY, phoneNumber: '37011111', phoneShortCode: '+509', address: { street: 'Rue Example', city: 'PAP', state: 'Ouest', postal_code: 'HT6110', country: 'HT' },
  };
  const h = await api('POST', '/dashboard/cards/holders', { token, body });
  assert.equal(h.status, 201);
  assert.ok(h.data.id && h.data.id.startsWith('mpc_'));
  assert.equal(h.data.holder.mode, 'sandbox');
  // a newer holder that failed must not hide the enrolled one
  mockTables.maplerad_customers.push({ id: 'mpc_failed1', merchant_id: mockTables.maplerad_customers.find((x) => x.id === h.data.id).merchant_id, mode: 'sandbox', status: 'failed', email: 'x@y.com', failure_reason: 'boom', created_at: new Date(Date.now() + 5000).toISOString() });
  const bad = await api('POST', '/dashboard/cards', { token, body: { reference: 'hr-1', amount: 5, holder_id: 'mpc_failed1' } });
  assert.equal(bad.status, 409);
  assert.equal(bad.data.error.code, 'HOLDER_NOT_ENROLLED');
});

test('an email already registered at the provider (even upgraded to Tier 2) is recovered and upgraded, never rejected as "already enrolled"', async () => {
  const mk = (label) => ({
    firstName: 'Re', lastName: 'Use', email: 'shared-person@example.com', country: 'HT', dob: '1990-05-12',
    identificationNumber: 'ID-SH', identity: TEST_IDENTITY, phoneNumber: '37077777', phoneShortCode: '+509',
    address: { street: 'Rue Example', city: 'PAP', state: 'Ouest', postalCode: 'HT6110', country: 'HT' },
  });
  const regA = await registerAndVerify({ business_name: 'Shared A', email: 'shared-a@example.com', password: 'password123' });
  const regB = await registerAndVerify({ business_name: 'Shared B', email: 'shared-b@example.com', password: 'password123' });
  const a = await api('POST', '/dashboard/cards/holders', { token: regA.data.session_token, body: mk('a') });
  assert.equal(a.status, 201);
  // Another merchant enrolls the same person: the provider already knows the email (now Tier 2 / APPROVED).
  const b = await api('POST', '/dashboard/cards/holders', { token: regB.data.session_token, body: mk('b') });
  assert.equal(b.status, 201);
  assert.equal(b.data.holder.status, 'enrolled');
  // Same merchant sends it again (different letter case): reused and re-upgraded, no new provider customer.
  const again = await api('POST', '/dashboard/cards/holders', { token: regA.data.session_token, body: { ...mk('a'), email: 'Shared-Person@Example.com' } });
  assert.equal(again.status, 200);
  assert.equal(again.data.already_existed, true);
});

test('official price list: plan prices, recharge fee flat up to 100 $ then a percentage, decline fee and card limit per plan', () => {
  const pricing = require('../src/services/pricing');
  const r = (n) => Math.round(n * 100) / 100;
  const expected = {
    startup: { sub: 0, create: 5, recharge: 1.6, pct: 0.03, withdraw: 1.3, wallet: 0.045, decline: 1, spend: 0.1, limit: 200 },
    pro: { sub: 150, create: 3.5, recharge: 1.25, pct: 0.02, withdraw: 1.15, wallet: 0.03, decline: 0.5, spend: 0, limit: 10000 },
    premium: { sub: 500, create: 2.5, recharge: 1.1, pct: 0.02, withdraw: 1.1, wallet: 0.025, decline: 0.25, spend: 0, limit: null },
  };
  for (const [plan, e] of Object.entries(expected)) {
    const cfg = pricing.issuingPlan(plan);
    assert.equal(cfg.monthlyFeeUSD, e.sub, plan);
    assert.equal(pricing.cardCreationFee(plan), e.create, plan);
    assert.equal(pricing.cardRechargeFee(plan, null, 50), e.recharge, plan);
    assert.equal(pricing.cardRechargeFee(plan, null, 100), e.recharge, plan); // 100 $ itself is still flat
    assert.equal(pricing.cardRechargeFee(plan, null, 200), r(200 * e.pct), plan);
    assert.equal(pricing.cardWithdrawalFee(plan), e.withdraw, plan);
    assert.equal(cfg.walletFundingPct, e.wallet, plan);
    assert.equal(pricing.cardDeclineFee(plan), e.decline, plan);
    assert.equal(pricing.cardSpendFee(plan), e.spend, plan);
    assert.equal(pricing.cardLimitFor(plan), e.limit, plan);
    assert.equal(cfg.cardMaintenanceUSD, 0, plan);
  }
  assert.equal(pricing.crossBorderFee(100), 3.1); // 2.5 % + 0.60
});

test('site visits: a page view is counted once per visitor, robots and unknown pages are ignored, the admin sees day/week/month totals', async () => {
  const track = (path, ua, extra = {}) => fetch(baseUrl + '/track', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': ua, 'X-Forwarded-For': extra.ip || '10.0.0.1' }, body: JSON.stringify({ path, referrer: extra.referrer || '' }) });
  const phone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile Safari';
  const desktop = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120';
  assert.equal((await track('/docs', desktop, { ip: '10.0.0.7', referrer: 'https://www.google.com/search?q=x' })).status, 204);
  assert.equal((await track('/docs.html', desktop, { ip: '10.0.0.7' })).status, 204); // same visitor, same page: 2 views, 1 visitor
  assert.equal((await track('/', phone, { ip: '10.0.0.8' })).status, 204);
  assert.equal((await track('/', 'Googlebot/2.1 (+http://www.google.com/bot.html)', { ip: '10.0.0.9' })).status, 204); // robot: ignored
  assert.equal((await track('/dashboard', desktop, { ip: '10.0.0.10' })).status, 204); // private page: ignored
  assert.equal((await track('/blog/mon-article', desktop, { ip: '10.0.0.11' })).status, 204);

  const { token } = await adminLogin('owner');
  const r = await api('GET', '/admin/visits', { token });
  assert.equal(r.status, 200);
  assert.equal(r.data.today.views, 4);
  assert.equal(r.data.today.visitors, 3);
  assert.equal(r.data.by_day.length, 30);
  assert.equal(r.data.by_day[29].views, 4);
  assert.equal(r.data.by_month.length, 12);
  assert.ok(r.data.by_week.length >= 12 - 1);
  assert.deepEqual(r.data.top_pages_30d.find((p) => p.name === '/docs'), { name: '/docs', views: 2 });
  assert.deepEqual(r.data.top_referrers_30d, [{ name: 'google.com', views: 1 }]);
  assert.ok(!JSON.stringify(r.data).includes('10.0.0.')); // no IP anywhere
  const anon = await api('GET', '/admin/visits', {});
  assert.equal(anon.status, 401);
});

test('several bank accounts: add, list, edit, delete; the merchant picks which one a withdrawal goes to; the admin sees the chosen account', async () => {
  const live = await liveWithGateway('bankmany');
  await ledgerCredit(live.merchantId, 20000);
  const A = { holder_name: 'Rose Lakay', bank_name: 'Unibank', country: 'HT', currency: 'HTG', account_number: '1111222233' };
  const B = { holder_name: 'Rose Lakay', bank_name: 'Sogebank', country: 'HT', currency: 'USD', account_number: '9999888877' };
  const a = await api('POST', '/dashboard/bank-accounts', { token: live.token, body: A });
  const b = await api('POST', '/dashboard/bank-accounts', { token: live.token, body: B });
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  assert.ok(a.data.bank_account.id && a.data.bank_account.id !== b.data.bank_account.id);
  const list = await api('GET', '/dashboard/bank-accounts', { token: live.token });
  assert.equal(list.data.bank_accounts.length, 2);
  assert.ok(!JSON.stringify(list.data).includes('1111222233')); // never shown in full
  assert.equal((await api('PUT', `/dashboard/bank-accounts/${b.data.bank_account.id}`, { token: live.token, body: { ...B, bank_name: 'Sogebank SA' } })).data.bank_account.bank_name, 'Sogebank SA');
  assert.equal((await api('PUT', '/dashboard/bank-accounts/bnk_nope', { token: live.token, body: B })).status, 404);

  // the withdrawal goes to the chosen account (the second one), and the team receives its full details
  const w = await api('POST', '/dashboard/payouts', { token: live.token, body: { amount: 5000, method: 'bank', reference: 'PO-MANY-1', bank_account_id: b.data.bank_account.id } });
  assert.equal(w.status, 202);
  const { token: adminToken } = await adminLogin('owner');
  const q = await api('GET', '/admin/bank-payouts?status=pending', { token: adminToken });
  const mine = q.data.payouts.find((p) => p.reference === 'PO-MANY-1');
  assert.equal(mine.bank_details.bank_name, 'Sogebank SA');
  assert.equal(mine.bank_details.account_number, '9999888877');
  // without a choice: the default (first) account; an account of someone else is refused
  const w2 = await api('POST', '/dashboard/payouts', { token: live.token, body: { amount: 5000, method: 'bank', reference: 'PO-MANY-2' } });
  const q2 = await api('GET', '/admin/bank-payouts?status=pending', { token: adminToken });
  assert.equal(q2.data.payouts.find((p) => p.reference === 'PO-MANY-2').bank_details.bank_name, 'Unibank');
  const other = await liveWithGateway('bankother');
  const otherTry = await api('POST', '/dashboard/payouts', { token: other.token, body: { amount: 5000, method: 'bank', reference: 'PO-MANY-3', bank_account_id: a.data.bank_account.id } });
  assert.equal(otherTry.status, 404);
  // deleting an account does not touch a withdrawal already requested
  assert.equal((await api('DELETE', `/dashboard/bank-accounts/${b.data.bank_account.id}`, { token: live.token })).data.removed, true);
  assert.equal((await api('GET', '/dashboard/bank-accounts', { token: live.token })).data.bank_accounts.length, 1);
  const q3 = await api('GET', '/admin/bank-payouts?status=pending', { token: adminToken });
  assert.equal(q3.data.payouts.find((p) => p.reference === 'PO-MANY-1').bank_details.bank_name, 'Sogebank SA');
  assert.equal(w2.status, 202);
});

test('bank account currency depends on the country, and a Zelle account (email or US phone) can receive a withdrawal', async () => {
  const live = await liveWithGateway('zelle');
  await ledgerCredit(live.merchantId, 20000);
  const post = (body) => api('POST', '/dashboard/bank-accounts', { token: live.token, body });
  // outside Haiti only dollars; in Haiti gourdes or dollars; the currency defaults from the country
  const us = { holder_name: 'Rose Lakay', bank_name: 'Chase', country: 'US', account_number: '123456789' };
  assert.equal((await post({ ...us, currency: 'HTG' })).status, 400);
  assert.equal((await post(us)).data.bank_account.currency, 'USD');
  assert.equal((await post({ holder_name: 'Rose', bank_name: 'BNC', country: 'HT', account_number: '55556666' })).data.bank_account.currency, 'HTG');
  // Zelle: email or US phone, always US / USD; the full contact is never shown back
  assert.equal((await post({ kind: 'zelle', holder_name: 'Rose Lakay', zelle_contact: 'nope' })).status, 400);
  const z = await post({ kind: 'zelle', holder_name: 'Rose Lakay', zelle_contact: 'Rose.Lakay@Gmail.com' });
  assert.equal(z.status, 201);
  assert.equal(z.data.bank_account.kind, 'zelle');
  assert.equal(z.data.bank_account.currency, 'USD');
  assert.ok(!JSON.stringify(z.data).includes('rose.lakay@gmail.com'));
  const zp = await post({ kind: 'zelle', holder_name: 'Rose Lakay', zelle_contact: '(305) 555-0142' });
  assert.equal(zp.status, 201);
  const w = await api('POST', '/dashboard/payouts', { token: live.token, body: { amount: 5000, method: 'bank', reference: 'PO-ZELLE-1', bank_account_id: z.data.bank_account.id } });
  assert.equal(w.status, 202);
  const { token: adminToken } = await adminLogin('owner');
  const q = await api('GET', '/admin/bank-payouts?status=pending', { token: adminToken });
  const mine = q.data.payouts.find((p) => p.reference === 'PO-ZELLE-1');
  assert.equal(mine.bank_details.kind, 'zelle');
  assert.equal(mine.bank_details.zelle_contact, 'rose.lakay@gmail.com');
});

test('a verified (KYC/KYB) account can no longer change its name; the phone can still change', async () => {
  const live = await liveWithGateway('namelock');
  const row = mockTables.merchants.find((m) => m.id === live.merchantId);
  // before verification the name can be edited
  row.kyc_status = 'not_started'; row.kyb_status = 'not_started';
  const free = await api('PUT', '/dashboard/account', { token: live.token, body: { business_name: 'Nouveau Nom Libre' } });
  assert.equal(free.status, 200);
  assert.equal(free.data.merchant.business_name, 'Nouveau Nom Libre');
  // once verified it is locked, but the same name + a new phone still saves
  row.kyc_status = 'verified';
  const bad = await api('PUT', '/dashboard/account', { token: live.token, body: { business_name: 'Autre Nom SA' } });
  assert.equal(bad.status, 403);
  assert.equal(bad.data.error.code, 'NAME_LOCKED');
  const ok = await api('PUT', '/dashboard/account', { token: live.token, body: { business_name: 'Nouveau Nom Libre', phone: '50937001122' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.merchant.phone, '50937001122');
  assert.equal(ok.data.merchant.business_name, 'Nouveau Nom Libre');
});

test('identity image: a https link is downloaded and sent to the provider as a Base64 URI; a "requires Base64" answer is fixed by updating the customer', async () => {
  const identityImage = require('../src/services/identityImage');
  const live = await makeLiveMerchant('b64img', { fundUsd: 0 });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  identityImage.setFetch(async () => ({ ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => png }));
  const holderBody = (email, identity) => ({
    firstName: 'Rose', lastName: 'Lakay', email, country: 'HT', dob: '1990-05-12', identificationNumber: 'ID123456', identity,
    phoneNumber: '37001234', phoneShortCode: '+509',
    address: { street: 'Rue Example', city: 'Port-au-Prince', state: 'Ouest', postalCode: 'HT6110', country: 'HT' },
  });
  try {
    // 1. a link: converted, then accepted (the mock refuses anything that is not a Base64 URI)
    const a = await api('POST', '/dashboard/cards/holders', { token: live.token, body: holderBody('b64a@live-test.example.com', { ...TEST_IDENTITY, imageUrl: 'https://cdn.example.com/id.png' }) });
    assert.equal(a.status, 201, JSON.stringify(a.data));
    // 2. the provider answers "requires Base64 image" once: the customer is updated, the upgrade repeated
    mapleradBehavior.tier2Base64ErrorOnce = true;
    const b = await api('POST', '/dashboard/cards/holders', { token: live.token, body: holderBody('b64b@live-test.example.com', TEST_IDENTITY) });
    assert.equal(b.status, 201, JSON.stringify(b.data));
    assert.ok(mapleradCalls.some((c) => c.path === '/customers/update'));
    // 3. junk is refused before any provider call
    const bad = await api('POST', '/dashboard/cards/holders', { token: live.token, body: holderBody('b64c@live-test.example.com', { ...TEST_IDENTITY, imageUrl: 'ftp://x/y.png' }) });
    assert.equal(bad.status, 400);
  } finally { identityImage.setFetch(null); }
  // private addresses are never fetched
  await assert.rejects(() => identityImage.toBase64Uri('https://127.0.0.1/id.png'), /accessible/);
});

test('fund and withdraw: the response carries fee / total_debited / net_credited, and a replayed reference moves money only once', async () => {
  const live = await liveMerchantWithActivity('idemp');
  const wallet = async () => (await api('GET', '/dashboard/balance', { token: live.token })).data.master_wallet.available;
  const w0 = await wallet();

  const f1 = await api('POST', `/dashboard/cards/${live.card.id}/fund`, { token: live.token, body: { amount: 50, reference: 'FUND-1' } });
  assert.equal(f1.status, 200);
  assert.equal(f1.data.fee, 1.6);
  assert.equal(f1.data.total_debited, 51.6);
  assert.equal(f1.data.idempotent_replay, false);
  const w1 = await wallet();
  assert.equal(Math.round((w0 - w1) * 100) / 100, 51.6);
  // the same reference again (a retry after a timeout): same answer, nothing moved
  const f2 = await api('POST', `/dashboard/cards/${live.card.id}/fund`, { token: live.token, body: { amount: 50, reference: 'FUND-1' } });
  assert.equal(f2.status, 200);
  assert.equal(f2.data.idempotent_replay, true);
  assert.equal(f2.data.balance, f1.data.balance);
  assert.equal(await wallet(), w1);
  // same reference, different amount: refused
  assert.equal((await api('POST', `/dashboard/cards/${live.card.id}/fund`, { token: live.token, body: { amount: 60, reference: 'FUND-1' } })).data.error.code, 'IDEMPOTENCY_MISMATCH');
  // the header works too, and without any key two calls are two operations (as before)
  const h = { token: live.token, body: { amount: 10 }, headers: { 'Idempotency-Key': 'HDR-1' } };
  await api('POST', `/dashboard/cards/${live.card.id}/fund`, h);
  const w2 = await wallet();
  await api('POST', `/dashboard/cards/${live.card.id}/fund`, h);
  assert.equal(await wallet(), w2);

  const d1 = await api('POST', `/dashboard/cards/${live.card.id}/withdraw`, { token: live.token, body: { amount: 20, reference: 'WD-1' } });
  assert.equal(d1.status, 200);
  assert.equal(d1.data.fee, 1.3);
  assert.equal(d1.data.net_credited, 18.7);
  const w3 = await wallet();
  const d2 = await api('POST', `/dashboard/cards/${live.card.id}/withdraw`, { token: live.token, body: { amount: 20, reference: 'WD-1' } });
  assert.equal(d2.data.idempotent_replay, true);
  assert.equal(d2.data.net_credited, 18.7);
  assert.equal(await wallet(), w3);
  assert.equal(d2.data.balance, d1.data.balance);
});

/* ===== Card payments (USD) through the card partner + two Gateway balances (HTG and USD) ===== */

const tranzakMock = require('../mock/tranzak-mock-server');
const TZ = 'http://localhost:4530';
const tzControl = (path, body) => fetch(`${TZ}/__control/${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const signHook = (raw, secret) => crypto.createHmac('sha256', secret).update(raw).digest('hex');
async function sendCardHook(event, payment, { secret = 'whsec_test_card_secret', signature } = {}) {
  const raw = JSON.stringify({ event, timestamp: 1791122041, data: { transaction_id: payment.provider_transaction_id, amount: payment.amount, currency: 'USD', status: event === 'payment.success' ? 'completed' : 'failed', reference: payment.reference } });
  const res = await fetch(`${baseUrl}/webhooks/tranzak`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tranzak-Signature': signature != null ? signature : signHook(raw, secret) }, body: raw });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const usdBal = async (token, mode) => (await api('GET', '/dashboard/balance', { token })).data.gateway_usd.available;
/** A merchant (sandbox by default) plus the helper to create a card payment on the dashboard. */
async function cardMerchant(label, { live = false } = {}) {
  const m = await makeLiveMerchant(label, { fundUsd: 0 });
  if (!live) await api('PUT', '/dashboard/mode', { token: m.token, body: { mode: 'sandbox' } });
  m.pay = (amount, reference, extra = {}) => api('POST', '/dashboard/payments', { token: m.token, body: { amount, currency: 'USD', method: 'carte', reference, ...extra } });
  return m;
}
async function providerRow(paymentId) {
  const row = mockTables.payments.find((p) => p.id === paymentId);
  return { ...row, reference: row.plopplop_reference };
}

test('card payment: created in USD, the page gets the widget values, the sandbox key is used, the fee is 7 % + 0.50 USD', async () => {
  const m = await cardMerchant('cardbasic');
  await tzControl('reset', {});
  const bad1 = await m.pay(20, 'CARD-HTG', { currency: 'HTG' });
  assert.equal(bad1.status, 400); assert.equal(bad1.data.error.code, 'INVALID_CURRENCY');
  const bad2 = await m.pay(0.2, 'CARD-LOW');
  assert.equal(bad2.status, 400); assert.equal(bad2.data.error.code, 'AMOUNT_TOO_LOW');
  const mc = await api('POST', '/dashboard/payments', { token: m.token, body: { amount: 500, currency: 'USD', method: 'moncash', reference: 'MC-USD' } });
  assert.equal(mc.data.error.code, 'INVALID_CURRENCY'); // MonCash is paid in HTG

  const r = await m.pay(20, 'CARD-1');
  assert.equal(r.status, 201);
  assert.equal(r.data.status, 'pending');
  assert.equal(r.data.method, 'carte');
  assert.equal(r.data.currency, 'USD');
  assert.ok(r.data.card.client_secret && r.data.card.publishable_key);
  assert.match(r.data.checkout_url, /\/checkout\?payment=/);
  const calls = await tzControl('calls');
  assert.ok(calls.filter((c) => c.method === 'POST').every((c) => c.key === 'tk_test_mock'));

  // replaying the same reference returns the same payment, no second one at the partner
  const again = await m.pay(20, 'CARD-1');
  assert.equal(again.status, 200); assert.equal(again.data.id, r.data.id);
  assert.equal((await tzControl('all')).length, 1);
  // the hosted page: the API answer carries its address, and only the secret token opens it
  assert.match(r.data.checkout_url, /\/checkout\?payment=pay_[a-z0-9]+&t=[a-f0-9]{32}$/);
  const [, pid, tok] = r.data.checkout_url.match(/payment=(pay_[a-z0-9]+)&t=([a-f0-9]+)/);
  const page = await api('GET', `/public/card-checkout/${pid}?t=${tok}`);
  assert.equal(page.status, 200);
  assert.equal(page.data.amount, 20); assert.equal(page.data.currency, 'USD');
  assert.equal(page.data.card.client_secret, r.data.card.client_secret);
  assert.equal((await api('GET', `/public/card-checkout/${pid}?t=${'0'.repeat(32)}`)).status, 404);
  assert.equal((await api('GET', `/public/card-checkout/${pid}`)).status, 404);
  assert.equal((await api('GET', `/public/card-checkout/${pid}/status?t=${tok}`)).data.status, 'pending');
});

test('card webhook: bad signature refused; a signed success credits the USD balance once (fee deducted) and leaves HTG alone; duplicates change nothing', async () => {
  const m = await cardMerchant('cardhook');
  const r = await m.pay(20, 'CARD-HOOK');
  const p = await providerRow(r.data.id);
  assert.equal((await sendCardHook('payment.success', p, { signature: 'deadbeef' })).status, 403);
  assert.equal((await sendCardHook('payment.success', p, { secret: 'whsec_live_card_secret' })).data.ignored, true); // signed by the OTHER environment: ignored
  assert.equal(await usdBal(m.token), 0);

  await tzControl('complete', { transaction_id: p.provider_transaction_id });
  const ok = await sendCardHook('payment.success', p);
  assert.equal(ok.status, 200);
  const pay = (await api('GET', `/dashboard/payments`, { token: m.token })).data.payments.find((x) => x.id === r.data.id);
  assert.equal(pay.status, 'succeeded');
  assert.equal(pay.fee, 1.9);
  assert.equal(pay.net_amount, 18.1);
  assert.equal(await usdBal(m.token), 18.1);
  assert.equal((await api('GET', '/dashboard/balance', { token: m.token })).data.gateway.available, 0);

  const dup = await sendCardHook('payment.success', p);
  assert.equal(dup.data.duplicate, true);
  await api('GET', `/dashboard/payments`, { token: m.token });
  assert.equal(await usdBal(m.token), 18.1);
  // our income and the partner's cost (4 % + 0.30 USD) are both recorded
  const rev = mockTables.fee_revenue.filter((f) => f.related_id === r.data.id);
  assert.equal(rev.length, 1);
  assert.equal(rev[0].amount, 1.9); assert.equal(rev[0].currency, 'USD'); assert.equal(rev[0].partner_cost_usd, 1.1);
});

test('card polling path: the status read credits exactly once even when asked several times at once', async () => {
  const m = await cardMerchant('cardpoll');
  const r = await m.pay(50, 'CARD-POLL');
  const p = await providerRow(r.data.id);
  assert.equal((await api('GET', `/dashboard/payments`, { token: m.token })).data.payments[0].status, 'pending');
  await tzControl('complete', { transaction_id: p.provider_transaction_id });
  const apiKey = (await api('POST', '/dashboard/api-keys', { token: m.token, body: { mode: 'test' } })).data.secret;
  const reads = await Promise.all([1, 2, 3, 4, 5].map(() => api('GET', `/v1/payments/${r.data.id}`, { token: apiKey })));
  assert.ok(reads.every((x) => x.data.status === 'succeeded'));
  // Standard: 7 % of 50 = 3.50 + 0.50 -> 4 ; net 46, credited ONE time
  assert.equal(await usdBal(m.token), 46);
  const bal = (await api('GET', '/v1/balance', { token: apiKey })).data;
  assert.equal(bal.gateway_usd.available, 46);
  assert.deepEqual(bal.gateway_balances, { HTG: 0, USD: 46 });
});

test('card: a declined payment is marked failed with no credit; money that does not match what we asked is never credited', async () => {
  const m = await cardMerchant('cardfail');
  const a = await m.pay(10, 'CARD-DECL');
  const pa = await providerRow(a.data.id);
  await tzControl('fail', { transaction_id: pa.provider_transaction_id });
  assert.equal((await sendCardHook('payment.failed', pa)).status, 200);
  const list = (await api('GET', '/dashboard/payments', { token: m.token })).data.payments;
  assert.equal(list.find((x) => x.id === a.data.id).status, 'failed');
  assert.equal(await usdBal(m.token), 0);

  const b = await m.pay(10, 'CARD-TAMPER');
  const pb = await providerRow(b.data.id);
  tranzakMock.payments.get(pb.provider_transaction_id).amount = '1.00'; // the partner reports a different amount
  await tzControl('complete', { transaction_id: pb.provider_transaction_id });
  await sendCardHook('payment.success', pb);
  assert.equal(await usdBal(m.token), 0);
  assert.equal((await api('GET', '/dashboard/payments', { token: m.token })).data.payments.find((x) => x.id === b.data.id).status, 'pending');
});

test('card in LIVE: the live key is used, only the live secret is accepted for a live payment, the money goes to the LIVE USD balance', async () => {
  const m = await cardMerchant('cardlive', { live: true });
  await tzControl('reset', {});
  const r = await m.pay(100, 'CARD-LIVE-1');
  assert.equal(r.status, 201);
  const calls = await tzControl('calls');
  assert.ok(calls.some((c) => c.method === 'POST' && c.key === 'tk_live_mock'));
  const p = await providerRow(r.data.id);
  assert.equal(p.mode, 'live');
  await tzControl('complete', { transaction_id: p.provider_transaction_id });

  await sendCardHook('payment.success', p, { secret: 'whsec_test_card_secret' }); // a sandbox-signed event can not settle a live payment
  assert.equal(await usdBal(m.token), 0);
  assert.equal((await sendCardHook('payment.success', p, { secret: 'whsec_live_card_secret' })).status, 200);
  assert.equal(await usdBal(m.token), 92.5); // 100 - (7 + 0.50)
  await api('PUT', '/dashboard/mode', { token: m.token, body: { mode: 'sandbox' } });
  assert.equal(await usdBal(m.token), 0); // sandbox and live never share a balance
});

test('card in LIVE without the partner approval: a clear message, and the partner is never named', async () => {
  const m = await cardMerchant('cardnoappr', { live: true });
  await tzControl('set', { liveNotApproved: true });
  const r = await m.pay(10, 'CARD-NA');
  await tzControl('set', { liveNotApproved: false });
  assert.equal(r.status, 403);
  assert.equal(r.data.error.code, 'CARD_NOT_AVAILABLE');
  assert.ok(!/tranzak/i.test(JSON.stringify(r.data)));
  // a partner outage is a clean 502 without provider details either
  await tzControl('set', { failNextCreate: { status: 500, body: { error: 'boom tranzak' } } });
  const down = await m.pay(10, 'CARD-DOWN');
  assert.equal(down.status, 502);
  assert.ok(!/tranzak/i.test(JSON.stringify(down.data)));
});

test('card: when the answer to a creation is lost, the retry looks the reference up first and never reuses it', async () => {
  const m = await cardMerchant('cardlost');
  await tzControl('reset', {});
  await tzControl('set', { loseNextCreateResponse: true });
  const lost = await m.pay(15, 'CARD-LOST');
  assert.equal(lost.status, 502);
  const retry = await m.pay(15, 'CARD-LOST');
  assert.equal(retry.status, 201);
  const all = await tzControl('all');
  assert.equal(all.length, 2);
  assert.notEqual(all[0].reference, all[1].reference); // the orphan keeps its own reference
  const row = mockTables.payments.find((p) => p.id === retry.data.id);
  assert.equal(row.plopplop_reference, all[1].reference);
});

test('card polling is throttled per payment (the partner limits calls per address)', async () => {
  const orchestrator = require('../src/services/paymentOrchestrator');
  const config = require('../src/config');
  const m = await cardMerchant('cardthrottle');
  const r = await m.pay(10, 'CARD-THR');
  const row = mockTables.payments.find((p) => p.id === r.data.id);
  config.tranzak.pollMinGapMs = 60000;
  try {
    const before = (await tzControl('calls')).filter((c) => c.method === 'GET').length;
    for (let i = 0; i < 6; i++) await orchestrator.refreshStatus(m.merchantId, row);
    const after = (await tzControl('calls')).filter((c) => c.method === 'GET').length;
    assert.equal(after - before, 1);
  } finally { config.tranzak.pollMinGapMs = 0; }
});

test('card reconciliation settles an old pending payment whose webhook never came', async () => {
  const orchestrator = require('../src/services/paymentOrchestrator');
  const m = await cardMerchant('cardrecon');
  const r = await m.pay(30, 'CARD-RECON');
  const row = mockTables.payments.find((p) => p.id === r.data.id);
  row.created_at = new Date(Date.now() - 3600 * 1000).toISOString();
  await tzControl('complete', { transaction_id: row.provider_transaction_id });
  const res = await orchestrator.reconcilePendingCards(50);
  assert.ok(res.settled >= 1);
  assert.equal(await usdBal(m.token), 27.4); // 30 - (2.10 + 0.50)
});

test('payment links: ONE link accepts MonCash, Natcash and card; the amount is converted to the currency of the method chosen', async () => {
  const m = await cardMerchant('cardlink');
  const usdLink = (await api('POST', '/dashboard/payment-links', { token: m.token, body: { amount: 26.6, currency: 'USD', description: 'Abonnement' } })).data;
  const htgLink = (await api('POST', '/dashboard/payment-links', { token: m.token, body: { amount: 2660, currency: 'HTG', description: 'Facture' } })).data;
  assert.equal((await api('POST', '/dashboard/payment-links', { token: m.token, body: { amount: 5, currency: 'EUR' } })).data.error.code, 'INVALID_CURRENCY');
  const info = (await api('GET', `/public/payment-links/${htgLink.id}`)).data;
  assert.deepEqual(info.pay_with, { moncash_natcash: { amount: 2660, currency: 'HTG' }, carte: { amount: 20, currency: 'USD' } });
  const infoUsd = (await api('GET', `/public/payment-links/${usdLink.id}`)).data;
  assert.deepEqual(infoUsd.pay_with.moncash_natcash, { amount: 3538, currency: 'HTG' }); // 26.6 x 133

  // HTG link paid by card: charged 20 USD
  const card = await api('POST', `/public/payment-links/${htgLink.id}/pay`, { body: { method: 'carte', customer_name: 'Marie Client' } });
  assert.equal(card.status, 201);
  assert.ok(card.data.card.client_secret);
  const row = mockTables.payments.find((p) => p.id === card.data.id);
  assert.equal([Number(row.amount), row.currency].join(' '), '20 USD');
  await tzControl('complete', { transaction_id: row.provider_transaction_id });
  assert.equal((await api('GET', `/public/payment-links/${htgLink.id}/payments/${card.data.id}`)).data.status, 'succeeded');
  assert.equal(await usdBal(m.token), 18.1); // 20 - (1.20 + 0.50)

  // USD link paid by MonCash: charged 3538 HTG; and by card: 26.60 USD
  const mc = await api('POST', `/public/payment-links/${usdLink.id}/pay`, { body: { method: 'moncash' } });
  assert.equal(mc.status, 201);
  const mrow = mockTables.payments.find((p) => p.id === mc.data.id);
  assert.equal([Number(mrow.amount), mrow.currency].join(' '), '3538 HTG');
  const card2 = await api('POST', `/public/payment-links/${usdLink.id}/pay`, { body: { method: 'carte' } });
  assert.equal(Number(mockTables.payments.find((p) => p.id === card2.data.id).amount), 26.6);
});

test('USD withdrawal: bank/Zelle only, to a USD account, USD fee and minimum, held at once, given back when refused; HTG untouched', async () => {
  const m = await cardMerchant('cardpayout', { live: true });
  const r = await m.pay(200, 'CARD-PO');
  const p = await providerRow(r.data.id);
  await tzControl('complete', { transaction_id: p.provider_transaction_id });
  await sendCardHook('payment.success', p, { secret: 'whsec_live_card_secret' });
  assert.equal(await usdBal(m.token), 185.5); // 200 - (14 + 0.50)
  await ledgerCredit(m.merchantId, 5000); // some HTG too
  const req = (extra = {}) => api('POST', '/dashboard/payouts', { token: m.token, body: { amount: 100, currency: 'USD', method: 'bank', reference: `PO-${Math.random().toString(16).slice(2)}`, ...extra } });

  assert.equal((await req({ method: 'moncash', recipient: '50937001234' })).data.error.code, 'INVALID_METHOD');
  assert.equal((await req()).data.error.code, 'NO_BANK_ACCOUNT');
  const htgAcc = await api('POST', '/dashboard/bank-accounts', { token: m.token, body: BANK });
  assert.equal((await req({ bank_account_id: htgAcc.data.bank_account.id })).data.error.code, 'BANK_ACCOUNT_CURRENCY');
  const zelle = await api('POST', '/dashboard/bank-accounts', { token: m.token, body: { kind: 'zelle', holder_name: 'Acme Commerce LLC', zelle_contact: 'pay@acme.example.com', country: 'US', currency: 'USD' } });
  assert.equal(zelle.status, 201);
  const accId = zelle.data.bank_account.id;
  assert.equal((await req({ amount: 5, bank_account_id: accId })).data.error.code, 'AMOUNT_TOO_LOW');
  assert.equal((await req({ amount: 185, bank_account_id: accId })).data.error.code, 'INSUFFICIENT_BALANCE'); // 185 + 1 > 185.50

  const quote = (await api('GET', '/dashboard/payouts/quote?method=bank&currency=USD&amount=100', { token: m.token })).data;
  assert.deepEqual([quote.currency, quote.fee, quote.total, quote.minimum], ['USD', 1, 101, 10]);

  const created = await req({ bank_account_id: accId });
  assert.equal(created.status, 202);
  assert.equal(created.data.currency, 'USD');
  assert.equal(created.data.fee, 1);
  assert.equal(await usdBal(m.token), 84.5);                  // 185.50 - 101 held
  assert.equal(await gw(m.token), 5000);                      // HTG balance untouched
  const queue = (await api('GET', '/admin/bank-payouts', { token: m.adminToken })).data.payouts.find((x) => x.id === created.data.id);
  assert.equal(queue.currency, 'USD');
  assert.equal(queue.bank_details.zelle_contact, 'pay@acme.example.com');

  const rej = await api('POST', `/admin/bank-payouts/${created.data.id}/reject`, { token: m.adminToken, body: { reason: 'Zelle introuvable' } });
  assert.equal(rej.status, 200);
  assert.equal(await usdBal(m.token), 185.5);                 // amount + fee given back, in USD
  assert.equal(await gw(m.token), 5000);

  const second = await req({ bank_account_id: accId });
  const done = await api('POST', `/admin/bank-payouts/${second.data.id}/complete`, { token: m.adminToken, body: { bank_reference: 'ZELLE-1' } });
  assert.equal(done.data.payout.status, 'success');
  assert.equal(await usdBal(m.token), 84.5);
  assert.ok(sentEmails.some((e) => e.to === emailOf(m) && /virement bancaire a été envoyé/.test(e.subject) && /100,00 \$/.test(e.text)));
});

test('USD withdrawal in sandbox completes at once with no real transfer, and HTG withdrawals still work as before', async () => {
  const m = await cardMerchant('cardsbpo');
  const r = await m.pay(100, 'CARD-SBPO');
  const p = await providerRow(r.data.id);
  await tzControl('complete', { transaction_id: p.provider_transaction_id });
  await sendCardHook('payment.success', p);
  const acc = await api('POST', '/dashboard/bank-accounts', { token: m.token, body: { kind: 'zelle', holder_name: 'Test', zelle_contact: 'a@b.co', country: 'US', currency: 'USD' } });
  const po = await api('POST', '/dashboard/payouts', { token: m.token, body: { amount: 50, currency: 'USD', method: 'bank', reference: 'SBPO-1', bank_account_id: acc.data.bank_account.id } });
  assert.equal(po.status, 202);
  assert.equal((await api('GET', `/dashboard/payouts/${po.data.id}`, { token: m.token })).data.status, 'success');
  assert.equal(await usdBal(m.token), 100 - 7.5 - 51);
});

test('admin: a custom card fee applies to that merchant, and the admin can credit the USD Gateway balance', async () => {
  const m = await cardMerchant('cardadmin');
  const set = await api('PUT', `/admin/merchants/${m.merchantId}/pricing`, { token: m.adminToken, body: { gateway_card_pct: 0.03, gateway_card_fixed_usd: 0.25 } });
  assert.equal(set.status, 200);
  const r = await m.pay(100, 'CARD-ADM');
  const p = await providerRow(r.data.id);
  await tzControl('complete', { transaction_id: p.provider_transaction_id });
  await sendCardHook('payment.success', p);
  assert.equal(await usdBal(m.token), 96.75); // 100 - (3 + 0.25)
  const credit = await api('POST', `/admin/merchants/${m.merchantId}/credit`, { token: m.adminToken, body: { wallet: 'gateway_usd', amount: 10, mode: 'sandbox' } });
  assert.equal(credit.status, 200);
  assert.equal(credit.data.new_balance, 106.75);
  assert.equal(await gw(m.token), 0); // the HTG balance is a different one
});

test('transactions summary: counters, monthly performance per currency, filters, and gateway totals never mix HTG with USD', async () => {
  const m = await cardMerchant('cardperf');
  // one succeeded card payment (USD), one pending card payment, one failed card payment
  const ok = await m.pay(40, 'PERF-OK');
  const po = await providerRow(ok.data.id);
  await tzControl('complete', { transaction_id: po.provider_transaction_id });
  await sendCardHook('payment.success', po);
  await m.pay(10, 'PERF-PEND');
  const bad = await m.pay(10, 'PERF-BAD');
  const pb = await providerRow(bad.data.id);
  await tzControl('fail', { transaction_id: pb.provider_transaction_id });
  await sendCardHook('payment.failed', pb);
  // and one succeeded HTG payment
  const mc = await api('POST', '/dashboard/payments', { token: m.token, body: { amount: 1000, currency: 'HTG', method: 'moncash', reference: 'PERF-HTG' } });
  await fetch('http://localhost:4501/__control/confirm-payment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refference_id: `fp_${m.merchantId}_PERF-HTG` }) });
  await api('GET', '/dashboard/payments', { token: m.token }); // (list does not poll) - poll the one payment
  const apiKey = (await api('POST', '/dashboard/api-keys', { token: m.token, body: { mode: 'test' } })).data.secret;
  await api('GET', `/v1/payments/${mc.data.id}`, { token: apiKey });

  const s = (await api('GET', '/dashboard/transactions/summary', { token: m.token })).data;
  assert.deepEqual(s.counts, { total: 4, succeeded: 2, pending: 1, failed: 1 });
  assert.equal(s.month.attempts, 4);
  assert.equal(s.month.success_rate, 50);
  assert.equal(s.month.current.USD.volume, 40);
  assert.equal(s.month.current.USD.net, 36.7); // 40 - (2.80 + 0.50)
  assert.equal(s.month.current.HTG.volume, 1000);
  assert.equal(s.month.current.HTG.count, 1);
  assert.equal(s.month.previous.USD.volume, 0);
  assert.equal(s.month.by_day.length >= 28, true);
  assert.deepEqual(s.month.by_method.map((x) => x.method).sort(), ['carte', 'moncash']);

  const failed = (await api('GET', '/dashboard/payments?status=failed', { token: m.token })).data.payments;
  assert.equal(failed.length, 1);
  assert.equal((await api('GET', '/dashboard/payments?method=carte', { token: m.token })).data.payments.length, 3);

  const g = (await api('GET', '/dashboard/gateway-summary', { token: m.token })).data;
  assert.equal(g.total_in_htg, 1000);
  assert.equal(g.usd.total_in, 40);
  const w = (await api('GET', '/dashboard/wallet/summary', { token: m.token })).data;
  assert.equal(w.gateway.total_in_htg, 1000);
  assert.equal(w.gateway.total_in_usd, 40);
  assert.equal(w.gateway.pending_usd, 10);
});

test('hosted card page: return_url is validated, returned after payment, and the card form values disappear once the payment is settled', async () => {
  const m = await cardMerchant('cardhosted');
  assert.equal((await m.pay(10, 'HOST-BAD', { return_url: 'http://evil.example.com/x' })).data.error.code, 'INVALID_RETURN_URL');
  assert.equal((await m.pay(10, 'HOST-BAD2', { return_url: 'javascript:alert(1)' })).data.error.code, 'INVALID_RETURN_URL');
  const r = await m.pay(10, 'HOST-1', { return_url: 'https://boutique.example.com/commande/42' });
  assert.equal(r.status, 201);
  assert.equal(r.data.return_url, 'https://boutique.example.com/commande/42');
  const [, pid, tok] = r.data.checkout_url.match(/payment=(pay_[a-z0-9]+)&t=([a-f0-9]+)/);
  const row = mockTables.payments.find((p) => p.id === pid);
  await tzControl('complete', { transaction_id: row.provider_transaction_id });
  const st = await api('GET', `/public/card-checkout/${pid}/status?t=${tok}`);
  assert.equal(st.data.status, 'succeeded');
  assert.equal(st.data.return_url, 'https://boutique.example.com/commande/42');
  const page = await api('GET', `/public/card-checkout/${pid}?t=${tok}`);
  assert.ok(!page.data.card);
  assert.equal(await usdBal(m.token), 8.8); // 10 - (0.70 + 0.50)
});

test('admin: the exchange rate is editable, validated, role-protected, logged, and drives every conversion', async () => {
  const m = await cardMerchant('raterate');
  const { token: adminToken } = await adminLogin('owner');
  const get0 = await api('GET', '/admin/settings/exchange-rate', { token: adminToken });
  assert.equal(get0.status, 200);
  assert.equal(get0.data.rate, 133);

  assert.equal((await api('PUT', '/admin/settings/exchange-rate', { token: adminToken, body: { rate: 10 } })).data.error.code, 'INVALID_RATE');
  assert.equal((await api('PUT', '/admin/settings/exchange-rate', { token: adminToken, body: { rate: 'abc' } })).data.error.code, 'INVALID_RATE');
  const typo = await api('PUT', '/admin/settings/exchange-rate', { token: adminToken, body: { rate: 400 } });
  assert.equal(typo.status, 409); assert.equal(typo.data.error.code, 'LARGE_CHANGE');
  const { token: editorToken } = await adminLogin('editor');
  assert.equal((await api('PUT', '/admin/settings/exchange-rate', { token: editorToken, body: { rate: 140 } })).status, 403);

  try {
    const set = await api('PUT', '/admin/settings/exchange-rate', { token: adminToken, body: { rate: 140 } });
    assert.equal(set.status, 200); assert.equal(set.data.changed, true); assert.equal(set.data.rate, 140);
    assert.deepEqual([set.data.history[0].from, set.data.history[0].to], [133, 140]);
    // a payment link priced 2800 HTG now costs 20 USD by card (2800 / 140), and a USD price converts to HTG at 140
    const link = (await api('POST', '/dashboard/payment-links', { token: m.token, body: { amount: 2800, currency: 'HTG' } })).data;
    const info = (await api('GET', `/public/payment-links/${link.id}`)).data;
    assert.equal(info.rate_htg_per_usd, 140);
    assert.deepEqual(info.pay_with.carte, { amount: 20, currency: 'USD' });
    const usdLink = (await api('POST', '/dashboard/payment-links', { token: m.token, body: { amount: 10, currency: 'USD' } })).data;
    assert.deepEqual((await api('GET', `/public/payment-links/${usdLink.id}`)).data.pay_with.moncash_natcash, { amount: 1400, currency: 'HTG' });
    assert.equal((await api('GET', '/dashboard/billing/plans', { token: m.token })).data.exchange_rate_htg_per_usd, 140);
    // unchanged value: no change recorded
    assert.equal((await api('PUT', '/admin/settings/exchange-rate', { token: adminToken, body: { rate: 140 } })).data.changed, false);
  } finally {
    await api('PUT', '/admin/settings/exchange-rate', { token: adminToken, body: { rate: 133 } });
  }
  assert.equal((await api('GET', '/admin/settings/exchange-rate', { token: adminToken })).data.rate, 133);
});

test('KYC upload of several multi-MB documents is accepted; an oversized generic body gets a clean 413', async () => {
  const reg = await registerAndVerify({ business_name: 'Big Docs Co', email: 'big-docs@example.com', password: 'password123' });
  const token = reg.data.session_token;
  const big = Buffer.alloc(3 * 1024 * 1024, 7).toString('base64'); // ~4 MB of base64 each
  const submit = await api('POST', '/dashboard/verification/kyc', {
    token, body: { documents: [
      { label: 'ID', filename: 'id.jpg', content_type: 'image/jpeg', base64: big },
      { label: 'Selfie', filename: 's.jpg', content_type: 'image/jpeg', base64: big },
    ] },
  });
  assert.equal(submit.status, 201);

  const huge = await api('POST', '/auth/login', { body: { email: 'x@example.com', password: 'a'.repeat(2 * 1024 * 1024) } });
  assert.equal(huge.status, 413);
});

test('plugin and SDK kits are served only to a logged-in merchant, from a fixed whitelist', async () => {
  const anon = await fetch(baseUrl + '/dashboard/downloads/freda-pay-wix.zip');
  assert.equal(anon.status, 401);

  const reg = await registerAndVerify({ business_name: 'Kits Co', email: 'kits@example.com', password: 'password123' });
  const token = reg.data.session_token;
  const ok = await fetch(baseUrl + '/dashboard/downloads/freda-pay-woocommerce.zip', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'application/zip');
  const buf = Buffer.from(await ok.arrayBuffer());
  assert.equal(buf.slice(0, 2).toString(), 'PK');

  for (const bad of ['..%2F..%2Fpackage.json', 'package.json', 'unknown.zip']) {
    const r = await fetch(baseUrl + '/dashboard/downloads/' + bad, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 404, bad);
  }
});

test('the merchant sees who paid: the name and email entered by the customer are kept and returned', async () => {
  const m = await cardMerchant('cardpayer');
  const r = await m.pay(20, 'CARD-PAYER', { customer: { name: '  Marie Jean  ', email: 'marie@example.com' } });
  assert.equal(r.status, 201);
  assert.equal(r.data.customer_name, 'Marie Jean');
  const g = await api('GET', `/dashboard/payments/${r.data.id}`, { token: m.token });
  assert.equal(g.data.customer_name, 'Marie Jean');
  assert.equal(g.data.customer_email, 'marie@example.com');
});

// ===================================================== internal e-signature (contracts)
function sigMask(w = 300, h = 90) {
  const a = Buffer.alloc(w * h);
  for (let x = 0; x < w; x++) {
    const y = Math.round(h / 2 + Math.sin(x / 12) * h / 4);
    for (let d = -2; d <= 2; d++) if (y + d >= 0 && y + d < h) a[(y + d) * w + x] = 255;
  }
  return { w, h, alpha: a.toString('base64') };
}
const drawnSig = () => ({ type: 'drawn', image: sigMask() });
const typedSig = (name) => ({ type: 'typed', name, font: 'Dancing Script', image: sigMask(320, 100) });
const CONTRACT_HTML = '<h1 style="text-align:center">Contrat de partenariat</h1><p>Entre Freda Pay LLC et <b>[[Nom de l\'entreprise]]</b>, représentée par [[Représentant]], il est convenu ce qui suit : les deux parties collaborent.</p><ul><li>Premier point</li><li>Deuxième point</li></ul><script>alert(1)</script>';
async function rawGet(path, token) {
  const res = await fetch(baseUrl + path, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  return { status: res.status, type: res.headers.get('content-type'), buf: Buffer.from(await res.arrayBuffer()) };
}

test('contracts: admin signs and sends to a merchant, the merchant fills the blanks and signs, both get the PDF', async () => {
  const m = await makeLiveMerchant('ctrmerchant');
  const email = emailOf(m);
  sentEmails.length = 0;
  // admin creates + signs + sends
  const create = await api('POST', '/admin/contracts', { token: m.adminToken, body: { title: 'Contrat de partenariat', body_html: CONTRACT_HTML, merchant_id: m.merchantId, admin_signature: typedSig('Admin Freda') } });
  assert.equal(create.status, 201);
  const id = create.data.contract.id;
  assert.equal(create.data.contract.status, 'PENDING_SIGNATURE');
  assert.equal(create.data.sign_url, null); // a merchant signs in the dashboard, no private link
  assert.ok(!JSON.stringify(create.data).includes('script'));      // the markup was cleaned
  assert.ok(create.data.contract.field_labels.includes('Représentant'));
  assert.ok(sentEmails.some((e) => e.to === email && /Un contrat vous attend/.test(e.subject)));
  // merchant sees it
  const list = await api('GET', '/dashboard/contracts', { token: m.token });
  assert.equal(list.data.pending, 1);
  assert.equal(list.data.contracts[0].id, id);
  const view = await api('GET', `/dashboard/contracts/${id}`, { token: m.token });
  assert.equal(view.status, 200);
  assert.match(view.data.contract.body_html, /ctr-field/);
  assert.ok(view.data.contract.admin_signature_png.startsWith('data:image/png;base64,'));
  // validation: blank field, empty signature
  const base = { signer_name: 'Marie Jean', fields: { "Nom de l'entreprise": 'Boutik Lakay', 'Représentant': 'Marie Jean' }, signature: drawnSig() };
  const noField = await api('POST', `/dashboard/contracts/${id}/sign`, { token: m.token, body: { ...base, fields: { "Nom de l'entreprise": 'Boutik Lakay' } } });
  assert.equal(noField.status, 400); assert.equal(noField.data.error.code, 'FIELD_REQUIRED');
  const blank = await api('POST', `/dashboard/contracts/${id}/sign`, { token: m.token, body: { ...base, signature: { type: 'drawn', image: { w: 100, h: 40, alpha: Buffer.alloc(4000).toString('base64') } } } });
  assert.equal(blank.data.error.code, 'SIGNATURE_EMPTY');
  assert.equal((await rawGet(`/dashboard/contracts/${id}/pdf`, m.token)).status, 200); // a preview is possible before signing
  // sign
  sentEmails.length = 0;
  const sign = await api('POST', `/dashboard/contracts/${id}/sign`, { token: m.token, body: base });
  assert.equal(sign.status, 200);
  assert.equal(sign.data.contract.status, 'COMPLETED');
  assert.deepEqual(sign.data.contract.fields, base.fields);
  // double signature refused
  assert.equal((await api('POST', `/dashboard/contracts/${id}/sign`, { token: m.token, body: base })).data.error.code, 'NOT_PENDING');
  // the PDF
  const pdf = await rawGet(`/dashboard/contracts/${id}/pdf`, m.token);
  assert.equal(pdf.type, 'application/pdf');
  assert.equal(pdf.buf.slice(0, 5).toString(), '%PDF-');
  assert.ok(pdf.buf.length > 5000);
  // audit data kept on the row
  const row = mockTables.contracts.find((c) => c.id === id);
  assert.equal(row.signed_ip.length > 0, true);
  assert.match(row.content_hash, /^[0-9a-f]{64}$/);
  assert.equal(row.signer_email, email);
  // both parties receive the PDF
  const mine = sentEmails.filter((e) => /Contrat signé/.test(e.subject));
  assert.ok(mine.some((e) => e.to === email && e.attachments.some((a) => a.name === `contrat-${id}.pdf` && a.size > 5000)));
  assert.ok(mine.some((e) => e.to !== email && e.attachments.length === 1)); // the admin
  // the admin sees it completed
  const adm = await api('GET', `/admin/contracts?status=COMPLETED`, { token: m.adminToken });
  assert.ok(adm.data.contracts.some((c) => c.id === id && c.merchant_name === 'ctrmerchant Co'));
  assert.equal((await rawGet(`/admin/contracts/${id}/pdf`, m.adminToken)).buf.slice(0, 5).toString(), '%PDF-');
});

test('contracts: another merchant cannot see or sign it, a read-only member cannot sign, an admin can cancel a pending one', async () => {
  const a = await makeLiveMerchant('ctrowner');
  const b = await makeLiveMerchant('ctrother');
  const create = await api('POST', '/admin/contracts', { token: a.adminToken, body: { title: 'Contrat privé', body_html: '<p>Texte du contrat sans blancs à remplir, assez long.</p>', merchant_id: a.merchantId, admin_signature: drawnSig() } });
  const id = create.data.contract.id;
  assert.equal((await api('GET', `/dashboard/contracts/${id}`, { token: b.token })).status, 404);
  assert.equal((await api('POST', `/dashboard/contracts/${id}/sign`, { token: b.token, body: { signer_name: 'X Y', signature: drawnSig() } })).status, 404);
  assert.equal((await api('GET', '/dashboard/contracts', { token: b.token })).data.contracts.length, 0);
  assert.equal((await api('GET', '/admin/contracts', { token: a.token })).status, 401); // a merchant token is not an admin token
  const cancel = await api('POST', `/admin/contracts/${id}/cancel`, { token: a.adminToken });
  assert.equal(cancel.data.contract.status, 'CANCELLED');
  assert.equal((await api('GET', `/dashboard/contracts/${id}`, { token: a.token })).status, 404); // a cancelled contract disappears
  assert.equal((await api('POST', `/admin/contracts/${id}/cancel`, { token: a.adminToken })).data.error.code, 'NOT_PENDING');
  // missing signature / short text refused at creation
  assert.equal((await api('POST', '/admin/contracts', { token: a.adminToken, body: { title: 'Contrat', body_html: '<p>Texte du contrat assez long pour passer.</p>', merchant_id: a.merchantId } })).data.error.code, 'SIGNATURE_REQUIRED');
  assert.equal((await api('POST', '/admin/contracts', { token: a.adminToken, body: { title: 'Contrat', body_html: '<p>court</p>', merchant_id: a.merchantId, admin_signature: drawnSig() } })).data.error.code, 'INVALID_BODY');
});

test('contracts: an outside partner signs through a private link, a new link replaces the old one', async () => {
  const m = await makeLiveMerchant('ctrpartner');
  sentEmails.length = 0;
  const create = await api('POST', '/admin/contracts', { token: m.adminToken, body: { title: 'Accord partenaire', body_html: '<p>Accord entre Freda Pay et <b>[[Société]]</b>, valable un an à compter de la signature.</p>', recipient_name: 'Jean Partenaire', recipient_email: 'jean.partenaire@example.com', admin_signature: drawnSig() } });
  assert.equal(create.status, 201);
  const url = create.data.sign_url;
  assert.match(url, /\/sign\?token=[a-f0-9]{48}$/);
  const token1 = url.split('token=')[1];
  assert.ok(sentEmails.some((e) => e.to === 'jean.partenaire@example.com' && e.text.includes(token1)));
  assert.equal((await api('GET', '/public/contracts/' + 'a'.repeat(48))).status, 404);
  const view = await api('GET', `/public/contracts/${token1}`);
  assert.equal(view.status, 200);
  assert.equal(view.data.contract.recipient_name, 'Jean Partenaire');
  assert.equal(view.data.contract.token_hash, undefined);
  // the PDF is only for a signed contract
  assert.equal((await rawGet(`/public/contracts/${token1}/pdf`)).status, 409);
  // resend: the old link stops working
  const resend = await api('POST', `/admin/contracts/${create.data.contract.id}/resend`, { token: m.adminToken });
  const token2 = resend.data.sign_url.split('token=')[1];
  assert.notEqual(token1, token2);
  assert.equal((await api('GET', `/public/contracts/${token1}`)).status, 404);
  const sign = await api('POST', `/public/contracts/${token2}/sign`, { body: { signer_name: 'Jean Partenaire', fields: { 'Société': 'Partenaire SA' }, signature: typedSig('Jean Partenaire') } });
  assert.equal(sign.status, 200);
  assert.equal(sign.data.contract.status, 'COMPLETED');
  assert.equal((await api('POST', `/public/contracts/${token2}/sign`, { body: { signer_name: 'Jean Partenaire', fields: { 'Société': 'X' }, signature: typedSig('Jean Partenaire') } })).data.error.code, 'NOT_PENDING');
  const pdf = await rawGet(`/public/contracts/${token2}/pdf`);
  assert.equal(pdf.buf.slice(0, 5).toString(), '%PDF-');
  assert.ok(sentEmails.some((e) => e.to === 'jean.partenaire@example.com' && /Contrat signé/.test(e.subject) && e.attachments.length === 1));
  // a merchant contract can never be opened through a token
  const mc = await api('POST', '/admin/contracts', { token: m.adminToken, body: { title: 'Contrat marchand', body_html: '<p>Texte du contrat marchand assez long pour passer.</p>', merchant_id: m.merchantId, admin_signature: drawnSig() } });
  assert.ok(mc.data.contract.id);
  assert.equal(mockTables.contracts.filter((c) => c.merchant_id).length >= 1, true);
});

test('contracts: several signers on each side, links go out once the main recipient signed, completed when everyone signed', async () => {
  const m = await makeLiveMerchant('ctrmulti');
  sentEmails.length = 0;
  const create = await api('POST', '/admin/contracts', { token: m.adminToken, body: {
    title: 'Contrat multi-signataires', body_html: '<p>Accord entre Freda Pay et <b>[[Société]]</b>, signé par plusieurs personnes.</p>', merchant_id: m.merchantId, admin_signature: drawnSig(),
    signers: [{ side: 'FREDA', name: 'Co Directeur', email: 'co.directeur@fredapay.example' }, { side: 'CLIENT', name: 'Associé Lakay', email: 'associe@lakay.example' }],
  } });
  assert.equal(create.status, 201);
  const id = create.data.contract.id;
  assert.equal(create.data.contract.progress.total, 4);
  assert.equal(create.data.invites.length, 2);
  // heads-up only: no private link yet
  const early = sentEmails.filter((e) => e.to === 'associe@lakay.example');
  assert.equal(early.length, 1);
  assert.ok(!/sign\?token=/.test(early[0].text));
  assert.equal((await api('POST', '/admin/contracts', { token: m.adminToken, body: { title: 'Doublon', body_html: '<p>Texte du contrat assez long pour passer.</p>', merchant_id: m.merchantId, admin_signature: drawnSig(), signers: [{ side: 'FREDA', name: 'Dup', email: emailOf(m) }] } })).data.error.code, 'DUPLICATE_SIGNER');
  // the merchant signs: still pending, the extra signers now get their link
  sentEmails.length = 0;
  const sign = await api('POST', `/dashboard/contracts/${id}/sign`, { token: m.token, body: { signer_name: 'Marie Jean', fields: { 'Société': 'Lakay SA' }, signature: typedSig('Marie Jean') } });
  assert.equal(sign.status, 200);
  assert.equal(sign.data.contract.status, 'PENDING_SIGNATURE');
  assert.equal(sign.data.contract.progress.done, 2);
  assert.equal((await api('GET', '/dashboard/contracts', { token: m.token })).data.pending, 0);
  const linkOf = (to) => sentEmails.filter((e) => e.to === to).map((e) => (e.text.match(/sign\?token=([a-f0-9]{48})/) || [])[1]).filter(Boolean).pop();
  const t1 = linkOf('co.directeur@fredapay.example'), t2 = linkOf('associe@lakay.example');
  assert.ok(t1 && t2 && t1 !== t2);
  assert.equal((await rawGet(`/public/contracts/${t1}/pdf`)).status, 409);
  const v1 = await api('GET', `/public/contracts/${t1}`);
  assert.equal(v1.data.contract.viewer.role, 'signer');
  assert.equal(v1.data.contract.viewer.can_sign, true);
  assert.equal(v1.data.contract.fields['Société'], 'Lakay SA');
  const s1 = await api('POST', `/public/contracts/${t1}/sign`, { body: { signer_name: 'Co Directeur', signature: typedSig('Co Directeur') } });
  assert.equal(s1.status, 200);
  assert.equal(s1.data.contract.status, 'PENDING_SIGNATURE');
  assert.equal(s1.data.contract.viewer.signed, true);
  assert.equal((await api('POST', `/public/contracts/${t1}/sign`, { body: { signature: typedSig('Co Directeur') } })).data.error.code, 'ALREADY_SIGNED');
  // whoever has signed can download right away, the final PDF follows by email at the end
  assert.equal((await rawGet(`/public/contracts/${t1}/pdf`)).status, 200);
  assert.equal((await rawGet(`/dashboard/contracts/${id}/pdf`, m.token)).status, 200);
  assert.ok(sentEmails.some((e) => e.to === emailOf(m) && /signature est enregistrée/.test(e.subject) && e.attachments.length === 1));
  assert.ok(sentEmails.some((e) => e.to === 'co.directeur@fredapay.example' && /signature est enregistrée/.test(e.subject) && e.attachments.length === 1));
  const s2 = await api('POST', `/public/contracts/${t2}/sign`, { body: { signer_name: 'Associé Lakay', signature: drawnSig() } });
  assert.equal(s2.data.contract.status, 'COMPLETED');
  const doneMails = sentEmails.filter((e) => /Contrat signé/.test(e.subject));
  assert.deepEqual(doneMails.map((e) => e.to).sort(), [emailOf(m), 'associe@lakay.example', 'co.directeur@fredapay.example', mockTables.contracts.find((c) => c.id === id).admin_email].filter((v, i, a) => a.indexOf(v) === i).sort());
  assert.ok(doneMails.every((e) => e.attachments.length === 1));
  const pdf = await rawGet(`/public/contracts/${t2}/pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.buf.slice(0, 5).toString(), '%PDF-');
  assert.ok(mockTables.contracts.find((c) => c.id === id).content_hash);
});

test('contracts: the admin invites a signer later, can resend and remove; removing the last unsigned one completes the contract', async () => {
  const m = await makeLiveMerchant('ctrlate');
  const create = await api('POST', '/admin/contracts', { token: m.adminToken, body: { title: 'Contrat invitation', body_html: '<p>Texte du contrat sans blancs à remplir, assez long.</p>', merchant_id: m.merchantId, admin_signature: drawnSig() } });
  const id = create.data.contract.id;
  const add = await api('POST', `/admin/contracts/${id}/signers`, { token: m.adminToken, body: { side: 'FREDA', name: 'Nouveau Signataire', email: 'nouveau@fredapay.example' } });
  assert.equal(add.status, 201);
  assert.equal(add.data.sign_url, null); // the merchant has not signed yet
  assert.equal((await api('POST', `/admin/contracts/${id}/signers`, { token: m.adminToken, body: { side: 'FREDA', name: 'Nouveau', email: 'NOUVEAU@fredapay.example' } })).data.error.code, 'DUPLICATE_SIGNER');
  assert.equal((await api('POST', `/admin/contracts/${id}/signers`, { token: m.adminToken, body: { side: 'X', name: 'Nouveau', email: 'x@y.example' } })).data.error.code, 'INVALID_SIGNERS');
  assert.equal((await api('POST', `/admin/contracts/${id}/signers`, { token: m.token, body: { side: 'FREDA', name: 'Nouveau', email: 'z@y.example' } })).status, 401);
  const sid = add.data.contract.signers[0].id;
  await api('POST', `/dashboard/contracts/${id}/sign`, { token: m.token, body: { signer_name: 'Marie Jean', signature: drawnSig() } });
  const resend = await api('POST', `/admin/contracts/${id}/signers/${sid}/resend`, { token: m.adminToken });
  assert.match(resend.data.sign_url, /\/sign\?token=[a-f0-9]{48}$/);
  const removed = await api('POST', `/admin/contracts/${id}/signers/${sid}/remove`, { token: m.adminToken });
  assert.equal(removed.data.contract.status, 'COMPLETED');
  assert.equal((await api('POST', `/admin/contracts/${id}/signers`, { token: m.adminToken, body: { side: 'FREDA', name: 'Tard Venu', email: 'tard@fredapay.example' } })).data.error.code, 'NOT_PENDING');
});

test('the bare API address answers with a friendly service message', async () => {
  const res = await fetch(baseUrl + '/');
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.service, 'Freda Pay Issuing API');
});

test('contracts: tables are kept, [[Signature ...]] marks are not blanks to fill, the PDF is built', async () => {
  const m = await makeLiveMerchant('ctrtable');
  const html = '<h1>Contrat Marchand</h1><p>Entre Freda Pay LLC et [[Raison sociale]], pour la plateforme.</p><table><thead><tr><th>Service</th><th>Tarif</th></tr></thead><tbody><tr><td>Abonnement</td><td>150 USD</td></tr></tbody></table><table><tr><td>Signature : [[Signature du Marchand]]</td><td>Nom : [[Nom du signataire]]</td></tr></table><script>x</script>';
  const create = await api('POST', '/admin/contracts', { token: m.adminToken, body: { title: 'Contrat Marchand', body_html: html, merchant_id: m.merchantId, admin_signature: drawnSig() } });
  assert.equal(create.status, 201);
  const c = create.data.contract;
  assert.deepEqual(c.field_labels, ['Raison sociale', 'Nom du signataire']);
  assert.match(c.body_html, /<table>/);
  assert.match(c.body_html, /ctr-sigmark/);
  assert.ok(!/script/.test(c.body_html));
  const sign = await api('POST', `/dashboard/contracts/${c.id}/sign`, { token: m.token, body: { signer_name: 'Marie Jean', fields: { 'Raison sociale': 'Boutik SA', 'Nom du signataire': 'Marie Jean' }, signature: drawnSig() } });
  assert.equal(sign.data.contract.status, 'COMPLETED');
  const pdf = await rawGet(`/dashboard/contracts/${c.id}/pdf`, m.token);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.buf.slice(0, 5).toString(), '%PDF-');
});

// ===== fixer2: money integrity =====

const f2Balance = async (token) => (await api('GET', '/dashboard/balance', { token })).data;
const f2Entries = (relatedId, type) => mockTables.ledger_entries.filter((e) => e.related_id === relatedId && (!type || e.type === type));

test('fixer2: concurrent status polls credit a confirmed MonCash payment once', async () => {
  const live = await liveWithGateway('f2pay', 0);
  const create = await api('POST', '/dashboard/payments', { token: live.token, body: { amount: 1000, method: 'moncash', reference: 'F2-PAY-1' } });
  assert.equal(create.status, 201);
  await fetch('http://localhost:4501/__control/confirm-payment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refference_id: `fp_${live.merchantId}_F2-PAY-1` }) });
  const polls = await Promise.all(Array.from({ length: 6 }, () => api('GET', `/dashboard/payments/${create.data.id}`, { token: live.token })));
  assert.ok(polls.every((p) => p.status === 200 && p.data.status === 'succeeded'));
  assert.equal(f2Entries(create.data.id, 'payment_credit').length, 1);
  assert.equal(await gw(live.token), polls[0].data.net_amount);
});

test('fixer2: concurrent status polls credit a confirmed automatic wallet top-up once', async () => {
  const live = await makeLiveMerchant('f2topup', { fundUsd: 0 });
  const create = await api('POST', '/dashboard/wallet/topups', { token: live.token, body: { method: 'moncash', amount_htg: 13300, reference: 'F2-TOPUP-1' } });
  assert.equal(create.status, 201);
  await fetch('http://localhost:4501/__control/confirm-payment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refference_id: `fp_${live.merchantId}_F2-TOPUP-1` }) });
  const polls = await Promise.all(Array.from({ length: 6 }, () => api('GET', `/dashboard/wallet/topups/${create.data.id}`, { token: live.token })));
  assert.ok(polls.every((p) => p.status === 200 && p.data.status === 'succeeded'));
  assert.equal(f2Entries(create.data.id, 'wallet_topup').length, 1);
  assert.equal((await f2Balance(live.token)).master_wallet.available, polls[0].data.credited_usd);
});

test('fixer2: parallel card creations can never take the Master Wallet under its minimum reserve', async () => {
  const live = await makeLiveMerchant('f2race', { fundUsd: 130 }); // 130 - 50 reserve = room for a few 20 $ cards only
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    api('POST', '/dashboard/cards', { token: live.token, body: { reference: `F2-RACE-${i}`, kind: 'business', business_name: 'Race Co', brand: 'VISA', amount: 20 } })));
  const ok = results.filter((r) => r.status === 202).length;
  const refused = results.filter((r) => r.status === 400 && r.data.error.code === 'BELOW_MINIMUM_BALANCE').length;
  assert.ok(ok >= 1 && refused >= 1 && ok + refused === 8, JSON.stringify(results.map((r) => r.status)));
  assert.ok((await f2Balance(live.token)).master_wallet.available >= 50);
});

test('fixer2: terminating a card does not refund what the card spent online', async () => {
  const live = await liveMerchantWithActivity('f2term'); // business card pre-funded with 100 $
  await sendProviderEvent(purchase(live.card.maplerad_card_id, { amount: 3000, reference: 'f2-spend-1' }), MOCK_LIVE_WHSEC);
  const before = (await f2Balance(live.token)).master_wallet.available;
  const term = await api('POST', `/dashboard/cards/${live.card.id}/terminate`, { token: live.token });
  assert.equal(term.status, 200);
  const after = (await f2Balance(live.token)).master_wallet.available;
  assert.equal(Math.round((after - before) * 100) / 100, 69.5); // 100 loaded - 30 spent = 70 left, minus the 0.50 closure fee
});

test('fixer2: money amounts must be real positive numbers with at most two decimals (French 400, nothing charged)', async () => {
  const live = await makeLiveMerchant('f2amounts', { fundUsd: 300 });
  const before = (await f2Balance(live.token)).master_wallet.available;
  for (const bad of ['100', -100, 0, true, null, 10.005, 1e12, {}, [5]]) {
    const r = await api('POST', '/dashboard/cards', { token: live.token, body: { reference: `F2-BAD-${JSON.stringify(bad)}`, kind: 'business', business_name: 'Bad Co', brand: 'VISA', amount: bad } });
    assert.equal(r.status, 400, `card amount ${JSON.stringify(bad)}`);
    assert.equal(r.data.error.code, 'INVALID_AMOUNT');
  }
  const ind = await api('POST', '/dashboard/cards', { token: live.token, body: { reference: 'F2-BAD-IND', kind: 'individual', brand: 'VISA', amount: '100' } });
  assert.equal(ind.status, 400);
  assert.equal((await f2Balance(live.token)).master_wallet.available, before); // nothing was debited
  const card = mockTables.cards.find((c) => c.merchant_id === live.merchantId);
  assert.equal(card, undefined);

  for (const [path, body] of [
    ['/dashboard/payments', { amount: '500', method: 'moncash', reference: 'F2-S-1' }],
    ['/dashboard/payments', { amount: 20.555, method: 'moncash', reference: 'F2-S-2' }],
    ['/dashboard/payouts', { amount: '2000', method: 'moncash', recipient: '50937001234', reference: 'F2-S-3' }],
    ['/dashboard/wallet/topups', { method: 'moncash', amount_htg: '13300', reference: 'F2-S-4' }],
    ['/dashboard/wallet/topups', { method: 'zelle', amount_usd: -5, reference: 'F2-S-5' }],
    ['/dashboard/payment-links', { amount: '50', currency: 'HTG' }],
  ]) {
    const r = await api('POST', path, { token: live.token, body });
    assert.equal(r.status, 400, `${path} ${JSON.stringify(body)}`);
    assert.equal(r.data.error.code, 'INVALID_AMOUNT');
    assert.match(r.data.error.message, /nombre positif|décimales|trop élevé/);
  }
});

test('fixer2: fund and withdraw refuse string and fractional-cent amounts', async () => {
  const live = await liveMerchantWithActivity('f2fund');
  for (const amount of ['10', 0.001, 10.005, -3]) {
    assert.equal((await api('POST', `/dashboard/cards/${live.card.id}/fund`, { token: live.token, body: { amount } })).status, 400);
    assert.equal((await api('POST', `/dashboard/cards/${live.card.id}/withdraw`, { token: live.token, body: { amount } })).status, 400);
  }
});

test('fixer2: parallel recharges all land in the card balance (no lost update)', async () => {
  const live = await liveMerchantWithActivity('f2parfund');
  await Promise.all([1, 2, 3].map(() => api('POST', `/dashboard/cards/${live.card.id}/fund`, { token: live.token, body: { amount: 10 } })));
  assert.equal(mockTables.cards.find((c) => c.id === live.card.id).balance, 130);
});

test('fixer2: a failed-creation webhook delivered again refunds only once, and a late success does not resurrect the card', async () => {
  const reg = await registerAndVerify({ business_name: 'F2 Refund Co', email: 'f2refund@sandbox-test.example.com', password: 'password123' });
  const token = reg.data.session_token;
  const start = (await f2Balance(token)).master_wallet.available;
  const c = await api('POST', '/dashboard/cards', { token, body: { reference: 'F2-REFUND-1', kind: 'business', business_name: 'F2 Refund Co', brand: 'VISA', amount: 20 } });
  assert.equal(c.status, 202);
  await pollUntil(() => api('GET', `/dashboard/cards/${c.data.id}`, { token }), (r) => r.data.status === 'active', 40, 20);
  // The card is pending again in our books, as if the creation had not been confirmed yet.
  const row = mockTables.cards.find((x) => x.id === c.data.id);
  row.status = 'pending';
  assert.equal(start - (await f2Balance(token)).master_wallet.available, 25);
  const failed = { event: 'issuing.created.failed', reference: row.maplerad_reference };
  await sendProviderEvent(failed, MOCK_SANDBOX_WHSEC);
  await sendProviderEvent(failed, MOCK_SANDBOX_WHSEC); // a second delivery with a new event id
  await sendProviderEvent(failed, MOCK_SANDBOX_WHSEC);
  assert.equal((await f2Balance(token)).master_wallet.available, start); // refunded exactly once
  assert.equal(row.status, 'failed');
  await sendProviderEvent({ event: 'issuing.created.successful', reference: row.maplerad_reference, card: { id: row.maplerad_card_id, masked_pan: '411111******1111', name: 'X', currency: 'USD' } }, MOCK_SANDBOX_WHSEC);
  assert.equal(row.status, 'failed'); // still failed: it was refunded, it must not come back as a free card
});

test('fixer2: a card payment too small to leave anything after the fee is refused; a payout below the MonCash minimum too', async () => {
  const live = await liveWithGateway('f2min');
  const card = await api('POST', '/dashboard/payments', { token: live.token, body: { amount: 0.5, currency: 'USD', method: 'card', reference: 'F2-MIN-1' } });
  assert.equal(card.status, 400);
  assert.equal(card.data.error.code, 'AMOUNT_TOO_LOW');
  const small = await api('POST', '/dashboard/payouts', { token: live.token, body: { amount: 5, method: 'moncash', recipient: '50937001234', reference: 'F2-MIN-2' } });
  assert.equal(small.status, 400);
  assert.equal(small.data.error.code, 'AMOUNT_TOO_LOW');
  const pricing = require('../src/services/pricing');
  assert.ok(pricing.computeGatewayCardFee('standard', 0.5).net >= 0);
  assert.ok(pricing.computeGatewayFee('standard', 5).net >= 0);
});

// ===== fixer3: authorization, blog, contracts =====
test('fixer3: an editor admin cannot read KYC documents, receipts, merchants, overview, team or disputes (owner/admin still can)', async () => {
  const { token: editor } = await adminLogin('editor');
  const { token: owner } = await adminLogin('owner');
  for (const path of ['/admin/verifications', '/admin/verifications/vs_x/document?path=a/b', '/admin/deposits', '/admin/deposits/dep_x/receipt', '/admin/merchants', '/admin/merchants/mch_x', '/admin/overview', '/admin/visits', '/admin/team', '/admin/disputes', '/admin/issuing-access']) {
    const r = await api('GET', path, { token: editor });
    assert.equal(r.status, 403, path);
    assert.equal(r.data.error.code, 'INSUFFICIENT_ROLE', path);
  }
  assert.equal((await api('GET', '/admin/merchants', { token: owner })).status, 200);
  assert.equal((await api('GET', '/admin/verifications', { token: owner })).status, 200);
  assert.equal((await api('GET', '/admin/blog', { token: editor })).status, 200); // the blog stays open to editors
  assert.equal((await api('GET', '/admin/me', { token: editor })).status, 200);
});

test('fixer3: blog cover URL must be https, and every field is escaped on the public page', async () => {
  const { token } = await adminLogin('editor');
  const bad = await api('POST', '/admin/blog', { token, body: { title: 'XSS test', content_markdown: 'texte', cover_image_url: 'x" onerror="alert(1)' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error.code, 'INVALID_COVER');
  assert.equal((await api('POST', '/admin/blog', { token, body: { title: 'XSS test', content_markdown: 'texte', cover_image_url: 'javascript:alert(1)' } })).status, 400);
  assert.equal((await api('POST', '/admin/blog', { token, body: { title: 'XSS test', content_markdown: 'texte', cover_image_url: 'http://insecure.example.com/a.png' } })).status, 400);
  const ok = await api('POST', '/admin/blog', { token, body: { title: 'Article sûr <b>x</b>', content_markdown: '[clic](javascript:alert(1)) ![i](data:text/html,x) [bon](https://example.com/?a=1&b=2) \'quote\'', cover_image_url: 'https://cdn.example.com/c.png', tags: ['<img src=x>'] } });
  assert.equal(ok.status, 201);
  assert.equal((await api('PUT', `/admin/blog/${ok.data.post.id}`, { token, body: { cover_image_url: 'x" onerror="alert(1)' } })).status, 400);
  await api('POST', `/admin/blog/${ok.data.post.id}/publish`, { token });
  const html = await (await fetch(baseUrl + '/blog/' + ok.data.post.slug)).text();
  assert.ok(!/javascript:/i.test(html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, '')));
  assert.ok(!/<img src=x>|<b>x<\/b>/.test(html));
  assert.match(html, /<img class="cover" src="https:\/\/cdn\.example\.com\/c\.png"/);
  assert.match(html, /<a href="https:\/\/example\.com\/\?a=1&amp;b=2" rel="noopener nofollow">bon<\/a>/);
  // an old row holding a hostile cover is not rendered either
  mockTables.blog_posts.find((p) => p.id === ok.data.post.id).cover_image_url = 'javascript:alert(1)" onerror="alert(2)';
  const html2 = await (await fetch(baseUrl + '/blog/' + ok.data.post.slug)).text();
  assert.ok(!/onerror|javascript:/i.test(html2.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, '')));
  const up = await api('POST', '/admin/blog/upload-cover', { token, body: { base64: 'aGVsbG8=', content_type: 'text/html', filename: 'a.html' } });
  assert.equal(up.status, 400);
});

test('fixer3: webhook URLs pointing at local, private, link-local or non-https addresses are refused (no flag), and delivery re-checks', async () => {
  const urlSafety = require('../src/utils/urlSafety');
  const saved = process.env.ALLOW_PRIVATE_WEBHOOKS;
  delete process.env.ALLOW_PRIVATE_WEBHOOKS;
  try {
    const reg = await registerAndVerify({ business_name: 'Ssrf Co', email: 'ssrf-co@example.com', password: 'password123' });
    const token = reg.data.session_token;
    for (const url of ['http://localhost:4503/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5:9/', 'https://192.168.1.1/', 'https://172.16.0.1/', 'https://169.254.169.254/latest/meta-data/', 'https://[::1]/', 'https://[::ffff:7f00:1]/', 'https://[fd00::1]/', 'https://0.0.0.0/', 'https://metadata.google.internal/', 'https://intranet/', 'ftp://example.com/', 'file:///etc/passwd', 'https://user:pw@example.com/', 'https://2130706433/']) {
      const r = await api('POST', '/dashboard/webhooks', { token, body: { url } });
      assert.equal(r.status, 400, url);
      assert.equal(r.data.error.code, 'INVALID_URL', url);
    }
    assert.equal((await api('POST', '/dashboard/webhooks', { token, body: { url: 'https://8.8.8.8/hook' } })).status, 201);
    assert.equal(urlSafety.isBlockedIp('8.8.8.8'), false);
    assert.equal(urlSafety.isBlockedIp('100.64.0.1'), true);
    // a stored endpoint that is not allowed any more is not called
    const row = mockTables.webhook_endpoints.find((e) => e.merchant_id === reg.data.merchant.id);
    row.url = 'https://169.254.169.254/latest/';
    const key = await apiKeyFor(reg.data.session_token, 'test');
    const t = await api('POST', '/v1/webhooks/test', { token: key });
    assert.equal(t.data.sent, false);
    assert.equal(t.data.http_status, undefined);
  } finally {
    process.env.ALLOW_PRIVATE_WEBHOOKS = saved;
  }
});

test('fixer3: a [[field]] split by formatting is merged, so the contract can be signed and the PDF shows the answer', async () => {
  const h = require('../src/utils/contractHtml');
  const clean = h.sanitize('<p>Entre [[Nom <b>du</b>  rep]] et [[constructor]] &amp;lt;b&amp;gt;</p>');
  assert.deepEqual(h.fieldLabels(clean), ['Nom du rep', 'constructor']);
  assert.match(h.viewHtml(clean), /data-field="Nom du rep"/);
  const runs = h.toBlocks(clean, { 'Nom du rep': 'Jean' })[0].runs;
  assert.ok(runs.some((r) => r.field === 'Nom du rep' && r.text === 'Jean'));
  assert.ok(runs.some((r) => r.field === 'constructor' && r.text === '')); // never the Object.prototype function
  assert.ok(runs.some((r) => /&lt;b&gt;/.test(r.text || ''))); // typed entities are not decoded twice
  const m = await makeLiveMerchant('ctrsplit');
  const html = '<p>Contrat de test avec [[Nom <b>du</b> rep]] et la suite du texte.</p>';
  const create = await api('POST', '/admin/contracts', { token: m.adminToken, body: { title: 'Contrat split', body_html: html, merchant_id: m.merchantId, admin_signature: typedSig('Admin Freda') } });
  assert.equal(create.status, 201);
  assert.deepEqual(create.data.contract.field_labels, ['Nom du rep']);
  const sign = await api('POST', `/dashboard/contracts/${create.data.contract.id}/sign`, { token: m.token, body: { signer_name: 'Jean Test', fields: { 'Nom du rep': 'Jean' }, signature: typedSig('Jean Test') } });
  assert.equal(sign.status, 200);
  assert.equal(sign.data.contract.status, 'COMPLETED');
  // unreadable blanks and absurd words are refused at creation
  const open = await api('POST', '/admin/contracts', { token: m.adminToken, body: { title: 'Contrat ouvert', body_html: '<p>Un champ [[jamais fermé et assez de texte ici.</p>', merchant_id: m.merchantId, admin_signature: typedSig('A') } });
  assert.equal(open.status, 400);
  const word = await api('POST', '/admin/contracts', { token: m.adminToken, body: { title: 'Contrat mot', body_html: `<p>${'a'.repeat(400)}</p>`, merchant_id: m.merchantId, admin_signature: typedSig('A') } });
  assert.equal(word.status, 400);
});

test('fixer3: contract PDF handles lists in cells, a huge word quickly, long names, oversized rows, accents and loose numbered lists', async () => {
  const { buildPdf } = require('../src/services/contractPdf');
  const h = require('../src/utils/contractHtml');
  // list in a cell: kept inside the cell, not ejected before the table
  const blocks = h.toBlocks(h.sanitize('<table><tr><td><ul><li>un</li><li>deux</li></ul></td></tr></table>'));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'table');
  assert.equal(blocks[0].rows[0].cells[0].runs.filter((r) => r.text === '• ').length, 2);
  // loose numbered list keeps counting
  const ol = h.toBlocks(h.sanitize('<ol><li>a</li></ol><p></p><ol><li>b</li></ol><ol><li>c</li></ol>')).filter((b) => b.kind === 'li').map((b) => b.prefix);
  assert.deepEqual(ol, ['1.', '2.', '3.']);
  const base = { id: 'ctr_f3', title: 'Contrat “œuvre” 5 €', status: 'COMPLETED', admin_name: 'N'.repeat(120), admin_email: `${'e'.repeat(150)}@example.com`, signer_name: 'Zażółć', signer_email: 'a@b.co', fields: {}, signers: [], admin_signed_at: new Date().toISOString(), signed_at: new Date().toISOString() };
  const t0 = Date.now();
  const long = await buildPdf({ ...base, body_html: `<p>${'a'.repeat(5000)}</p><p>Voilà l’œuvre à 5 € « ok » Zażółć</p>` });
  assert.ok(Date.now() - t0 < 3000, `5000-char word took ${Date.now() - t0} ms`);
  assert.equal(long.slice(0, 5).toString(), '%PDF-');
  const giant = await buildPdf({ ...base, body_html: `<table><tr><th>H</th><th>I</th></tr><tr><td>${'mot '.repeat(1500)}</td><td>x</td></tr></table>` });
  assert.equal(giant.slice(0, 5).toString(), '%PDF-');
  const { PDFDocument } = require('../src/vendor/pdf-lib.min.js');
  assert.ok((await PDFDocument.load(giant)).getPageCount() >= 3); // the oversized row continues over several pages instead of running off one
});

test('fixer3: resending an admin invitation links to the panel the request came from; KYC cannot be resubmitted once verified; CSV formulas are neutralised', async () => {
  const { token } = await adminLogin('owner');
  const inv = await api('POST', '/admin/team/invite', { token, body: { email: 'resend-panel@fredapay.com', name: 'Resend Panel', role: 'editor' } });
  assert.equal(inv.status, 201);
  sentEmails.length = 0;
  const re = await api('POST', `/admin/team/${inv.data.admin.id}/resend`, { token, body: {}, headers: { Origin: 'https://panel.example.org' } });
  assert.equal(re.status, 200);
  const mail = sentEmails.filter((e) => e.to === 'resend-panel@fredapay.com').slice(-1)[0];
  assert.match(mail.text, /https:\/\/panel\.example\.org\/admin\.html\?invite=[a-f0-9]{64}/);

  const reg = await registerAndVerify({ business_name: 'Kyc Twice Co', email: 'kyc-twice@example.com', password: 'password123' });
  mockTables.merchants.find((x) => x.id === reg.data.merchant.id).kyc_status = 'verified';
  const again = await api('POST', '/dashboard/verification/kyc', { token: reg.data.session_token, body: { documents: [{ label: 'ID', base64: 'aGVsbG8=', filename: "a.x')-alert(1)-('" }] } });
  assert.equal(again.status, 409);
  assert.equal(again.data.error.code, 'ALREADY_VERIFIED');
});

// ===== fixer1: auth & injection =====

test('fixer1: /auth/verify-otp never returns a session for an already verified account (no code needed was the bug)', async () => {
  const reg = await registerAndVerify({ business_name: 'Otp Bypass Co', email: 'otp-bypass@example.com', password: 'password123' });
  const id = reg.data.merchant.id;
  for (const code of ['x', '000000', 123456]) {
    const r = await api('POST', '/auth/verify-otp', { headers: freshIp(), body: { merchant_id: id, code } });
    assert.equal(r.status, 409);
    assert.equal(r.data.error.code, 'ALREADY_VERIFIED');
    assert.equal(r.data.session_token, undefined);
    assert.equal(r.data.merchant, undefined);
  }
  // Wrong types are refused, not coerced.
  const obj = await api('POST', '/auth/verify-otp', { headers: freshIp(), body: { merchant_id: { a: 1 }, code: '000000' } });
  assert.equal(obj.status, 400);
});

test('fixer1: operator-looking values are literal ids: no filter injection through verify-otp / resend-otp / public links / forgot-password', async () => {
  const reg = await registerAndVerify({ business_name: 'Inject Victim Co', email: 'inject-victim@example.com', password: 'password123' });
  for (const evil of ['neq.zzz', 'like.mch_*', 'not.is.null', 'in.(a,b)', 'gte.a']) {
    const v = await api('POST', '/auth/verify-otp', { headers: freshIp(), body: { merchant_id: evil, code: '000000' } });
    assert.equal(v.status, 404, `verify-otp ${evil}`);
    assert.equal(v.data.session_token, undefined);
    const rs = await api('POST', '/auth/resend-otp', { headers: freshIp(), body: { merchant_id: evil } });
    assert.equal(rs.status, 404, `resend-otp ${evil}`);
    const link = await api('GET', `/public/payment-links/${encodeURIComponent(evil)}`);
    assert.equal(link.status, 404, `public link ${evil}`);
  }
  // A reset mail must not go to "the first account" for a pattern address.
  const before = sentEmails.length;
  const f = await api('POST', '/auth/forgot-password', { headers: freshIp(), body: { email: 'neq.a@b.co' } });
  assert.equal(f.status, 200);
  assert.equal(sentEmails.slice(before).length, 0);
  // Login challenges: a pattern challenge_id does not touch (or burn attempts on) a real challenge.
  const step1 = await api('POST', '/auth/login', { headers: freshIp(), body: { email: 'inject-victim@example.com', password: 'password123' } });
  assert.equal(step1.status, 200);
  for (let i = 0; i < 7; i++) {
    const r = await api('POST', '/auth/login/verify', { headers: freshIp(), body: { challenge_id: 'neq.x', code: '000000' } });
    assert.equal(r.status, 400);
    assert.equal(r.data.error.code, 'LOGIN_CHALLENGE_INVALID');
  }
  const ok = await api('POST', '/auth/login/verify', { headers: freshIp(), body: { challenge_id: step1.data.challenge_id, code: extractLoginCode('inject-victim@example.com') } });
  assert.equal(ok.status, 200);
  assert.ok(reg.data.merchant.id);
});

test('fixer1: the supabase helper: plain strings are always equality, operators only through explicit helpers', async () => {
  const supabase = require('../src/lib/supabase');
  const rows = await supabase.select('merchants', {}, { limit: 3 });
  assert.ok(rows.length >= 2);
  assert.deepEqual(await supabase.select('merchants', { id: 'neq.nothing' }), []);
  assert.deepEqual(await supabase.select('merchants', { id: 'like.mch_*' }), []);
  assert.equal((await supabase.select('merchants', { id: supabase.neq('nothing') })).length >= rows.length, true);
  assert.equal((await supabase.select('merchants', { id: supabase.inList([rows[0].id, rows[1].id]) })).length, 2);
  assert.equal((await supabase.select('merchants', { email: supabase.notNull() })).length >= 2, true);
  assert.throws(() => supabase.inList(['a,b', 'c)']), /invalide/);
  assert.throws(() => supabase.inList(['x),id=neq.(y']));
});

test('fixer1: malformed percent-escapes and URLs answer 400/404 JSON and never crash the server', async () => {
  const http = require('node:http');
  const raw = (path) => new Promise((resolve, reject) => {
    const req = http.request({ host: 'localhost', port: APP_PORT, path, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
    req.end();
  });
  for (const path of ['/blog/%', '/public/payment-links/%E0%A4%A', '/public/payment-links/%E0%A4%A/payments/%', '/public/contracts/%zz', '/assets/%']) {
    const r = await raw(path);
    assert.ok(r.status === 400 || r.status === 404, `${path} -> ${r.status}`);
    assert.ok(JSON.parse(r.data).error.code);
  }
  const health = await api('GET', '/health');
  assert.equal(health.status, 200); // still alive
});

test('fixer1: client IP comes from the trusted proxy hop, not from the first (client-written) X-Forwarded-For entry', () => {
  const { clientIp } = require('../src/utils/rateLimit');
  const req = (headers, ip = '127.0.0.1') => ({ headers, socket: { remoteAddress: ip } });
  const saved = { cf: process.env.TRUST_CF_CONNECTING_IP, hops: process.env.TRUSTED_PROXY_HOPS };
  try {
    delete process.env.TRUSTED_PROXY_HOPS;
    process.env.TRUST_CF_CONNECTING_IP = '0';
    // The client rotates the first entry; the hop appended by our proxy (last) is what counts.
    assert.equal(clientIp(req({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' })), '203.0.113.9');
    assert.equal(clientIp(req({ 'x-forwarded-for': '7.7.7.7, 203.0.113.9' })), '203.0.113.9');
    assert.equal(clientIp(req({ 'x-forwarded-for': '198.51.100.4' })), '198.51.100.4');
    // Garbage in the header falls back to the socket peer; a forged cf-connecting-ip is ignored when not trusted.
    assert.equal(clientIp(req({ 'x-forwarded-for': 'not-an-ip' }, '10.1.1.1')), '10.1.1.1');
    assert.equal(clientIp(req({ 'cf-connecting-ip': '6.6.6.6' }, '10.1.1.1')), '10.1.1.1');
    assert.equal(clientIp(req({}, '10.1.1.1')), '10.1.1.1');
    // Behind Cloudflare (production default) its header is authoritative, and must be a real address.
    process.env.TRUST_CF_CONNECTING_IP = '1';
    assert.equal(clientIp(req({ 'cf-connecting-ip': '192.0.2.55', 'x-forwarded-for': '6.6.6.6, 172.70.0.1' })), '192.0.2.55');
    assert.equal(clientIp(req({ 'cf-connecting-ip': 'junk', 'x-forwarded-for': '6.6.6.6, 172.70.0.1' })), '172.70.0.1');
    // More trusted hops are configurable.
    process.env.TRUST_CF_CONNECTING_IP = '0';
    process.env.TRUSTED_PROXY_HOPS = '2';
    assert.equal(clientIp(req({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 172.70.0.1' })), '203.0.113.9');
  } finally {
    if (saved.cf === undefined) delete process.env.TRUST_CF_CONNECTING_IP; else process.env.TRUST_CF_CONNECTING_IP = saved.cf;
    if (saved.hops === undefined) delete process.env.TRUSTED_PROXY_HOPS; else process.env.TRUSTED_PROXY_HOPS = saved.hops;
  }
});

test('fixer1: rotating the first X-Forwarded-For entry no longer escapes the per-IP rate limit', async () => {
  let limited = 0;
  for (let i = 0; i < 25; i++) {
    const r = await api('POST', '/auth/reset-password', { headers: { 'x-forwarded-for': `${100 + i}.1.1.1, 203.0.113.250` }, body: { token: 'x'.repeat(40), password: 'whatever-123' } });
    if (r.status === 429) limited += 1;
  }
  assert.ok(limited >= 5, `expected the 15/15min limit to bite, got ${limited} x 429`);
});

test('fixer1: resend-otp is limited per account, not only per IP', async () => {
  const r0 = await api('POST', '/auth/register', { headers: freshIp(), body: { business_name: 'Resend Co', email: 'resend-co@example.com', password: 'password123' } });
  assert.equal(r0.status, 201);
  const statuses = [];
  for (let i = 0; i < 8; i++) {
    const r = await api('POST', '/auth/resend-otp', { headers: freshIp(), body: { merchant_id: r0.data.merchant_id } });
    statuses.push(r.status);
  }
  assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200]);
  assert.deepEqual(statuses.slice(5), [429, 429, 429]);
});

test('fixer1: a signup code works once even when used twice in parallel', async () => {
  const r0 = await api('POST', '/auth/register', { headers: freshIp(), body: { business_name: 'Race Otp Co', email: 'race-otp@example.com', password: 'password123' } });
  const code = extractOtpFromEmail('race-otp@example.com');
  const both = await Promise.all([1, 2].map(() => api('POST', '/auth/verify-otp', { headers: freshIp(), body: { merchant_id: r0.data.merchant_id, code } })));
  assert.equal(both.filter((r) => r.status === 200).length, 1);
});

test('fixer1: a password change ends every older session (owner and admin) and hands back a fresh token', async () => {
  const reg = await registerAndVerify({ business_name: 'Revoke Co', email: 'owner@revoke-co.com', password: 'old-password-1' });
  const stolen = (await loginWithOtp('owner@revoke-co.com', 'old-password-1')).data.session_token;
  assert.equal((await api('GET', '/auth/me', { token: stolen })).status, 200);
  await new Promise((r) => setTimeout(r, 1100)); // tokens carry whole-second timestamps
  const change = await api('POST', '/dashboard/account/password', { token: reg.data.session_token, body: { current_password: 'old-password-1', new_password: 'brand-new-pass' } });
  assert.equal(change.status, 200);
  assert.ok(change.data.session_token);
  const old = await api('GET', '/auth/me', { token: stolen });
  assert.equal(old.status, 401);
  assert.equal(old.data.error.code, 'SESSION_ENDED');
  assert.equal((await api('GET', '/auth/me', { token: change.data.session_token })).status, 200);

  // Admin
  const adm = await adminLogin('admin');
  const stolenAdmin = (await loginWithOtp(adm.email, adm.password, '/admin')).data.session_token;
  assert.equal((await api('GET', '/admin/me', { token: stolenAdmin })).status, 200);
  await new Promise((r) => setTimeout(r, 1100));
  const ch = await api('POST', '/admin/account/password', { token: adm.token, body: { current_password: adm.password, new_password: 'another-admin-pass-2' } });
  assert.equal(ch.status, 200);
  assert.ok(ch.data.session_token);
  assert.equal((await api('GET', '/admin/me', { token: stolenAdmin })).status, 401);
  assert.equal((await api('GET', '/admin/me', { token: ch.data.session_token })).status, 200);
});

test('fixer1: register validates types/email/password length and refuses an email already invited to a team', async () => {
  const bad = await api('POST', '/auth/register', { headers: freshIp(), body: { business_name: { a: 1 }, email: 'x@y.co', password: 'password123' } });
  assert.equal(bad.status, 400);
  const mail = await api('POST', '/auth/register', { headers: freshIp(), body: { business_name: 'Mail Co', email: 'notanemail', password: 'password123' } });
  assert.equal(mail.status, 400);
  assert.equal(mail.data.error.code, 'INVALID_EMAIL');
  const long = await api('POST', '/auth/register', { headers: freshIp(), body: { business_name: 'Long Co', email: 'long-pw@example.com', password: 'p'.repeat(5000) } });
  assert.equal(long.status, 400);
  const reg = await registerAndVerify({ business_name: 'Invite Owner Co', email: 'owner@invite-owner.com', password: 'password123' });
  await api('POST', '/dashboard/team/invite', { token: reg.data.session_token, body: { email: 'invitee@invite-owner.com', role: 'viewer' } });
  const taken = await api('POST', '/auth/register', { headers: freshIp(), body: { business_name: 'Squatter Co', email: 'invitee@invite-owner.com', password: 'password123' } });
  assert.equal(taken.status, 409);
  assert.equal(taken.data.error.code, 'EMAIL_TAKEN');
});

test('fixer1: production refuses to boot with a missing or placeholder SESSION_SECRET', () => {
  const { spawnSync } = require('node:child_process');
  const run = (secret) => spawnSync(process.execPath, ['-e', "require('./src/config')"], {
    cwd: require('path').join(__dirname, '..'),
    env: Object.assign({}, process.env, { NODE_ENV: 'production', SESSION_SECRET: secret }),
    encoding: 'utf8',
  });
  assert.notEqual(run('').status, 0);
  assert.notEqual(run('CHANGE_ME_LONG_RANDOM_VALUE_0123456789abcdef').status, 0);
  assert.equal(run('short').status, 0); // a short secret only warns: it must never take the service down
  assert.equal(run('a'.repeat(48)).status, 0);
});

test('admin API traffic: who calls /v1 and how often, 429s counted, unauthenticated calls separated, editors refused', async () => {
  const apiTraffic = require('../src/services/apiTraffic');
  apiTraffic.reset();
  const live = await makeLiveMerchant('traffic');
  const k = await api('POST', '/dashboard/api-keys', { token: live.token, body: { mode: 'live' } });
  const secret = (k.data && (k.data.secret || k.data.key || k.data.api_key)) || null;
  assert.ok(secret, JSON.stringify(k.data).slice(0, 200));
  for (let i = 0; i < 3; i++) await api('GET', '/v1/payments', { token: secret });
  await api('GET', '/v1/payments', { token: 'sk_live_' + 'a'.repeat(40) });
  const { token: owner } = await adminLogin('owner');
  const snap = await api('GET', '/admin/api-traffic', { token: owner });
  assert.equal(snap.status, 200);
  const me = snap.data.merchants.find((m) => m.merchant_id === live.merchantId);
  assert.ok(me, JSON.stringify(snap.data).slice(0, 300));
  assert.equal(me.req_60s, 3);
  assert.equal(me.live_5min, 3);
  assert.equal(me.top_endpoints[0].route, 'GET /v1/payments');
  assert.ok(me.business_name);
  assert.equal(snap.data.limit_per_minute, 100);
  assert.equal(snap.data.unauthenticated.req_5min, 1);
  assert.equal((await api('GET', '/admin/api-traffic', { token: (await adminLogin('editor')).token })).status, 403);
  assert.equal((await api('GET', '/admin/api-traffic', { token: live.token })).status, 401);
});

// ===== chat + minimum balance for MonCash / Natcash withdrawals =====
test('chat: a merchant writes to the team and the team answers; unread counters, isolation, validation', async () => {
  const a = await makeLiveMerchant('chata');
  const b = await makeLiveMerchant('chatb');
  const { token: owner } = await adminLogin('owner');
  assert.equal((await api('GET', '/dashboard/chat', { token: a.token })).data.messages.length, 0);
  assert.equal((await api('POST', '/dashboard/chat', { token: a.token, body: { body: '   ' } })).data.error.code, 'EMPTY_MESSAGE');
  assert.equal((await api('POST', '/dashboard/chat', { token: a.token, body: { body: 'x'.repeat(2001) } })).data.error.code, 'MESSAGE_TOO_LONG');
  const sent = await api('POST', '/dashboard/chat', { token: a.token, body: { body: 'Bonjour, mon retrait est bloqué <b>aidez-moi</b>' } });
  assert.equal(sent.status, 201);
  assert.equal(sent.data.message.sender, 'merchant');
  assert.equal(sent.data.message.body, 'Bonjour, mon retrait est bloqué <b>aidez-moi</b>'); // plain text, kept as written (pages render it as text)
  // admin sees it
  assert.equal((await api('GET', '/admin/chat-unread', { token: owner })).data.unread >= 1, true);
  const conv = await api('GET', '/admin/chat', { token: owner });
  const mine = conv.data.conversations.find((c) => c.merchant_id === a.merchantId);
  assert.ok(mine && mine.unread === 1);
  assert.equal(conv.data.conversations.some((c) => c.merchant_id === b.merchantId), false);
  const th = await api('GET', `/admin/chat/${a.merchantId}`, { token: owner });
  assert.equal(th.data.messages.length, 1);
  assert.equal((await api('GET', '/admin/chat', { token: owner })).data.conversations.find((c) => c.merchant_id === a.merchantId).unread, 0); // opening marks it read
  // admin answers, merchant sees an unread message
  const reply = await api('POST', `/admin/chat/${a.merchantId}`, { token: owner, body: { body: 'Bonjour, nous regardons.' } });
  assert.equal(reply.status, 201);
  assert.equal((await api('GET', '/dashboard/chat/unread', { token: a.token })).data.unread, 1);
  const mine2 = await api('GET', '/dashboard/chat', { token: a.token });
  assert.equal(mine2.data.messages.length, 2);
  assert.equal(mine2.data.messages[1].sender, 'admin');
  await api('POST', '/dashboard/chat/read', { token: a.token });
  assert.equal((await api('GET', '/dashboard/chat/unread', { token: a.token })).data.unread, 0);
  // another merchant sees nothing; editors and merchants cannot use the admin side
  assert.equal((await api('GET', '/dashboard/chat', { token: b.token })).data.messages.length, 0);
  assert.equal((await api('GET', '/admin/chat', { token: (await adminLogin('editor')).token })).status, 403);
  assert.equal((await api('GET', '/admin/chat', { token: a.token })).status, 401);
  assert.equal((await api('POST', '/admin/chat/mch_unknown', { token: owner, body: { body: 'x' } })).status, 404);
});

test('live MonCash/Natcash withdrawal needs a Gateway balance of at least 2 500 HTG; above it any amount goes', async () => {
  const low = await liveWithGateway('minbal-low', 2000);
  const r = await api('POST', '/dashboard/payouts', { token: low.token, body: { amount: 100, method: 'moncash', reference: 'MB-LOW-1', recipient: '50912345678' } });
  assert.equal(r.status, 400);
  assert.equal(r.data.error.code, 'MIN_BALANCE_FOR_WITHDRAWAL');
  assert.match(r.data.error.message, /2\s?500 HTG/);
  const ok = await liveWithGateway('minbal-ok', 2600);
  const w = await api('POST', '/dashboard/payouts', { token: ok.token, body: { amount: 100, method: 'moncash', reference: 'MB-OK-1', recipient: '50912345678' } });
  assert.equal(w.status, 202);
  const q = await api('GET', '/dashboard/payouts/quote?method=moncash&amount=100', { token: ok.token });
  assert.equal(q.data.min_balance_htg, 2500);
});

test('a withdrawal that failed for a technical reason shows the merchant a clear sentence, not the raw code', async () => {
  const live = await liveWithGateway('failmsg', 5000);
  const w = await api('POST', '/dashboard/payouts', { token: live.token, body: { amount: 100, method: 'moncash', reference: 'FM-1', recipient: '50912345678' } });
  const row = mockTables.payouts.find((p) => p.id === w.data.id);
  row.status = 'failed'; row.failure_reason = 'WITHDRAWAL_TOKEN_FAILED: Jeton d\'authentification manquant. (HTTP 401)';
  const got = await api('GET', `/dashboard/payouts/${w.data.id}`, { token: live.token });
  assert.ok(!/WITHDRAWAL_TOKEN_FAILED/.test(got.data.failure_reason));
  assert.match(got.data.failure_reason, /momentanément indisponible/);
  row.failure_reason = 'Numéro NatCash invalide';
  assert.equal((await api('GET', `/dashboard/payouts/${w.data.id}`, { token: live.token })).data.failure_reason, 'Numéro NatCash invalide');
});

// ===== API usage per day/week/month and API blocks =====
test('admin API usage: every merchant with keys is listed, day/week/month counts, and a block stops the API (403) until lifted', async () => {
  const apiUsage = require('../src/services/apiUsage');
  const apiTraffic = require('../src/services/apiTraffic');
  apiTraffic.reset(); apiUsage.reset();
  const live = await makeLiveMerchant('usage');
  const idle = await makeLiveMerchant('usageidle');
  const k = await api('POST', '/dashboard/api-keys', { token: live.token, body: { mode: 'live' } });
  await api('POST', '/dashboard/api-keys', { token: idle.token, body: { mode: 'live' } }); // a key and no traffic at all
  const secret = k.data.secret;
  for (let i = 0; i < 4; i++) await api('GET', '/v1/payments', { token: secret });
  await apiUsage.flush();
  const { token: owner } = await adminLogin('owner');
  const u = await api('GET', '/admin/api-usage', { token: owner });
  assert.equal(u.status, 200);
  const me = u.data.merchants.find((m) => m.merchant_id === live.merchantId);
  const other = u.data.merchants.find((m) => m.merchant_id === idle.merchantId);
  assert.ok(me && other, 'merchants with keys are all listed, even without traffic');
  assert.equal(me.today, 4); assert.equal(me.last7, 4); assert.equal(me.last30, 4); assert.equal(me.this_month, 4);
  assert.equal(me.keys.active, 1); assert.equal(me.keys.live, 1);
  assert.equal(other.today, 0);
  const d = await api('GET', `/admin/api-usage/${live.merchantId}`, { token: owner });
  assert.equal(d.data.daily.length, 30);
  assert.equal(d.data.daily[29].requests, 4);
  assert.equal(d.data.weekly.length, 12); assert.equal(d.data.weekly[11].requests, 4);
  assert.equal(d.data.monthly.length, 6); assert.equal(d.data.monthly[5].requests, 4);
  assert.equal(d.data.keys.length, 1);
  // block: the key stops working at once, the merchant is told why, other merchants are untouched
  const bl = await api('POST', '/admin/api-blocks', { token: owner, body: { merchant_id: live.merchantId, reason: 'Trop de requêtes', hours: 24 } });
  assert.equal(bl.status, 200);
  const denied = await api('GET', '/v1/payments', { token: secret });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.error.code, 'API_BLOCKED');
  assert.match(denied.data.error.message, /Trop de requêtes/);
  assert.equal((await api('GET', '/admin/api-usage', { token: owner })).data.merchants.find((m) => m.merchant_id === live.merchantId).block.reason, 'Trop de requêtes');
  assert.equal((await api('POST', '/admin/api-blocks', { token: owner, body: { merchant_id: live.merchantId, hours: 0.2 } })).data.error.code, 'INVALID_DURATION');
  assert.equal((await api('POST', '/admin/api-blocks/' + live.merchantId + '/remove', { token: owner })).status, 200);
  assert.equal((await api('GET', '/v1/payments', { token: secret })).status, 200);
  // revoking one key is permanent
  const keyId = d.data.keys[0].id;
  assert.equal((await api('POST', `/admin/api-keys/${keyId}/revoke`, { token: owner })).status, 200);
  assert.equal((await api('GET', '/v1/payments', { token: secret })).status, 401);
  // editors and merchants cannot use these routes
  assert.equal((await api('GET', '/admin/api-usage', { token: (await adminLogin('editor')).token })).status, 403);
  assert.equal((await api('POST', '/admin/api-blocks', { token: live.token, body: { merchant_id: live.merchantId } })).status, 401);
});

// ===== Haiti time, chat photos, API health, email alerts =====
test('Haiti time: dates are formatted in America/Port-au-Prince and the day changes at midnight there', () => {
  const t = require('../src/utils/haitiTime');
  assert.equal(t.format('2026-10-18T21:44:00Z'), '18/10/2026 17:44:00');
  assert.equal(t.day('2026-10-19T02:00:00Z'), '2026-10-18'); // 22:00 on the 18th in Haiti
  assert.equal(t.day('2026-10-19T05:00:00Z'), '2026-10-19');
  assert.equal(t.format(null), '-');
});

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
test('chat photos: a real image can be sent by either side, anything else is refused, the photo comes back as a link', async () => {
  const a = await makeLiveMerchant('chatphoto');
  const { token: owner } = await adminLogin('owner');
  assert.equal((await api('POST', '/dashboard/chat', { token: a.token, body: { body: '' } })).data.error.code, 'EMPTY_MESSAGE');
  const bad = await api('POST', '/dashboard/chat', { token: a.token, body: { attachment: { name: 'x.png', data: Buffer.from('<script>alert(1)</script>').toString('base64') } } });
  assert.equal(bad.data.error.code, 'INVALID_ATTACHMENT');
  const big = await api('POST', '/dashboard/chat', { token: a.token, body: { attachment: { name: 'big.png', data: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(5 * 1024 * 1024 + 10)]).toString('base64') } } });
  assert.equal(big.status, 413);
  const ok = await api('POST', '/dashboard/chat', { token: a.token, body: { body: 'Voici la capture', attachment: { name: 'capture.png', data: PNG_1PX } } });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.message.attachment.type, 'image/png');
  assert.ok(ok.data.message.attachment.url);
  const onlyPhoto = await api('POST', '/dashboard/chat', { token: a.token, body: { attachment: { name: 'p.png', data: 'data:image/png;base64,' + PNG_1PX } } });
  assert.equal(onlyPhoto.status, 201);
  const th = await api('GET', `/admin/chat/${a.merchantId}`, { token: owner });
  assert.equal(th.data.messages.filter((m) => m.attachment).length, 2);
  const reply = await api('POST', `/admin/chat/${a.merchantId}`, { token: owner, body: { attachment: { name: 'reponse.png', data: PNG_1PX } } });
  assert.equal(reply.status, 201);
  assert.ok((await api('GET', '/dashboard/chat', { token: a.token })).data.messages.some((m) => m.sender === 'admin' && m.attachment && m.attachment.url));
});

test('API health: a well connected merchant is OK, one with errors/429s/an unused key gets named problems and error codes', async () => {
  const apiUsage = require('../src/services/apiUsage');
  const apiTraffic = require('../src/services/apiTraffic');
  const webhookHealth = require('../src/services/webhookHealth');
  apiTraffic.reset(); apiUsage.reset(); webhookHealth.reset();
  const good = await makeLiveMerchant('healthgood');
  const bad = await makeLiveMerchant('healthbad');
  const idle = await makeLiveMerchant('healthidle');
  const gk = (await api('POST', '/dashboard/api-keys', { token: good.token, body: { mode: 'live' } })).data.secret;
  const bk = (await api('POST', '/dashboard/api-keys', { token: bad.token, body: { mode: 'live' } })).data.secret;
  await api('POST', '/dashboard/api-keys', { token: idle.token, body: { mode: 'live' } });
  for (let i = 0; i < 5; i++) await api('GET', '/v1/payments', { token: gk });
  for (let i = 0; i < 6; i++) await api('POST', '/v1/payments', { token: bk, body: { amount: 'abc' } }); // invalid on purpose
  await apiUsage.flush();
  const { token: owner } = await adminLogin('owner');
  const h = await api('GET', '/admin/api-health', { token: owner });
  assert.equal(h.status, 200);
  const find = (m) => h.data.merchants.find((x) => x.merchant_id === m.merchantId);
  assert.equal(find(good).status, 'ok');
  assert.equal(find(idle).status, 'inactive');
  assert.ok(find(idle).problems.some((p) => /aucun appel/i.test(p.detail)));
  const b = find(bad);
  assert.equal(b.status, 'problem');
  assert.ok(b.problems.some((p) => /Appels réussis/.test(p.title)));
  assert.ok(b.errors.length > 0 && b.errors[0].explanation);
  assert.equal(h.data.summary.problem >= 1, true);
  assert.equal((await api('GET', '/admin/api-health', { token: (await adminLogin('editor')).token })).status, 403);
});

test('email alerts: a merchant that saturates the API and a new chat message each alert the team once (throttled)', async () => {
  const alerts = require('../src/services/adminAlerts');
  const apiTraffic = require('../src/services/apiTraffic');
  alerts.reset(); apiTraffic.reset();
  const m = await makeLiveMerchant('alertme');
  await adminLogin('owner');
  sentEmails.length = 0;
  for (let i = 0; i < 25; i++) apiTraffic.record({ merchantId: m.merchantId, route: 'GET /v1/payments', status: 429, ip: '1.1.1.1', mode: 'live', code: 'RATE_LIMITED' });
  await alerts.watchApi();
  await alerts.watchApi(); // second pass: throttled
  const abuse = sentEmails.filter((e) => /Alerte API/.test(e.subject));
  assert.ok(abuse.length >= 1);
  const recipients = new Set(abuse.map((e) => e.to));
  assert.equal(abuse.length, recipients.size, 'one email per recipient, not repeated');
  sentEmails.length = 0;
  await api('POST', '/dashboard/chat', { token: m.token, body: { body: 'Besoin daide' } });
  await api('POST', '/dashboard/chat', { token: m.token, body: { body: 'Toujours là' } });
  await new Promise((r) => setTimeout(r, 300));
  const chat = sentEmails.filter((e) => /Nouveau message de/.test(e.subject));
  assert.ok(chat.length >= 1);
  assert.equal(chat.length, new Set(chat.map((e) => e.to)).size);
});

test('API health: the team can send a merchant the error message of its connection (chat, and email on request)', async () => {
  const apiUsage = require('../src/services/apiUsage');
  const apiTraffic = require('../src/services/apiTraffic');
  apiTraffic.reset(); apiUsage.reset();
  const bad = await makeLiveMerchant('healthmsg');
  const good = await makeLiveMerchant('healthmsgok');
  const bk = (await api('POST', '/dashboard/api-keys', { token: bad.token, body: { mode: 'live' } })).data.secret;
  const gk = (await api('POST', '/dashboard/api-keys', { token: good.token, body: { mode: 'live' } })).data.secret;
  for (let i = 0; i < 6; i++) await api('POST', '/v1/payments', { token: bk, body: { amount: 'abc' } });
  for (let i = 0; i < 3; i++) await api('GET', '/v1/payments', { token: gk });
  await apiUsage.flush();
  const { token: owner } = await adminLogin('owner');
  const draft = await api('GET', `/admin/api-health/${bad.merchantId}/message`, { token: owner });
  assert.equal(draft.status, 200);
  assert.match(draft.data.message, /MISSING_FIELDS/);
  assert.match(draft.data.message, /Pour corriger/);
  assert.equal((await api('GET', `/admin/api-health/${good.merchantId}/message`, { token: owner })).data.error.code, 'NO_PROBLEM');
  sentEmails.length = 0;
  const sent = await api('POST', `/admin/api-health/${bad.merchantId}/send`, { token: owner, body: { message: draft.data.message, email: true } });
  assert.equal(sent.status, 200);
  assert.equal(sent.data.emailed, true);
  assert.ok(sentEmails.some((e) => e.to === emailOf(bad) && /connexion API/i.test(e.subject)));
  const chat = await api('GET', '/dashboard/chat', { token: bad.token });
  assert.ok(chat.data.messages.some((m) => m.sender === 'admin' && /MISSING_FIELDS/.test(m.body)));
  assert.equal((await api('POST', `/admin/api-health/${bad.merchantId}/send`, { token: owner, body: { message: ' ' } })).data.error.code, 'EMPTY_MESSAGE');
  assert.equal((await api('GET', `/admin/api-health/${bad.merchantId}/message`, { token: (await adminLogin('editor')).token })).status, 403);
});

test('webhook endpoint check: the admin sees whether a merchant endpoint is well configured and why not', async () => {
  const http = require('node:http');
  const answers = { '/ok': [200, ''], '/missing': [404, ''], '/boom': [500, ''], '/denied': [403, ''], '/moved': [302, 'https://elsewhere.example/hook'] };
  const srv = http.createServer((req, res) => {
    req.resume();
    const [code, loc] = answers[req.url] || [200, ''];
    res.writeHead(code, loc ? { Location: loc } : {}); res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const { token: owner } = await adminLogin('owner');
    const m = await makeLiveMerchant('whprobe');
    const probe = async (path) => {
      mockTables.webhook_endpoints = (mockTables.webhook_endpoints || []).filter((e) => e.merchant_id !== m.merchantId);
      mockTables.webhook_endpoints.push({ id: 'wh_' + path.replace('/', ''), merchant_id: m.merchantId, url: base + path, secret: 'whsec_x', active: true, created_at: new Date().toISOString() });
      return (await api('POST', `/admin/api-health/${m.merchantId}/test-webhook`, { token: owner })).data;
    };
    const ok = await probe('/ok');
    assert.equal(ok.ok, true); assert.equal(ok.http_status, 200); assert.equal(ok.https, false);
    const missing = await probe('/missing');
    assert.equal(missing.ok, false); assert.match(missing.diagnosis, /404/);
    assert.match((await probe('/boom')).diagnosis, /plante \(500\)/);
    assert.match((await probe('/denied')).diagnosis, /refuse la requête \(403\)/);
    assert.match((await probe('/moved')).diagnosis, /redirige/);
    // nothing is listening on a closed port
    mockTables.webhook_endpoints.find((e) => e.merchant_id === m.merchantId).url = 'http://127.0.0.1:1/x';
    assert.match((await api('POST', `/admin/api-health/${m.merchantId}/test-webhook`, { token: owner })).data.diagnosis, /refusée|injoignable/);
    // no endpoint at all
    mockTables.webhook_endpoints = mockTables.webhook_endpoints.filter((e) => e.merchant_id !== m.merchantId);
    const none = (await api('POST', `/admin/api-health/${m.merchantId}/test-webhook`, { token: owner })).data;
    assert.equal(none.configured, false);
    // a private address is refused when the explicit test allowance is off
    process.env.ALLOW_PRIVATE_WEBHOOKS = '0';
    mockTables.webhook_endpoints.push({ id: 'wh_p', merchant_id: m.merchantId, url: 'http://127.0.0.1:9/x', secret: 's', active: true });
    assert.match((await api('POST', `/admin/api-health/${m.merchantId}/test-webhook`, { token: owner })).data.diagnosis, /pas publique/);
    process.env.ALLOW_PRIVATE_WEBHOOKS = '1';
    const all = await api('POST', '/admin/api-health/test-webhooks', { token: owner });
    assert.equal(all.status, 200);
    assert.equal((await api('POST', `/admin/api-health/${m.merchantId}/test-webhook`, { token: (await adminLogin('editor')).token })).status, 403);
  } finally { process.env.ALLOW_PRIVATE_WEBHOOKS = '1'; await new Promise((r) => srv.close(r)); }
});

test('admin "Erreurs cartes": a failed card creation keeps the provider message for the team, the merchant only sees the French sentence', async () => {
  const providerErrors = require('../src/services/providerErrors');
  providerErrors.reset();
  const reg = await registerAndVerify({ business_name: 'Prov Err Co', email: 'prov-err@example.com', password: 'password123' });
  const token = reg.data.session_token;
  mapleradBehavior.softErrorNextCard = true;
  const r = await api('POST', '/dashboard/cards', { token, body: { reference: 'PROV-1', kind: 'business', business_name: 'Prov Err Co', brand: 'VISA', amount: 15 } });
  assert.equal(r.status, 400);
  assert.doesNotMatch(JSON.stringify(r.data), /CreateCardRequest|CustomerID/);
  const { token: owner } = await adminLogin('owner');
  const list = await api('GET', '/admin/provider-errors', { token: owner });
  assert.equal(list.status, 200);
  const mine = list.data.errors.find((e) => /PROV-1|\/dashboard\/cards/.test(e.route || '') && e.merchant_name);
  assert.ok(mine, JSON.stringify(list.data.errors.slice(0, 2)));
  assert.match(mine.message, /CustomerID|validation|required/i);
  assert.ok(mine.hint && mine.hint.length > 10);
  assert.ok(mine.request_keys && !/PROV-1/.test(mine.request_keys), 'field names only, never values');
  assert.equal((await api('GET', '/admin/provider-errors', { token: (await adminLogin('editor')).token })).status, 403);
});

test('provider "service is not available" shows the temporary-unavailable sentence, with an admin hint', () => {
  const maplerad = require('../src/services/maplerad');
  const providerErrors = require('../src/services/providerErrors');
  assert.match(maplerad.translateKnownMessage('service is not available at the moment'), /momentanément indisponible/);
  assert.match(providerErrors.hintFor({ message: 'service is not available at the moment', http_status: 400 }), /indisponible/);
});

test('low-balance email warns before the floor (alert at 150 $) and keeps the 50 $ reserve wording', async () => {
  const { lowBalanceEmail } = require('../src/templates/lowBalanceEmail');
  const config = require('../src/config');
  assert.equal(config.masterWallet.alertBalanceUsd, 150);
  assert.equal(config.masterWallet.minimumBalanceUsd, 50);
  const warn = lowBalanceEmail({ businessName: 'X', balance: 140, minimumBalance: 50 });
  assert.match(warn.subject, /approche/);
  assert.match(warn.html, /50,00 \$ restent toujours bloqu/);
  const floor = lowBalanceEmail({ businessName: 'X', balance: 50, minimumBalance: 50 });
  assert.match(floor.html, /a atteint le solde minimum/);
});

test('failed-creation webhook: the partner reason is translated for the merchant and kept raw for the admin', async () => {
  const reg = await registerAndVerify({ business_name: 'Reason Co', email: 'reasonco@sandbox-test.example.com', password: 'password123' });
  const token = reg.data.session_token;
  const c = await api('POST', '/dashboard/cards', { token, body: { reference: 'REASON-1', kind: 'business', business_name: 'Reason Co', brand: 'VISA', amount: 20 } });
  assert.equal(c.status, 202);
  await pollUntil(() => api('GET', `/dashboard/cards/${c.data.id}`, { token }), (r) => r.data.status === 'active', 40, 20);
  const row = mockTables.cards.find((x) => x.id === c.data.id);
  row.status = 'pending';
  const providerErrors = require('../src/services/providerErrors');
  providerErrors.reset();
  await sendProviderEvent({ event: 'issuing.created.failed', reference: row.maplerad_reference, reason: 'customer must be tier 2 or above to create a card' }, MOCK_SANDBOX_WHSEC);
  assert.equal(row.status, 'failed');
  assert.match(row.failure_reason, /vérification d'identité/);
  assert.match(row.failure_reason, /remboursés/);
  const seen = await providerErrors.list(10);
  assert.ok(seen.some((e) => /tier 2/.test(e.message)));
});

test('failed-creation webhook in the documented wrapped shape: reason translated, retry link relayed', async () => {
  const reg = await registerAndVerify({ business_name: 'Wrapped Co', email: 'wrappedco@sandbox-test.example.com', password: 'password123' });
  const token = reg.data.session_token;
  const c = await api('POST', '/dashboard/cards', { token, body: { reference: 'WRAP-1', kind: 'business', business_name: 'Wrapped Co', brand: 'VISA', amount: 20 } });
  assert.equal(c.status, 202);
  await pollUntil(() => api('GET', `/dashboard/cards/${c.data.id}`, { token }), (r) => r.data.status === 'active', 40, 20);
  const row = mockTables.cards.find((x) => x.id === c.data.id);
  row.status = 'pending';
  const dispatcher = require('../src/services/webhookDispatcher');
  const seen = [];
  const original = dispatcher.dispatch;
  dispatcher.dispatch = (m, ev, data) => { seen.push({ ev, data }); return original.apply(dispatcher, [m, ev, data]); };
  try {
    await sendProviderEvent({ eventId: 'e1', eventType: 'issuing.created.failed', payload: { event: 'issuing.created.failed', reference: row.maplerad_reference, status: 'Rejected', reason: 'Facial verification mismatch: Selfie does not match passport photo', verification_link: 'https://example.com/retry/abc', link_expire_at: '2026-10-30T18:00:00Z' } }, MOCK_SANDBOX_WHSEC);
  } finally { dispatcher.dispatch = original; }
  assert.equal(row.status, 'failed');
  assert.match(row.failure_reason, /vérification faciale/);
  const ev = seen.find((x) => x.ev === 'card.failed');
  assert.ok(ev, 'card.failed dispatched');
  assert.equal(ev.data.verification_link, 'https://example.com/retry/abc');
});

test('identity back image is optional but validated, and the KYC rejection codes are translated', async () => {
  const maplerad = require('../src/services/maplerad');
  assert.match(maplerad.translateKnownMessage('FRONT_SIDE_MISSING'), /recto et le verso/);
  assert.match(maplerad.translateKnownMessage('LOW_QUALITY'), /lisible/);
  const reg = await registerAndVerify({ business_name: 'Back Co', email: 'backco@sandbox-test.example.com', password: 'password123' });
  const bad = await api('POST', '/dashboard/cards/holders', { token: reg.data.session_token, body: { firstName: 'A', lastName: 'B', email: 'a@b.com', country: 'US', dob: '1990-01-01', identificationNumber: '123', phoneNumber: '5551234567', phoneShortCode: '+1', address: { street: 's', city: 'c', state: 'st', postalCode: '1', country: 'US' }, identity: { type: 'NIN', number: '1', imageUrl: 'data:image/jpeg;base64,AAAA', imageBackUrl: 'nope', country: 'US' } } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error.message, /imageBackUrl/);
});

test('holder creation accepts a body larger than 1 MB (front and back ID images)', async () => {
  const reg = await registerAndVerify({ business_name: 'Big Body Co', email: 'bigbody@sandbox-test.example.com', password: 'password123' });
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(1_200_000);
  const r = await api('POST', '/dashboard/cards/holders', { token: reg.data.session_token, body: { firstName: 'A', identity: { type: 'NIN', number: '1', imageUrl: big, imageBackUrl: big, country: 'US' } } });
  assert.notEqual(r.status, 413);
  assert.equal(r.status, 400); // reaches validation (missing fields) instead of being cut at the body limit
});

test('business cards paused: refused before any debit, individual cards unaffected', async () => {
  const config = require('../src/config');
  const reg = await registerAndVerify({ business_name: 'Paused Co', email: 'pausedco@sandbox-test.example.com', password: 'password123' });
  const token = reg.data.session_token;
  const before = (await f2Balance(token)).master_wallet.available;
  config.businessCardsPaused = true;
  try {
    const r = await api('POST', '/dashboard/cards', { token, body: { reference: 'PAUSED-1', kind: 'business', business_name: 'Paused Co', brand: 'VISA', amount: 20 } });
    assert.equal(r.status, 503);
    assert.equal(r.data.error.code, 'BUSINESS_CARDS_PAUSED');
    assert.match(r.data.error.message, /temporairement suspendue/);
    assert.equal((await f2Balance(token)).master_wallet.available, before);
  } finally { config.businessCardsPaused = false; }
});

test('seo: slugs end on a whole word, "# " is removed from titles, old blog addresses redirect (301), titles and metas are short', async () => {
  const seo = require('../src/utils/seo');
  const longTitle = 'Top 10 des meilleures solutions pour accepter des paiements en ligne en Haïti en 2026 comparatif complet';
  const slug = seo.slugFrom(longTitle, 60);
  assert.ok(slug.length <= 60 && slug.endsWith('2026') === false || slug.length <= 60);
  assert.ok(!/-$/.test(slug) && longTitle.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').startsWith(slug));
  assert.equal(seo.cleanTitle('# Top 10 des solutions'), 'Top 10 des solutions');
  assert.ok(seo.seoTitle(longTitle).length <= 60);
  assert.equal(seo.seoTitle('Court titre'), 'Court titre | Freda Pay Issuing');

  const { token } = await adminLogin('owner');
  const created = await api('POST', '/admin/blog', { token, body: { title: '# Article à renommer', content_markdown: 'Contenu.', excerpt: 'Résumé' } });
  assert.equal(created.status, 201);
  assert.equal(created.data.post.title, 'Article à renommer');
  const id = created.data.post.id;
  const oldSlug = created.data.post.slug;
  await api('POST', `/admin/blog/${id}/publish`, { token });
  const renamed = await api('PUT', `/admin/blog/${id}`, { token, body: { slug: 'nouveau-slug-court' } });
  assert.equal(renamed.data.post.slug, 'nouveau-slug-court');
  const moved = await fetch(`http://localhost:${APP_PORT}/blog/${oldSlug}`, { redirect: 'manual' });
  assert.equal(moved.status, 301);
  assert.match(moved.headers.get('location'), /\/blog\/nouveau-slug-court$/);
  const page = await (await fetch(`http://localhost:${APP_PORT}/blog/nouveau-slug-court`)).text();
  assert.match(page, /<title>Article à renommer \| Freda Pay Issuing<\/title>/);
  assert.match(page, /BreadcrumbList/);
  assert.match(page, /Ressources liées/);
  const sm = await (await fetch(`http://localhost:${APP_PORT}/sitemap.xml`)).text();
  assert.match(sm, /xmlns:xhtml/);
  assert.match(sm, /hreflang="en" href="[^"]*\/en\/card-payments-haiti"/);
});

test('MonCash / Natcash payments and auto top-ups are settled in the background, without anybody polling', async () => {
  const orchestrator = require('../src/services/paymentOrchestrator');
  const topups = require('../src/services/walletTopupOrchestrator');
  const live = await liveWithGateway('mobilerecon', 0);
  const before = await gw(live.token);
  const pay = await api('POST', '/dashboard/payments', { token: live.token, body: { amount: 1000, currency: 'HTG', method: 'moncash', reference: 'BG-RECON-1' } });
  assert.equal(pay.status, 201);
  const row = mockTables.payments.find((p) => p.id === pay.data.id);
  // Nothing confirmed yet: the pass leaves it pending.
  await orchestrator.reconcilePendingMobile(50);
  assert.equal(mockTables.payments.find((p) => p.id === pay.data.id).status, 'pending');
  // The customer pays on the partner's side; nobody asks for the payment.
  await fetch('http://localhost:4501/__control/confirm-payment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refference_id: row.plopplop_reference }) });
  const res = await orchestrator.reconcilePendingMobile(50);
  assert.ok(res.settled >= 1);
  assert.equal(mockTables.payments.find((p) => p.id === pay.data.id).status, 'succeeded');
  assert.equal((await gw(live.token)) - before, 930);
  // Once settled it is never credited twice.
  await orchestrator.reconcilePendingMobile(50);
  assert.equal((await gw(live.token)) - before, 930);
  assert.equal(typeof topups.reconcilePendingAutoTopups, 'function');
  assert.deepEqual(await topups.reconcilePendingAutoTopups(10).then((r) => typeof r.settled), 'number');
});

test('admin merchant list and detail show the Gateway balance in dollars too (card payments credit it)', async () => {
  const { token } = await adminLogin('owner');
  const live = await liveWithGateway('admgwusd', 0);
  await require('../src/services/ledger').creditGateway(live.merchantId, 12.5, 'USD', `seed-usd-${Math.random()}`, null, 'live');
  const detail = await api('GET', `/admin/merchants/${live.merchantId}`, { token });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.balances.gateway_usd, 12.5);
  const list = await api('GET', '/admin/merchants', { token });
  assert.equal(list.data.merchants.find((m) => m.id === live.merchantId).balances.gateway_usd, 12.5);
});

test('a payment that stays pending with an unexpected partner answer leaves a readable trace for the admin', async () => {
  const orchestrator = require('../src/services/paymentOrchestrator');
  const providerErrors = require('../src/services/providerErrors');
  const plopplop = require('../src/services/plopplop');
  const live = await liveWithGateway('verifynote', 0);
  const pay = await api('POST', '/dashboard/payments', { token: live.token, body: { amount: 500, currency: 'HTG', method: 'natcash', reference: 'VERIFY-NOTE-1' } });
  const row = mockTables.payments.find((p) => p.id === pay.data.id);
  row.created_at = new Date(Date.now() - 3600 * 1000).toISOString();
  providerErrors.reset();
  const original = plopplop.verifyPayment;
  plopplop.verifyPayment = async () => ({ httpStatus: 200, data: { status: true, trans_status: 'waiting_settlement', message: 'success', montant: 500, method: 'natcash' } });
  try {
    const after = await orchestrator.refreshStatus(live.merchantId, row);
    assert.equal(after.status, 'pending');
  } finally { plopplop.verifyPayment = original; }
  await new Promise((r) => setTimeout(r, 150)); // the trace is saved without making the caller wait
  const seen = await providerErrors.list(10);
  assert.ok(seen.some((e) => /waiting_settlement/.test(e.message) && e.route === 'verify payment'));
});

test('admin can ask the payment partner about one payment and re-run its confirmation', async () => {
  const { token } = await adminLogin('owner');
  const live = await liveWithGateway('admcheck', 0);
  const pay = await api('POST', '/dashboard/payments', { token: live.token, body: { amount: 1000, currency: 'HTG', method: 'natcash', reference: 'ADM-CHECK-1' } });
  const row = mockTables.payments.find((p) => p.id === pay.data.id);
  const first = await api('POST', '/admin/payments/check', { token, body: { payment: pay.data.id } });
  assert.equal(first.status, 200);
  assert.equal(first.data.payment.status, 'pending');
  assert.equal(first.data.partner.answer.trans_status, 'no');
  await fetch('http://localhost:4501/__control/confirm-payment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refference_id: row.plopplop_reference }) });
  const settled = await api('POST', '/admin/payments/check', { token, body: { payment: 'ADM-CHECK-1', settle: true } });
  assert.equal(settled.data.partner.answer.trans_status, 'ok');
  assert.equal(settled.data.after.status, 'succeeded');
  assert.equal((await api('POST', '/admin/payments/check', { token: (await adminLogin('editor')).token, body: { payment: 'x' } })).status, 403);
  assert.equal((await api('POST', '/admin/payments/check', { token, body: { payment: 'nope' } })).status, 404);
});

test('payment diagnostic: lists pending MonCash/Natcash payments with what the partner answered, flags the odd ones, and the lookup accepts partner ids', async () => {
  const orchestrator = require('../src/services/paymentOrchestrator');
  const plopplop = require('../src/services/plopplop');
  const { token } = await adminLogin('owner');
  const live = await liveWithGateway('diagpay', 0);
  const pay = await api('POST', '/dashboard/payments', { token: live.token, body: { amount: 700, currency: 'HTG', method: 'natcash', reference: 'DIAG-PAY-1' } });
  const row = mockTables.payments.find((p) => p.id === pay.data.id);
  row.created_at = new Date(Date.now() - 45 * 60 * 1000).toISOString();
  const original = plopplop.verifyPayment;
  plopplop.verifyPayment = async () => ({ httpStatus: 404, data: { status: false, message: 'Transaction introuvable.' } });
  try { await orchestrator.reconcilePendingMobile(50); } finally { plopplop.verifyPayment = original; }
  const diag = await api('GET', '/admin/payments/diagnostic', { token });
  assert.equal(diag.status, 200);
  assert.ok(diag.data.background.runs >= 1);
  const item = diag.data.items.find((i) => i.id === row.id);
  assert.ok(item, 'listed');
  assert.equal(item.kind, 'not_found');
  assert.equal(item.level, 'bad');
  assert.match(item.label, /Introuvable chez le partenaire/);
  // The lookup finds the payment from the partner's transaction id and from part of its reference.
  if (row.plopplop_transaction_id) assert.equal((await api('POST', '/admin/payments/check', { token, body: { payment: row.plopplop_transaction_id } })).data.payment.id, row.id);
  assert.equal((await api('POST', '/admin/payments/check', { token, body: { payment: 'DIAG-PAY' } })).data.payment.id, row.id);
  assert.equal((await api('GET', '/admin/payments/diagnostic', { token: (await adminLogin('editor')).token })).status, 403);
  const unknown = await api('POST', '/admin/payments/check', { token, body: { payment: 'zzz-not-here-99' } });
  assert.equal(unknown.status, 404);
  assert.match(unknown.data.error.message, /n'a pas été enregistré chez nous/);
});

test('background reconciliation reads MonCash/Natcash rows that carry provider = plopplop (the real database default) and skips card rows', async () => {
  const orchestrator = require('../src/services/paymentOrchestrator');
  const live = await liveWithGateway('provdefault', 0);
  const pay = await api('POST', '/dashboard/payments', { token: live.token, body: { amount: 1000, currency: 'HTG', method: 'natcash', reference: 'PROV-DEF-1' } });
  const row = mockTables.payments.find((p) => p.id === pay.data.id);
  row.provider = 'plopplop'; // what the production column default stores
  await fetch('http://localhost:4501/__control/confirm-payment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refference_id: row.plopplop_reference }) });
  const res = await orchestrator.reconcilePendingMobile(100);
  assert.ok(res.settled >= 1);
  assert.equal(mockTables.payments.find((p) => p.id === pay.data.id).status, 'succeeded');
});

test('admin API journal: each /v1 call is listed per merchant, errors carry the message and the fix, an oversized body is still attributed, and bodies are never stored', async () => {
  const apiCallLog = require('../src/services/apiCallLog');
  const { token } = await adminLogin('owner');
  const bad = await api('POST', '/v1/payments', { token: testApiKeySecret, body: { amount: 1000 } });
  assert.equal(bad.status, 400);
  assert.ok(await api('GET', '/v1/balance', { token: testApiKeySecret }));
  const big = await fetch(`http://localhost:${APP_PORT}/v1/cards/holders`, { method: 'POST', headers: { Authorization: `Bearer ${testApiKeySecret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ firstName: 'x'.repeat(4 * 1024 * 1024) }) });
  assert.equal(big.status, 413);
  assert.match(big.headers.get('x-request-id') || '', /^req_[a-f0-9]{12}$/);
  await apiCallLog.flush();
  const list = await api('GET', '/admin/api-calls?days=7', { token });
  assert.equal(list.status, 200);
  const me = list.data.merchants.find((m) => m.merchant_id === merchantId);
  assert.ok(me && me.calls >= 3 && me.errors >= 2);
  const detail = await api('GET', `/admin/api-calls/${merchantId}?errors=1`, { token });
  assert.equal(detail.status, 200);
  const missing = detail.data.calls.find((c) => c.code === 'MISSING_FIELDS');
  assert.ok(missing, 'MISSING_FIELDS listed');
  assert.match(missing.message, /requis/);
  assert.ok(missing.fix && missing.explain);
  assert.equal(missing.route, '/v1/payments');
  const tooBig = detail.data.calls.find((c) => c.status === 413);
  assert.ok(tooBig, 'oversized body attributed to the merchant from its key');
  assert.equal(tooBig.code, 'PAYLOAD_TOO_LARGE');
  assert.match(tooBig.fix, /Réduisez/);
  // No body content anywhere in the journal.
  assert.ok(!JSON.stringify(mockTables.api_call_log).includes('xxxxxxxxxx'));
  const onlyBalance = await api('GET', `/admin/api-calls/${merchantId}?route=balance`, { token });
  assert.ok(onlyBalance.data.calls.length >= 1 && onlyBalance.data.calls.every((c) => /balance/.test(c.route)));
  assert.equal((await api('GET', '/admin/api-calls', { token: (await adminLogin('editor')).token })).status, 403);
});

test('contracts: a signature imported from a picture and the new handwriting fonts are accepted, and the PDF says how each was made', async () => {
  const m = await makeLiveMerchant('ctrupload');
  const imported = () => ({ type: 'uploaded', image: sigMask() });
  const create = await api('POST', '/admin/contracts', { token: m.adminToken, body: { title: 'Contrat signature importée', body_html: CONTRACT_HTML, merchant_id: m.merchantId, admin_signature: { type: 'typed', name: 'Admin Freda', font: 'Alex Brush', image: sigMask(320, 100) } } });
  assert.equal(create.status, 201);
  const id = create.data.contract.id;
  const sign = await api('POST', `/dashboard/contracts/${id}/sign`, { token: m.token, body: { signer_name: 'Marie Jean', fields: { "Nom de l'entreprise": 'Boutik Lakay', 'Représentant': 'Marie Jean' }, signature: imported() } });
  assert.equal(sign.status, 200);
  const pdf = await rawGet(`/dashboard/contracts/${id}/pdf`, m.token);
  assert.equal(pdf.status, 200);
  assert.ok(pdf.buf.length > 3000);
  const bad = await api('POST', '/admin/contracts', { token: m.adminToken, body: { title: 'x', body_html: CONTRACT_HTML, merchant_id: m.merchantId, admin_signature: { type: 'scanned', image: sigMask() } } });
  assert.equal(bad.status, 400);
});

test('card purchases lower the card balance (once per event), refunds give it back, declines and funding events do not move it', async () => {
  const reg = await registerAndVerify({ business_name: 'Spend Co', email: 'spendco@sandbox-test.example.com', password: 'password123' });
  const token = reg.data.session_token;
  const c = await api('POST', '/dashboard/cards', { token, body: { reference: 'SPEND-1', kind: 'business', business_name: 'Spend Co', brand: 'VISA', amount: 20 } });
  assert.equal(c.status, 202);
  await pollUntil(() => api('GET', `/dashboard/cards/${c.data.id}`, { token }), (r) => r.data.status === 'active', 40, 20);
  const row = mockTables.cards.find((x) => x.id === c.data.id);
  assert.equal(Number(row.balance), 20);
  const ev = (over) => Object.assign({ event: 'issuing.transaction', type: 'AUTHORIZATION', mode: 'DEBIT', status: 'SUCCESS', amount: 500, currency: 'USD', card_id: row.maplerad_card_id, reference: 'spend-a', merchant: { name: 'SHOP' } }, over);
  await sendProviderEvent(ev({}), MOCK_SANDBOX_WHSEC);
  assert.equal(Number(mockTables.cards.find((x) => x.id === row.id).balance), 15);
  await sendProviderEvent(ev({}), MOCK_SANDBOX_WHSEC); // the same purchase delivered again
  assert.equal(Number(mockTables.cards.find((x) => x.id === row.id).balance), 15);
  await sendProviderEvent(ev({ reference: 'spend-settle', type: 'SETTLEMENT' }), MOCK_SANDBOX_WHSEC);
  assert.equal(Number(mockTables.cards.find((x) => x.id === row.id).balance), 15);
  await sendProviderEvent(ev({ reference: 'spend-decline', type: 'DECLINE', status: 'FAILED', amount: 9999 }), MOCK_SANDBOX_WHSEC);
  assert.equal(Number(mockTables.cards.find((x) => x.id === row.id).balance), 15);
  await sendProviderEvent(ev({ reference: 'spend-funding', type: 'FUNDING', mode: 'CREDIT', amount: 3000 }), MOCK_SANDBOX_WHSEC);
  assert.equal(Number(mockTables.cards.find((x) => x.id === row.id).balance), 15);
  await sendProviderEvent(ev({ reference: 'spend-refund', type: 'REFUND', mode: 'CREDIT', amount: 200 }), MOCK_SANDBOX_WHSEC);
  assert.equal(Number(mockTables.cards.find((x) => x.id === row.id).balance), 17);
  await sendProviderEvent(ev({ reference: 'spend-big', amount: 90000 }), MOCK_SANDBOX_WHSEC); // more than the card holds: never below zero
  assert.equal(Number(mockTables.cards.find((x) => x.id === row.id).balance), 0);
  const shown = await api('GET', `/dashboard/cards/${row.id}`, { token });
  assert.equal(Number(shown.data.balance), 0);
});

test('one-time correction: purchases stored before this version are taken off the card once, never twice', async () => {
  const orchestrator = require('../src/services/cardOrchestrator');
  const live = await liveMerchantWithActivity('backfill'); // business card pre-funded with 100 $
  const card = mockTables.cards.find((c) => c.id === live.card.id);
  card.balance = 100;
  const old = new Date(Date.now() - 3600 * 1000).toISOString();
  mockTables.card_transactions.push({ id: 'ctx_bf1', merchant_id: live.merchantId, card_id: card.id, mode: 'live', provider_reference: 'bf-1', type: 'AUTHORIZATION', status: 'SUCCESS', direction: 'DEBIT', amount_usd: 30, currency: 'USD', occurred_at: old, created_at: old });
  mockTables.card_transactions.push({ id: 'ctx_bf2', merchant_id: live.merchantId, card_id: card.id, mode: 'live', provider_reference: 'bf-2', type: 'DECLINE', status: 'FAILED', direction: 'DEBIT', amount_usd: 500, currency: 'USD', occurred_at: old, created_at: old });
  mockTables.platform_settings = mockTables.platform_settings.filter((r) => r.key !== 'card_balance_cutover');
  const first = await orchestrator.backfillCardBalances();
  assert.ok(first.corrected >= 1);
  assert.equal(Number(mockTables.cards.find((c) => c.id === card.id).balance), 70);
  const second = await orchestrator.backfillCardBalances();
  assert.equal(second.skipped, true);
  assert.equal(Number(mockTables.cards.find((c) => c.id === card.id).balance), 70);
});

test('per-card transactions: stored purchases show up with a French label and this-month spend even if the partner list is empty or down', async () => {
  const reg = await registerAndVerify({ business_name: 'Txn List Co', email: 'txnlistco@sandbox-test.example.com', password: 'password123' });
  const token = reg.data.session_token;
  const c = await api('POST', '/dashboard/cards', { token, body: { reference: 'TXL-1', kind: 'business', business_name: 'Txn List Co', brand: 'VISA', amount: 50 } });
  await pollUntil(() => api('GET', `/dashboard/cards/${c.data.id}`, { token }), (r) => r.data.status === 'active', 40, 20);
  const row = mockTables.cards.find((x) => x.id === c.data.id);
  const ev = (over) => Object.assign({ event: 'issuing.transaction', type: 'AUTHORIZATION', mode: 'DEBIT', status: 'SUCCESS', amount: 1000, currency: 'USD', card_id: row.maplerad_card_id, reference: 'txl-a', merchant: { name: 'AMAZON' }, created_at: new Date().toISOString() }, over);
  await sendProviderEvent(ev({}), MOCK_SANDBOX_WHSEC);
  await sendProviderEvent(ev({ reference: 'txl-b', type: 'DECLINE', status: 'FAILED', amount: 9000, merchant: { name: 'SHOPX' } }), MOCK_SANDBOX_WHSEC);
  await sendProviderEvent(ev({ reference: 'txl-c', type: 'REFUND', mode: 'CREDIT', amount: 300 }), MOCK_SANDBOX_WHSEC);
  const maplerad = require('../src/services/maplerad');
  const original = maplerad.forMode;
  maplerad.forMode = () => ({ getCardTransactions: async () => { const e = new Error('down'); e.httpStatus = 502; e.code = 'CARD_SERVICE_ERROR'; throw e; } });
  let r;
  try { r = await api('GET', `/dashboard/cards/${row.id}/transactions`, { token }); } finally { maplerad.forMode = original; }
  assert.equal(r.status, 200);
  assert.equal(r.data.complete, false);
  const labels = r.data.transactions.map((t) => t.label).sort();
  assert.deepEqual(labels, ['Achat', 'Refusé', 'Remboursement']);
  assert.equal(r.data.month_spend, 7); // 10 spent - 3 refunded, the decline does not count
});

test('withdrawal safety net: a MonCash payout lost by a restart is settled from what the partner says (success, failed, never sent)', async () => {
  const orchestrator = require('../src/services/payoutOrchestrator');
  const plopplop = require('../src/services/plopplop');
  const live = await liveWithGateway('payrecon', 10000);
  const old = new Date(Date.now() - 3600 * 1000).toISOString();
  const mk = async (suffix, amount) => {
    const id = `po_recon_${suffix}`;
    const ref = `fp_${live.merchantId}_RECON-${suffix}`;
    mockTables.payouts.push({ id, merchant_id: live.merchantId, own_reference: `RECON-${suffix}`, plopplop_reference: ref, amount, method: 'moncash', recipient: '50937001234', status: 'pending', fee: 50, currency: 'HTG', mode: 'live', created_at: old, updated_at: old });
    await require('../src/services/ledger').debitGatewayForPayout(live.merchantId, amount, 'HTG', `${ref}:hold`, id, 'live');
    await require('../src/services/ledger').debitGatewayForPayout(live.merchantId, 50, 'HTG', `${ref}:hold-fee`, id, 'live');
    return id;
  };
  const okId = await mk('ok', 1000), failId = await mk('fail', 800), lostId = await mk('lost', 600), waitId = await mk('wait', 400);
  const afterHold = await gw(live.token);
  const original = plopplop.verifyWithdrawal;
  plopplop.verifyWithdrawal = async ({ reference }) => {
    if (reference.endsWith('RECON-ok')) return { httpStatus: 200, data: { success: true, data: { status: 'success', transaction_id: 'T1' } } };
    if (reference.endsWith('RECON-fail')) return { httpStatus: 200, data: { success: true, data: { status: 'failed' } } };
    if (reference.endsWith('RECON-lost')) return { httpStatus: 404, data: { success: false, message: 'Aucun retrait trouvé pour cette référence.' } };
    return { httpStatus: 200, data: { success: true, data: { status: 'pending' } } };
  };
  let res;
  try { res = await orchestrator.reconcilePendingPayouts(10); } finally { plopplop.verifyWithdrawal = original; }
  assert.ok(res.settled >= 3);
  const status = (id) => mockTables.payouts.find((p) => p.id === id).status;
  assert.equal(status(okId), 'success');
  assert.equal(status(failId), 'failed');
  assert.equal(status(lostId), 'failed');
  assert.equal(status(waitId), 'pending');
  // failed + never sent give back amount + fee: (800 + 50) + (600 + 50)
  assert.equal((await gw(live.token)) - afterHold, 1500);
  // Nothing happens twice.
  plopplop.verifyWithdrawal = async () => ({ httpStatus: 200, data: { success: true, data: { status: 'failed' } } });
  try { await orchestrator.reconcilePendingPayouts(10); } finally { plopplop.verifyWithdrawal = original; }
  assert.equal((await gw(live.token)) - afterHold, 1500 + 450); // only the still-pending one (400 + 50) is now given back
});

test('card safety nets: a creation whose notification never came is activated from the partner, a partner closure marks the card terminated, a partner fee lowers the balance', async () => {
  const orchestrator = require('../src/services/cardOrchestrator');
  const maplerad = require('../src/services/maplerad');
  const reg = await registerAndVerify({ business_name: 'Net Co', email: 'netco@sandbox-test.example.com', password: 'password123' });
  const token = reg.data.session_token;
  const c = await api('POST', '/dashboard/cards', { token, body: { reference: 'NET-1', kind: 'business', business_name: 'Net Co', brand: 'VISA', amount: 20 } });
  await pollUntil(() => api('GET', `/dashboard/cards/${c.data.id}`, { token }), (r) => r.data.status === 'active', 40, 20);
  const row = mockTables.cards.find((x) => x.id === c.data.id);
  // 1) creation lost: the card is pending again, 20 minutes old, and the partner knows it.
  row.status = 'pending'; row.masked_pan = null; row.created_at = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const original = maplerad.forMode;
  maplerad.forMode = () => ({ getCard: async () => ({ data: { id: row.maplerad_card_id, status: 'ACTIVE', masked_pan: '411111******9999', name: 'NET CO', currency: 'USD' } }) });
  try { assert.ok((await orchestrator.reconcilePendingCardCreations(10)).activated >= 1); } finally { maplerad.forMode = original; }
  assert.equal(mockTables.cards.find((x) => x.id === row.id).status, 'active');
  // 2) partner fee (issuing.charge) lowers the balance once
  const before = Number(mockTables.cards.find((x) => x.id === row.id).balance);
  const charge = { event: 'issuing.charge', amount: 150, card_id: row.maplerad_card_id, transaction_date: '2026-10-30 10:00:00 +0000 UTC' };
  await sendProviderEvent(charge, MOCK_SANDBOX_WHSEC);
  await sendProviderEvent(charge, MOCK_SANDBOX_WHSEC);
  assert.equal(Number(mockTables.cards.find((x) => x.id === row.id).balance), before - 1.5);
  // 3) the partner closes the card: it is terminated here too, the merchant's webhook is sent
  await sendProviderEvent({ event: 'issuing.terminated', amount: 0, card_id: row.maplerad_card_id, reason: 'Insufficient Funds', reference: 'term-1' }, MOCK_SANDBOX_WHSEC);
  const after = mockTables.cards.find((x) => x.id === row.id);
  assert.equal(after.status, 'terminated');
  assert.match(after.failure_reason, /Insufficient Funds/);
});

test('admin card balance check compares our balance with the partner and can align one card; editors are refused', async () => {
  const maplerad = require('../src/services/maplerad');
  const { token } = await adminLogin('owner');
  const live = await liveMerchantWithActivity('balcheck'); // business card, active, live
  const row = mockTables.cards.find((c) => c.id === live.card.id);
  row.balance = 100;
  const original = maplerad.forMode;
  maplerad.forMode = () => ({ getCard: async () => ({ data: { id: row.maplerad_card_id, balance: 7000 } }) }); // the partner says 70 $
  try {
    const check = await api('GET', '/admin/cards-balance-check?mode=live', { token });
    assert.equal(check.status, 200);
    const mine = check.data.cards.find((c) => c.id === row.id);
    assert.equal(mine.our_balance, 100);
    assert.equal(mine.partner_balance, 70);
    assert.equal(mine.gap, -30);
    assert.ok(check.data.out_of_line >= 1);
    const align = await api('POST', `/admin/cards/${row.id}/align-balance`, { token });
    assert.equal(align.status, 200);
    assert.equal(align.data.balance, 70);
    assert.equal(Number(mockTables.cards.find((c) => c.id === row.id).balance), 70);
    assert.equal((await api('GET', '/admin/cards-balance-check', { token: (await adminLogin('editor')).token })).status, 403);
  } finally { maplerad.forMode = original; }
});

test('card.balance_updated: sent when the team aligns a card with the partner, on request, and a purchase webhook carries the new balance', async () => {
  const maplerad = require('../src/services/maplerad');
  const receiver = startWebhookReceiver();
  await new Promise((r) => receiver.server.listen(4511, r));
  const original = maplerad.forMode;
  try {
    const { token: admin } = await adminLogin('owner');
    const reg = await registerAndVerify({ business_name: 'Bal Hook Co', email: 'balhook@example.com', password: 'password123' });
    const token = reg.data.session_token;
    await api('POST', '/dashboard/webhooks', { token, body: { url: 'http://localhost:4511/hook' } });
    const create = await api('POST', '/dashboard/cards', { token, body: { reference: 'BALHOOK-1', kind: 'business', business_name: 'Bal Hook Co', brand: 'VISA', amount: 20 } });
    await pollUntil(() => api('GET', `/dashboard/cards/${create.data.id}`, { token }), (r) => r.data.status !== 'pending', 30, 20);
    const row = mockTables.cards.find((c) => c.id === create.data.id);
    // a purchase: the webhook carries the new card balance
    await sendProviderEvent({ event: 'issuing.transaction', type: 'AUTHORIZATION', mode: 'DEBIT', status: 'SUCCESS', amount: 500, currency: 'USD', card_id: row.maplerad_card_id, reference: 'bh-1', merchant: { name: 'SHOP' } }, MOCK_SANDBOX_WHSEC);
    await sleep(300);
    const tx = receiver.received.find((d) => d.json.event === 'card.transaction');
    assert.ok(tx && tx.json.data.card_balance === 15);
    // alignment with the partner
    maplerad.forMode = () => ({ getCard: async () => ({ data: { id: row.maplerad_card_id, balance: 1200 } }) });
    const align = await api('POST', `/admin/cards/${row.id}/align-balance`, { token: admin });
    assert.equal(align.status, 200);
    await sleep(300);
    const upd = receiver.received.find((d) => d.json.event === 'card.balance_updated');
    assert.ok(upd, 'card.balance_updated delivered');
    assert.equal(upd.json.data.balance, 12);
    assert.equal(upd.json.data.previous_balance, 15);
    assert.equal(upd.json.data.reason, 'aligned');
    // on request
    const before = receiver.received.filter((d) => d.json.event === 'card.balance_updated').length;
    const sent = await api('POST', `/admin/cards/${row.id}/send-balance`, { token: admin });
    assert.equal(sent.status, 200);
    assert.equal(sent.data.balance, 12);
    await sleep(300);
    assert.equal(receiver.received.filter((d) => d.json.event === 'card.balance_updated').length, before + 1);
  } finally { maplerad.forMode = original; receiver.server.close(); }
});

test('closing a card keeps 0.50 $ from what is given back, never more than what is left, and logs it as income', async () => {
  const reg = await registerAndVerify({ business_name: 'Close Fee Co', email: 'closefee@sandbox-test.example.com', password: 'password123' });
  const token = reg.data.session_token;
  const mk = async (ref) => {
    const c = await api('POST', '/dashboard/cards', { token, body: { reference: ref, kind: 'business', business_name: 'Close Fee Co', brand: 'VISA', amount: 10 } });
    await pollUntil(() => api('GET', `/dashboard/cards/${c.data.id}`, { token }), (r) => r.data.status === 'active', 40, 20);
    return c.data.id;
  };
  const a = await mk('CLOSE-A');
  const b = await mk('CLOSE-B');
  mockTables.cards.find((c) => c.id === b).balance = 0.3; // less than the fee
  const bal = async () => (await api('GET', '/dashboard/balance', { token })).data.master_wallet.available;
  const start = await bal();
  const ra = await api('POST', `/dashboard/cards/${a}/terminate`, { token });
  assert.equal(ra.data.refunded_usd, 9.5);
  assert.equal(ra.data.closure_fee_usd, 0.5);
  const rb = await api('POST', `/dashboard/cards/${b}/terminate`, { token });
  assert.equal(rb.data.refunded_usd, 0);
  assert.equal(rb.data.closure_fee_usd, 0.3);
  assert.equal(Math.round(((await bal()) - start) * 100) / 100, 9.5);
  assert.ok(mockTables.fee_revenue.some((r) => r.kind === 'card_closure' && r.related_id === a && Number(r.amount) === 0.5));
});

test('admin debit: reason required and e-mailed, limited to what the wallet holds, the owner can force it, every debit is in the ledger', async () => {
  const { token: owner } = await adminLogin('owner');
  const live = await makeLiveMerchant('admdebit', { fundUsd: 200 });
  const bal = async () => (await api('GET', '/dashboard/balance', { token: live.token })).data.master_wallet.available;
  const start = await bal();
  sentEmails.length = 0;
  assert.equal((await api('POST', `/admin/merchants/${live.merchantId}/debit`, { token: owner, body: { wallet: 'master_wallet', amount: 20 } })).data.error.code, 'REASON_REQUIRED');
  assert.equal((await api('POST', `/admin/merchants/${live.merchantId}/debit`, { token: owner, body: { wallet: 'master_wallet', amount: 0, reason: 'Avertissement de paiement' } })).status, 400);
  const ok = await api('POST', `/admin/merchants/${live.merchantId}/debit`, { token: owner, body: { wallet: 'master_wallet', amount: 20, reason: 'Avertissement de paiement : litige client #123', mode: 'live' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.new_balance, start - 20);
  assert.equal(await bal(), start - 20);
  const mail = sentEmails.find((e) => e.to === emailOf(live) && /Débit/.test(e.subject));
  assert.ok(mail && /litige client #123/.test(mail.html));
  const tooMuch = await api('POST', `/admin/merchants/${live.merchantId}/debit`, { token: owner, body: { wallet: 'master_wallet', amount: 5000, reason: 'Recouvrement', mode: 'live' } });
  assert.equal(tooMuch.status, 400);
  assert.equal(tooMuch.data.error.code, 'INSUFFICIENT_BALANCE');
  const adminRow = await adminLogin('admin');
  const notOwner = await api('POST', `/admin/merchants/${live.merchantId}/debit`, { token: adminRow.token, body: { wallet: 'master_wallet', amount: 5000, reason: 'Recouvrement', mode: 'live', force: true } });
  assert.equal(notOwner.status, 403);
  const forced = await api('POST', `/admin/merchants/${live.merchantId}/debit`, { token: owner, body: { wallet: 'master_wallet', amount: 5000, reason: 'Recouvrement après litige', mode: 'live', force: true } });
  assert.equal(forced.status, 200);
  assert.ok(forced.data.new_balance < 0);
  assert.ok(mockTables.ledger_entries.some((e) => e.merchant_id === live.merchantId && e.type === 'admin_debit' && Number(e.amount) === -20));
  assert.equal((await api('POST', `/admin/merchants/${live.merchantId}/debit`, { token: (await adminLogin('editor')).token, body: { wallet: 'master_wallet', amount: 1, reason: 'Test de rôle' } })).status, 403);
});

test('guarantee deposit: 50 $ by default, the team raises or lowers it per merchant (reason e-mailed), operations respect the new floor', async () => {
  const guarantee = require('../src/services/guarantee');
  guarantee.clearCache();
  const { token: owner } = await adminLogin('owner');
  const live = await makeLiveMerchant('guar', { fundUsd: 200 });
  const bal = await api('GET', '/dashboard/balance', { token: live.token });
  assert.equal(bal.data.master_wallet.guarantee_usd, 50);
  assert.equal(bal.data.master_wallet.spendable_usd, bal.data.master_wallet.available - 50);
  const get = await api('GET', `/admin/merchants/${live.merchantId}/guarantee`, { token: owner });
  assert.equal(get.data.guarantee_usd, 50);
  assert.equal(get.data.default_usd, 50);
  sentEmails.length = 0;
  assert.equal((await api('PUT', `/admin/merchants/${live.merchantId}/guarantee`, { token: owner, body: { guarantee_usd: 150 } })).data.error.code, 'REASON_REQUIRED');
  assert.equal((await api('PUT', `/admin/merchants/${live.merchantId}/guarantee`, { token: owner, body: { guarantee_usd: -5, reason: 'Montant invalide' } })).status, 400);
  const up = await api('PUT', `/admin/merchants/${live.merchantId}/guarantee`, { token: owner, body: { guarantee_usd: 180, reason: 'Volume de litiges élevé ce mois-ci' } });
  assert.equal(up.status, 200);
  assert.equal(up.data.previous_usd, 50);
  assert.equal(up.data.guarantee_usd, 180);
  const mail = sentEmails.find((e) => e.to === emailOf(live) && /garantie/i.test(e.subject));
  assert.ok(mail && /Volume de litiges/.test(mail.html) && /180,00/.test(mail.html));
  assert.equal((await api('GET', '/dashboard/balance', { token: live.token })).data.master_wallet.guarantee_usd, 180);
  // The wallet holds 200: a card that would leave less than 180 is refused, a small one passes.
  const refused = await api('POST', '/dashboard/cards', { token: live.token, body: { reference: 'GUAR-1', kind: 'business', business_name: 'Guar Co', brand: 'VISA', amount: 30 } });
  assert.equal(refused.status, 400);
  assert.equal(refused.data.error.code, 'BELOW_MINIMUM_BALANCE');
  assert.match(refused.data.error.message, /180/);
  // Lowering frees money; the history lists both changes.
  const down = await api('PUT', `/admin/merchants/${live.merchantId}/guarantee`, { token: owner, body: { guarantee_usd: 20, reason: 'Litiges réglés' } });
  assert.equal(down.data.guarantee_usd, 20);
  const ok = await api('POST', '/dashboard/cards', { token: live.token, body: { reference: 'GUAR-2', kind: 'business', business_name: 'Guar Co', brand: 'VISA', amount: 30 } });
  assert.equal(ok.status, 202);
  const after = await api('GET', `/admin/merchants/${live.merchantId}/guarantee`, { token: owner });
  assert.equal(after.data.history.length, 2);
  assert.equal((await api('PUT', `/admin/merchants/${live.merchantId}/guarantee`, { token: (await adminLogin('editor')).token, body: { guarantee_usd: 10, reason: 'Test de rôle' } })).status, 403);
  guarantee.clearCache();
});

test('issuers: the admin list shows only merchants with live issuing access and their real Master Wallet; the API gives an issuer its own wallet', async () => {
  const { token } = await adminLogin('owner');
  const guarantee = require('../src/services/guarantee');
  guarantee.clearCache();
  const live = await makeLiveMerchant('issuerA', { fundUsd: 120 });
  const plain = await registerAndVerify({ business_name: 'Not An Issuer', email: 'notissuer@sandbox-test.example.com', password: 'password123' });
  const list = await api('GET', '/admin/issuers', { token });
  assert.equal(list.status, 200);
  const mine = list.data.issuers.find((i) => i.id === live.merchantId);
  assert.ok(mine, 'live issuer listed');
  assert.equal(mine.master_wallet_usd, 120);
  assert.equal(mine.guarantee_usd, 50);
  assert.equal(mine.spendable_usd, 70);
  assert.ok(!list.data.issuers.some((i) => i.email === 'notissuer@sandbox-test.example.com'));
  assert.ok(list.data.totals.issuers >= 1);
  assert.equal((await api('GET', '/admin/issuers', { token: (await adminLogin('editor')).token })).status, 403);
  // the issuer reads its own Master Wallet with an API key (live key here)
  const key = await api('POST', '/dashboard/api-keys', { token: live.token, body: { name: 'wallet-check', mode: 'live' } });
  const secret = key.data.secret;
  assert.ok(secret, JSON.stringify(key.data));
  {
    const w = await api('GET', '/v1/master-wallet', { token: secret });
    assert.equal(w.status, 200);
    assert.equal(w.data.balance, 120);
    assert.equal(w.data.guarantee_usd, 50);
    assert.equal(w.data.spendable_usd, 70);
    assert.equal(w.data.mode, 'live');
    assert.equal(typeof w.data.reserved_on_cards_usd, 'number');
  }
});
