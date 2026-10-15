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
    id: a.id, kind: a.kind || 'bank',
    zelle_masked: maskZelle(a.zelle_contact),
    holder_name: a.holder_name, bank_name: a.bank_name, country: a.country, currency: a.currency,
    account_number_masked: tail(a.account_number), iban_masked: tail(a.iban),
    swift: a.swift || null, routing_number: a.routing_number || null, updated_at: a.updated_at,
  };
}

/** "j•••@gmail.com" or "••••1234": recognisable, never the full contact. */
function maskZelle(v) {
  if (!v) return null;
  const x = String(v);
  const at = x.indexOf('@');
  return at > 0 ? `${x[0]}•••${x.slice(at)}` : tail(x);
}

/** Currencies a merchant can choose for a bank account in this country. Haiti: gourdes or dollars; everywhere else: dollars. */
function allowedCurrencies(country) {
  return country === 'HT' ? ['HTG', 'USD'] : ['USD'];
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
  const kind = String(b.kind || 'bank').toLowerCase();
  if (!['bank', 'zelle'].includes(kind)) throw httpError(400, 'INVALID_KIND', "Le type de compte doit être 'bank' ou 'zelle'.");
  if (kind === 'zelle') {
    const holder = str('holder_name', 100);
    let contact = str('zelle_contact', 120).replace(/\s/g, '');
    if (holder.length < 2) throw httpError(400, 'MISSING_FIELDS', 'Le nom associé au compte Zelle est requis.');
    if (/^[^@]+@[^@]+\.[^@]+$/.test(contact)) contact = contact.toLowerCase();
    else {
      const digits = contact.replace(/[^\d]/g, '');
      const national = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
      if (!/^\d{10}$/.test(national)) throw httpError(400, 'INVALID_ZELLE', "Entrez l'email ou le numéro de téléphone américain (10 chiffres) lié à votre compte Zelle.");
      contact = `+1${national}`;
    }
    // Zelle only exists in the United States and only pays in dollars.
    return { kind: 'zelle', holder_name: holder, bank_name: 'Zelle', country: 'US', currency: 'USD', zelle_contact: contact, account_number: null, iban: null, swift: null, routing_number: null };
  }
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
  if (!out.currency) out.currency = allowedCurrencies(out.country)[0];
  if (!allowedCurrencies(out.country).includes(out.currency)) {
    throw httpError(400, 'INVALID_CURRENCY', out.country === 'HT' ? 'La devise du compte doit être HTG ou USD.' : 'Pour ce pays, la devise du compte est le dollar (USD).');
  }
  if (!out.account_number && !out.iban) throw httpError(400, 'MISSING_FIELDS', "Entrez le numéro de compte ou l\'IBAN.");
  if (out.account_number && !/^[A-Za-z0-9\-]{4,34}$/.test(out.account_number)) throw httpError(400, 'INVALID_ACCOUNT', "Le numéro de compte n\'est pas valide.");
  if (out.iban && !ibanOk(out.iban)) throw httpError(400, 'INVALID_IBAN', "L\'IBAN n\'est pas valide (vérifiez les caractères).");
  if (out.swift && !/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(out.swift)) throw httpError(400, 'INVALID_SWIFT', "Le code SWIFT/BIC n\'est pas valide (8 ou 11 caractères).");
  if (out.routing_number && !/^[A-Za-z0-9\-]{3,20}$/.test(out.routing_number)) throw httpError(400, 'INVALID_ROUTING', "Le numéro de routage n\'est pas valide.");
  return { ...out, kind: 'bank', zelle_contact: null, account_number: out.account_number || null, iban: out.iban || null, swift: out.swift || null, routing_number: out.routing_number || null };
}

const MAX_ACCOUNTS = 5;

async function accountsOf(merchantId) {
  const rows = await supabase.select('bank_accounts', { merchant_id: merchantId }, { order: 'created_at.asc' });
  return rows || [];
}

async function notifyChange(ctx, data, added) {
  const merchant = ctx.merchant || (await supabase.selectOne('merchants', { id: ctx.merchantId }));
  await notify.bankAccountChanged(merchant, { bankName: data.bank_name, masked: data.kind === 'zelle' ? maskZelle(data.zelle_contact) : tail(data.iban || data.account_number), added });
}

/** All the merchant's bank accounts (the oldest one is the default). */
async function list(ctx) {
  const rows = await accountsOf(ctx.merchantId);
  return { status: 200, body: { bank_accounts: rows.map(toPublic) } };
}

async function add(ctx) {
  const data = clean(ctx.body);
  const rows = await accountsOf(ctx.merchantId);
  if (rows.length >= MAX_ACCOUNTS) throw httpError(400, 'TOO_MANY_ACCOUNTS', `Vous pouvez enregistrer ${MAX_ACCOUNTS} comptes bancaires au maximum. Supprimez-en un d'abord.`);
  const row = await supabase.insert('bank_accounts', { id: `bnk_${randomHex(10)}`, merchant_id: ctx.merchantId, ...data });
  await notifyChange(ctx, data, true);
  return { status: 201, body: { bank_account: toPublic(row) } };
}

async function update(ctx) {
  const current = await supabase.selectOne('bank_accounts', { id: ctx.params.id, merchant_id: ctx.merchantId });
  if (!current) throw httpError(404, 'NOT_FOUND', 'Compte bancaire introuvable.');
  const data = clean(ctx.body);
  const [row] = await supabase.update('bank_accounts', { id: current.id }, { ...data, updated_at: new Date().toISOString() });
  await notifyChange(ctx, data, false);
  return { status: 200, body: { bank_account: toPublic(row) } };
}

async function removeOne(ctx) {
  const current = await supabase.selectOne('bank_accounts', { id: ctx.params.id, merchant_id: ctx.merchantId });
  if (!current) throw httpError(404, 'NOT_FOUND', 'Compte bancaire introuvable.');
  await supabase.delete('bank_accounts', { id: current.id }); // withdrawals already requested keep their own copy of the details
  return { status: 200, body: { removed: true } };
}

/** Older single-account endpoints, kept so existing integrations keep working: they act on the default (oldest) account. */
async function get(ctx) {
  const rows = await accountsOf(ctx.merchantId);
  return { status: 200, body: { bank_account: toPublic(rows[0]) } };
}

async function put(ctx) {
  const rows = await accountsOf(ctx.merchantId);
  if (!rows.length) return add(ctx);
  ctx.params = { ...(ctx.params || {}), id: rows[0].id };
  return update(ctx);
}

async function remove(ctx) {
  const rows = await accountsOf(ctx.merchantId);
  if (rows.length) await supabase.delete('bank_accounts', { id: rows[0].id });
  return { status: 200, body: { removed: rows.length > 0 } };
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { get, put, remove, list, add, update, removeOne };
