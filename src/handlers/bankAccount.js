'use strict';
const supabase = require('../lib/supabase');
const config = require('../config');
const notify = require('../services/notify');
const { randomHex } = require('../utils/ids');

const tail = (v) => (v ? `••••${String(v).replace(/\s/g, '').slice(-4)}` : null);

/** What the merchant sees back: the account is recognisable, the full number is not displayed again. */
function toPublic(a) {
  if (!a) return null;
  return {
    holder_name: a.holder_name, bank_name: a.bank_name, country: a.country, currency: a.currency,
    account_number_masked: tail(a.account_number), iban_masked: tail(a.iban),
    swift: a.swift || null, routing_number: a.routing_number || null, updated_at: a.updated_at,
  };
}

function ibanOk(iban) {
  const v = String(iban).replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(v)) return false;
  const rearranged = v.slice(4) + v.slice(0, 4);
  const digits = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of digits) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}

function clean(body) {
  const b = body || {};
  const str = (k, max) => (b[k] == null ? '' : String(b[k]).trim().slice(0, max));
  const out = {
    holder_name: str('holder_name', 100), bank_name: str('bank_name', 100),
    country: str('country', 40).toUpperCase(), currency: str('currency', 3).toUpperCase(),
    account_number: str('account_number', 40).replace(/\s/g, ''), iban: str('iban', 42).replace(/\s/g, '').toUpperCase(),
    swift: str('swift', 11).toUpperCase(), routing_number: str('routing_number', 20),
  };
  if (out.holder_name.length < 2) throw httpError(400, 'MISSING_FIELDS', "Le nom du titulaire du compte est requis.");
  if (out.bank_name.length < 2) throw httpError(400, 'MISSING_FIELDS', 'Le nom de la banque est requis.');
  if (!/^[A-Z]{2}$/.test(out.country)) throw httpError(400, 'INVALID_COUNTRY', "Le pays de la banque doit être un code à 2 lettres (ex. HT, US, FR).");
  if (config.restrictedCountries.includes(out.country)) throw httpError(403, 'COUNTRY_NOT_SUPPORTED', "Les virements vers ce pays ne sont pas disponibles.");
  if (!['HTG', 'USD'].includes(out.currency)) throw httpError(400, 'INVALID_CURRENCY', "La devise du compte doit être HTG ou USD.");
  if (!out.account_number && !out.iban) throw httpError(400, 'MISSING_FIELDS', "Entrez le numéro de compte ou l\'IBAN.");
  if (out.account_number && !/^[A-Za-z0-9\-]{4,34}$/.test(out.account_number)) throw httpError(400, 'INVALID_ACCOUNT', "Le numéro de compte n\'est pas valide.");
  if (out.iban && !ibanOk(out.iban)) throw httpError(400, 'INVALID_IBAN', "L\'IBAN n\'est pas valide (vérifiez les caractères).");
  if (out.swift && !/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(out.swift)) throw httpError(400, 'INVALID_SWIFT', "Le code SWIFT/BIC n\'est pas valide (8 ou 11 caractères).");
  if (out.routing_number && !/^[A-Za-z0-9\-]{3,20}$/.test(out.routing_number)) throw httpError(400, 'INVALID_ROUTING', "Le numéro de routage n\'est pas valide.");
  return { ...out, account_number: out.account_number || null, iban: out.iban || null, swift: out.swift || null, routing_number: out.routing_number || null };
}

async function get(ctx) {
  const account = await supabase.selectOne('bank_accounts', { merchant_id: ctx.merchantId });
  return { status: 200, body: { bank_account: toPublic(account) } };
}

/** Adds the account, or replaces it. The owner is told by email, so a changed account never goes unnoticed. */
async function put(ctx) {
  const data = clean(ctx.body);
  const existing = await supabase.selectOne('bank_accounts', { merchant_id: ctx.merchantId });
  const row = existing
    ? (await supabase.update('bank_accounts', { merchant_id: ctx.merchantId }, { ...data, updated_at: new Date().toISOString() }))[0]
    : await supabase.insert('bank_accounts', { id: `bnk_${randomHex(10)}`, merchant_id: ctx.merchantId, ...data });
  const merchant = ctx.merchant || (await supabase.selectOne('merchants', { id: ctx.merchantId }));
  await notify.bankAccountChanged(merchant, { bankName: data.bank_name, masked: tail(data.iban || data.account_number), added: !existing });
  return { status: existing ? 200 : 201, body: { bank_account: toPublic(row) } };
}

async function remove(ctx) {
  const existing = await supabase.selectOne('bank_accounts', { merchant_id: ctx.merchantId });
  if (existing) await supabase.delete('bank_accounts', { merchant_id: ctx.merchantId });
  return { status: 200, body: { removed: !!existing } };
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { get, put, remove };
