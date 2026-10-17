'use strict';
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const config = require('../config');
const { sanitize, fieldLabels, viewHtml } = require('../utils/contractHtml');
const { maskToPng } = require('../utils/png');
const { buildPdf, contentHash } = require('../services/contractPdf');
const mail = require('../services/contractMail');
const { clientIp } = require('../utils/rateLimit');

/**
 * Internal e-signature. An admin writes a contract, signs it and sends it to a merchant (who signs in the dashboard)
 * or to an outside partner (who signs through a private link). When the second signature arrives the contract is
 * COMPLETED, the PDF can be downloaded and both parties receive it by email.
 */
const STATUS = { PENDING: 'PENDING_SIGNATURE', DONE: 'COMPLETED', CANCELLED: 'CANCELLED' };
const FONTS = ['Dancing Script', 'Great Vibes', 'Caveat', 'Allura', 'Sacramento', 'Pacifico'];
const MAX_BODY = 150 * 1024;
const LIST_COLUMNS = 'id,title,status,merchant_id,recipient_name,recipient_email,admin_name,created_at,admin_signed_at,signed_at,viewed_at';

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const isEmail = (s) => typeof s === 'string' && /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(s.trim());
function ipOf(ctx) {
  const cf = ctx.req.headers['cf-connecting-ip'];
  return String(cf || clientIp(ctx.req) || 'inconnue').slice(0, 64);
}
const cleanText = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

/** A signature arrives as an 8-bit coverage mask drawn by the browser (typed or hand-drawn): checked, never trusted. */
function cleanSignature(sig) {
  if (!sig || typeof sig !== 'object') throw httpError(400, 'SIGNATURE_REQUIRED', 'La signature est obligatoire.');
  const type = sig.type === 'typed' ? 'typed' : sig.type === 'drawn' ? 'drawn' : null;
  if (!type) throw httpError(400, 'INVALID_SIGNATURE', 'Type de signature invalide.');
  const img = sig.image || {};
  const w = Number(img.w), h = Number(img.h);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 40 || w > 720 || h < 20 || h > 300) throw httpError(400, 'INVALID_SIGNATURE', 'Dimensions de signature invalides.');
  if (typeof img.alpha !== 'string' || img.alpha.length > 400000) throw httpError(400, 'INVALID_SIGNATURE', 'Image de signature invalide.');
  const alpha = Buffer.from(img.alpha, 'base64');
  if (alpha.length !== w * h) throw httpError(400, 'INVALID_SIGNATURE', 'Image de signature invalide.');
  let ink = 0;
  for (let i = 0; i < alpha.length; i++) if (alpha[i] > 40) ink++;
  if (ink < 60 || ink > alpha.length * 0.8) throw httpError(400, 'SIGNATURE_EMPTY', 'La signature est vide : dessinez-la ou tapez votre nom.');
  const out = { type, image: { w, h, alpha: alpha.toString('base64') } };
  if (type === 'typed') {
    out.name = cleanText(sig.name, 80);
    if (out.name.length < 2) throw httpError(400, 'SIGNATURE_EMPTY', 'Tapez votre nom pour la signature.');
    out.font = FONTS.includes(sig.font) ? sig.font : FONTS[0];
  }
  return out;
}
function signaturePng(sig) {
  if (!sig || !sig.image) return null;
  const png = maskToPng(sig.image.w, sig.image.h, Buffer.from(sig.image.alpha, 'base64'));
  return `data:image/png;base64,${png.toString('base64')}`;
}

function cleanContent(body) {
  const title = cleanText(body.title, 160);
  if (title.length < 3) throw httpError(400, 'MISSING_FIELDS', 'Le titre du contrat est requis (3 caractères minimum).');
  if (typeof body.body_html !== 'string' || body.body_html.length > MAX_BODY) throw httpError(400, 'INVALID_BODY', 'Le texte du contrat est trop long ou manquant.');
  const html = sanitize(body.body_html);
  if (html.replace(/<[^>]*>/g, '').trim().length < 20) throw httpError(400, 'INVALID_BODY', 'Le contrat est trop court : écrivez le texte du contrat.');
  return { title, html };
}

