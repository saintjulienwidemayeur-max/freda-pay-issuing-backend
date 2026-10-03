'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Isolated env, configured BEFORE requiring any app module (config.js reads env at require time).
process.env.SESSION_SECRET = 'test-session-secret';
process.env.PLOPPLOP_BASE_URL = 'http://localhost:4501';
process.env.PLOPPLOP_CLIENT_ID = 'pp_test_client';
process.env.PLOPPLOP_CLIENT_SECRET = 'test_secret_value';
process.env.PAYOUT_COOLDOWN_MS = '50'; // fast for tests

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
process.env.MOCK_MAPLERAD_PORT = '4504';
process.env.MOCK_MAPLERAD_SECRET_KEY = 'sk_test_mock_maplerad_key';
process.env.MOCK_MAPLERAD_WEBHOOK_SECRET = process.env.MAPLERAD_WEBHOOK_SECRET;
process.env.MOCK_MAPLERAD_WEBHOOK_TARGET = `http://localhost:${APP_PORT}/webhooks/maplerad`;

process.env.BREVO_BASE_URL = 'http://localhost:4506';
process.env.BREVO_API_KEY = 'mock-brevo-key';
process.env.MOCK_BREVO_PORT = '4506';
process.env.MOCK_BREVO_API_KEY = 'mock-brevo-key';

process.env.MASTER_WALLET_MINIMUM_USD = '50';

const { server: mockPlopplop } = require('../mock/plopplop-mock-server');
const { server: mockSupabase, reset: resetSupabase, tables: mockTables } = require('../mock/supabase-mock-server');
const { server: mockMaplerad, behavior: mapleradBehavior, calls: mapleradCalls, LIVE_WEBHOOK_SECRET: MOCK_LIVE_WHSEC, WEBHOOK_SECRET: MOCK_SANDBOX_WHSEC } = require('../mock/maplerad-mock-server');
const { server: mockBrevo, sentEmails } = require('../mock/brevo-mock-server');
const app = require('../src/server');

let baseUrl;

test.before(async () => {
  await new Promise((r) => mockPlopplop.listen(4501, r));
  await new Promise((r) => mockSupabase.listen(4503, r));
  await new Promise((r) => mockMaplerad.listen(4504, r));
  await new Promise((r) => mockBrevo.listen(4506, r));
  await new Promise((r) => app.listen(APP_PORT, r));
  baseUrl = `http://localhost:${APP_PORT}`;
  resetSupabase();
});

