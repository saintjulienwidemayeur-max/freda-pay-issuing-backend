'use strict';
const supabase = require('../lib/supabase');
const walletAudit = require('../services/walletAudit');

/** GET /admin/merchants/:id/ledger?mode&wallet&currency&limit&offset : why a balance is what it is. */
async function merchantLedger(ctx) {
  const m = await supabase.selectOne('merchants', { id: ctx.params.id });
  if (!m) { const e = new Error('Marchand introuvable.'); e.httpStatus = 404; e.code = 'NOT_FOUND'; throw e; }
  const q = ctx.query || {};
  const limit = Math.min(500, Math.max(1, parseInt(q.limit, 10) || 100));
  const offset = Math.max(0, parseInt(q.offset, 10) || 0);
  const data = await walletAudit.ledgerFor(m.id, { wallet: q.wallet, mode: q.mode === 'sandbox' ? 'sandbox' : 'live', currency: q.currency, limit, offset });
  return { status: 200, body: { merchant: { id: m.id, business_name: m.business_name, email: m.email }, ...data } };
}

/** GET /admin/master-wallet/anomalies?mode : credits with no real source, across every merchant. */
async function anomalies(ctx) {
  return { status: 200, body: await walletAudit.masterWalletAnomalies(ctx.query && ctx.query.mode === 'sandbox' ? 'sandbox' : 'live') };
}

/** GET /admin/master-wallet/below-floor?mode : who is under the guarantee deposit, and what took them there. */
async function belowFloor(ctx) {
  return { status: 200, body: await walletAudit.belowFloor(ctx.query && ctx.query.mode === 'sandbox' ? 'sandbox' : 'live') };
}

module.exports = { merchantLedger, anomalies, belowFloor };