/** What a recipient sees: no token hash, no raw signature masks (pictures instead). */
function publicView(c, opts) {
  const labels = fieldLabels(c.body_html);
  return {
    id: c.id,
    title: c.title,
    status: c.status,
    body_html: viewHtml(c.body_html),
    field_labels: labels,
    fields: c.status === STATUS.DONE ? (c.fields || {}) : {},
    recipient_name: c.recipient_name,
    recipient_email: c.recipient_email,
    admin_name: c.admin_name,
    admin_signed_at: c.admin_signed_at,
    admin_signature_png: signaturePng(c.admin_signature),
    signed_at: c.signed_at || null,
    signer_name: c.signer_name || null,
    signer_signature_png: c.status === STATUS.DONE ? signaturePng(c.signer_signature) : null,
    created_at: c.created_at,
    ...(opts && opts.admin ? { merchant_id: c.merchant_id, admin_email: c.admin_email, signed_ip: c.signed_ip, admin_signed_ip: c.admin_signed_ip, content_hash: c.content_hash, viewed_at: c.viewed_at } : {}),
  };
}

function sendPdf(ctx, c, pdf) {
  const name = `contrat-${c.id}${c.status === STATUS.DONE ? '' : '-apercu'}.pdf`;
  ctx.res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': pdf.length,
    'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'private, no-store',
  });
  ctx.res.end(pdf);
}

/** Records the second signature. Only one caller can win the PENDING -> COMPLETED change, so a double click or two tabs sign once. */
async function completeContract(c, { fieldsIn, signerName, signature, ip, ua, email }) {
  if (c.status !== STATUS.PENDING) {
    throw httpError(409, 'NOT_PENDING', c.status === STATUS.DONE ? 'Ce contrat est déjà signé.' : 'Ce contrat n\'est plus disponible pour signature.');
  }
  const labels = fieldLabels(c.body_html);
  const fields = {};
  for (const label of labels) {
    const v = cleanText(fieldsIn && fieldsIn[label], 200);
    if (!v) throw httpError(400, 'FIELD_REQUIRED', `Veuillez remplir le champ « ${label} ».`);
    fields[label] = v;
  }
  const name = cleanText(signerName, 120);
  if (name.length < 2) throw httpError(400, 'MISSING_FIELDS', 'Entrez votre nom complet.');
  const sig = cleanSignature(signature);
  const signedAt = new Date().toISOString();
  const draft = Object.assign({}, c, { fields, signer_name: name, signer_email: email, signer_signature: sig, signed_at: signedAt, signed_ip: ip, signed_user_agent: cleanText(ua, 300), status: STATUS.DONE });
  draft.content_hash = contentHash(draft);
  const [won] = await supabase.update('contracts', { id: c.id, status: STATUS.PENDING }, {
    status: STATUS.DONE, fields, signer_name: name, signer_email: email, signer_signature: sig,
    signed_at: signedAt, signed_ip: ip, signed_user_agent: draft.signed_user_agent, content_hash: draft.content_hash, updated_at: signedAt,
  });
  if (!won) throw httpError(409, 'NOT_PENDING', 'Ce contrat vient d\'être signé ou annulé.');
  // The PDF and the emails are built after the signature is safely saved: a mail problem never undoes it.
  try {
    const pdf = await buildPdf(Object.assign({}, c, won));
    await mail.completed(Object.assign({}, c, won), pdf);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Contract completion email failed:', err.message);
  }
  return won;
}

