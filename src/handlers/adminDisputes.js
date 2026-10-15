'use strict';
const supabase = require('../lib/supabase');

async function list(ctx) {
  const statusFilter = ctx.query && ctx.query.status;
  const rows = await supabase.select('disputes', statusFilter ? { status: statusFilter } : {}, { order: 'created_at.desc' });
  const merchantIds = [...new Set(rows.map((d) => d.merchant_id))];
  const merchants = await Promise.all(merchantIds.map((id) => supabase.selectOne('merchants', { id })));
  const byId = Object.fromEntries(merchants.filter(Boolean).map((m) => [m.id, m]));

  return {
    status: 200,
    body: {
      disputes: rows.map((d) => ({
        id: d.id, payment_id: d.payment_id, reason: d.reason, details: d.details,
        status: d.status, admin_note: d.admin_note, created_at: d.created_at, resolved_at: d.resolved_at,
        merchant: byId[d.merchant_id] ? { id: byId[d.merchant_id].id, business_name: byId[d.merchant_id].business_name, email: byId[d.merchant_id].email } : null,
      })),
    },
  };
}

async function resolve(ctx) {
  const dispute = await getOpen(ctx.params.id);
  const [updated] = await supabase.update('disputes', { id: dispute.id }, {
    status: 'resolved', admin_note: (ctx.body && ctx.body.note) || null, resolved_by: ctx.adminId, resolved_at: new Date().toISOString(),
  });
  return { status: 200, body: { dispute: updated } };
}

async function reject(ctx) {
  const dispute = await getOpen(ctx.params.id);
  const [updated] = await supabase.update('disputes', { id: dispute.id }, {
    status: 'rejected', admin_note: (ctx.body && ctx.body.note) || null, resolved_by: ctx.adminId, resolved_at: new Date().toISOString(),
  });
  return { status: 200, body: { dispute: updated } };
}

async function getOpen(id) {
  const dispute = await supabase.selectOne('disputes', { id });
  if (!dispute) throw httpError(404, 'NOT_FOUND', 'Litige introuvable.');
  if (dispute.status !== 'open') throw httpError(409, 'ALREADY_RESOLVED', 'Ce litige a déjà été traité.');
  return dispute;
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { list, resolve, reject };