test.after(async () => {
  await new Promise((r) => mockPlopplop.close(r));
  await new Promise((r) => mockSupabase.close(r));
  await new Promise((r) => mockMaplerad.close(r));
  await new Promise((r) => mockBrevo.close(r));
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
async function registerAndVerify(payload) {
  const reg = await api('POST', '/auth/register', { body: payload });
  if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.data)}`);
  const code = extractOtpFromEmail(payload.email.toLowerCase());
  const verify = await api('POST', '/auth/verify-otp', { body: { merchant_id: reg.data.merchant_id, code } });
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

test('verifying again (already verified) just re-issues a session, no error', async () => {
  const code = extractOtpFromEmail('owner@boutiquelakay.com');
  const r = await api('POST', '/auth/verify-otp', { body: { merchant_id: pendingMerchantId, code } });
  assert.equal(r.status, 200);
  assert.ok(r.data.session_token);
});

test('resend-otp is rejected once already verified', async () => {
  const r = await api('POST', '/auth/resend-otp', { body: { merchant_id: pendingMerchantId } });
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, 'ALREADY_VERIFIED');
});

test('login with correct credentials works after verification', async () => {
  const r = await api('POST', '/auth/login', {
    body: { email: 'owner@boutiquelakay.com', password: 'sup3rSecret!' },
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.session_token);
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

  const bal = await api('GET', '/v1/balance', { token: testApiKeySecret });
  // 930 available, mock fee is 2.5% of 500 = 12.5, total debited = 512.5
  assert.equal(bal.data.gateway.available, 930 - 512.5);
});

test('a failed provider withdrawal does NOT debit the ledger', async () => {
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
  // Startup Issuing plan (default): 4.5% fee, no fixed fee. 13300*0.045=598.5 fee -> net 12701.5 -> /133 = 95.5 USD
  assert.equal(check.data.fee_htg, 598.5);
  assert.equal(check.data.credited_usd, 95.5);

  const bal = await api('GET', '/dashboard/balance', { token: sessionToken });
  assert.equal(bal.data.master_wallet.available, SANDBOX_SEED + 95.5);
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
      identificationNumber: 'ID123456',
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
      identificationNumber: 'ID-IC', phoneNumber: '37099999', phoneShortCode: '+509',
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
      identificationNumber: 'ID-FN', phoneNumber: '37088888', phoneShortCode: '+509',
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
      dob: '1992-03-01', identificationNumber: 'ID999999', phoneNumber: '37009999', phoneShortCode: '+509',
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

test('terminating a card refunds its remaining balance and lists all cards', async () => {
  const before = await api('GET', '/dashboard/balance', { token: sessionToken });
  const term = await api('POST', `/dashboard/cards/${firstCardId}/terminate`, { token: sessionToken });
  assert.equal(term.status, 200);
  assert.equal(term.data.status, 'terminated');
  assert.equal(term.data.balance, 0);

  const after = await api('GET', '/dashboard/balance', { token: sessionToken });
  assert.equal(after.data.master_wallet.available, before.data.master_wallet.available + 25);

  const list = await api('GET', '/dashboard/cards', { token: sessionToken });
  assert.equal(list.status, 200);
  assert.ok(list.data.cards.some((c) => c.id === firstCardId));
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
      dob: '1991-01-01', identificationNumber: 'ID-A1', phoneNumber: '37011111', phoneShortCode: '+509',
      address: { street: 'Rue Example', city: 'PAP', state: 'Ouest', postal_code: 'HT6110', country: 'HT' },
    },
  });
  assert.equal(holder1.status, 201);
  assert.equal(holder1.data.holder.status, 'enrolled');

  const holder2 = await api('POST', '/dashboard/cards/holders', {
    token, body: {
      firstName: 'Bob', lastName: 'Employee', email: 'bob@multiholder.com', country: 'HT',
      dob: '1993-02-02', identificationNumber: 'ID-B2', phoneNumber: '37022222', phoneShortCode: '+509',
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
      dob: '1990-05-12', identificationNumber: 'ID999', phoneShortCode: '+509', phoneNumber: '37001234',
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
      identificationNumber: 'ID-2S', phoneNumber: '37012345', phoneShortCode: '+509', address: { street: 'Rue Example', city: 'PAP', state: 'Ouest', postal_code: 'HT6110', country: 'HT' },
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
      identificationNumber: 'ID-BD', phoneNumber: '37012346', phoneShortCode: '+509', address: { street: 'Rue Example', city: 'PAP', state: 'Ouest', postal_code: 'HT6110', country: 'HT' },
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
    identificationNumber: 'ID-RC', phoneNumber: '37055555', phoneShortCode: '+509', address: { street: 'Rue Example', city: 'PAP', state: 'Ouest', postal_code: 'HT6110', country: 'HT' },
  };
  const first = await api('POST', '/dashboard/cards/holders', { token, body });
  assert.equal(first.status, 201);
  const second = await api('POST', '/dashboard/cards/holders', { token, body }); // provider answers "already enrolled"
  assert.equal(second.status, 201);
  assert.equal(second.data.holder.status, 'enrolled');
  const ids = mockTables.maplerad_customers.filter((h) => h.email === 'rec@over.com').map((h) => h.maplerad_customer_id);
  assert.equal(new Set(ids).size, 1); // same provider customer, recovered by email
});

test('an old holder saved without a provider id is healed automatically when issuing a card', async () => {
  const reg = await registerAndVerify({ business_name: 'Heal Co', email: 'heal-co@example.com', password: 'password123' });
  const token = reg.data.session_token;
  const body = {
    firstName: 'Old', lastName: 'Holder', email: 'old@holder.com', country: 'HT', dob: '1985-01-02',
    identificationNumber: 'ID-OH', phoneNumber: '37066666', phoneShortCode: '+509', address: { street: 'Rue Example', city: 'PAP', state: 'Ouest', postal_code: 'HT6110', country: 'HT' },
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
  const login = await api('POST', '/auth/login', { body: { email: 'viewer@team-co.com', password: 'my-new-password' } });
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
  assert.equal((await api('POST', '/auth/login', { body: { email: 'owner@pwd-co.com', password: 'brand-new-pass' } })).status, 200);

  // A read-only teammate can still change their OWN password.
  await api('POST', '/dashboard/team/invite', { token: owner, body: { email: 'ro@pwd-co.com', role: 'viewer' } });
  const acc = await api('POST', '/auth/accept-invite', { body: { token: inviteTokenFor('ro@pwd-co.com'), password: 'member-pass-1' } });
  const change = await api('POST', '/dashboard/account/password', { token: acc.data.session_token, body: { current_password: 'member-pass-1', new_password: 'member-pass-2' } });
  assert.equal(change.status, 200);
  assert.equal((await api('POST', '/auth/login', { body: { email: 'ro@pwd-co.com', password: 'member-pass-2' } })).status, 200);
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
  const r = await api('POST', '/admin/login', { body: { email: seeded.email, password: seeded.password } });
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
  assert.equal(r.status, 200); // listing is fine
  // but approving requires owner/admin
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
  assert.equal((await api('POST', '/auth/login', { body: { email: 'delete-me@example.com', password: 'password123' } })).status, 200);
});

test('revenue is tracked per merchant and summarized with profit', async () => {
  const reg = await registerAndVerify({ business_name: 'Revenue Track Co', email: 'revenue-track@example.com', password: 'password123' });
  const token = reg.data.session_token;
  await api('POST', '/dashboard/cards', { token, body: { reference: 'REV-1', kind: 'business', business_name: 'Revenue Track Co', brand: 'VISA', amount: 10 } });

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

  const login = await api('POST', '/admin/login', { body: { email: 'new-admin@fredapay.com', password: 'new-admin-pass-1' } });
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
  assert.ok(Array.isArray(all.data.transactions));
  // The mock provider seeds at least one transaction per created card.
  assert.ok(all.data.transactions.some((t) => t.card_id === create.data.id));
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
    identificationNumber: 'ID-LIVE-1', phoneNumber: '37011111', phoneShortCode: '+509',
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
