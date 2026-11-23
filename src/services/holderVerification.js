'use strict';
const supabase = require('../lib/supabase');

/**
 * Starts (or restarts) the identity check of a holder at the new card program, for a holder that already exists there.
 * The issuer's rules: POST /cardholders/:id/verification needs id_number and an address (line1, city, state), the documents only when none
 * is on file; a refused holder is checked again by sending NEW documents (5 submissions per 24 h). The result comes by webhook
 * (and, in Sandbox, the test helper approves at once).
 */
const save = async (holder, fields) => {
  const [row] = await supabase.update('maplerad_customers', { id: holder.id }, Object.assign({ updated_at: new Date().toISOString() }, fields)).catch(() => []);
  return row || Object.assign({}, holder, fields);
};

/**
 * The issuer accepts letters, digits, spaces and , . - in an address (an apostrophe, #, / or accents make it refuse: "parameter_invalid").
 * Accents are removed and any other sign becomes a space.
 */
function cleanText(v) {
  return String(v == null ? '' : v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 ,.\-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** What we already know about the holder, in the shape the issuer asks for. State falls back to the city, then the country (it is required). */
function submissionFor(holder) {
  const a = holder.address || {};
  const city = cleanText(a.city).slice(0, 60);
  return {
    id_number: String(holder.identification_number || '').trim().slice(0, 30),
    address: { line1: cleanText(a.street || a.line1).slice(0, 120), city, state: cleanText(a.state || city || a.country || holder.country).slice(0, 60), postal_code: cleanText(a.postal_code || a.postalCode).replace(/\s+/g, '').slice(0, 20) || undefined },
    birth_date: holder.dob || undefined,
  };
}

/** What is missing or wrong before the check can be sent: the admin completes it one holder at a time. */
function issuesFor(holder, docsOnFile) {
  const a = holder.address || {};
  const out = [];
  if (!String(holder.identification_number || '').trim()) out.push({ field: 'id_number', label: "Numéro de la pièce d'identité manquant" });
  if (!cleanText(a.street || a.line1)) out.push({ field: 'address.line1', label: 'Adresse (rue) manquante' });
  else if (cleanText(a.street || a.line1) !== String(a.street || a.line1).trim()) out.push({ field: 'address.line1', label: "L'adresse contient des signes non acceptés (apostrophe, #, /, accents…) : ils seront retirés à l'envoi", auto: true });
  if (!cleanText(a.city)) out.push({ field: 'address.city', label: 'Ville manquante' });
  if (!String(a.state || '').trim()) out.push({ field: 'address.state', label: 'Région / département manquant : la ville sera utilisée', auto: true });
  if (!holder.dob) out.push({ field: 'birth_date', label: 'Date de naissance manquante' });
  else if (Date.now() - new Date(holder.dob).getTime() < 18 * 365.25 * 24 * 3600 * 1000) out.push({ field: 'birth_date', label: 'Moins de 18 ans' });
  if (docsOnFile === false) out.push({ field: 'documents', label: 'Aucune photo de la pièce chez le programme : ajoutez le recto (et le verso sauf passeport)' });
  return out;
}

async function relaunch(holder, { documents, force } = {}) {
  const monerails = require('./monerails').forMode(holder.mode === 'live' ? 'live' : 'sandbox');
  const bridge = require('./monerailsBridge');
  const chId = holder.monerails_cardholder_id;
  if (!chId) return { status: 'none', error: 'Ce titulaire n\'est pas chez le nouveau programme.' };
  try {
    const v = ((await monerails.getCardholder(chId)).data || {}).verification || {};
    const state = async (status, reason) => {
      const row = await save(holder, { monerails_status: status, monerails_reason: reason || null });
      if (status !== holder.monerails_status) bridge.notifyHolderResult(Object.assign({}, holder, row), status, reason);
      return row;
    };
    if (v.status === 'verified') { await state('verified'); return { status: 'verified', changed: holder.monerails_status !== 'verified' }; }
    if (v.status === 'in_review' && !documents && !force) { await state('in_review'); return { status: 'in_review', changed: holder.monerails_status !== 'in_review' }; }
    if (v.status === 'rejected' && !documents && !force) { await state('rejected', v.reason); return { status: 'rejected', needs_photo: true, reason: v.reason || null }; }
    if (!documents && v.documents_on_file === false) return { status: v.status === 'rejected' ? 'rejected' : 'pending', needs_photo: true };
    const r = await monerails.submitVerification(chId, Object.assign(submissionFor(holder), documents ? { documents } : {}));
    let status = ((r.data || {}).verification || {}).status || 'in_review';
    if (status !== 'verified' && holder.mode !== 'live') {
      const ok = await monerails.testVerification(chId, 'approved');
      status = ((ok.data || {}).verification || {}).status || status;
    }
    await state(status);
    return { status, submitted: true };
  } catch (e) {
    const code = String(e.code || '');
    if (/IDENTITY_ALREADY_REGISTERED|VERIFICATION_DECLINED/.test(code)) { await save(holder, { monerails_status: 'rejected', monerails_reason: String(e.message).slice(0, 300) }); bridge.notifyHolderResult(Object.assign({}, holder, { monerails_status: 'rejected' }), 'rejected', e.message); return { status: 'rejected', reason: e.message }; }
    await save(holder, { monerails_reason: String(e.message || e).slice(0, 300) });
    return { status: holder.monerails_status || 'pending', error: String(e.message || e).slice(0, 300) };
  }
}

/** Every holder of an environment that exists at the new program but whose check never started (pending) or was left as failed. */
async function stuckHolders({ mode, merchantId } = {}) {
  const filters = {};
  if (mode === 'live' || mode === 'sandbox') filters.mode = mode;
  if (merchantId) filters.merchant_id = merchantId;
  const rows = await supabase.select('maplerad_customers', filters, { order: 'created_at.desc', limit: 5000 });
  return rows.filter((h) => h.monerails_cardholder_id && (!h.monerails_status || h.monerails_status === 'pending' || h.monerails_status === 'failed'));
}

async function relaunchStuck({ mode, merchantId, confirm, limit } = {}) {
  const list = (await stuckHolders({ mode, merchantId })).slice(0, limit || 150);
  if (confirm !== true) return { relaunched: false, preview: true, holders: list.length };
  const out = { relaunched: true, holders: list.length, in_review: 0, verified: 0, rejected: 0, needs_photo: 0, errors: 0, samples: [] };
  for (const h of list) {
    const r = await relaunch(h);
    if (r.status === 'verified') out.verified += 1; else if (r.status === 'in_review') out.in_review += 1; else if (r.status === 'rejected') out.rejected += 1;
    if (r.needs_photo) out.needs_photo += 1;
    if (r.error) { out.errors += 1; if (out.samples.length < 5) out.samples.push({ holder: h.id, error: r.error }); }
  }
  return out;
}

const DOC_TYPES = { national_id: "Carte nationale d'identité", passport: 'Passeport', driver_license: 'Permis de conduire', voters_card: "Carte d'électeur" };
const OLD_TYPE = { national_id: 'NIN', passport: 'PASSPORT', driver_license: 'DRIVERS_LICENSE', voters_card: 'VOTERS_CARD' };
const err = (status, code, message) => { const e = new Error(message); e.httpStatus = status; e.code = code; return e; };
const DOC = /^data:image\/(png|jpeg|jpg);base64,[A-Za-z0-9+/]+=*$/;
function readDoc(v, label) {
  if (v == null || v === '') return null;
  const s = String(v);
  if (!DOC.test(s)) throw err(400, 'INVALID_DOCUMENT', `${label} : image JPEG ou PNG requise.`);
  if (s.length * 0.75 > 4 * 1024 * 1024) throw err(413, 'DOCUMENT_TOO_LARGE', `${label} : 4 Mo au plus.`);
  return s;
}

/**
 * Completes what is missing for ONE holder (number, birth date, address, document type, photos) and sends its identity check. Used by the admin
 * panel and by the merchant's own dashboard. A holder not yet at the new program is sent there now (photos required); one already there is
 * checked again. rateLimit: the issuer allows 5 submissions per holder per 24 h. Returns { r, warning, front }.
 */
async function applyAndSend(h, b, { rateLimit } = {}) {
  const fields = {};
  if (b.id_number !== undefined) { const v = String(b.id_number).trim(); if (v.length < 4 || v.length > 30) throw err(400, 'INVALID_ID_NUMBER', "Numéro de pièce : 4 à 30 caractères, tel qu'il figure sur la pièce."); fields.identification_number = v; }
  if (b.birth_date !== undefined) { const v = String(b.birth_date).trim(); if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw err(400, 'INVALID_DOB', 'Date de naissance : AAAA-MM-JJ.'); fields.dob = v; }
  if (b.address && typeof b.address === 'object') {
    const a = Object.assign({}, h.address || {});
    for (const k of ['street', 'city', 'state', 'postal_code']) if (b.address[k] !== undefined) a[k] = String(b.address[k]).trim().slice(0, 120);
    fields.address = a;
  }
  const docType = b.document_type && DOC_TYPES[b.document_type] ? b.document_type : null;
  if (docType === 'passport') {
    const num = String(fields.identification_number || h.identification_number || '').trim();
    if (!/^[A-Za-z0-9]{6,9}$/.test(num)) throw err(400, 'INVALID_ID_NUMBER', "Passeport : le numéro a 6 à 9 lettres ou chiffres, sans espace ni tiret, tel qu'il figure sur la page photo.");
  }
  const front = readDoc(b.documents && b.documents.front, 'Recto');
  const back = docType === 'passport' ? null : readDoc(b.documents && b.documents.back, 'Verso');
  if (readDoc(b.documents && b.documents.back, 'Verso') && !front) throw err(400, 'INVALID_DOCUMENT', 'Ajoutez aussi le recto.');
  let warning = null;
  if (docType && h.monerails_cardholder_id) {
    try {
      const ch = (await require('./monerails').forMode(h.mode === 'live' ? 'live' : 'sandbox').getCardholder(h.monerails_cardholder_id)).data || {};
      if (ch.id_document && ch.id_document !== docType) warning = `Ce titulaire est enregistré dans le nouveau programme avec « ${DOC_TYPES[ch.id_document] || ch.id_document} », pas « ${DOC_TYPES[docType]} ». Si la vérification est refusée pour cette raison, le type de pièce doit être changé par le programme.`;
    } catch (e) { /* the type cannot be compared */ }
  }
  if (!h.monerails_cardholder_id && !front) throw err(400, 'PHOTO_REQUIRED', "Ajoutez la photo de la pièce : le recto, et le verso sauf pour un passeport.");
  if (!h.monerails_cardholder_id && await require('./cardIssuer').issuerFor(h.merchant_id, h.mode, 'individual') !== 'monerails') throw err(409, 'NOT_AVAILABLE', "Le nouveau programme de cartes n'est pas disponible pour ce compte pour le moment.");
  if (rateLimit) await require('./cardOrchestrator').countVerificationAttempt(h.id);
  let holder = h;
  if (Object.keys(fields).length) holder = (await supabase.update('maplerad_customers', { id: h.id }, Object.assign({ updated_at: new Date().toISOString() }, fields)).catch(() => [h]))[0] || Object.assign({}, h, fields);
  const documents = front ? (back ? { front, back } : { front }) : undefined;
  let r;
  if (!holder.monerails_cardholder_id) {
    const a = holder.address || {};
    const done = await require('./cardOrchestrator').enrollAtMonerails(holder, {
      firstName: holder.first_name, lastName: holder.last_name, email: holder.email, country: holder.country, dob: holder.dob,
      phoneShortCode: holder.phone_short_code, phoneNumber: holder.phone_number, address: { street: a.street || a.line1, city: a.city, state: a.state, postal_code: a.postal_code || a.postalCode, country: a.country }, identificationNumber: holder.identification_number,
      identity: { type: OLD_TYPE[docType || 'national_id'], number: holder.identification_number, image: front, imageBackUrl: back || undefined },
    });
    const st = done && done.monerails_status;
    r = { status: st === 'failed' ? 'rejected' : (st || 'pending'), submitted: true, error: st === 'failed' || st === 'pending' ? (done.monerails_reason || null) : null };
  } else r = await relaunch(holder, { force: true, documents });
  return { r, warning, front };
}

module.exports = { applyAndSend, DOC_TYPES, cleanText, issuesFor, relaunch, relaunchStuck, stuckHolders, submissionFor };
