'use strict';
const supabase = require('../lib/supabase');
const notify = require('../services/notify');

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

const MAX_DOWNLOAD = 15 * 1024 * 1024;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' };
const slug = (v) => String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'dossier';

/**
 * GET /admin/verifications/all?status=&kind=&q=&limit= : every KYC / KYB file ever submitted (pending, approved, refused), newest first,
 * with its documents (selfie, ID card...), to look at or download again later.
 */
async function listAll(ctx) {
  const q = ctx.query || {};
  const filters = {};
  if (['submitted', 'approved', 'rejected'].includes(q.status)) filters.status = q.status;
  if (['kyc', 'kyb'].includes(q.kind)) filters.kind = q.kind;
  const limit = Math.min(1000, Math.max(20, parseInt(q.limit || '300', 10) || 300));
  const rows = await supabase.select('verification_submissions', filters, { order: 'created_at.desc', limit: 2000 });
  const ids = [...new Set(rows.map((r) => r.merchant_id))];
  const merchants = ids.length ? await supabase.select('merchants', { id: supabase.inList(ids) }, { limit: 5000 }) : [];
  const by = new Map(merchants.map((m) => [m.id, m]));
  const needle = String(q.q || '').trim().toLowerCase().slice(0, 80);
  let list = rows.map((r) => { const m = by.get(r.merchant_id) || {}; return { id: r.id, kind: r.kind, status: r.status, created_at: r.created_at, reviewed_at: r.reviewed_at || null, rejection_reason: r.rejection_reason || null, documents: (r.documents || []).map((d) => ({ label: d.label, path: d.path })), merchant: { id: r.merchant_id, business_name: m.business_name || null, email: m.email || null, account_type: m.account_type || null } }; });
  if (needle) list = list.filter((x) => `${x.merchant.business_name || ''} ${x.merchant.email || ''} ${x.merchant.id} ${x.documents.map((d) => d.label).join(' ')}`.toLowerCase().includes(needle));
  return { status: 200, body: { total: list.length, submissions: list.slice(0, limit) } };
}

async function readDoc(submission, path) {
  const doc = (submission.documents || []).find((d) => d.path === path);
  if (!doc) throw httpError(404, 'NOT_FOUND', 'Document introuvable.');
  const url = await supabase.signedUrl('verification-documents', doc.path, 120);
  const res = await fetch(url);
  if (!res.ok) throw httpError(502, 'DOWNLOAD_FAILED', 'Le fichier est introuvable dans le stockage.');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD) throw httpError(413, 'FILE_TOO_LARGE', 'Fichier trop volumineux pour le téléchargement.');
  const type = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0];
  const rawExt = String(doc.path).includes('.') ? String(doc.path).split('.').pop().toLowerCase() : '';
  const ext = EXT[type] || (/^[a-z0-9]{1,5}$/.test(rawExt) ? rawExt : 'bin');
  return { doc, buf, type, ext };
}

/** GET /admin/verifications/:id/download?path= : one document as base64 (the admin page turns it into a file download). */
async function download(ctx) {
  const submission = await supabase.selectOne('verification_submissions', { id: ctx.params.id });
  if (!submission) throw httpError(404, 'NOT_FOUND', 'Soumission introuvable.');
  const merchant = await supabase.selectOne('merchants', { id: submission.merchant_id });
  const { doc, buf, type, ext } = await readDoc(submission, ctx.query && ctx.query.path);
  console.log(`KYC document downloaded by ${(ctx.admin && ctx.admin.email) || ctx.adminId}: ${submission.id} / ${doc.label}`); // eslint-disable-line no-console
  return { status: 200, body: { filename: `${slug(merchant && merchant.business_name)}-${submission.kind}-${slug(doc.label)}.${ext}`, content_type: type, base64: buf.toString('base64') } };
}

/** GET /admin/verifications/:id/zip : every document of the file (selfie, ID card...) in one ZIP. */
async function zip(ctx) {
  const submission = await supabase.selectOne('verification_submissions', { id: ctx.params.id });
  if (!submission) throw httpError(404, 'NOT_FOUND', 'Soumission introuvable.');
  const merchant = await supabase.selectOne('merchants', { id: submission.merchant_id });
  const files = []; let n = 0;
  for (const d of submission.documents || []) {
    const { buf, ext } = await readDoc(submission, d.path);
    n += 1;
    files.push({ name: `${String(n).padStart(2, '0')}-${slug(d.label)}.${ext}`, data: buf });
  }
  if (!files.length) throw httpError(404, 'NOT_FOUND', 'Aucun document dans ce dossier.');
  console.log(`KYC file downloaded (zip) by ${(ctx.admin && ctx.admin.email) || ctx.adminId}: ${submission.id}`); // eslint-disable-line no-console
  const buf = require('../utils/zip').build(files);
  return { status: 200, body: { filename: `${slug(merchant && merchant.business_name)}-${submission.kind}-${submission.id}.zip`, content_type: 'application/zip', base64: buf.toString('base64') } };
}

/** The approval itself (used by the admin and, when the team switched it on, by the AI agent). adminId = null for the agent. */
async function approveSubmission(submission, adminId) {
  const [updated] = await supabase.update('verification_submissions', { id: submission.id, status: 'submitted' }, {
    status: 'approved', reviewed_by: adminId || null, reviewed_at: new Date().toISOString(),
  });
  if (!updated) throw httpError(409, 'ALREADY_REVIEWED', 'Cette soumission a déjà été traitée.');
  await supabase.update('merchants', { id: submission.merchant_id }, { [`${submission.kind}_status`]: 'verified' });
  await maybeEnableLive(submission.merchant_id);
  require('../middleware/apiKey').clearAuthCache();
  const merchant = await supabase.selectOne('merchants', { id: submission.merchant_id });
  await notify.verificationApproved(merchant, submission.kind, { liveEnabled: !!(merchant && merchant.gateway_live_enabled) });
  return updated;
}

async function approve(ctx) {
  const submission = await getOwnedSubmission(ctx.params.id);
  const updated = await approveSubmission(submission, ctx.adminId);
  return { status: 200, body: { submission: toPublic(updated) } };
}

async function reject(ctx) {
  const submission = await getOwnedSubmission(ctx.params.id);
  const reason = (ctx.body && ctx.body.reason) || 'Documents insuffisants ou illisibles.';
  const [updated] = await supabase.update('verification_submissions', { id: submission.id }, {
    status: 'rejected', reviewed_by: ctx.adminId, reviewed_at: new Date().toISOString(), rejection_reason: reason,
  });
  await supabase.update('merchants', { id: submission.merchant_id }, { [`${submission.kind}_status`]: 'rejected' });
  await notify.verificationRejected(await supabase.selectOne('merchants', { id: submission.merchant_id }), submission.kind, reason);
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

module.exports = { listAll, download, zip, listPending, viewDocument, approve, reject, approveSubmission };
