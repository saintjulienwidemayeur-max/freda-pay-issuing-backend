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

const SIDES = ['FREDA', 'CLIENT'];
const MAX_SIGNERS = 8;
const signerTable = 'contract_signers';

async function loadSigners(contractId) {
  return supabase.select(signerTable, { contract_id: contractId }, { order: 'created_at.asc', limit: 50 });
}
async function withSigners(c) {
  c.signers = await loadSigners(c.id);
  return c;
}
/** Extra signers as {side,name,email}, checked: a valid side, a name, a valid and not-yet-used email. */
function cleanSignerInputs(list, taken) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw httpError(400, 'INVALID_SIGNERS', 'Liste de signataires invalide.');
  const seen = new Set(taken.map((e) => String(e).toLowerCase()));
  const out = [];
  for (const it of list) {
    const side = it && SIDES.includes(it.side) ? it.side : null;
    const name = cleanText(it && it.name, 120);
    const email = cleanText(it && it.email, 200).toLowerCase();
    if (!side) throw httpError(400, 'INVALID_SIGNERS', 'Choisissez le côté du signataire (Freda Pay ou partenaire).');
    if (name.length < 2) throw httpError(400, 'MISSING_FIELDS', 'Le nom du signataire est requis.');
    if (!isEmail(email)) throw httpError(400, 'INVALID_EMAIL', `L'email « ${email || '-'} » n'est pas valide.`);
    if (seen.has(email)) throw httpError(400, 'DUPLICATE_SIGNER', `${email} est déjà signataire de ce contrat.`);
    seen.add(email);
    out.push({ side, name, email });
  }
  return out;
}
function signerRow(contractId, input, adminId) {
  const token = crypto.randomBytes(24).toString('hex');
  return {
    token,
    row: { id: `sgn_${crypto.randomBytes(8).toString('hex')}`, contract_id: contractId, side: input.side, name: input.name, email: input.email, token_hash: sha256(token), status: 'PENDING', invited_by_admin_id: adminId || null },
  };
}
const progress = (c, signers) => {
  const list = signers || c.signers || [];
  return { total: 2 + list.length, done: 1 + (c.signed_at ? 1 : 0) + list.filter((s) => s.status === 'SIGNED').length };
};

