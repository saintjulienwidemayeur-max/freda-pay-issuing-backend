'use strict';
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('../vendor/pdf-lib.min.js');
const { maskToPng } = require('../utils/png');

/**
 * The official partner report as a PDF, built inside this server: logo, the figures, the expenses, the result, the company's legal
 * mentions and the CEO's signature. Standard PDF fonts only (nothing to embed or download).
 */
const PAGE = { w: 595.28, h: 841.89 };
const M = 56;
const INK = rgb(0.09, 0.09, 0.1);
const MUTED = rgb(0.42, 0.42, 0.47);
const LINE = rgb(0.86, 0.84, 0.88);
const PINK = rgb(1, 0.25, 0.5);
const LOGO = (() => { try { return fs.readFileSync(path.join(__dirname, '..', 'assets', 'logo-email.png')); } catch (e) { return null; } })();

const round2 = (n) => Math.round(Number(n) * 100) / 100;
/** 1 234,50 $ : plain spaces only (the PDF fonts cannot print the narrow no-break space toLocaleString uses). */
function usd(n) {
  const v = round2(n);
  const [i, d] = Math.abs(v).toFixed(2).split('.');
  return `${v < 0 ? '-' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${d} $`;
}
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
function dateFr(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : String(iso);
}

async function build(report, company) {
  const doc = await PDFDocument.create();
  const f = { r: await doc.embedFont(StandardFonts.Helvetica), b: await doc.embedFont(StandardFonts.HelveticaBold), i: await doc.embedFont(StandardFonts.HelveticaOblique) };
  const charset = new Set(f.r.getCharacterSet());
  const safe = (s) => {
    let out = '';
    for (const ch of String(s == null ? '' : s)) {
      const cp = ch.codePointAt(0);
      if (cp === 0x2019 || cp === 0x2018) out += "'";
      else if (cp === 0x201c || cp === 0x201d) out += '"';
      else if (cp === 0x2192) out += '->';
      else if (cp === 9 || cp === 10 || cp === 13 || cp === 0xa0 || cp === 0x202f) out += ' ';
      else if (charset.has(cp)) out += ch;
      else {
        const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
        out += base && [...base].every((b) => charset.has(b.codePointAt(0))) ? base : '?';
      }
    }
    return out;
  };
  doc.setTitle(safe(report.title));
  doc.setAuthor(safe(company.legal_name || 'Freda Pay Issuing'));
  doc.setCreator('Freda Pay Issuing');
  doc.setProducer('Freda Pay Issuing');
  const created = new Date(report.created_at || Date.now());
  doc.setCreationDate(created); doc.setModificationDate(created);

  const logo = LOGO ? await doc.embedPng(LOGO) : null;
  let page = null; let y = 0;
  const contentW = PAGE.w - 2 * M;
  const text = (t, x, size, font, color, opts) => page.drawText(safe(t), Object.assign({ x, y: y - size, size, font, color: color || INK }, opts || {}));
  const right = (t, xr, size, font, color) => { const s = safe(t); page.drawText(s, { x: xr - font.widthOfTextAtSize(s, size), y: y - size, size, font, color: color || INK }); };
  const fit = (t, font, size, width) => { let s = safe(t); while (s.length > 1 && font.widthOfTextAtSize(s, size) > width) s = s.slice(0, -2) + '…'.replace('…', '.'); return s; };
  const wrap = (t, font, size, width) => {
    const lines = []; let line = '';
    for (const w of safe(t).split(/\s+/).filter(Boolean)) {
      const test = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(test, size) > width && line) { lines.push(line); line = w; } else line = test;
    }
    if (line) lines.push(line);
    return lines;
  };

  const header = () => {
    page = doc.addPage([PAGE.w, PAGE.h]);
    page.drawRectangle({ x: 0, y: PAGE.h - 96, width: PAGE.w, height: 96, color: rgb(0.067, 0.067, 0.067) });
    if (logo) page.drawImage(logo, { x: M, y: PAGE.h - 72, width: 46, height: 46 });
    page.drawText('FREDA PAY', { x: M + 58, y: PAGE.h - 52, size: 17, font: f.b, color: rgb(1, 1, 1) });
    page.drawText('ISSUING', { x: M + 58 + f.b.widthOfTextAtSize('FREDA PAY', 17) + 6, y: PAGE.h - 52, size: 17, font: f.b, color: PINK });
    const legal = safe(company.legal_name || '');
    if (legal) page.drawText(legal, { x: M + 58, y: PAGE.h - 68, size: 9, font: f.r, color: rgb(0.8, 0.8, 0.82) });
    page.drawText('RAPPORT', { x: PAGE.w - M - f.b.widthOfTextAtSize('RAPPORT', 11), y: PAGE.h - 50, size: 11, font: f.b, color: rgb(1, 1, 1) });
    y = PAGE.h - 96 - 34;
  };
  const ensure = (h) => { if (y - h < 130) { header(); } };
  header();

  // Title block
  for (const l of wrap(report.title, f.b, 19, contentW)) { text(l, M, 19, f.b); y -= 25; }
  y -= 2;
  text(`Partenaire : ${report.partner_name}`, M, 11, f.r, MUTED); y -= 16;
  text(`Période : du ${dateFr(report.period_from)} au ${dateFr(report.period_to)}  (${report.mode === 'live' ? 'argent réel' : 'Sandbox'})`, M, 11, f.r, MUTED); y -= 16;
  text(`Établi le ${dateFr(String(created.toISOString()))}`, M, 11, f.r, MUTED); y -= 28;

  const row = (label, value, opt = {}) => {
    ensure(26);
    if (opt.shade) page.drawRectangle({ x: M, y: y - 20, width: contentW, height: 24, color: rgb(0.97, 0.95, 0.96) });
    text(label, M + 8, opt.size || 11, opt.bold ? f.b : f.r, opt.color);
    right(value, PAGE.w - M - 8, opt.size || 11, opt.bold ? f.b : f.r, opt.color);
    y -= 24;
    page.drawLine({ start: { x: M, y: y + 3 }, end: { x: PAGE.w - M, y: y + 3 }, thickness: 0.5, color: LINE });
  };
  const section = (t) => { ensure(40); y -= 6; text(t.toUpperCase(), M, 9, f.b, PINK); y -= 18; };

  section('Résultat de la période');
  row('Frais encaissés', usd(report.revenue_usd));
  row('Frais facturés par les partenaires', `- ${usd(report.partner_cost_usd)}`);
  row('Bénéfice de la période', usd(report.profit_usd), { bold: true, shade: true });

  section('Dépenses');
  const exp = report.expenses || [];
  if (!exp.length) row('Aucune dépense', usd(0));
  for (const e of exp) {
    const lines = wrap(e.label, f.r, 11, contentW - 130);
    ensure(24 + (lines.length - 1) * 14);
    text(lines[0] || '', M + 8, 11, f.r); right(usd(e.amount_usd), PAGE.w - M - 8, 11, f.r);
    for (let i = 1; i < lines.length; i += 1) { y -= 14; text(lines[i], M + 8, 11, f.r, MUTED); }
    y -= 24; page.drawLine({ start: { x: M, y: y + 3 }, end: { x: PAGE.w - M, y: y + 3 }, thickness: 0.5, color: LINE });
  }
  row('Total des dépenses', `- ${usd(report.expenses_total_usd)}`, { bold: true });

  section('Répartition');
  row('Bénéfice net (bénéfice - dépenses)', usd(report.net_usd), { bold: true });
  row(`Part de ${report.partner_name} (${Number(report.profit_pct)} %)`, usd(report.partner_share_usd), { bold: true, shade: true, size: 12 });
  row(`Part ${company.legal_name || 'Freda Pay Issuing'}`, usd(report.our_share_usd));

  if (report.notes) {
    section('Note');
    for (const l of wrap(report.notes, f.r, 10.5, contentW)) { ensure(16); text(l, M, 10.5, f.r); y -= 15; }
  }

  // CEO signature
  ensure(150);
  y -= 22;
  text('Certifié sincère et véritable', M, 10, f.i, MUTED); y -= 18;
  text(`${company.city ? `Fait à ${company.city}, le` : 'Fait le'} ${dateFr(created.toISOString())}`, M, 10, f.r); y -= 14;
  const sig = company.signature;
  const boxW = 190; const boxH = 62;
  if (sig && sig.image) {
    const png = maskToPng(sig.image.w, sig.image.h, Buffer.from(sig.image.alpha, 'base64'));
    const img = await doc.embedPng(png);
    const sc = Math.min(boxW / sig.image.w, boxH / sig.image.h);
    page.drawImage(img, { x: M, y: y - boxH + (boxH - sig.image.h * sc) / 2, width: sig.image.w * sc, height: sig.image.h * sc });
  }
  y -= boxH + 4;
  page.drawLine({ start: { x: M, y }, end: { x: M + boxW, y }, thickness: 0.7, color: INK });
  y -= 4;
  text(company.ceo_name || '', M, 11, f.b); y -= 14;
  text(`${company.ceo_title || 'CEO'}${company.legal_name ? ` - ${company.legal_name}` : ''}`, M, 9.5, f.r, MUTED);

  // Legal mentions on every page
  const legal = [
    [company.legal_name, company.legal_form].filter(Boolean).join(' - '),
    company.address,
    company.registration,
    company.tax_id && `N° fiscal : ${company.tax_id}`,
    [company.email, company.phone, company.website].filter(Boolean).join('   '),
  ].filter(Boolean);
  const pages = doc.getPages();
  pages.forEach((pg, idx) => {
    pg.drawLine({ start: { x: M, y: 92 }, end: { x: PAGE.w - M, y: 92 }, thickness: 0.6, color: LINE });
    legal.forEach((l, k) => pg.drawText(fit(l, f.r, 8, contentW), { x: M, y: 78 - k * 11, size: 8, font: f.r, color: MUTED }));
    const label = `Page ${idx + 1} / ${pages.length}`;
    pg.drawText(label, { x: PAGE.w - M - f.r.widthOfTextAtSize(label, 8), y: 34, size: 8, font: f.r, color: MUTED });
    pg.drawText('Document confidentiel', { x: M, y: 34, size: 8, font: f.i, color: MUTED });
  });
  return Buffer.from(await doc.save());
}

module.exports = { build, usd };
