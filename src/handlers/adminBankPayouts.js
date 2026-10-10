'use strict';
const supabase = require('../lib/supabase');
const payoutOrchestrator = require('../services/payoutOrchestrator');
const notify = require('../services/notify');

const num = (v) => (v == null ? null : Number(v));

function toAdmin(p, merchant) {
  return {
    id: p.id,
    reference: p.own_reference,
    status: p.status,                        // pending | success | failed
    mode: p.mode || 'sandbox',
    amount: num(p.amount),
    fee: num(p.fee),
    total_debited: Math.round((num(p.amount) + (num(p.fee) || 0)) * 100) / 100,
    bank_details: p.bank_details || null,    // the FULL details, as the merchant had them when requesting: the team needs them to send the transfer
    bank_reference: p.bank_reference || null,
    admin_note: p.admin_note || p.failure_reason || null,
    created_at: p.created_at,
    reviewed_at: p.reviewed_at || null,
    merchant: merchant ? { id: merchant.id, business_name: merchant.business_name, email: merchant.email } : null,
  };
}

/** Bank-transfer withdrawals. Default view: the real (Live) ones waiting for the team. */
async function list(ctx) {
  const status = (ctx.query && ctx.query.status) || 'pending';
  const mode = ctx.query && ctx.query.mode === 'sandbox' ? 'sandbox' : 'live';
  const filters = { method: 'bank', mode };
  if (status !== 'all') filters.status = status;
  const rows = await supabase.select('payouts', filters, { order: 'created_at.desc', limit: 200 });
  const ids = [...new Set(rows.map((p) => p.merchant_id))];
  const merchants = await Promise.all(ids.map((id) => supabase.selectOne('merchants', { id })));
  const byId = Object.fromEntries(merchants.filter(Boolean).map((m) => [m.id, m]));
  return { status: 200, body: { payouts: rows.map((p) => toAdmin(p, byId[p.merchant_id])) } };
}

/** The team sent the transfer: record its reference and tell the merchant. */
async function complete(ctx) {
  const current = await supabase.selectOne('payouts', { id: ctx.params.id, method: 'bank' });
  if (!current) throw httpError(404, 'NOT_FOUND', 'Retrait introuvable.');
  const reference = String((ctx.body && ctx.body.bank_reference) || '').trim().slice(0, 100);
  if (!reference) throw httpError(400, 'MISSING_FIELDS', 'Entrez la référence du virement envoyé.');
  const done = await payoutOrchestrator.completeBankPayout({ id: current.id, bankReference: reference, note: String((ctx.body && ctx.body.note) || '').slice(0, 300) || null, adminId: ctx.adminId });
  if (!done) throw httpError(409, 'ALREADY_PROCESSED', 'Ce retrait a déjà été traité.');
  const merchant = await supabase.selectOne('merchants', { id: done.merchant_id });
  await notify.bankPayoutSent(merchant, { amount: Number(done.amount), fee: Number(done.fee || 0), reference });
  return { status: 200, body: { payout: toAdmin(done, merchant) } };
}

/** Refused: the held money (amount + fee) goes back to the merchant's balance. */
async function reject(ctx) {
  const current = await supabase.selectOne('payouts', { id: ctx.params.id, method: 'bank' });
  if (!current) throw httpError(404, 'NOT_FOUND', 'Retrait introuvable.');
  const reason = String((ctx.body && ctx.body.reason) || '').trim().slice(0, 300);
  if (!reason) throw httpError(400, 'MISSING_FIELDS', 'Indiquez la raison du refus (elle sera envoyée au marchand).');
  const done = await payoutOrchestrator.rejectBankPayout({ id: current.id, reason, adminId: ctx.adminId });
  if (!done) throw httpError(409, 'ALREADY_PROCESSED', 'Ce retrait a déjà été traité.');
  const merchant = await supabase.selectOne('merchants', { id: done.merchant_id });
  await notify.bankPayoutRejected(merchant, { amount: Number(done.amount), reason });
  return { status: 200, body: { payout: toAdmin(done, merchant) } };
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { list, complete, reject };
