'use strict';
const SIG_METHOD = { typed: 'Signature saisie au clavier', drawn: 'Signature dessinée à la main', uploaded: 'Signature importée depuis une image' };
const crypto = require('crypto');
const haitiTime = require('../utils/haitiTime');
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
const LINE = rgb(0.85, 0.83, 0.87);
const SIZES = { p: 10.5, li: 10.5, blockquote: 10.5, h1: 19, h2: 14.5, h3: 12 };
const FALLBACK_CHARS = { '≈': '~', '→': '->', '←': '<-', '✓': 'v', '✔': 'v', '’': "'", '‘': "'", '“': '"', '”': '"', ' ': ' ', ' ': ' ', '​': '', '﻿': '' };
/** Letters outside WinAnsi that have a plain look-alike (accents are handled by decomposition). */
const LOOKALIKE = { 'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D', 'ı': 'i', 'İ': 'I', 'ø': 'o', 'Ø': 'O', 'ħ': 'h', 'ŧ': 't', '‐': '-', '‑': '-', '‒': '-', '−': '-', '‚': ',', '′': "'", '″': '"', '‹': '<', '›': '>', '№': 'No', '™': '(TM)', '℅': 'c/o', '＄': '$', '½': '1/2', '¼': '1/4', '¾': '3/4', '×': 'x', '÷': '/', '‣': '•', '◦': 'o', '▪': '-', '■': '-', '…': '...' };

