'use strict';
const crypto = require('crypto');
const { PDFDocument, StandardFonts, rgb } = require('../vendor/pdf-lib.min.js');
const { toBlocks } = require('../utils/contractHtml');
const { maskToPng } = require('../utils/png');

/**
 * Builds the signed contract as a PDF, entirely inside this server (no outside service): the contract text, both
 * signatures and an audit trail. Fonts are the 14 standard PDF fonts, so nothing has to be embedded or downloaded.
 */
const PAGE = { w: 595.28, h: 841.89 };
const MARGIN = { l: 58, r: 58, t: 62, b: 70 };
const INK = rgb(0.09, 0.09, 0.1);
const MUTED = rgb(0.4, 0.4, 0.45);
const PINK = rgb(1, 0.25, 0.5);
const LINE = rgb(0.85, 0.83, 0.87);
const SIZES = { p: 10.5, li: 10.5, blockquote: 10.5, h1: 19, h2: 14.5, h3: 12 };
const FALLBACK_CHARS = { '≈': '~', '→': '->', '←': '<-', '✓': 'v', '✔': 'v', '’': "'", '‘': "'", '“': '"', '”': '"', ' ': ' ', ' ': ' ', '​': '', '﻿': '' };

function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

/** The fingerprint of what was signed: text, filled blanks and both signatures. Changing any of them changes it. */
function contentHash(c) {
  const sigFp = (s) => (s ? crypto.createHash('sha256').update(JSON.stringify(s)).digest('hex') : null);
  const payload = JSON.stringify({
    id: c.id, title: c.title, body_html: c.body_html, fields: c.fields || {},
    admin: { name: c.admin_name, email: c.admin_email, signed_at: c.admin_signed_at, signature: sigFp(c.admin_signature) },
    signer: { name: c.signer_name, email: c.signer_email, signed_at: c.signed_at, signature: sigFp(c.signer_signature) },
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

async function buildPdf(c) {
  const doc = await PDFDocument.create();
  const f = {
    r: await doc.embedFont(StandardFonts.Helvetica),
    b: await doc.embedFont(StandardFonts.HelveticaBold),
    i: await doc.embedFont(StandardFonts.HelveticaOblique),
    bi: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    m: await doc.embedFont(StandardFonts.Courier),
  };
  const charset = new Set(f.r.getCharacterSet());
  const safe = (s) => {
    let out = '';
    for (const ch of String(s)) {
      const cp = ch.codePointAt(0);
      if (FALLBACK_CHARS[ch] !== undefined) out += FALLBACK_CHARS[ch];
      else if (cp === 9 || cp === 10 || cp === 13) out += ' ';
      else if (charset.has(cp)) out += ch;
      else out += '?';
    }
    return out;
  };
  doc.setTitle(safe(c.title));
  doc.setAuthor('Freda Pay');
  doc.setProducer('Freda Pay e-signature');
  doc.setCreator('Freda Pay');
  const when = new Date(c.signed_at || c.admin_signed_at || Date.now());
  doc.setCreationDate(when); doc.setModificationDate(when);

  const pages = [];
  let page = null, y = 0;
  const contentW = PAGE.w - MARGIN.l - MARGIN.r;
  const newPage = () => { page = doc.addPage([PAGE.w, PAGE.h]); pages.push(page); y = PAGE.h - MARGIN.t; };
  const ensure = (h) => { if (y - h < MARGIN.b) newPage(); };
  const pickFont = (b, i) => (b && i ? f.bi : b ? f.b : i ? f.i : f.r);
  newPage();

  // ---- title block
  page.drawRectangle({ x: 0, y: PAGE.h - 8, width: PAGE.w, height: 8, color: PINK });
  page.drawText('FREDA PAY', { x: MARGIN.l, y: y + 14, size: 10, font: f.b, color: INK });
  page.drawText('ISSUING', { x: MARGIN.l + f.b.widthOfTextAtSize('FREDA PAY', 10) + 5, y: y + 14, size: 10, font: f.b, color: PINK });
  const status = c.status === 'COMPLETED' ? 'Document signé' : c.status === 'CANCELLED' ? 'Document annulé' : 'En attente de signature';
  const sw = f.r.widthOfTextAtSize(status, 9);
  page.drawText(status, { x: PAGE.w - MARGIN.r - sw, y: y + 14, size: 9, font: f.r, color: MUTED });
  y -= 14;

  // ---- text layout
  const drawLine = (items, size, align, last, lineH, x0, width) => {
    const total = items.reduce((s, it) => s + it.w, 0);
    let x = x0;
    let extra = 0;
    const gaps = items.filter((it) => it.space).length;
    if (align === 'center') x = x0 + (width - total) / 2;
    else if (align === 'right') x = x0 + width - total;
    else if (align === 'justify' && !last && gaps > 0) extra = (width - total) / gaps;
    for (const it of items) {
      if (!it.space && it.text) {
        page.drawText(it.text, { x, y: y - size, size, font: it.font, color: INK });
        if (it.u) page.drawLine({ start: { x, y: y - size - 1.6 }, end: { x: x + it.w, y: y - size - 1.6 }, thickness: 0.6, color: INK });
      }
      x += it.w + (it.space ? extra : 0);
    }
  };
  const layoutBlock = (blk) => {
    if (blk.kind === 'space') { ensure(8); y -= 8; return; }
    if (blk.kind === 'hr') { ensure(14); y -= 6; page.drawLine({ start: { x: MARGIN.l, y }, end: { x: PAGE.w - MARGIN.r, y }, thickness: 0.7, color: LINE }); y -= 8; return; }
    const size = SIZES[blk.kind] || 10.5;
    const heading = blk.kind === 'h1' || blk.kind === 'h2' || blk.kind === 'h3';
    const lineH = size * 1.38;
    const indent = blk.kind === 'li' ? 16 * blk.indent : blk.kind === 'blockquote' ? 20 : 0;
    const x0 = MARGIN.l + indent;
    const width = contentW - indent;
    // words
    const words = [];
    for (const r of blk.runs) {
      if (r.br) { words.push({ br: true }); continue; }
      let text = r.text;
      if (r.field !== undefined && !text) text = '………………';
      const font = pickFont(heading || r.b, r.i || blk.kind === 'blockquote');
      for (const part of safe(text).split(/(\s+)/)) {
        if (part === '') continue;
        if (/^\s+$/.test(part)) words.push({ space: true, text: ' ', font, w: font.widthOfTextAtSize(' ', size), u: false });
        else words.push({ text: part, font, w: font.widthOfTextAtSize(part, size), u: !!r.u });
      }
    }
    if (heading && blk.kind !== 'h3') { ensure(size * 2.4); y -= size * 0.5; }
    else if (blk.kind === 'h3') { ensure(size * 2); y -= size * 0.3; }
    const lines = [];
    let line = [], lw = 0;
    const pushLine = (hard) => { while (line.length && line[line.length - 1].space) { lw -= line[line.length - 1].w; line.pop(); } lines.push({ items: line, hard }); line = []; lw = 0; };
    for (const w of words) {
      if (w.br) { pushLine(true); continue; }
      if (w.space && !line.length) continue;
      if (!w.space && line.length && lw + w.w > width) pushLine(false);
      if (!w.space && w.w > width) { // a word wider than the line: cut it
        let rest = w.text;
        while (rest.length) {
          let n = rest.length;
          while (n > 1 && w.font.widthOfTextAtSize(rest.slice(0, n), size) > width) n--;
          const piece = rest.slice(0, n); rest = rest.slice(n);
          line.push({ text: piece, font: w.font, w: w.font.widthOfTextAtSize(piece, size), u: w.u }); lw += line[line.length - 1].w;
          if (rest.length) pushLine(false);
        }
        continue;
      }
      line.push(w); lw += w.w;
    }
    if (line.length) pushLine(true);
    if (!lines.length) lines.push({ items: [], hard: true });
    lines.forEach((ln, idx) => {
      ensure(lineH);
      if (idx === 0 && blk.kind === 'li') page.drawText(blk.prefix, { x: x0 - 13, y: y - size, size, font: f.r, color: INK });
      if (ln.items.length) drawLine(ln.items, size, blk.align || 'left', ln.hard || idx === lines.length - 1, lineH, x0, width);
      y -= lineH;
    });
    y -= blk.kind === 'li' ? 2.5 : heading ? size * 0.35 : 5;
  };

  // document title, then the contract text
  const titleSize = 21;
  const titleWords = safe(c.title).split(' ');
  let tl = '', tlines = [];
  for (const w of titleWords) {
    const t = tl ? `${tl} ${w}` : w;
    if (f.b.widthOfTextAtSize(t, titleSize) > contentW && tl) { tlines.push(tl); tl = w; } else tl = t;
  }
  if (tl) tlines.push(tl);
  for (const t of tlines) { page.drawText(t, { x: MARGIN.l, y: y - titleSize, size: titleSize, font: f.b, color: INK }); y -= titleSize * 1.25; }
  page.drawText(safe(`Contrat n° ${c.id}`), { x: MARGIN.l, y: y - 11, size: 9, font: f.r, color: MUTED });
  y -= 26;
  page.drawLine({ start: { x: MARGIN.l, y: y + 8 }, end: { x: PAGE.w - MARGIN.r, y: y + 8 }, thickness: 0.7, color: LINE });
  y -= 6;
  for (const blk of toBlocks(c.body_html, c.fields || {})) layoutBlock(blk);

  // ---- signatures
  ensure(250);
  y -= 14;
  page.drawText('Signatures', { x: MARGIN.l, y: y - 13, size: 13, font: f.b, color: INK });
  y -= 30;
  const colW = (contentW - 24) / 2;
  const sigBlock = async (x, label, name, email, signedAt, sig, pending) => {
    page.drawText(safe(label), { x, y: y - 9, size: 9, font: f.b, color: MUTED });
    const boxTop = y - 16, boxH = 74;
    page.drawRectangle({ x, y: boxTop - boxH, width: colW, height: boxH, borderColor: LINE, borderWidth: 0.8, color: rgb(0.995, 0.995, 0.995) });
    if (sig && sig.image) {
      const png = maskToPng(sig.image.w, sig.image.h, Buffer.from(sig.image.alpha, 'base64'));
      const img = await doc.embedPng(png);
      const scale = Math.min((colW - 16) / sig.image.w, (boxH - 12) / sig.image.h);
      const dw = sig.image.w * scale, dh = sig.image.h * scale;
      page.drawImage(img, { x: x + (colW - dw) / 2, y: boxTop - boxH + (boxH - dh) / 2, width: dw, height: dh });
    } else {
      const t = pending ? 'En attente de signature' : '';
      page.drawText(t, { x: x + 10, y: boxTop - boxH / 2 - 3, size: 9, font: f.i, color: MUTED });
    }
    let ty = boxTop - boxH - 14;
    page.drawText(safe(name || ''), { x, y: ty, size: 10.5, font: f.b, color: INK }); ty -= 13;
    if (email) { page.drawText(safe(email), { x, y: ty, size: 9, font: f.r, color: MUTED }); ty -= 12; }
    if (signedAt) { page.drawText(`Signé le ${fmtDate(signedAt)}`, { x, y: ty, size: 8.5, font: f.r, color: MUTED }); ty -= 12; }
    if (sig) { page.drawText(sig.type === 'typed' ? 'Signature saisie au clavier' : 'Signature dessinée à la main', { x, y: ty, size: 8, font: f.i, color: MUTED }); }
  };
  await sigBlock(MARGIN.l, 'POUR FREDA PAY', c.admin_name, c.admin_email, c.admin_signed_at, c.admin_signature, false);
  await sigBlock(MARGIN.l + colW + 24, 'LE SIGNATAIRE', c.signer_name || c.recipient_name, c.signer_email || c.recipient_email, c.signed_at, c.signer_signature, !c.signer_signature);
  y -= 16 + 74 + 14 + 13 + 12 + 12 + 12 + 14;

  // ---- audit trail
  const rows = [
    ['Document', c.id],
    ['Statut', status],
    ['Empreinte SHA-256', c.content_hash || '(calculée à la signature)'],
    ['Freda Pay', `${c.admin_name} <${c.admin_email}>`],
    ['  signé le', `${fmtDate(c.admin_signed_at)}   IP ${c.admin_signed_ip || '-'}`],
    ['Signataire', `${c.signer_name || c.recipient_name} <${c.signer_email || c.recipient_email}>`],
    ['  signé le', c.signed_at ? `${fmtDate(c.signed_at)}   IP ${c.signed_ip || '-'}` : '-'],
    ['  appareil', c.signed_user_agent ? String(c.signed_user_agent).slice(0, 80) : '-'],
  ];
  const auditH = 36 + rows.length * 12.5 + (c.content_hash ? 12.5 : 0);
  ensure(auditH + 10);
  const top = y;
  page.drawRectangle({ x: MARGIN.l, y: top - auditH, width: contentW, height: auditH, color: rgb(0.965, 0.96, 0.97), borderColor: LINE, borderWidth: 0.6 });
  page.drawText("Journal d'audit (piste de vérification)", { x: MARGIN.l + 12, y: top - 17, size: 9.5, font: f.b, color: INK });
  let ay = top - 33;
  for (const [k, v] of rows) {
    page.drawText(safe(k), { x: MARGIN.l + 12, y: ay, size: 7.5, font: f.b, color: MUTED });
    const text = safe(v);
    if (k === 'Empreinte SHA-256' && text.length > 48) {
      page.drawText(text.slice(0, 64), { x: MARGIN.l + 112, y: ay, size: 7.5, font: f.m, color: INK });
    } else {
      page.drawText(text, { x: MARGIN.l + 112, y: ay, size: 7.5, font: f.m, color: INK, maxWidth: contentW - 124 });
    }
    ay -= 12.5;
  }
  page.drawText('Signature électronique interne Freda Pay : date, heure et adresse IP enregistrées au moment de chaque signature.', { x: MARGIN.l + 12, y: top - auditH + 7, size: 6.8, font: f.i, color: MUTED });

  // ---- footer on every page
  pages.forEach((p, i) => {
    const t = safe(`Freda Pay · ${c.id}${c.content_hash ? ` · ${c.content_hash.slice(0, 16)}` : ''}`);
    p.drawLine({ start: { x: MARGIN.l, y: 46 }, end: { x: PAGE.w - MARGIN.r, y: 46 }, thickness: 0.5, color: LINE });
    p.drawText(t, { x: MARGIN.l, y: 33, size: 7.5, font: f.r, color: MUTED });
    const pn = `Page ${i + 1} / ${pages.length}`;
    p.drawText(pn, { x: PAGE.w - MARGIN.r - f.r.widthOfTextAtSize(pn, 7.5), y: 33, size: 7.5, font: f.r, color: MUTED });
  });
  return Buffer.from(await doc.save());
}

module.exports = { buildPdf, contentHash, fmtDate };
