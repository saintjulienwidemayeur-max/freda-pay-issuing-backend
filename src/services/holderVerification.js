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

/** What we already know about the holder, in the shape the issuer asks for. State falls back to the city, then the country (it is required). */
function submissionFor(holder) {
  const a = holder.address || {};
  const city = String(a.city || '').slice(0, 60);
  return {
    id_number: String(holder.identification_number || '').slice(0, 30),
    address: { line1: String(a.street || a.line1 || '').slice(0, 120), city, state: String(a.state || city || a.country || holder.country || '').slice(0, 60), postal_code: String(a.postal_code || a.postalCode || '').slice(0, 20) || undefined },
    birth_date: holder.dob || undefined,
  };
}

async function relaunch(holder, { documents } = {}) {
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
    if (v.status === 'in_review' && !documents) { await state('in_review'); return { status: 'in_review', changed: holder.monerails_status !== 'in_review' }; }
    if (v.status === 'rejected' && !documents) { await state('rejected', v.reason); return { status: 'rejected', needs_photo: true, reason: v.reason || null }; }
    if (!documents && v.documents_on_file === false) return { status: 'pending', needs_photo: true };
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

module.exports = { relaunch, relaunchStuck, stuckHolders, submissionFor };