/** What a recipient sees: no token hash, no raw signature masks (pictures instead). */
function publicView(c, opts) {
  const labels = fieldLabels(c.body_html);
  const signed = !!c.signed_at;
  const signers = (c.signers || []).map((s) => Object.assign(
    { id: s.id, side: s.side, name: s.name, status: s.status, signed_at: s.signed_at || null, signature_png: s.status === 'SIGNED' ? signaturePng(s.signature) : null },
    opts && opts.admin ? { email: s.email, signed_ip: s.signed_ip || null } : {},
  ));
  return {
    signers,
    progress: progress(c),
    id: c.id,
    title: c.title,
    status: c.status,
    body_html: viewHtml(c.body_html),
    field_labels: labels,
    fields: signed ? (c.fields || {}) : {},
    recipient_name: c.recipient_name,
    recipient_email: c.recipient_email,
    admin_name: c.admin_name,
    admin_signed_at: c.admin_signed_at,
    admin_signature_png: signaturePng(c.admin_signature),
    signed_at: c.signed_at || null,
    signer_name: c.signer_name || null,
    signer_signature_png: signed ? signaturePng(c.signer_signature) : null,
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

/** When the main recipient and every extra signer have signed, the contract is sealed: one caller wins PENDING -> COMPLETED. */
async function finalize(contractId) {
  const c = await withSigners(await supabase.selectOne('contracts', { id: contractId }));
  if (c.status !== STATUS.PENDING || !c.signed_at) return c;
  const waiting = c.signers.filter((s) => s.status !== 'SIGNED');
  if (waiting.length) {
    return c;
  }
  const hash = contentHash(Object.assign({}, c, { status: STATUS.DONE }));
  const [won] = await supabase.update('contracts', { id: c.id, status: STATUS.PENDING }, { status: STATUS.DONE, content_hash: hash, updated_at: new Date().toISOString() });
  if (!won) return c;
  const full = Object.assign({}, c, won, { signers: c.signers });
  // The PDF and the emails are built after the signatures are safely saved: a mail problem never undoes them.
  try {
    await mail.completed(full, await buildPdf(full));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Contract completion email failed:', err.message);
  }
  return full;
}

/** Records the main recipient's signature (and the blanks they filled). A double click or two tabs sign once. */
async function completeContract(c, { fieldsIn, signerName, signature, ip, ua, email }) {
  if (c.status !== STATUS.PENDING) {
    throw httpError(409, 'NOT_PENDING', c.status === STATUS.DONE ? 'Ce contrat est déjà signé.' : 'Ce contrat n\'est plus disponible pour signature.');
  }
  if (c.signed_at) throw httpError(409, 'ALREADY_SIGNED', 'Vous avez déjà signé ce contrat.');
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
  const [won] = await supabase.update('contracts', { id: c.id, status: STATUS.PENDING, signed_at: 'is.null' }, {
    fields, signer_name: name, signer_email: email, signer_signature: sig,
    signed_at: signedAt, signed_ip: ip, signed_user_agent: cleanText(ua, 300), updated_at: signedAt,
  });
  if (!won) throw httpError(409, 'NOT_PENDING', 'Ce contrat vient d\'être signé ou annulé.');
  const after = await finalize(c.id);
  if (after.status !== STATUS.DONE) {
    // Others still have to sign: invite them now that the text and the blanks are final.
    for (const s of after.signers) if (s.status !== 'SIGNED') await resendInvite(after, s);
  }
  return after;
}

/** An extra signer signs once the main recipient has (the text and the blanks are then final). */
async function signerSign(c, s, { signerName, signature, ip, ua }) {
  if (c.status !== STATUS.PENDING) throw httpError(409, 'NOT_PENDING', c.status === STATUS.DONE ? 'Ce contrat est déjà signé.' : 'Ce contrat n\'est plus disponible pour signature.');
  if (!c.signed_at) throw httpError(409, 'WAITING', `Ce contrat sera prêt à signer dès que ${c.recipient_name} l'aura signé. Vous recevrez un email.`);
  if (s.status === 'SIGNED') throw httpError(409, 'ALREADY_SIGNED', 'Vous avez déjà signé ce contrat.');
  const name = cleanText(signerName, 120) || s.name;
  const sig = cleanSignature(signature);
  const [won] = await supabase.update(signerTable, { id: s.id, status: 'PENDING' }, {
    status: 'SIGNED', name, signature: sig, signed_at: new Date().toISOString(), signed_ip: ip, signed_user_agent: cleanText(ua, 300),
  });
  if (!won) throw httpError(409, 'ALREADY_SIGNED', 'Vous avez déjà signé ce contrat.');
  return finalize(c.id);
}

/**
 * Emails a signer. Until the main recipient has signed the contract is not ready, so the email is only a heads-up with no
 * link; once it is ready the signer gets a fresh private link (the previous one, if any, stops working).
 */
async function resendInvite(c, s) {
  if (!c.signed_at) return { emailed: await mail.invited(c, s, null), sign_url: null };
  const token = crypto.randomBytes(24).toString('hex');
  await supabase.update(signerTable, { id: s.id }, { token_hash: sha256(token) });
  const url = mail.signUrl(token);
  return { emailed: await mail.invited(c, s, url), sign_url: url };
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
  const extras = {};
  if (rows.length) {
    const sg = await supabase.select(signerTable, { contract_id: `in.(${rows.map((r) => r.id).join(',')})` }, { select: 'contract_id,status', limit: 1000 });
    for (const x of sg) (extras[x.contract_id] = extras[x.contract_id] || []).push(x);
  }
  return { status: 200, body: { contracts: rows.map((r) => Object.assign({}, r, { merchant_name: r.merchant_id ? names[r.merchant_id] || null : null, progress: progress(r, extras[r.id] || []) })) } };
}

async function adminGet(ctx) {
  const c = await supabase.selectOne('contracts', { id: ctx.params.id });
  if (!c) throw httpError(404, 'NOT_FOUND', 'Contrat introuvable.');
  await withSigners(c);
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
  const extraIn = cleanSignerInputs(b.signers, [recipientEmail, (ctx.admin && ctx.admin.email) || '']);
  if (extraIn.length > MAX_SIGNERS) throw httpError(400, 'TOO_MANY_SIGNERS', `Maximum ${MAX_SIGNERS} signataires supplémentaires.`);
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
  // Extra signers are saved now and get a heads-up; their private link is sent once the main recipient has signed.
  row.signers = [];
  const invites = [];
  for (const input of extraIn) {
    const { row: sr } = signerRow(row.id, input, ctx.adminId);
    const saved = await supabase.insert(signerTable, sr);
    row.signers.push(saved);
    invites.push({ id: saved.id, email: saved.email, emailed: (await resendInvite(row, saved)).emailed });
  }
  return { status: 201, body: { contract: publicView(row, { admin: true }), emailed, sign_url: merchantId ? null : url, invites } };
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
  await withSigners(c);
  return sendPdf(ctx, c, await buildPdf(c));
}

async function adminAddSigner(ctx) {
  const c = await supabase.selectOne('contracts', { id: ctx.params.id });
  if (!c) throw httpError(404, 'NOT_FOUND', 'Contrat introuvable.');
  if (c.status !== STATUS.PENDING) throw httpError(409, 'NOT_PENDING', 'On ne peut inviter un signataire que sur un contrat en attente de signature.');
  await withSigners(c);
  if (c.signers.length >= MAX_SIGNERS) throw httpError(400, 'TOO_MANY_SIGNERS', `Maximum ${MAX_SIGNERS} signataires supplémentaires.`);
  const taken = [c.recipient_email, c.admin_email].concat(c.signers.map((x) => x.email));
  const [input] = cleanSignerInputs([ctx.body || {}], taken);
  const { row } = signerRow(c.id, input, ctx.adminId);
  const saved = await supabase.insert(signerTable, row);
  c.signers.push(saved);
  const sent = await resendInvite(c, saved);
  return { status: 201, body: { contract: publicView(c, { admin: true }), emailed: sent.emailed, sign_url: sent.sign_url } };
}

async function signerOf(ctx) {
  const c = await supabase.selectOne('contracts', { id: ctx.params.id });
  const s = c && await supabase.selectOne(signerTable, { id: ctx.params.sid, contract_id: c.id });
  if (!c || !s) throw httpError(404, 'NOT_FOUND', 'Signataire introuvable.');
  if (c.status !== STATUS.PENDING) throw httpError(409, 'NOT_PENDING', 'Ce contrat n\'est plus en attente de signature.');
  return { c, s };
}

async function adminResendSigner(ctx) {
  const { c, s } = await signerOf(ctx);
  if (s.status === 'SIGNED') throw httpError(409, 'ALREADY_SIGNED', 'Ce signataire a déjà signé.');
  const sent = await resendInvite(c, s);
  return { status: 200, body: { emailed: sent.emailed, sign_url: sent.sign_url } };
}

async function adminRemoveSigner(ctx) {
  const { c, s } = await signerOf(ctx);
  if (s.status === 'SIGNED') throw httpError(409, 'ALREADY_SIGNED', 'Ce signataire a déjà signé : il ne peut plus être retiré.');
  await supabase.delete(signerTable, { id: s.id });
  // Removing the last person who had not signed completes the contract.
  const after = await finalize(c.id);
  return { status: 200, body: { contract: publicView(after, { admin: true }) } };
}

// =============================================================== merchant (dashboard)
async function merchantContract(ctx) {
  const c = await supabase.selectOne('contracts', { id: ctx.params.id, merchant_id: ctx.merchantId });
  if (!c || c.status === STATUS.CANCELLED) throw httpError(404, 'NOT_FOUND', 'Contrat introuvable.');
  return withSigners(c);
}

async function merchantList(ctx) {
  const rows = await supabase.select('contracts', { merchant_id: ctx.merchantId }, { select: LIST_COLUMNS, order: 'created_at.desc', limit: 100 });
  const visible = rows.filter((r) => r.status !== STATUS.CANCELLED);
  return { status: 200, body: { contracts: visible, pending: visible.filter((r) => r.status === STATUS.PENDING && !r.signed_at).length } };
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
  const after = await completeContract(c, {
    fieldsIn: b.fields, signerName: b.signer_name, signature: b.signature,
    ip: ipOf(ctx), ua: ctx.req.headers['user-agent'], email: (merchant && merchant.email) || c.recipient_email,
  });
  return { status: 200, body: { contract: publicView(after) } };
}

async function merchantPdf(ctx) {
  const c = await merchantContract(ctx);
  return sendPdf(ctx, c, await buildPdf(c));
}

// =============================================================== private link (outside partner or extra signer)
/** The link belongs either to the main recipient of an outside-partner contract, or to an extra signer. */
async function byToken(ctx) {
  const token = String(ctx.params.token || '');
  const bad = () => httpError(404, 'NOT_FOUND', 'Lien invalide ou expiré.');
  if (!/^[a-f0-9]{48}$/.test(token)) throw bad();
  const hash = sha256(token);
  const main = await supabase.selectOne('contracts', { token_hash: hash });
  if (main) {
    if (main.merchant_id || main.status === STATUS.CANCELLED) throw bad();
    return { c: await withSigners(main), signer: null };
  }
  const signer = await supabase.selectOne(signerTable, { token_hash: hash });
  if (!signer) throw bad();
  const c = await supabase.selectOne('contracts', { id: signer.contract_id });
  if (!c || c.status === STATUS.CANCELLED) throw bad();
  return { c: await withSigners(c), signer };
}

/** The contract as one link holder sees it, with who they are and whether it is their turn. */
function linkView(c, signer) {
  const view = publicView(c);
  view.viewer = signer
    ? { role: 'signer', name: signer.name, side: signer.side, signed: signer.status === 'SIGNED', can_sign: c.status === STATUS.PENDING && !!c.signed_at && signer.status !== 'SIGNED' }
    : { role: 'recipient', name: c.recipient_name, side: 'CLIENT', signed: !!c.signed_at, can_sign: c.status === STATUS.PENDING && !c.signed_at };
  return view;
}

async function publicGet(ctx) {
  const { c, signer } = await byToken(ctx);
  if (!signer && !c.viewed_at) await supabase.update('contracts', { id: c.id }, { viewed_at: new Date().toISOString() });
  return { status: 200, body: { contract: linkView(c, signer) } };
}

async function publicSign(ctx) {
  const { c, signer } = await byToken(ctx);
  const b = ctx.body || {};
  const opts = { signerName: b.signer_name, signature: b.signature, ip: ipOf(ctx), ua: ctx.req.headers['user-agent'] };
  const after = signer
    ? await signerSign(c, signer, opts)
    : await completeContract(c, Object.assign(opts, { fieldsIn: b.fields, email: c.recipient_email }));
  const { signer: fresh } = signer ? { signer: await supabase.selectOne(signerTable, { id: signer.id }) } : { signer: null };
  return { status: 200, body: { contract: linkView(after, fresh) } };
}

async function publicPdf(ctx) {
  const { c } = await byToken(ctx);
  if (c.status !== STATUS.DONE) throw httpError(409, 'NOT_COMPLETED', 'Le PDF est disponible une fois le contrat signé par toutes les parties.');
  return sendPdf(ctx, c, await buildPdf(c));
}

module.exports = {
  adminList, adminGet, adminCreate, adminCancel, adminResend, adminPdf, adminAddSigner, adminResendSigner, adminRemoveSigner,
  merchantList, merchantGet, merchantSign, merchantPdf,
  publicGet, publicSign, publicPdf,
};