function fmtDate(iso) {
  const t = haitiTime.format(iso);
  return t === '-' ? t : `${t} (heure d'Haïti)`;
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
  const lookalike = (ch) => {
    if (LOOKALIKE[ch] !== undefined) return LOOKALIKE[ch];
    const base = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (base && base !== ch && [...base].every((b) => charset.has(b.codePointAt(0)))) return base;
    return '?';
  };
  const safe = (s) => {
    let out = '';
    for (const ch of String(s)) {
      const cp = ch.codePointAt(0);
      if (FALLBACK_CHARS[ch] !== undefined) out += FALLBACK_CHARS[ch];
      else if (cp === 9 || cp === 10 || cp === 13) out += ' ';
      else if (charset.has(cp)) out += ch;
      else out += lookalike(ch);
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

  const status = c.status === 'COMPLETED' ? 'Document signé' : c.status === 'CANCELLED' ? 'Document annulé' : 'En attente de signature';

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
  // Words of a run list laid out in lines no wider than `width` (a word wider than the line is cut).
  // Longest prefix of `text` (at least one character) that fits in `width`; binary search, so a very long word stays cheap.
  const cutToWidth = (text, font, size, width) => {
    let lo = 1, hi = text.length;
    if (font.widthOfTextAtSize(text, size) <= width) return text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (font.widthOfTextAtSize(text.slice(0, mid), size) <= width) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
  // One line: the text is shortened with "..." when it is wider than `width`.
  const fit = (txt, font, size, width) => {
    const t = safe(txt);
    if (font.widthOfTextAtSize(t, size) <= width) return t;
    const n = cutToWidth(t, font, size, width - font.widthOfTextAtSize('...', size));
    return `${t.slice(0, n)}...`;
  };
  const buildLines = (runs, size, width, forceBold, forceItalic) => {
    const words = [];
    for (const r of runs) {
      if (r.br) { words.push({ br: true }); continue; }
      let text = r.text;
      if (r.field !== undefined && !text) text = '………………';
      const font = pickFont(forceBold || r.b, r.i || forceItalic);
      for (const part of safe(text).split(/(\s+)/)) {
        if (part === '') continue;
        if (/^\s+$/.test(part)) words.push({ space: true, text: ' ', font, w: font.widthOfTextAtSize(' ', size), u: false });
        else words.push({ text: part, font, w: font.widthOfTextAtSize(part, size), u: !!r.u });
      }
    }
    const lines = [];
    let line = [], lw = 0;
    const pushLine = (hard) => { while (line.length && line[line.length - 1].space) { lw -= line[line.length - 1].w; line.pop(); } lines.push({ items: line, hard }); line = []; lw = 0; };
    for (const w of words) {
      if (w.br) { pushLine(true); continue; }
      if (w.space && !line.length) continue;
      if (!w.space && line.length && lw + w.w > width) pushLine(false);
      if (!w.space && w.w > width) {
        let rest = w.text;
        while (rest.length) {
          const n = cutToWidth(rest, w.font, size, width);
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
    return lines;
  };
  const layoutTable = (blk) => {
    const size = 9.2, lineH = size * 1.4, padX = 6, padY = 5;
    const nCols = Math.max(...blk.rows.map((r) => r.cells.length));
    const weight = Array.from({ length: nCols }, (_, c) => Math.min(60, Math.max(8, ...blk.rows.map((r) => (r.cells[c] ? r.cells[c].runs.reduce((n, x) => n + String(x.text || x.field || '').length, 0) : 0)))));
    const sum = weight.reduce((a, b) => a + b, 0);
    const minW = Math.min(70, contentW / nCols);
    let widths = weight.map((w) => Math.max(minW, (w / sum) * contentW));
    const scale = contentW / widths.reduce((a, b) => a + b, 0);
    widths = widths.map((w) => w * scale);
    y -= 4;
    const fullLines = Math.floor((PAGE.h - MARGIN.t - MARGIN.b - 2 * padY) / lineH);
    const header = blk.rows[0].cells.every((x) => x.head) && blk.rows.length > 1 ? blk.rows[0] : null;
    const prepare = (row) => row.cells.map((cell, c) => ({ cell, lines: buildLines(cell.runs, size, widths[c] - 2 * padX, cell.head, false) }));
    // Draws lines [from, to) of every cell of a row as one bordered band.
    const drawBand = (cells, from, to) => {
      const h = (to - from) * lineH + 2 * padY;
      let x = MARGIN.l;
      cells.forEach(({ cell, lines }, c) => {
        page.drawRectangle({ x, y: y - h, width: widths[c], height: h, borderColor: LINE, borderWidth: 0.7, color: cell.head ? rgb(0.955, 0.955, 0.96) : undefined });
        const saved = y;
        y -= padY - 1.5;
        lines.slice(from, to).forEach((ln) => {
          if (ln.items.length) drawLine(ln.items, size, cell.align || 'left', true, lineH, x + padX, widths[c] - 2 * padX);
          y -= lineH;
        });
        y = saved;
        x += widths[c];
      });
      y -= h;
    };
    const headerCells = header ? prepare(header) : null;
    const headerH = header ? Math.max(...headerCells.map((x) => x.lines.length)) * lineH + 2 * padY : 0;
    // A page break inside the table repeats its header row.
    const breakPage = (row) => { newPage(); if (header && row !== header && headerH < PAGE.h / 3) drawBand(headerCells, 0, Math.max(...headerCells.map((x) => x.lines.length))); };
    for (const row of blk.rows) {
      const cells = row === header ? headerCells : prepare(row);
      const total = Math.max(...cells.map((x) => x.lines.length));
      if (total <= fullLines) {
        const h = total * lineH + 2 * padY;
        if (y - h < MARGIN.b) breakPage(row);
        drawBand(cells, 0, total);
        continue;
      }
      // A row taller than a page continues on the next page(s), a band of lines at a time.
      let done = 0;
      while (done < total) {
        let avail = Math.floor((y - MARGIN.b - 2 * padY) / lineH);
        if (avail < 3) { breakPage(row); avail = Math.floor((y - MARGIN.b - 2 * padY) / lineH); }
        const take = Math.min(avail, total - done);
        drawBand(cells, done, done + take);
        done += take;
        if (done < total) breakPage(row);
      }
    }
    y -= 8;
  };
  const layoutBlock = (blk) => {
    if (blk.kind === 'table') { layoutTable(blk); return; }
    if (blk.kind === 'space') { ensure(8); y -= 8; return; }
    if (blk.kind === 'hr') { ensure(14); y -= 6; page.drawLine({ start: { x: MARGIN.l, y }, end: { x: PAGE.w - MARGIN.r, y }, thickness: 0.7, color: LINE }); y -= 8; return; }
    const size = SIZES[blk.kind] || 10.5;
    const heading = blk.kind === 'h1' || blk.kind === 'h2' || blk.kind === 'h3';
    const lineH = size * 1.38;
    const indent = blk.kind === 'li' ? 16 * blk.indent : blk.kind === 'blockquote' ? 20 : 0;
    const x0 = MARGIN.l + indent;
    const width = contentW - indent;
    const lines = buildLines(blk.runs, size, width, heading, blk.kind === 'blockquote');
    if (heading && blk.kind !== 'h3') { ensure(size * 2.4); y -= size * 0.5; }
    else if (blk.kind === 'h3') { ensure(size * 2); y -= size * 0.3; }
    lines.forEach((ln, idx) => {
      ensure(lineH);
      if (idx === 0 && blk.kind === 'li') page.drawText(blk.prefix, { x: x0 - 13, y: y - size, size, font: f.r, color: INK });
      if (ln.items.length) drawLine(ln.items, size, blk.align || 'left', ln.hard || idx === lines.length - 1, lineH, x0, width);
      y -= lineH;
    });
    y -= blk.kind === 'li' ? 2.5 : heading ? size * 0.35 : 5;
  };

  // The contract text carries its own title; one is added only when the text does not start with a heading.
  const blocks = toBlocks(c.body_html, c.fields || {});
  if (!blocks.length || blocks[0].kind !== 'h1') blocks.unshift({ kind: 'h1', align: null, runs: [{ text: c.title, b: true, i: false, u: false }] });
  for (const blk of blocks) layoutBlock(blk);

  // ---- signatures
  ensure(250);
  y -= 14;
  page.drawText('Signatures électroniques', { x: MARGIN.l, y: y - 13, size: 13, font: f.b, color: INK });
  y -= 30;
  const colW = (contentW - 24) / 2;
  const BOX_H = 74, BLOCK_H = 16 + BOX_H + 14 + 13 + 12 + 12 + 12 + 18;
  const sigBlock = async (x, label, name, email, signedAt, sig, pending) => {
    page.drawText(fit(label, f.b, 9, colW), { x, y: y - 9, size: 9, font: f.b, color: MUTED });
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
    page.drawText(fit(name || '', f.b, 10.5, colW), { x, y: ty, size: 10.5, font: f.b, color: INK }); ty -= 13;
    if (email) { page.drawText(fit(email, f.r, 9, colW), { x, y: ty, size: 9, font: f.r, color: MUTED }); ty -= 12; }
    if (signedAt) { page.drawText(`Signé le ${fmtDate(signedAt)}`, { x, y: ty, size: 8.5, font: f.r, color: MUTED }); ty -= 12; }
    if (sig) { page.drawText(SIG_METHOD[sig.type] || 'Signature dessinée à la main', { x, y: ty, size: 8, font: f.i, color: MUTED }); }
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
  page.drawText('Certificat de signature électronique', { x: MARGIN.l, y: y - 18, size: 18, font: f.b, color: INK });
  y -= 30;
  const lead = 'Ce certificat atteste que le document ci-dessous a été signé électroniquement sur la plateforme Freda Pay Issuing. Il consigne les éléments de preuve recueillis lors de chaque signature.';
  const wrap = (text, font, size, width) => {
    const out = []; let cur = '';
    for (let w of safe(text).split(' ')) {
      while (font.widthOfTextAtSize(w, size) > width && w.length > 1) { // a word wider than the line is cut
        if (cur) { out.push(cur); cur = ''; }
        const n = cutToWidth(w, font, size, width);
        out.push(w.slice(0, n)); w = w.slice(n);
      }
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
  const method = (sg) => (sg ? (SIG_METHOD[sg.type] || 'Signature dessinée à la main') : '-');
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
  for (const ln of wrap("Signature électronique interne Freda Pay Issuing : la date, l'heure (heure d'Haïti) et l'adresse IP sont enregistrées au moment de chaque signature. L'empreinte SHA-256 identifie de façon unique le contenu signé : toute modification du document la changerait.", f.i, 8, contentW)) { ensure(11); page.drawText(ln, { x: MARGIN.l, y: y - 8, size: 8, font: f.i, color: MUTED }); y -= 11; }

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