// =============================================================== admin
async function adminList(ctx) {
  const filters = {};
  const q = ctx.query || {};
  if (['PENDING_SIGNATURE', 'COMPLETED', 'CANCELLED'].includes(q.status)) filters.status = q.status;
  if (q.merchant_id) filters.merchant_id = String(q.merchant_id).slice(0, 80);
  const rows = await supabase.select('contracts', filters, { select: LIST_COLUMNS, order: 'created_at.desc', limit: 200 });
  const ids = [...new Set(rows.map((r) => r.merchant_id).filter(Boolean))];
  const names = {};
  if (ids.length) {
    const ms = await supabase.select('merchants', { id: `in.(${ids.join(',')})` }, { select: 'id,business_name' });
    for (const m of ms) names[m.id] = m.business_name;
  }
  return { status: 200, body: { contracts: rows.map((r) => Object.assign({}, r, { merchant_name: r.merchant_id ? names[r.merchant_id] || null : null })) } };
}

async function adminGet(ctx) {
  const c = await supabase.selectOne('contracts', { id: ctx.params.id });
  if (!c) throw httpError(404, 'NOT_FOUND', 'Contrat introuvable.');
  return { status: 200, body: { contract: publicView(c, { admin: true }) } };
}

async function adminCreate(ctx) {
  const b = ctx.body || {};
  const { title, html } = cleanContent(b);
  const adminSig = cleanSignature(b.admin_signature);
  let recipientName, recipientEmail, merchantId = null;
  if (b.merchant_id) {
    const m = await supabase.selectOne('merchants', { id: String(b.merchant_id) });
    if (!m || m.deleted_at) throw httpError(404, 'MERCHANT_NOT_FOUND', 'Machann introuvable.');
    merchantId = m.id;
    recipientName = m.business_name || m.email;
    recipientEmail = m.email;
  } else {
    recipientName = cleanText(b.recipient_name, 120);
    recipientEmail = cleanText(b.recipient_email, 200).toLowerCase();
    if (recipientName.length < 2) throw httpError(400, 'MISSING_FIELDS', 'Le nom du destinataire est requis.');
    if (!isEmail(recipientEmail)) throw httpError(400, 'INVALID_EMAIL', "L'email du destinataire n'est pas valide.");
  }
  const admin = ctx.admin || {};
  const token = crypto.randomBytes(24).toString('hex');
  const now = new Date().toISOString();
  const row = await supabase.insert('contracts', {
    id: `ctr_${crypto.randomBytes(8).toString('hex')}`,
    title, body_html: html, merchant_id: merchantId,
    recipient_name: recipientName, recipient_email: recipientEmail, token_hash: sha256(token),
    status: STATUS.PENDING, created_by_admin_id: ctx.adminId || null,
    admin_name: cleanText(b.admin_name, 120) || admin.name || 'Freda Pay', admin_email: admin.email || config.brevo.senderEmail,
    admin_signature: adminSig, admin_signed_at: now, admin_signed_ip: ipOf(ctx), fields: {},
  });
  const url = merchantId ? mail.dashboardUrl() : mail.signUrl(token);
  const emailed = await mail.sent(row, url);
  return { status: 201, body: { contract: publicView(row, { admin: true }), emailed, sign_url: merchantId ? null : url } };
}

async function adminCancel(ctx) {
  const c = await supabase.selectOne('contracts', { id: ctx.params.id });
  if (!c) throw httpError(404, 'NOT_FOUND', 'Contrat introuvable.');
  const [done] = await supabase.update('contracts', { id: c.id, status: STATUS.PENDING }, { status: STATUS.CANCELLED, updated_at: new Date().toISOString() });
  if (!done) throw httpError(409, 'NOT_PENDING', 'Seul un contrat en attente de signature peut être annulé.');
  return { status: 200, body: { contract: publicView(done, { admin: true }) } };
}

/** A new private link (the old one stops working: only a hash of the token is stored) and the email again. */
async function adminResend(ctx) {
  const c = await supabase.selectOne('contracts', { id: ctx.params.id });
  if (!c) throw httpError(404, 'NOT_FOUND', 'Contrat introuvable.');
  if (c.status !== STATUS.PENDING) throw httpError(409, 'NOT_PENDING', 'Seul un contrat en attente de signature peut être renvoyé.');
  const token = crypto.randomBytes(24).toString('hex');
  await supabase.update('contracts', { id: c.id }, { token_hash: sha256(token), updated_at: new Date().toISOString() });
  const url = c.merchant_id ? mail.dashboardUrl() : mail.signUrl(token);
  const emailed = await mail.sent(c, url);
  return { status: 200, body: { emailed, sign_url: c.merchant_id ? null : url } };
}

