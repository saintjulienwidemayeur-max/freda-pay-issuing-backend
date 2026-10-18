'use strict';
const payoutOrchestrator = require('../services/payoutOrchestrator');
const config = require('../config');
const supabase = require('../lib/supabase');
const pricing = require('../services/pricing');
const ledger = require('../services/ledger');
const { fetchPage } = require('../utils/pagination');
const { resolveMode } = require('../utils/mode');
const { parseAmount } = require('../utils/money');
const { generatePayoutId, namespaceReference } = require('../utils/ids');

const VALID_METHODS = ['moncash', 'natcash', 'bank'];
const PHONE_RE = /^509\d{8}$/;

/** "Virement bancaire •••• 4821 (Banque X)": enough to recognise the account, never the full number. */
function describeBank(account) {
  if (account.kind === 'zelle') {
    const c = String(account.zelle_contact || '');
    return `Zelle ${c.includes('@') ? c[0] + '•••' + c.slice(c.indexOf('@')) : '••••' + c.slice(-4)}`;
  }
  const tail = String(account.iban || account.account_number || '').replace(/\s/g, '').slice(-4);
  return `${account.bank_name} ••••${tail}`;
}

async function create(ctx) {
  const { amount, method, recipient, reference, bank_account_id: bankAccountId } = ctx.body || {};
  const currency = ctx.body && ctx.body.currency ? String(ctx.body.currency).toUpperCase() : 'HTG';
  if (!['HTG', 'USD'].includes(currency)) throw httpError(400, 'INVALID_CURRENCY', "currency doit être 'HTG' ou 'USD'.");
  if (currency === 'USD' && method !== 'bank') throw httpError(400, 'INVALID_METHOD', "Le solde USD (paiements par carte) se retire par virement bancaire ou Zelle : method 'bank'.");

  if (amount == null || !method || !reference) {
    throw httpError(400, 'MISSING_FIELDS', 'amount, method et reference sont requis.');
  }
  parseAmount(amount);
  if (!VALID_METHODS.includes(method)) {
    throw httpError(400, 'INVALID_METHOD', "method doit être 'moncash', 'natcash' ou 'bank'.");
  }
  if (method === 'bank' && ctx.apiKeyMode) {
    throw httpError(400, 'BANK_PAYOUT_DASHBOARD_ONLY', "Le virement bancaire se demande depuis le tableau de bord (il est traité par notre équipe). Par l'API : 'moncash' ou 'natcash'.");
  }
  if (method !== 'bank' && (!recipient || !PHONE_RE.test(recipient))) {
    throw httpError(400, recipient ? 'INVALID_RECIPIENT' : 'MISSING_FIELDS', 'recipient doit être au format 509XXXXXXXX.');
  }
  if (method !== 'bank' && amount < config.payoutFees.mobileMinHTG) {
    throw httpError(400, 'AMOUNT_TOO_LOW', `Le montant minimum d'un retrait MonCash / Natcash est de ${config.payoutFees.mobileMinHTG} HTG.`);
  }

  const existing = await payoutOrchestrator.getByOwnReference(ctx.merchantId, reference);
  if (existing) {
    return { status: 200, body: toPublic(existing) }; // idempotent replay
  }

  const mode = await resolveMode(ctx);
  let bankDetails = null;
  let target = recipient;
  if (method === 'bank') {
    const minimum = currency === 'USD' ? config.payoutFees.bankMinUSD : config.payoutFees.bankMinHTG;
    if (amount < minimum) {
      throw httpError(400, 'AMOUNT_TOO_LOW', `Le montant minimum d'un virement bancaire est de ${minimum} ${currency}.`);
    }
    // The merchant chooses which account receives the money; without a choice, the default (oldest) one is used.
    let account;
    if (bankAccountId) {
      account = await supabase.selectOne('bank_accounts', { id: bankAccountId, merchant_id: ctx.merchantId });
      if (!account) throw httpError(404, 'BANK_ACCOUNT_NOT_FOUND', 'Compte bancaire introuvable. Choisissez un de vos comptes enregistrés.');
    } else {
      const accounts = await supabase.select('bank_accounts', { merchant_id: ctx.merchantId }, { order: 'created_at.asc', limit: 1 });
      account = accounts && accounts[0];
    }
    if (!account) throw httpError(400, 'NO_BANK_ACCOUNT', "Ajoutez d'abord votre compte bancaire (section Retraits).");
    if ((account.currency || 'HTG') !== currency) {
      throw httpError(400, 'BANK_ACCOUNT_CURRENCY', currency === 'USD'
        ? 'Un retrait en USD va vers un compte en USD (compte bancaire USD ou Zelle). Choisissez un autre compte.'
        : 'Un retrait en HTG va vers un compte en HTG (Zelle ne reçoit que des dollars). Choisissez un autre compte.');
    }
    // A copy, as it is today: editing the account later never changes a withdrawal already requested.
    bankDetails = {
      kind: account.kind || 'bank', zelle_contact: account.zelle_contact || null,
      holder_name: account.holder_name, bank_name: account.bank_name, country: account.country, currency: account.currency,
      account_number: account.account_number || null, iban: account.iban || null, swift: account.swift || null, routing_number: account.routing_number || null,
    };
    target = describeBank(account);
  }

  const override = await supabase.selectOne('merchant_pricing', { merchant_id: ctx.merchantId });
  const { fee } = pricing.computePayoutFee(method, amount, override, currency);
  const available = await ledger.getBalance(ctx.merchantId, 'gateway', currency, mode);
  if (available < amount + fee) {
    throw httpError(400, 'INSUFFICIENT_BALANCE', `Solde disponible insuffisant (${available} ${currency}) : il faut ${amount + fee} ${currency} (${amount} ${currency} + ${fee} ${currency} de frais).`);
  }

  const id = generatePayoutId();
  const plopplopReference = namespaceReference(ctx.merchantId, reference);

  const payout = await payoutOrchestrator.createPayout({
    merchantId: ctx.merchantId,
    id,
    ownReference: reference,
    plopplopReference,
    amount,
    method,
    recipient: target,
    mode,
    bankDetails,
    currency,
  });

  return { status: 202, body: toPublic(payout) }; // 202 Accepted: processed asynchronously (queued / waiting for the team)
}

