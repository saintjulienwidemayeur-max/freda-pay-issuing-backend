'use strict';
const supabase = require('../lib/supabase');
const notify = require('../services/notify');

async function listPending(ctx) {
  const rows = await supabase.select('issuing_access_requests', { status: 'pending' }, { order: 'created_at.asc' });
  const merchantIds = [...new Set(rows.map((r) => r.merchant_id))];
  const merchants = await Promise.all(merchantIds.map((id) => supabase.selectOne('merchants', { id })));
  const byId = Object.fromEntries(merchants.filter(Boolean).map((m) => [m.id, m]));
  return {
    status: 200,
    body: {
      requests: rows.map((r) => ({
        id: r.id, note: r.note, created_at: r.created_at,
        merchant: byId[r.merchant_id] ? { id: byId[r.merchant_id].id, business_name: byId[r.merchant_id].business_name, email: byId[r.merchant_id].email, kyc_status: byId[r.merchant_id].kyc_status, kyb_status: byId[r.merchant_id].kyb_status } : null,
      })),
    },
  };
}

async function approve(ctx) {
  const reqRow = await getPending(ctx.params.id);
  const [updated] = await supabase.update('issuing_access_requests', { id: reqRow.id }, { status: 'approved', reviewed_by: ctx.adminId, reviewed_at: new Date().toISOString() });
  await supabase.update('merchants', { id: reqRow.merchant_id }, { issuing_live_enabled: true });
  require('../middleware/apiKey').clearAuthCache(); // the merchant's live key can issue cards right away
  await notify.issuingDecision(await supabase.selectOne('merchants', { id: reqRow.merchant_id }), true);
  return { status: 200, body: { request: updated } };
}

async function reject(ctx) {
  const reqRow = await getPending(ctx.params.id);
  const note = (ctx.body && ctx.body.note) || null;
  const [updated] = await supabase.update('issuing_access_requests', { id: reqRow.id }, { status: 'rejected', note, reviewed_by: ctx.adminId, reviewed_at: new Date().toISOString() });
  await notify.issuingDecision(await supabase.selectOne('merchants', { id: reqRow.merchant_id }), false, note);
  return { status: 200, body: { request: updated } };
}

async function getPending(id) {
  const row = await supabase.selectOne('issuing_access_requests', { id });
  if (!row) throw httpError(404, 'NOT_FOUND', 'Demande introuvable.');
  if (row.status !== 'pending') throw httpError(409, 'ALREADY_REVIEWED', 'Cette demande a déjà été traitée.');
  return row;
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { listPending, approve, reject };
