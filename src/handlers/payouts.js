'use strict';
const payoutOrchestrator = require('../services/payoutOrchestrator');
const ledger = require('../services/ledger');
const { fetchPage } = require('../utils/pagination');
const { resolveMode } = require('../utils/mode');
const { generatePayoutId, namespaceReference } = require('../utils/ids');

const VALID_METHODS = ['moncash', 'natcash'];
const PHONE_RE = /^509\d{8}$/;

async function create(ctx) {
  const { amount, method, recipient, reference } = ctx.body || {};

  if (amount == null || !method || !recipient || !reference) {
    throw httpError(400, 'MISSING_FIELDS', 'amount, method, recipient et reference sont requis.');
  }
  if (typeof amount !== 'number' || amount <= 0) {
    throw httpError(400, 'INVALID_AMOUNT', 'amount doit être un nombre positif.');
  }
  if (!VALID_METHODS.includes(method)) {
    throw httpError(400, 'INVALID_METHOD', "method doit être 'moncash' ou 'natcash'.");
  }
  if (!PHONE_RE.test(recipient)) {
    throw httpError(400, 'INVALID_RECIPIENT', "recipient doit être au format 509XXXXXXXX.");
  }

  const existing = await payoutOrchestrator.getByOwnReference(ctx.merchantId, reference);
  if (existing) {
    return { status: 200, body: toPublic(existing) }; // idempotent replay
  }

  const available = await ledger.getBalance(ctx.merchantId, 'gateway', 'HTG', await resolveMode(ctx));
  if (available < amount) {
    throw httpError(400, 'INSUFFICIENT_BALANCE', `Solde disponible insuffisant (${available} HTG).`);
  }

  const id = generatePayoutId();
  const plopplopReference = namespaceReference(ctx.merchantId, reference);
  const mode = await resolveMode(ctx);

  const payout = await payoutOrchestrator.createPayout({
    merchantId: ctx.merchantId,
    id,
    ownReference: reference,
    plopplopReference,
    amount,
    method,
    recipient,
    mode,
  });

  return { status: 202, body: toPublic(payout) }; // 202 Accepted: processing async (queued for cooldown)
}

async function get(ctx) {
  const payout = await payoutOrchestrator.getById(ctx.merchantId, ctx.params.id);
  if (!payout) throw httpError(404, 'NOT_FOUND', 'Retrait introuvable.');
  return { status: 200, body: toPublic(payout) };
}

async function list(ctx) {
  const mode = await resolveMode(ctx);
  const { rows, pagination } = await fetchPage(ctx.query, (limit, offset) =>
    payoutOrchestrator.list(ctx.merchantId, limit, offset, mode)
  );
  return { status: 200, body: { payouts: rows.map(toPublic), pagination, mode } };
}

function num(v) {
  return v == null ? v : Number(v);
}

function toPublic(p) {
  return {
    id: p.id,
    reference: p.own_reference,
    amount: num(p.amount),
    method: p.method,
    recipient: p.recipient,
    status: p.status, // 'pending' | 'success' | 'failed'
    fee: num(p.fee),
    provider_reference: p.api_reference,
    provider_transaction_id: p.plopplop_transaction_id,
    failure_reason: p.failure_reason,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { create, get, list };
