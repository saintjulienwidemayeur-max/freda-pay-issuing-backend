'use strict';
const supabase = require('../lib/supabase');
const ledger = require('../services/ledger');
const notify = require('../services/notify');
const revenue = require('../services/revenue');
const config = require('../config');

const MANUAL = ['zelle', 'bank_transfer'];

function toPublic(t, merchant) {
  return {
    id: t.id,
    method: t.method,
    status: t.status,
    mode: t.mode || 'sandbox',
    amount_usd: t.amount_usd != null ? Number(t.amount_usd) : null,
    credited_usd: t.credited_usd != null ? Number(t.credited_usd) : null,
    reference: t.own_reference,
    receipt_filename: t.receipt_filename || null,
    has_receipt: !!t.receipt_path,
    admin_note: t.admin_note || t.failure_reason || null,
    created_at: t.created_at,
    reviewed_at: t.reviewed_at || null,
    merchant: merchant ? { id: merchant.id, business_name: merchant.business_name, email: merchant.email } : null,
  };
}

/** Manual deposits (Zelle / bank transfer). Default view: the ones waiting for a decision. */
async function list(ctx) {
  const status = (ctx.query && ctx.query.status) || 'awaiting_review';
  const filters = status === 'all' ? {} : { status };
  const rows = (await supabase.select('wallet_topups', filters, { order: 'created_at.desc', limit: 200 })).filter((t) => MANUAL.includes(t.method));
  const ids = [...new Set(rows.map((t) => t.merchant_id))];
  const merchants = await Promise.all(ids.map((id) => supabase.selectOne('merchants', { id })));
  const byId = Object.fromEntries(merchants.filter(Boolean).map((m) => [m.id, m]));
  return { status: 200, body: { deposits: rows.map((t) => toPublic(t, byId[t.merchant_id])) } };
}

/** A short-lived link to the receipt image the merchant uploaded. The storage key never leaves the server. */
async function receipt(ctx) {
  const t = await supabase.selectOne('wallet_topups', { id: ctx.params.id });
  if (!t || !MANUAL.includes(t.method)) throw httpError(404, 'NOT_FOUND', 'Dépôt introuvable.');
  if (!t.receipt_path) throw httpError(404, 'NO_RECEIPT', 'Aucun justificatif joint à ce dépôt.');
  const url = await supabase.signedUrl('receipts', t.receipt_path, 300);
  return { status: 200, body: { url, filename: t.receipt_filename || null } };
}

async function approve(ctx) {
  const t = await supabase.selectOne('wallet_topups', { id: ctx.params.id });
  if (!t || !MANUAL.includes(t.method)) throw httpError(404, 'NOT_FOUND', 'Dépôt introuvable.');
  if (t.status !== 'awaiting_review') throw httpError(409, 'ALREADY_REVIEWED', 'Ce dépôt a déjà été traité.');

  // The admin confirms what actually arrived, which can differ from what the merchant typed.
  const requested = ctx.body && ctx.body.amount_usd != null ? Number(ctx.body.amount_usd) : Number(t.amount_usd);
  if (!(requested > 0) || requested > 1000000) throw httpError(400, 'INVALID_AMOUNT', 'amount_usd doit être un montant positif.');
  const amount = Math.round(requested * 100) / 100;
  const mode = t.mode === 'live' ? 'live' : 'sandbox';

  // Claim first, credit second: of two admins clicking at once only one gets the claim, so the wallet is credited exactly once.
  const claimed = await supabase.update('wallet_topups', { id: t.id, status: 'awaiting_review' }, {
    status: 'succeeded', credited_usd: amount, fee_htg: 0, reviewed_by: ctx.adminId, reviewed_at: new Date().toISOString(),
    admin_note: (ctx.body && ctx.body.note) || null, updated_at: new Date().toISOString(),
  });
  if (!claimed || !claimed.length) throw httpError(409, 'ALREADY_REVIEWED', 'Ce dépôt a déjà été traité.');

  try {
    await ledger.creditMasterWallet(t.merchant_id, amount, 'USD', `manual-topup:${t.id}`, t.id, mode);
  } catch (err) {
    await supabase.update('wallet_topups', { id: t.id }, { status: 'awaiting_review', credited_usd: null, reviewed_by: null, reviewed_at: null });
    throw err;
  }

  // The partner charges a funding fee on the money that backs the wallet: recorded as a cost (no income on a manual deposit).
  await revenue.log(t.merchant_id, 'wallet_deposit', 0, 'USD', t.id, mode, Math.round(config.issuingProviderCostsUSD.walletFundingPct * amount * 100) / 100);
  const merchant = await supabase.selectOne('merchants', { id: t.merchant_id });
  const newBalance = await ledger.getBalance(t.merchant_id, 'master_wallet', 'USD', mode);
  await notify.walletCredited(merchant, {
    amount, currency: 'USD', walletLabel: 'Master Wallet', newBalance, mode,
    note: `dépôt par ${t.method === 'zelle' ? 'Zelle' : 'virement bancaire'} confirmé`,
  });
  return { status: 200, body: { deposit: toPublic(claimed[0], merchant), new_balance: newBalance, mode } };
}

async function reject(ctx) {
  const t = await supabase.selectOne('wallet_topups', { id: ctx.params.id });
  if (!t || !MANUAL.includes(t.method)) throw httpError(404, 'NOT_FOUND', 'Dépôt introuvable.');
  if (t.status !== 'awaiting_review') throw httpError(409, 'ALREADY_REVIEWED', 'Ce dépôt a déjà été traité.');
  const reason = (ctx.body && ctx.body.reason) || 'Justificatif insuffisant ou illisible.';
  const claimed = await supabase.update('wallet_topups', { id: t.id, status: 'awaiting_review' }, {
    status: 'failed', failure_reason: reason, admin_note: reason, reviewed_by: ctx.adminId, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  if (!claimed || !claimed.length) throw httpError(409, 'ALREADY_REVIEWED', 'Ce dépôt a déjà été traité.');
  const merchant = await supabase.selectOne('merchants', { id: t.merchant_id });
  await notify.depositRejected(merchant, { amount: t.amount_usd, method: t.method, reason });
  return { status: 200, body: { deposit: toPublic(claimed[0], merchant) } };
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { list, receipt, approve, reject };
