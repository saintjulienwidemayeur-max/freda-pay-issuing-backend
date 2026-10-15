'use strict';
/**
 * Mock card-payment partner (Tranzak gateway API) - enough to test the backend end to end without network. NOT for production.
 * A tk_test_ key is the sandbox, a tk_live_ key is live (same URL, the key decides), like the real service.
 */
const http = require('http');
const crypto = require('crypto');

const PORT = parseInt(process.env.MOCK_TRANZAK_PORT || '4530', 10);
const TEST_KEY = process.env.MOCK_TRANZAK_TEST_KEY || 'tk_test_mock';
const LIVE_KEY = process.env.MOCK_TRANZAK_LIVE_KEY || 'tk_live_mock';

const payments = new Map(); // transaction_id -> payment
const calls = []; // every API call received: { method, path, key }
const behavior = { liveNotApproved: false, loseNextCreateResponse: false, failNextCreate: null };
let counter = 0;

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
function readJson(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (_) { resolve({}); } });
  });
}
function view(p) {
  return {
    transaction_id: p.transaction_id, amount: p.amount, currency: p.currency, status: p.status, payment_method: p.payment_method,
    reference: p.reference, description: p.description || null, customer: p.customer, created_at: p.created_at,
    completed_at: p.completed_at || null, failed_at: p.failed_at || null, failure_reason: p.failure_reason || null, metadata: p.metadata || null,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://internal');
  const body = req.method === 'POST' ? await readJson(req) : {};

  if (url.pathname === '/__control/reset') {
    payments.clear(); calls.length = 0; counter = 0;
    behavior.liveNotApproved = false; behavior.loseNextCreateResponse = false; behavior.failNextCreate = null;
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/__control/set') { Object.assign(behavior, body); return send(res, 200, { ok: true }); }
  if (url.pathname === '/__control/complete' || url.pathname === '/__control/fail') {
    const p = payments.get(body.transaction_id);
    if (!p) return send(res, 404, { ok: false });
    if (url.pathname === '/__control/complete') { p.status = 'completed'; p.completed_at = new Date().toISOString(); }
    else { p.status = 'failed'; p.failed_at = new Date().toISOString(); p.failure_reason = 'card_declined'; }
    return send(res, 200, { ok: true, payment: view(p) });
  }
  if (url.pathname === '/__control/payment') {
    const p = payments.get(url.searchParams.get('transaction_id'));
    return send(res, 200, p ? view(p) : null);
  }
  if (url.pathname === '/__control/all') return send(res, 200, [...payments.values()].map(view));
  if (url.pathname === '/__control/calls') return send(res, 200, calls);

  const key = req.headers['x-api-key'];
  calls.push({ method: req.method, path: url.pathname, key });
  if (key !== TEST_KEY && key !== LIVE_KEY) return send(res, 401, { success: false, error: { code: 'invalid_api_key' } });
  const live = key === LIVE_KEY;

  const base = '/payments';
  if (req.method === 'POST' && url.pathname === base) {
    if (live && behavior.liveNotApproved) return send(res, 403, { success: false, error: { code: 'payment_method_not_approved' } });
    if (behavior.failNextCreate) { const f = behavior.failNextCreate; behavior.failNextCreate = null; return send(res, f.status, f.body); }
    const { amount, currency, payment_method, customer_name, reference } = body;
    if (!amount || !currency || !payment_method || !customer_name) return send(res, 422, { success: false, error: { code: 'validation_error' } });
    if (payment_method !== 'card' || currency !== 'USD') return send(res, 422, { success: false, error: { code: 'validation_error' } });
    if (Number(amount) < 0.5) return send(res, 400, { success: false, error: { code: 'amount_too_low' } });
    counter += 1;
    const p = {
      transaction_id: `${live ? '2' : '1'}${String(counter).padStart(13, '0')}`,
      amount: Number(amount).toFixed(2), currency: 'USD', status: 'requires_payment_method', payment_method: 'card',
      reference: reference || null, description: body.description || null,
      customer: { name: customer_name, email: body.customer_email || null, phone: body.customer_phone || null },
      created_at: new Date().toISOString(), metadata: body.metadata || null, live,
    };
    payments.set(p.transaction_id, p);
    if (behavior.loseNextCreateResponse) { behavior.loseNextCreateResponse = false; return req.socket.destroy(); }
    return send(res, 201, {
      success: true, transaction_id: p.transaction_id, amount: p.amount, currency: 'USD', status: p.status, created_at: p.created_at,
      payment_intent_id: `pi_${crypto.randomBytes(6).toString('hex')}`, client_secret: `cs_${crypto.randomBytes(8).toString('hex')}`,
      publishable_key: live ? 'pk_live_mock' : 'pk_test_mock',
    });
  }
  let m = url.pathname.match(/^\/payments\/reference\/(.+)$/);
  if (req.method === 'GET' && m) {
    const ref = decodeURIComponent(m[1]);
    const p = [...payments.values()].reverse().find((x) => x.reference === ref && x.live === live);
    return p ? send(res, 200, { success: true, data: view(p) }) : send(res, 404, { success: false, error: { code: 'transaction_not_found' } });
  }
  m = url.pathname.match(/^\/payments\/([^/]+)$/);
  if (req.method === 'GET' && m) {
    const p = payments.get(m[1]);
    return p && p.live === live ? send(res, 200, { success: true, data: view(p) }) : send(res, 404, { success: false, error: { code: 'transaction_not_found' } });
  }
  send(res, 404, { success: false, error: { code: 'not_found' } });
});

if (require.main === module) server.listen(PORT, () => console.log(`Mock card partner on http://localhost:${PORT}`));

module.exports = { server, behavior, calls, TEST_KEY, LIVE_KEY, payments };
