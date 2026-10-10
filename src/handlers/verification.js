'use strict';
const supabase = require('../lib/supabase');
const { randomHex } = require('../utils/ids');

const MAX_DOC_BYTES = 8 * 1024 * 1024; // ~6 MB after base64 overhead, matches the receipt-upload limit

/**
 * Merchant submits KYC or KYB documents for review. Replaces what used to be
 * a purely client-side checkbox (kycSubmitted/kybSubmitted JS variables that
 * were never sent to the server) - this is the real submission.
 *
 * Body: { documents: [{ label, filename, content_type, base64 }] }
 */
async function submit(ctx) {
  const kind = ctx.params.kind;
  if (kind !== 'kyc' && kind !== 'kyb') {
    throw httpError(404, 'NOT_FOUND', 'Type de vérification inconnu.');
  }

  const merchant = await supabase.selectOne('merchants', { id: ctx.merchantId });
  if (!merchant) throw httpError(404, 'NOT_FOUND', 'Marchand introuvable.');
  if (kind === 'kyb' && merchant.account_type !== 'business') {
    throw httpError(400, 'KYB_NOT_APPLICABLE', "Le KYB ne s'applique pas à un compte particulier.");
  }

  const docs = (ctx.body && ctx.body.documents) || [];
  if (!Array.isArray(docs) || docs.length === 0) {
    throw httpError(400, 'MISSING_DOCUMENTS', 'Au moins un document est requis.');
  }

  const uploaded = [];
  for (const doc of docs) {
    if (!doc || !doc.base64 || !doc.label) {
      throw httpError(400, 'INVALID_DOCUMENT', 'Chaque document doit avoir un label et un contenu.');
    }
    if (doc.base64.length > MAX_DOC_BYTES) {
      throw httpError(400, 'DOCUMENT_TOO_LARGE', `Le document "${doc.label}" est trop volumineux (max ~6 Mo).`);
    }
    const buffer = Buffer.from(doc.base64, 'base64');
    const ext = (doc.filename && doc.filename.includes('.')) ? doc.filename.split('.').pop() : 'bin';
    const path = `${ctx.merchantId}/${kind}/${randomHex(8)}.${ext}`;
    await supabase.uploadFile('verification-documents', path, buffer, doc.content_type || 'application/octet-stream');
    uploaded.push({ label: doc.label, path });
  }

  const submission = await supabase.insert('verification_submissions', {
    id: `vs_${randomHex(8)}`,
    merchant_id: ctx.merchantId,
    kind,
    documents: uploaded,
    status: 'submitted',
  });

  await supabase.update('merchants', { id: ctx.merchantId }, { [`${kind}_status`]: 'submitted' });

  return { status: 201, body: { submission_id: submission.id, status: 'submitted' } };
}

/** Merchant's own submission history, so the dashboard can show "en cours de revue" vs "rejeté : <raison>". */
async function mine(ctx) {
  const rows = await supabase.select('verification_submissions', { merchant_id: ctx.merchantId }, { order: 'created_at.desc' });
  return {
    status: 200,
    body: {
      submissions: rows.map((r) => ({
        id: r.id, kind: r.kind, status: r.status, rejection_reason: r.rejection_reason, created_at: r.created_at, reviewed_at: r.reviewed_at,
      })),
    },
  };
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { submit, mine };
