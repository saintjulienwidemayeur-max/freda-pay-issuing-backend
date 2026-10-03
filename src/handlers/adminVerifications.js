'use strict';
const supabase = require('../lib/supabase');

/** All submissions awaiting review, newest first, with the merchant's business name attached. */
async function listPending(ctx) {
  const rows = await supabase.select('verification_submissions', { status: 'submitted' }, { order: 'created_at.asc' });
  const merchantIds = [...new Set(rows.map((r) => r.merchant_id))];
  const merchants = await Promise.all(merchantIds.map((id) => supabase.selectOne('merchants', { id })));
  const byId = Object.fromEntries(merchants.filter(Boolean).map((m) => [m.id, m]));

  return {
    status: 200,
    body: {
      submissions: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        documents: r.documents,
        created_at: r.created_at,
        merchant: byId[r.merchant_id]
          ? { id: byId[r.merchant_id].id, business_name: byId[r.merchant_id].business_name, email: byId[r.merchant_id].email, account_type: byId[r.merchant_id].account_type }
          : null,
      })),
    },
  };
}

/** A signed, short-lived-in-spirit (actually just service-role-proxied) URL to view one document. Kept server-side only - never give the client the service role key. */
async function viewDocument(ctx) {
  const submission = await supabase.selectOne('verification_submissions', { id: ctx.params.id });
  if (!submission) throw httpError(404, 'NOT_FOUND', 'Soumission introuvable.');
  const doc = (submission.documents || []).find((d) => d.path === ctx.query.path);
  if (!doc) throw httpError(404, 'NOT_FOUND', 'Document introuvable.');
  const url = await supabase.signedUrl('verification-documents', doc.path, 300);
  return { status: 200, body: { url } };
}

async function approve(ctx) {
  const submission = await getOwnedSubmission(ctx.params.id);
  const [updated] = await supabase.update('verification_submissions', { id: submission.id }, {
    status: 'approved', reviewed_by: ctx.adminId, reviewed_at: new Date().toISOString(),
  });
  await supabase.update('merchants', { id: submission.merchant_id }, { [`${submission.kind}_status`]: 'verified' });
  await maybeEnableLive(submission.merchant_id);
  return { status: 200, body: { submission: toPublic(updated) } };
}

async function reject(ctx) {
  const submission = await getOwnedSubmission(ctx.params.id);
  const reason = (ctx.body && ctx.body.reason) || 'Documents insuffisants ou illisibles.';
  const [updated] = await supabase.update('verification_submissions', { id: submission.id }, {
    status: 'rejected', reviewed_by: ctx.adminId, reviewed_at: new Date().toISOString(), rejection_reason: reason,
  });
  await supabase.update('merchants', { id: submission.merchant_id }, { [`${submission.kind}_status`]: 'rejected' });
  return { status: 200, body: { submission: toPublic(updated) } };
}

async function getOwnedSubmission(id) {
  const submission = await supabase.selectOne('verification_submissions', { id });
  if (!submission) throw httpError(404, 'NOT_FOUND', 'Soumission introuvable.');
  if (submission.status !== 'submitted') throw httpError(409, 'ALREADY_REVIEWED', 'Cette soumission a déjà été traitée.');
  return submission;
}

/**
 * KYC/KYB approval turns on Gateway Live mode only - Gateway is self-serve
 * once identity is verified. Issuing Live is NEVER auto-granted here, even
 * for a fully-verified merchant: it always needs its own separate request,
 * reviewed independently (see issuingAccess.js).
 */
async function maybeEnableLive(merchantId) {
  const merchant = await supabase.selectOne('merchants', { id: merchantId });
  if (!merchant) return;
  const kybOk = merchant.account_type !== 'business' || merchant.kyb_status === 'verified';
  if (merchant.kyc_status === 'verified' && kybOk && !merchant.gateway_live_enabled) {
    await supabase.update('merchants', { id: merchantId }, { gateway_live_enabled: true, live_enabled: true });
  }
}

function toPublic(s) {
  return { id: s.id, kind: s.kind, status: s.status, rejection_reason: s.rejection_reason, reviewed_at: s.reviewed_at };
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { listPending, viewDocument, approve, reject };