async function adminPdf(ctx) {
  const c = await supabase.selectOne('contracts', { id: ctx.params.id });
  if (!c) throw httpError(404, 'NOT_FOUND', 'Contrat introuvable.');
  return sendPdf(ctx, c, await buildPdf(c));
}

// =============================================================== merchant (dashboard)
async function merchantContract(ctx) {
  const c = await supabase.selectOne('contracts', { id: ctx.params.id, merchant_id: ctx.merchantId });
  if (!c || c.status === STATUS.CANCELLED) throw httpError(404, 'NOT_FOUND', 'Contrat introuvable.');
  return c;
}

async function merchantList(ctx) {
  const rows = await supabase.select('contracts', { merchant_id: ctx.merchantId }, { select: LIST_COLUMNS, order: 'created_at.desc', limit: 100 });
  const visible = rows.filter((r) => r.status !== STATUS.CANCELLED);
  return { status: 200, body: { contracts: visible, pending: visible.filter((r) => r.status === STATUS.PENDING).length } };
}

async function merchantGet(ctx) {
  const c = await merchantContract(ctx);
  if (!c.viewed_at) await supabase.update('contracts', { id: c.id }, { viewed_at: new Date().toISOString() });
  return { status: 200, body: { contract: publicView(c) } };
}

async function merchantSign(ctx) {
  const { requireOwner } = require('../middleware/session');
  requireOwner(ctx);
  const c = await merchantContract(ctx);
  const b = ctx.body || {};
  const merchant = await supabase.selectOne('merchants', { id: ctx.merchantId });
  const won = await completeContract(c, {
    fieldsIn: b.fields, signerName: b.signer_name, signature: b.signature,
    ip: ipOf(ctx), ua: ctx.req.headers['user-agent'], email: (merchant && merchant.email) || c.recipient_email,
  });
  return { status: 200, body: { contract: publicView(won) } };
}

async function merchantPdf(ctx) {
  const c = await merchantContract(ctx);
  return sendPdf(ctx, c, await buildPdf(c));
}

// =============================================================== outside partner (private link)
async function byToken(ctx) {
  const token = String(ctx.params.token || '');
  if (!/^[a-f0-9]{48}$/.test(token)) throw httpError(404, 'NOT_FOUND', 'Lien invalide ou expiré.');
  const c = await supabase.selectOne('contracts', { token_hash: sha256(token) });
  if (!c || c.merchant_id || c.status === STATUS.CANCELLED) throw httpError(404, 'NOT_FOUND', 'Lien invalide ou expiré.');
  return c;
}

async function publicGet(ctx) {
  const c = await byToken(ctx);
  if (!c.viewed_at) await supabase.update('contracts', { id: c.id }, { viewed_at: new Date().toISOString() });
  return { status: 200, body: { contract: publicView(c) } };
}

async function publicSign(ctx) {
  const c = await byToken(ctx);
  const b = ctx.body || {};
  const won = await completeContract(c, {
    fieldsIn: b.fields, signerName: b.signer_name, signature: b.signature,
    ip: ipOf(ctx), ua: ctx.req.headers['user-agent'], email: c.recipient_email,
  });
  return { status: 200, body: { contract: publicView(won) } };
}

async function publicPdf(ctx) {
  const c = await byToken(ctx);
  if (c.status !== STATUS.DONE) throw httpError(409, 'NOT_COMPLETED', 'Le PDF est disponible une fois le contrat signé.');
  return sendPdf(ctx, c, await buildPdf(c));
}

module.exports = {
  adminList, adminGet, adminCreate, adminCancel, adminResend, adminPdf,
  merchantList, merchantGet, merchantSign, merchantPdf,
  publicGet, publicSign, publicPdf,
};
