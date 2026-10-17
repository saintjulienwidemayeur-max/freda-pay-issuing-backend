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
    extra: (c.signers || []).map((x) => ({ id: x.id, side: x.side, name: x.name, email: x.email, signed_at: x.signed_at, signature: sigFp(x.signature) })).sort((p, q) => (p.id < q.id ? -1 : 1)),
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
  doc.setAuthor('Freda Pay Issuing');
  doc.setProducer('Freda Pay Issuing e-signature');
  doc.setCreator('Freda Pay Issuing');
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
  const BOX_H = 74, BLOCK_H = 16 + BOX_H + 14 + 13 + 12 + 12 + 12 + 18;
  const sigBlock = async (x, label, name, email, signedAt, sig, pending) => {
    page.drawText(safe(label), { x, y: y - 9, size: 9, font: f.b, color: MUTED });
    const boxTop = y - 16;
    page.drawRectangle({ x, y: boxTop - BOX_H, width: colW, height: BOX_H, borderColor: LINE, borderWidth: 0.8, color: rgb(0.995, 0.995, 0.995) });
    if (sig && sig.image) {
      const png = maskToPng(sig.image.w, sig.image.h, Buffer.from(sig.image.alpha, 'base64'));
      const img = await doc.embedPng(png);
      const scale = Math.min((colW - 16) / sig.image.w, (BOX_H - 12) / sig.image.h);
      const dw = sig.image.w * scale, dh = sig.image.h * scale;
      page.drawImage(img, { x: x + (colW - dw) / 2, y: boxTop - BOX_H + (BOX_H - dh) / 2, width: dw, height: dh });
    } else {
      page.drawText(pending ? 'En attente de signature' : '', { x: x + 10, y: boxTop - BOX_H / 2 - 3, size: 9, font: f.i, color: MUTED });
    }
    let ty = boxTop - BOX_H - 14;
    page.drawText(safe(name || ''), { x, y: ty, size: 10.5, font: f.b, color: INK }); ty -= 13;
    if (email) { page.drawText(safe(email), { x, y: ty, size: 9, font: f.r, color: MUTED }); ty -= 12; }
    if (signedAt) { page.drawText(`Signé le ${fmtDate(signedAt)}`, { x, y: ty, size: 8.5, font: f.r, color: MUTED }); ty -= 12; }
    if (sig) { page.drawText(sig.type === 'typed' ? 'Signature saisie au clavier' : 'Signature dessinée à la main', { x, y: ty, size: 8, font: f.i, color: MUTED }); }
  };
  const extras = c.signers || [];
  const left = [{ label: 'POUR FREDA PAY ISSUING', name: c.admin_name, email: c.admin_email, at: c.admin_signed_at, sig: c.admin_signature, pending: false }]
    .concat(extras.filter((x) => x.side === 'FREDA').map((x) => ({ label: 'POUR FREDA PAY ISSUING', name: x.name, email: x.email, at: x.signed_at, sig: x.signature, pending: !x.signature })));
  const right = [{ label: 'LE SIGNATAIRE', name: c.signer_name || c.recipient_name, email: c.signer_email || c.recipient_email, at: c.signed_at, sig: c.signer_signature, pending: !c.signer_signature }]
    .concat(extras.filter((x) => x.side !== 'FREDA').map((x) => ({ label: 'LE SIGNATAIRE', name: x.name, email: x.email, at: x.signed_at, sig: x.signature, pending: !x.signature })));
  for (let r = 0; r < Math.max(left.length, right.length); r++) {
    ensure(BLOCK_H);
    for (const [col, list] of [[0, left], [1, right]]) {
      const it = list[r];
      if (it) await sigBlock(MARGIN.l + col * (colW + 24), it.label, it.name, it.email, it.at, it.sig, it.pending);
    }
    y -= BLOCK_H;
  }

  // ---- certificate of signature: its own page, so the contract itself stays clean
  newPage();
  page.drawRectangle({ x: 0, y: PAGE.h - 8, width: PAGE.w, height: 8, color: PINK });
  page.drawText('FREDA PAY', { x: MARGIN.l, y: y + 14, size: 10, font: f.b, color: INK });
  page.drawText('ISSUING', { x: MARGIN.l + f.b.widthOfTextAtSize('FREDA PAY', 10) + 5, y: y + 14, size: 10, font: f.b, color: PINK });
  y -= 14;
  page.drawText('Certificat de signature électronique', { x: MARGIN.l, y: y - 18, size: 18, font: f.b, color: INK });
  y -= 30;
  const lead = 'Ce certificat atteste que le document ci-dessous a été signé électroniquement sur la plateforme Freda Pay Issuing. Il consigne les éléments de preuve recueillis lors de chaque signature.';
  const wrap = (text, font, size, width) => {
    const out = []; let cur = '';
    for (const w of safe(text).split(' ')) {
      const t = cur ? `${cur} ${w}` : w;
      if (cur && font.widthOfTextAtSize(t, size) > width) { out.push(cur); cur = w; } else cur = t;
    }
    if (cur) out.push(cur);
    return out;
  };
  for (const ln of wrap(lead, f.r, 9.5, contentW)) { page.drawText(ln, { x: MARGIN.l, y: y - 9.5, size: 9.5, font: f.r, color: MUTED }); y -= 13.5; }
  y -= 12;
  const device = (ua) => {
    const u = String(ua || '');
    if (!u) return '-';
    const br = /Edg\//.test(u) ? 'Microsoft Edge' : /OPR\/|Opera/.test(u) ? 'Opera' : /Firefox\//.test(u) ? 'Firefox' : /Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : 'Navigateur inconnu';
    const os = /Windows/.test(u) ? 'Windows' : /Android/.test(u) ? 'Android' : /iPhone|iPad|iOS/.test(u) ? 'iOS' : /Mac OS X|Macintosh/.test(u) ? 'macOS' : /Linux/.test(u) ? 'Linux' : '';
    return os ? `${br} sur ${os}` : br;
  };
  const LBL = 128;
  const section = (title, rows) => {
    const body = rows.map(([k, v, mono]) => {
      const font = mono ? f.m : f.r, size = mono ? 8.5 : 9.5;
      let lines;
      if (mono) { const t = safe(v); lines = []; for (let i = 0; i < t.length; i += 32) lines.push(t.slice(i, i + 32)); if (!lines.length) lines = ['-']; }
      else lines = wrap(v || '-', font, size, contentW - LBL - 24);
      return { k, lines, font, size, h: Math.max(1, lines.length) * (size + 4) + 10 };
    });
    const total = 26 + body.reduce((n, r) => n + r.h, 0);
    ensure(total + 14);
    page.drawRectangle({ x: MARGIN.l, y: y - 22, width: contentW, height: 22, color: INK });
    page.drawText(safe(title).toUpperCase(), { x: MARGIN.l + 12, y: y - 15, size: 8.5, font: f.b, color: rgb(1, 1, 1) });
    y -= 22;
    body.forEach((r, i) => {
      page.drawRectangle({ x: MARGIN.l, y: y - r.h, width: contentW, height: r.h, color: i % 2 ? rgb(1, 1, 1) : rgb(0.975, 0.97, 0.975) });
      page.drawText(safe(r.k), { x: MARGIN.l + 12, y: y - 5 - 9, size: 8.5, font: f.b, color: MUTED });
      r.lines.forEach((ln, j) => page.drawText(ln, { x: MARGIN.l + LBL, y: y - 5 - r.size - j * (r.size + 4), size: r.size, font: r.font, color: INK }));
      y -= r.h;
    });
    page.drawLine({ start: { x: MARGIN.l, y }, end: { x: PAGE.w - MARGIN.r, y }, thickness: 0.6, color: LINE });
    y -= 16;
  };
  section('Document', [
    ['Référence', c.id],
    ['Titre', c.title],
    ['Statut', status],
    ['Empreinte SHA-256', c.content_hash || 'Calculée à la signature', true],
  ]);
  const method = (sg) => (sg ? (sg.type === 'typed' ? 'Signature saisie au clavier' : 'Signature dessinée à la main') : '-');
  const fredaList = [{ name: c.admin_name, email: c.admin_email, at: c.admin_signed_at, ip: c.admin_signed_ip, sig: c.admin_signature, main: true }]
    .concat(extras.filter((x) => x.side === 'FREDA').map((x) => ({ name: x.name, email: x.email, at: x.signed_at, ip: x.signed_ip, ua: x.signed_user_agent, sig: x.signature })));
  const clientList = [{ name: c.signer_name || c.recipient_name, email: c.signer_email || c.recipient_email, at: c.signed_at, ip: c.signed_ip, ua: c.signed_user_agent, sig: c.signer_signature }]
    .concat(extras.filter((x) => x.side !== 'FREDA').map((x) => ({ name: x.name, email: x.email, at: x.signed_at, ip: x.signed_ip, ua: x.signed_user_agent, sig: x.signature })));
  const sectionFor = (title, list) => list.forEach((p, i) => section(list.length > 1 ? `${title} (${i + 1}/${list.length})` : title, [
    ['Signataire', p.name],
    ['Adresse email', p.email],
    ['Date et heure', p.at ? fmtDate(p.at) : 'En attente'],
    ['Adresse IP', p.at ? (p.ip || '-') : '-'],
    ...(p.main ? [] : [['Appareil', p.at && p.ua ? device(p.ua) : '-']]),
    ['Méthode', method(p.sig)],
  ]));
  sectionFor('Signature de Freda Pay Issuing', fredaList);
  sectionFor('Signature du cosignataire', clientList);
  for (const ln of wrap("Signature électronique interne Freda Pay Issuing : la date, l'heure (UTC) et l'adresse IP sont enregistrées au moment de chaque signature. L'empreinte SHA-256 identifie de façon unique le contenu signé : toute modification du document la changerait.", f.i, 8, contentW)) { ensure(11); page.drawText(ln, { x: MARGIN.l, y: y - 8, size: 8, font: f.i, color: MUTED }); y -= 11; }

  // ---- footer on every page
  pages.forEach((p, i) => {
    const t = safe(`Freda Pay Issuing · ${c.id}${c.content_hash ? ` · ${c.content_hash.slice(0, 16)}` : ''}`);
    p.drawLine({ start: { x: MARGIN.l, y: 46 }, end: { x: PAGE.w - MARGIN.r, y: 46 }, thickness: 0.5, color: LINE });
    p.drawText(t, { x: MARGIN.l, y: 33, size: 7.5, font: f.r, color: MUTED });
    const pn = `Page ${i + 1} / ${pages.length}`;
    p.drawText(pn, { x: PAGE.w - MARGIN.r - f.r.widthOfTextAtSize(pn, 7.5), y: 33, size: 7.5, font: f.r, color: MUTED });
  });
  return Buffer.from(await doc.save());
}

module.exports = { buildPdf, contentHash, fmtDate };
