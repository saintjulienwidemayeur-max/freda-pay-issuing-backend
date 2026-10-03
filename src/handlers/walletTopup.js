'use strict';
const orchestrator = require('../services/walletTopupOrchestrator');
const { generatePaymentId, namespaceReference } = require('../utils/ids');
const { resolveMode } = require('../utils/mode');

const ALL_METHODS = [...orchestrator.AUTO_METHODS, ...orchestrator.MANUAL_METHODS];

async function create(ctx) {
  const { method, reference } = ctx.body || {};
  if (!method || !reference) {
    throw httpError(400, 'MISSING_FIELDS', 'method et reference sont requis.');
  }
  if (!ALL_METHODS.includes(method)) {
    throw httpError(400, 'INVALID_METHOD', `method doit être l'un de : ${ALL_METHODS.join(', ')}.`);
  }

  const existing = await orchestrator.getByOwnReference(ctx.merchantId, reference);
  if (existing) {
    return { status: 200, body: toPublic(existing) }; // idempotent replay
  }

  const id = generatePaymentId();

  const mode = await resolveMode(ctx);
  try {
    if (orchestrator.AUTO_METHODS.includes(method)) {
      const { amount_htg } = ctx.body;
      if (typeof amount_htg !== 'number' || amount_htg <= 0) {
        throw httpError(400, 'INVALID_AMOUNT', 'amount_htg doit être un nombre positif.');
      }
      const plopplopReference = namespaceReference(ctx.merchantId, reference);
      const topup = await orchestrator.createAutoTopup({
        merchantId: ctx.merchantId,
        id,
        ownReference: reference,
        plopplopReference,
        method,
        amountHtg: amount_htg,
        mode,
      });
      return { status: 201, body: toPublic(topup) };
    }

    // Manual path: Zelle / bank_transfer.
    const { amount_usd, receipt_filename, receipt_base64, receipt_content_type } = ctx.body;
    if (typeof amount_usd !== 'number' || amount_usd <= 0) {
      throw httpError(400, 'INVALID_AMOUNT', 'amount_usd doit être un nombre positif.');
    }
    let receiptBuffer = null;
    if (receipt_base64) {
      if (receipt_base64.length > 8 * 1024 * 1024) {
        throw httpError(400, 'RECEIPT_TOO_LARGE', 'Le reçu est trop volumineux (max ~6 Mo).');
      }
      receiptBuffer = Buffer.from(receipt_base64, 'base64');
    }
    const topup = await orchestrator.createManualTopup({
      merchantId: ctx.merchantId,
      id,
      ownReference: reference,
      method,
      amountUsd: amount_usd,
      receiptBuffer,
      receiptFilename: receipt_filename,
      receiptContentType: receipt_content_type,
      mode,
    });
    return { status: 201, body: toPublic(topup) };
  } catch (err) {
    if (err.httpStatus) throw err;
    throw httpError(err.code === 'PROVIDER_ERROR' || err.code === 'STORAGE_ERROR' ? 502 : 400, err.code || 'TOPUP_ERROR', err.message);
  }
}

async function get(ctx) {
  let topup = await orchestrator.getById(ctx.merchantId, ctx.params.id);
  if (!topup) throw httpError(404, 'NOT_FOUND', 'Rechargement introuvable.');
  if (orchestrator.AUTO_METHODS.includes(topup.method)) {
    topup = await orchestrator.refreshAutoTopup(ctx.merchantId, topup);
  }
  return { status: 200, body: toPublic(topup) };
}

async function list(ctx) {
  const mode = await resolveMode(ctx);
  const rows = await orchestrator.list(ctx.merchantId, 50, mode);
  return { status: 200, body: { topups: rows.map(toPublic) } };
}

function num(v) {
  return v == null ? v : Number(v);
}

function toPublic(t) {
  return {
    id: t.id,
    reference: t.own_reference,
    method: t.method,
    status: t.status, // pending | succeeded | failed | awaiting_review
    amount_htg: num(t.amount_htg),
    amount_usd: num(t.amount_usd),
    fee_htg: num(t.fee_htg),
    exchange_rate: num(t.exchange_rate),
    credited_usd: num(t.credited_usd),
    checkout_url: t.checkout_url,
    receipt_filename: t.receipt_filename,
    failure_reason: t.failure_reason,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { create, get, list };
