'use strict';
/**
 * Mock PlopPlop server - mimics the real https://plopplop.solutionip.app/ API
 * documented endpoints closely enough to test our backend end-to-end without
 * network access. NOT for production use.
 *
 * Configure via env when starting: MOCK_CLIENT_ID, MOCK_CLIENT_SECRET, MOCK_PORT.
 */
const http = require('http');
const crypto = require('crypto');

const CLIENT_ID = process.env.MOCK_CLIENT_ID || 'pp_mock_client_id';
const CLIENT_SECRET = process.env.MOCK_CLIENT_SECRET || 'mock_secret_64_chars_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PORT = parseInt(process.env.MOCK_PORT || '4500', 10);

// In-memory state
const payments = new Map(); // refference_id -> { montant, method, status, transaction_id }
const usedWithdrawalRefs = new Set();
const withdrawalTokens = new Map(); // token -> { amount, method, recipient, reference, expires }
const marchandTokens = new Map(); // token -> expires

// Control knobs the test suite can flip to simulate behaviors.
const behavior = {
  failNextWithdrawal: false,
  moncashFeePct: 0.025,
};

function readJson(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); }
    });
  });
}

function send(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(s);
}

function randomDigits(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
  return s;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://internal');
  const body = req.method === 'POST' ? await readJson(req) : {};

  // ---- Test control endpoints (not part of the real API) ----
  if (url.pathname === '/__control/reset') {
    payments.clear();
    usedWithdrawalRefs.clear();
    withdrawalTokens.clear();
    marchandTokens.clear();
    behavior.failNextWithdrawal = false;
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/__control/fail-next-withdrawal') {
    behavior.failNextWithdrawal = true;
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/__control/confirm-payment') {
    const p = payments.get(body.refference_id);
    if (p) p.status = 'ok';
    return send(res, 200, { ok: true });
  }

  // ---- api/paiement-marchand ----
  if (url.pathname === '/api/paiement-marchand' && req.method === 'POST') {
    const { client_id, refference_id, montant, payment_method, phone_number } = body;
    if (!client_id || !refference_id || montant == null || !payment_method) {
      return send(res, 400, { status: false, message: 'Paramètre manquant.' });
    }
    if (client_id !== CLIENT_ID) return send(res, 404, { status: false, message: 'Client introuvable.' });
    if (montant < 20) return send(res, 400, { status: false, message: 'Montant invalide.' });
    if (payments.has(refference_id)) return send(res, 404, { status: false, message: 'Référence déjà utilisée.' });
    if (payment_method === 'moncash_ussd' && !phone_number) {
      return send(res, 400, { status: false, message: 'phone_number requis pour moncash_ussd.' });
    }

    const transactionId = Date.now().toString() + randomDigits(3);
    payments.set(refference_id, { montant, method: payment_method, status: 'no', transaction_id: transactionId });

    const url_ = payment_method === 'moncash_ussd' ? null : `https://mock-redirect/${transactionId}`;
    return send(res, 200, { status: true, message: 'success', url: url_, transaction_id: transactionId });
  }

  // ---- api/paiement-verify ----
  if (url.pathname === '/api/paiement-verify' && req.method === 'POST') {
    const { client_id, refference_id } = body;
    if (client_id !== CLIENT_ID) return send(res, 404, { status: false, message: 'Client introuvable.' });
    const p = payments.get(refference_id);
    if (!p) return send(res, 404, { status: false, message: 'Transaction introuvable.' });
    return send(res, 200, {
      status: true,
      message: 'success',
      montant: p.montant,
      trans_status: p.status,
      id_transaction: p.transaction_id,
      date: '2026-01-01',
      heure: '12:00:00',
      method: p.method,
      id_client: null,
    });
  }

  // ---- api/auth/marchand ----
  if (url.pathname === '/api/auth/marchand' && req.method === 'POST') {
    const { client_id, client_secret } = body;
    if (!client_id || !client_secret) return send(res, 400, { success: false, message: 'Paramètres manquants.' });
    if (client_id !== CLIENT_ID || client_secret !== CLIENT_SECRET) {
      return send(res, 401, { success: false, message: 'Identifiants invalides.' });
    }
    const token = 'marchand_' + crypto.randomBytes(16).toString('hex');
    marchandTokens.set(token, Date.now() + 300 * 1000);
    return send(res, 200, {
      success: true,
      message: 'Authentification réussie',
      token,
      marchand: { id: 1, client_id: CLIENT_ID, pseudo: 'MockMerchant' },
      expires_in: 300,
    });
  }

  // ---- api/auth/marchand/withdrawal-token ----
  if (url.pathname === '/api/auth/marchand/withdrawal-token' && req.method === 'POST') {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const exp = marchandTokens.get(token);
    if (!exp || Date.now() > exp) return send(res, 401, { success: false, message: 'Jeton invalide ou expiré.' });

    const { amount, method, recipient, reference, timestamp, withdrawal_signature } = body;
    if (!amount || !method || !recipient || !reference || !timestamp || !withdrawal_signature) {
      return send(res, 400, { success: false, message: 'Champ manquant.' });
    }
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > 300) {
      return send(res, 400, { success: false, message: 'Timestamp expiré.', error_code: 'TIMESTAMP_EXPIRED' });
    }
    const expected = crypto
      .createHmac('sha256', CLIENT_SECRET)
      .update([amount, method, recipient, reference, timestamp].join('|'))
      .digest('hex');
    if (expected !== withdrawal_signature) {
      return send(res, 403, { success: false, message: 'Signature invalide.', error_code: 'INVALID_SIGNATURE' });
    }

    const wToken = 'wd_' + crypto.randomBytes(16).toString('hex');
    withdrawalTokens.set(wToken, { amount, method, recipient, reference, used: false, expires: Date.now() + 120000 });
    return send(res, 200, {
      success: true,
      message: 'Jeton de retrait généré avec succès.',
      withdrawal_token: wToken,
      authorized_for: { amount, method, recipient, reference },
      expires_in: 120,
    });
  }

  // ---- api/withdraw/marchand ----
  if (url.pathname === '/api/withdraw/marchand' && req.method === 'POST') {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const grant = withdrawalTokens.get(token);
    if (!grant) return send(res, 401, { success: false, message: 'Jeton invalide ou expiré.' });
    if (grant.used) return send(res, 403, { success: false, message: 'Jeton déjà utilisé.', error_code: 'TOKEN_ALREADY_USED' });
    if (Date.now() > grant.expires) return send(res, 401, { success: false, message: 'Jeton expiré.' });

    const { amount, method, recipient, reference } = body;
    if (amount !== grant.amount || method !== grant.method || recipient !== grant.recipient || reference !== grant.reference) {
      return send(res, 403, { success: false, message: 'Paramètres incohérents.', error_code: 'PARAMETER_MISMATCH' });
    }
    if (usedWithdrawalRefs.has(reference)) {
      return send(res, 409, { success: false, message: `La référence '${reference}' a déjà été utilisée.`, error_code: 'DUPLICATE_REFERENCE' });
    }

    grant.used = true;
    usedWithdrawalRefs.add(reference);

    if (behavior.failNextWithdrawal) {
      behavior.failNextWithdrawal = false;
      const txId = `API_WD_MOCK_${Date.now()}_fail`;
      return send(res, 400, {
        success: false,
        message: `Échec du retrait ${method} : Numéro invalide (simulation)`,
        data: { transaction_id: txId, status: 'failed' },
        error_code: 'API_TRANSFER_FAILED',
      });
    }

    const fee = Math.round(amount * behavior.moncashFeePct * 100) / 100;
    const total = Math.round((amount + fee) * 100) / 100;
    const txId = `API_WD_MOCK_${Date.now()}`;
    return send(res, 200, {
      success: true,
      message: `Retrait ${method} effectué avec succès.`,
      data: {
        transaction_id: txId,
        api_reference: randomDigits(10),
        amount,
        fee,
        total,
        recipient,
        reference,
        balance_before: 100000,
        balance_after: 100000 - total,
        status: 'success',
      },
    });
  }

  // ---- api/withdraw/marchand/verify ----
  if (url.pathname === '/api/withdraw/marchand/verify' && req.method === 'POST') {
    return send(res, 200, {
      success: true,
      message: 'Statut du retrait récupéré avec succès.',
      data: { reference: body.reference, status: 'success' },
    });
  }

  send(res, 404, { status: false, message: 'Not found (mock)' });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Mock PlopPlop server on http://localhost:${PORT}`));
}

module.exports = { server, CLIENT_ID, CLIENT_SECRET, behavior };
