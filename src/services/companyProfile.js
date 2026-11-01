'use strict';
const supabase = require('../lib/supabase');

/**
 * The company's legal identity and the CEO's signature, used on official documents (partner reports...).
 * Stored in platform_settings (key company_profile) so the admin edits it without a redeploy.
 */
const KEY = 'company_profile';
/** What the public site already states about the company (terms, home page); the admin can change any of it. Address and the signature are never guessed. */
const DEFAULTS = {
  legal_name: 'Freda Pay LLC',
  legal_form: "Limited Liability Company (État du Wyoming, États-Unis)",
  registration: "Société enregistrée dans l'État du Wyoming (États-Unis) et auprès du FinCEN comme Money Services Business",
  email: 'issuing@fredapay.com',
  website: 'issuing.fredapay.com',
  ceo_name: 'Saint-Julien Widemayeur',
  ceo_title: 'Fondateur et CEO',
};
const TEXT_FIELDS = { legal_name: 150, legal_form: 80, address: 300, city: 80, registration: 120, tax_id: 120, email: 120, phone: 50, website: 120, ceo_name: 100, ceo_title: 100 };

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

async function get() {
  const row = await supabase.selectOne('platform_settings', { key: KEY });
  let saved = {};
  if (row) { try { saved = JSON.parse(row.value) || {}; } catch (e) { saved = {}; } }
  // A field the admin emptied on purpose stays empty; one never filled falls back to the default.
  const out = Object.assign({}, DEFAULTS, saved);
  return out;
}

/** What is still missing before an official PDF can be produced. */
function missing(p) {
  const out = [];
  if (!p.legal_name) out.push('le nom légal');
  if (!p.ceo_name) out.push('le nom du CEO');
  if (!p.signature || !p.signature.image) out.push('la signature du CEO');
  return out;
}

/** body: the text fields, and optionally `signature` (validated by the caller, same shape as a contract signature) or `clear_signature`. */
async function save(body, signature, adminEmail) {
  const current = await get();
  const next = Object.assign({}, current);
  for (const [field, max] of Object.entries(TEXT_FIELDS)) {
    if (body[field] === undefined) continue;
    const v = String(body[field] || '').replace(/[\u0000-\u001f]/g, ' ').trim();
    if (v.length > max) throw httpError(400, 'FIELD_TOO_LONG', `${field} : ${max} caractères maximum.`);
    next[field] = v;
  }
  if (body.clear_signature) delete next.signature;
  if (signature) next.signature = signature;
  const patch = { value: JSON.stringify(next), updated_by: adminEmail || null, updated_at: new Date().toISOString() };
  const existing = await supabase.selectOne('platform_settings', { key: KEY });
  if (existing) await supabase.update('platform_settings', { key: KEY }, patch);
  else await supabase.insert('platform_settings', Object.assign({ key: KEY }, patch));
  return next;
}

module.exports = { get, save, missing, TEXT_FIELDS };
