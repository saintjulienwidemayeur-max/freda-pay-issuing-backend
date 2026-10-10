'use strict';
const supabase = require('../lib/supabase');
const cardOrchestrator = require('../services/cardOrchestrator');
const webhookDispatcher = require('../services/webhookDispatcher');
const notify = require('../services/notify');
const { randomHex } = require('../utils/ids');

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

/** The admin team never sees a full card number or CVV: at most the last 4 digits. */
function last4Only(maskedPan) {
  if (!maskedPan) return null;
  const digits = String(maskedPan).replace(/\D/g, '');
  return digits.length >= 4 ? `•••• •••• •••• ${digits.slice(-4)}` : '••••';
}

function publicCard(c, holder) {
  return {
    id: c.id,
    reference: c.own_reference,
    kind: c.kind,
    mode: c.mode || 'sandbox',
    brand: c.brand,
    currency: c.currency,
    status: c.status,
    masked_pan: last4Only(c.masked_pan),
    name_on_card: c.holder_name || null,
    holder: holder ? { first_name: holder.first_name, last_name: holder.last_name, email: holder.email, country: holder.country, status: holder.status } : null,
    balance: Number(c.balance || 0),
    creation_fee: Number(c.creation_fee || 0),
    failure_reason: c.failure_reason || null,
    created_at: c.created_at,
    updated_at: c.updated_at,
    deleted_at: c.deleted_at || null,
  };
}

async function audit(ctx, action, card, details) {
  try {
    await supabase.insert('admin_audit_log', {
      id: 'aud_' + randomHex(8),
      admin_id: ctx.adminId,
      admin_email: (ctx.admin && ctx.admin.email) || null,
      action,
      target_type: 'card',
      target_id: card.id,
      merchant_id: card.merchant_id,
      details: details || null,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Admin audit log failed:', err.message);
  }
}

async function listForMerchant(ctx) {
  const merchant = await supabase.selectOne('merchants', { id: ctx.params.id });
  if (!merchant) throw httpError(404, 'NOT_FOUND', 'Marchand introuvable.');
  const filters = { merchant_id: merchant.id };
  if (ctx.query && (ctx.query.mode === 'live' || ctx.query.mode === 'sandbox')) filters.mode = ctx.query.mode;
  if (!(ctx.query && ctx.query.include_deleted === '1')) filters.deleted_at = 'is.null';
  const rows = await supabase.select('cards', filters, { order: 'created_at.desc', limit: 500 });

  const holders = {};
  for (const id of [...new Set(rows.map((c) => c.holder_id).filter(Boolean))]) {
    holders[id] = await supabase.selectOne('maplerad_customers', { id });
  }
  return { status: 200, body: { cards: rows.map((c) => publicCard(c, c.holder_id ? holders[c.holder_id] : null)) } };
}

async function loadCard(id) {
  const card = await supabase.selectOne('cards', { id });
  if (!card) throw httpError(404, 'NOT_FOUND', 'Carte introuvable.');
  return card;
}

function publicTransaction(t) {
  return {
    id: t.id, type: t.type, status: t.status, direction: t.direction,
    amount: t.amount_usd == null ? null : Number(t.amount_usd), currency: t.currency || 'USD',
    description: t.description, merchant_name: t.merchant_name, occurred_at: t.occurred_at,
  };
}

async function transactions(ctx) {
  const card = await loadCard(ctx.params.id);
  const rows = await supabase.select('card_transactions', { card_id: card.id }, { order: 'occurred_at.desc', limit: 200 });
  return { status: 200, body: { card: publicCard(card, null), transactions: rows.map(publicTransaction) } };
}

async function terminate(ctx) {
  const card = await loadCard(ctx.params.id);
  if (card.deleted_at) throw httpError(409, 'ALREADY_DELETED', 'Cette carte est déjà supprimée.');
  const balanceBefore = Number(card.balance || 0);
  let removed;
  try {
    removed = await cardOrchestrator.terminateCard(card.merchant_id, card.id);
  } catch (err) {
    throw httpError(err.httpStatus || 502, err.code || 'CARD_SERVICE_ERROR', err.message);
  }
  await audit(ctx, 'card.terminate', card, { reference: card.own_reference, balance_refunded: balanceBefore });
  const merchant = await supabase.selectOne('merchants', { id: card.merchant_id });
  notify.cardRemovedByAdmin(merchant, { reference: card.own_reference, refunded: card.status === 'active' || card.status === 'disabled' ? balanceBefore : 0 });
  return { status: 200, body: { card: publicCard(removed || card, null), deleted: true } };
}

const STATUS_EVENT = { active: 'card.created', disabled: 'card.frozen', terminated: 'card.terminated', failed: 'card.failed' };

/**
 * Re-sends a webhook to the merchant's endpoint: either one card transaction (body.transaction_id) or the card's
 * current state event. Returns whether the merchant's server accepted it.
 */
async function resendWebhook(ctx) {
  const card = await loadCard(ctx.params.id);
  const txId = ctx.body && ctx.body.transaction_id;
  let event; let data;
  if (txId) {
    const t = await supabase.selectOne('card_transactions', { id: txId, card_id: card.id });
    if (!t) throw httpError(404, 'NOT_FOUND', 'Transaction introuvable.');
    event = 'card.transaction';
    data = cardOrchestrator.transactionWebhookData(card, t);
  } else {
    event = STATUS_EVENT[card.status];
    if (!event) throw httpError(409, 'NO_EVENT', "Cette carte est encore en cours de création : aucun événement à renvoyer.");
    data = { id: card.id, reference: card.own_reference, kind: card.kind, brand: card.brand, status: card.status, masked_pan: last4Only(card.masked_pan), balance: Number(card.balance || 0) };
  }
  const result = await webhookDispatcher.deliverNow(card.merchant_id, event, data);
  await audit(ctx, 'card.resend_webhook', card, { event, transaction_id: txId || null, sent: result.sent, reason: result.reason || null });
  if (result.reason === 'NO_ENDPOINT') throw httpError(409, 'NO_WEBHOOK_ENDPOINT', "Ce marchand n'a pas configuré d'endpoint webhook.");
  return { status: 200, body: { event, ...result } };
}

module.exports = { listForMerchant, transactions, terminate, resendWebhook };
