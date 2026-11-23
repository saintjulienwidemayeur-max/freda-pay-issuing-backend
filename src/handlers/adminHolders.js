'use strict';
const supabase = require('../lib/supabase');

/**
 * GET /admin/holders?status=&program=&mode=&q=&limit= : the card holders of every merchant, with what the merchant sees (confirmed, pending,
 * refused) AND where each stands with the new card program (accepted, refused, pending, not sent) with the issuer's own reason.
 * status: enrolled | pending | failed.   program: accepted | refused | pending | none.
 */
async function list(ctx) {
  const q = ctx.query || {};
  const filters = {};
  if (['enrolled', 'pending', 'failed'].includes(q.status)) filters.status = q.status;
  if (q.mode === 'live' || q.mode === 'sandbox') filters.mode = q.mode;
  const limit = Math.min(1000, Math.max(20, parseInt(q.limit || '300', 10) || 300));
  const rows = await supabase.select('maplerad_customers', filters, { order: 'created_at.desc', limit: 5000 });
  const programOf = (h) => {
    const st = h.monerails_status;
    if (!h.monerails_cardholder_id && !st) return 'none';
    if (st === 'verified') return 'accepted';
    if (h.monerails_cardholder_id && (!st || st === 'pending' || st === 'failed')) return 'to_relaunch'; // exists there, the check never started: can be relaunched
    if (st === 'rejected' || st === 'failed') return 'refused';
    return 'pending'; // in review
  };
  const ids = [...new Set(rows.map((h) => h.merchant_id))];
  const merchants = ids.length ? await supabase.select('merchants', { id: supabase.inList(ids) }, { limit: 5000 }) : [];
  const by = new Map(merchants.map((m) => [m.id, m]));
  const needle = String(q.q || '').trim().toLowerCase().slice(0, 80);
  let list = rows.map((h) => {
    const m = by.get(h.merchant_id) || {};
    return {
      id: h.id, merchant_id: h.merchant_id, merchant_name: m.business_name || null, merchant_email: m.email || null,
      mode: h.mode || 'sandbox', status: h.status, failure_reason: h.failure_reason || null,
      first_name: h.first_name, last_name: h.last_name, email: h.email, country: h.country, dob: h.dob || null, created_at: h.created_at,
      at_program: !!h.monerails_cardholder_id, program: programOf(h), program_reason: h.monerails_reason ? (require('../services/cardIssuer').publicDetail(h.monerails_reason) || 'Raison non lisible : ouvrez le titulaire') : null,
    };
  });
  const counts = { all: 0, enrolled: 0, pending: 0, failed: 0, program_accepted: 0, program_refused: 0, program_pending: 0, program_to_relaunch: 0 };
  if (needle) list = list.filter((h) => `${h.first_name || ''} ${h.last_name || ''} ${h.email || ''} ${h.id} ${h.merchant_name || ''} ${h.merchant_email || ''} ${h.merchant_id}`.toLowerCase().includes(needle));
  for (const h of list) { counts.all += 1; if (counts[h.status] != null) counts[h.status] += 1; if (h.program !== 'none') counts[`program_${h.program}`] += 1; }
  if (['accepted', 'refused', 'pending', 'to_relaunch', 'none'].includes(q.program)) list = list.filter((h) => h.program === q.program);
  return { status: 200, body: { counts, total: list.length, holders: list.slice(0, limit) } };
}

/** POST /admin/holders/relaunch { mode?, merchant_id?, confirm } : starts the check of every holder whose check never started (preview without confirm). */
async function relaunch(ctx) {
  const b = ctx.body || {};
  const r = await require('../services/holderVerification').relaunchStuck({ mode: b.mode, merchantId: /^mch_[A-Za-z0-9_]+$/.test(String(b.merchant_id || '')) ? b.merchant_id : undefined, confirm: b.confirm === true });
  return { status: 200, body: r };
}

function httpError(status, code, message) { const e = new Error(message); e.httpStatus = status; e.code = code; return e; }
const publicText = (t) => (t ? (require('../services/cardIssuer').publicDetail(t) || null) : null);

/** GET /admin/holders/:id : one holder with what is missing or wrong, what would be sent, and where its check stands (no partner name). */
async function detail(ctx) {
  const hv = require('../services/holderVerification');
  const h = await supabase.selectOne('maplerad_customers', { id: ctx.params.id });
  if (!h) throw httpError(404, 'NOT_FOUND', 'Titulaire introuvable.');
  const m = await supabase.selectOne('merchants', { id: h.merchant_id }).catch(() => null);
  let remote = null;
  if (h.monerails_cardholder_id) {
    try { const ch = (await require('../services/monerails').forMode(h.mode === 'live' ? 'live' : 'sandbox').getCardholder(h.monerails_cardholder_id)).data || {}; const v = ch.verification || {}; remote = { status: v.status || null, reason: publicText(v.reason), documents_on_file: v.documents_on_file !== false, id_document: ch.id_document || null }; } catch (e) { remote = null; }
  }
  return { status: 200, body: {
    holder: { id: h.id, merchant_id: h.merchant_id, merchant_name: m && m.business_name, mode: h.mode, status: h.status, first_name: h.first_name, last_name: h.last_name, email: h.email, country: h.country, dob: h.dob || null, identification_number: h.identification_number || '', address: h.address || {}, at_program: !!h.monerails_cardholder_id, program_reason: publicText(h.monerails_reason) },
    remote, issues: hv.issuesFor(h, remote ? remote.documents_on_file : undefined), will_send: hv.submissionFor(h),
  } };
}

/**
 * POST /admin/holders/:id/relaunch { id_number?, birth_date?, document_type?, address?: { street, city, state, postal_code }, documents?: { front, back } } :
 * completes what is missing for ONE holder, then sends its check. Documents are JPEG/PNG data URLs, 4 MB at most.
 */
async function relaunchOne(ctx) {
  const h = await supabase.selectOne('maplerad_customers', { id: ctx.params.id });
  if (!h) throw httpError(404, 'NOT_FOUND', 'Titulaire introuvable.');
  console.log(`Holder verification sent by ${(ctx.admin && ctx.admin.email) || ctx.adminId}: ${h.id}`); // eslint-disable-line no-console
  const { r, warning, front } = await require('../services/holderVerification').applyAndSend(h, ctx.body || {});
  return { status: 200, body: { status: r.status, warning, documents_sent: !!front, submitted: !!r.submitted, needs_photo: !!r.needs_photo, reason: publicText(r.reason), error: publicText(r.error) || (r.error ? 'Envoi refusé : voir le détail du titulaire' : null) } };
}

module.exports = { list, relaunch, detail, relaunchOne };