/** What a withdrawal will cost, computed by the same rule as the real one: the dashboard shows this, not a number of its own. */
async function quote(ctx) {
  const amount = Number(ctx.query && ctx.query.amount);
  const method = ctx.query && ctx.query.method;
  const currency = ctx.query && String(ctx.query.currency || 'HTG').toUpperCase() === 'USD' ? 'USD' : 'HTG';
  if (currency === 'USD' && method !== 'bank') throw httpError(400, 'INVALID_METHOD', "Le solde USD se retire par virement bancaire ou Zelle : method 'bank'.");
  if (!VALID_METHODS.includes(method)) throw httpError(400, 'INVALID_METHOD', "method doit être 'moncash', 'natcash' ou 'bank'.");
  if (!(amount > 0 && amount <= 1e7)) throw httpError(400, 'INVALID_AMOUNT', 'amount doit être un nombre positif.');
  const override = await supabase.selectOne('merchant_pricing', { merchant_id: ctx.merchantId });
  const { fee, kind, pct } = pricing.computePayoutFee(method, amount, override, currency);
  const total = Math.round((amount + fee) * 100) / 100;
  return {
    status: 200,
    body: {
      method, currency,
      amount_htg: currency === 'HTG' ? amount : undefined, fee_htg: currency === 'HTG' ? fee : undefined, total_htg: currency === 'HTG' ? total : undefined,
      amount, fee, total,
      fee_rule: kind === 'percent' ? `${Math.round(pct * 10000) / 100} %` : `${fee} ${currency} fixes`,
      minimum: method === 'bank' ? (currency === 'USD' ? config.payoutFees.bankMinUSD : config.payoutFees.bankMinHTG) : null,
      minimum_htg: currency === 'HTG' && method === 'bank' ? config.payoutFees.bankMinHTG : null,
    },
  };
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
    currency: p.currency || 'HTG',
    method: p.method,
    recipient: p.recipient,
    status: p.status, // 'pending' | 'success' | 'failed'
    fee: num(p.fee), // what Freda Pay charged for this withdrawal (on top of the amount)
    total_debited: num(p.amount) == null ? null : Math.round((num(p.amount) + (num(p.fee) || 0)) * 100) / 100,
    bank_reference: p.method === 'bank' ? p.bank_reference || null : undefined,
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

module.exports = { create, get, list, quote };
