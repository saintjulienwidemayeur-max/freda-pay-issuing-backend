'use strict';
const supabase = require('../lib/supabase');
const brevo = require('../services/brevo');
const config = require('../config');
const adminStats = require('../services/adminStats');
const { buildEmail } = require('../templates/notificationEmail');
const companyProfile = require('../services/companyProfile');
const partnerReportPdf = require('../services/partnerReportPdf');
const { randomHex } = require('../utils/ids');

/**
 * Partner profit reports. The admin picks a period and the partner's percentage (e.g. 13): the profit of the period is filled in
 * from the real fees collected, expenses are entered by hand (amount + reason), and the partner's share is
 *   (profit - expenses) x percentage.
 * A report is saved so it can be reopened and emailed to any address typed in.
 */
const round2 = (n) => Math.round(n * 100) / 100;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

function readPeriod(src) {
  const from = String(src.from || '');
  const to = String(src.to || '');
  if (!DATE.test(from) || !DATE.test(to) || from > to) throw httpError(400, 'INVALID_PERIOD', 'Période invalide : dates AAAA-MM-JJ, début avant fin.');
  return { from, to };
}
const modeOf = (v) => (v === 'sandbox' ? 'sandbox' : 'live');

function readExpenses(list) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > 100) throw httpError(400, 'INVALID_EXPENSES', 'Dépenses invalides.');
  return list.map((e) => {
    const amount = Number(e && e.amount_usd);
    const label = String((e && e.label) || '').trim().slice(0, 200);
    if (!Number.isFinite(amount) || amount < 0) throw httpError(400, 'INVALID_EXPENSES', 'Chaque dépense doit avoir un montant positif.');
    if (!label) throw httpError(400, 'INVALID_EXPENSES', 'Chaque dépense doit dire pourquoi (le motif).');
    return { label, amount_usd: round2(amount) };
  });
}

function compute({ profit_usd, expenses, profit_pct }) {
  const expenses_total_usd = round2(expenses.reduce((t, e) => t + e.amount_usd, 0));
  const net_usd = round2(profit_usd - expenses_total_usd);
  const partner_share_usd = round2(Math.max(0, net_usd) * profit_pct / 100);
  return { expenses_total_usd, net_usd, partner_share_usd, our_share_usd: round2(net_usd - partner_share_usd) };
}

/** GET /admin/partner-reports/preview?from&to&mode : the money in for the period, to fill the form. */
async function preview(ctx) {
  const { from, to } = readPeriod(ctx.query || {});
  const mode = modeOf(ctx.query && ctx.query.mode);
  return { status: 200, body: { mode, from, to, ...(await adminStats.profitBetween(mode, from, to)) } };
}

/** POST /admin/partner-reports : computes and saves. profit_usd is optional: omitted = the real profit of the period. */
async function create(ctx) {
  const b = ctx.body || {};
  const { from, to } = readPeriod({ from: b.from, to: b.to });
  const mode = modeOf(b.mode);
  const partner = String(b.partner_name || '').trim().slice(0, 120);
  const pct = Number(b.profit_pct);
  if (!partner) throw httpError(400, 'MISSING_FIELDS', 'Le nom du partenaire est requis.');
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw httpError(400, 'INVALID_PERCENT', 'Le pourcentage doit être entre 0 et 100.');
  const expenses = readExpenses(b.expenses);
  const real = await adminStats.profitBetween(mode, from, to);
  const hasOverride = b.profit_usd !== undefined && b.profit_usd !== null && b.profit_usd !== '';
  const profit = hasOverride ? Number(b.profit_usd) : real.profit_usd;
  if (!Number.isFinite(profit)) throw httpError(400, 'INVALID_PROFIT', 'Montant du bénéfice invalide.');
  const calc = compute({ profit_usd: profit, expenses, profit_pct: pct });
  const row = await supabase.insert('partner_reports', {
    id: 'rpt_' + randomHex(8),
    title: String(b.title || `Rapport ${partner} ${from} → ${to}`).trim().slice(0, 150),
    partner_name: partner,
    mode,
    period_from: from,
    period_to: to,
    revenue_usd: real.revenue_usd,
    partner_cost_usd: real.partner_cost_usd,
    profit_usd: round2(profit),
    expenses,
    profit_pct: pct,
    notes: b.notes ? String(b.notes).slice(0, 2000) : null,
    created_by: (ctx.admin && ctx.admin.email) || ctx.adminId || null,
    ...calc,
  });
  return { status: 201, body: { report: row } };
}

async function list() {
  const rows = await supabase.select('partner_reports', {}, { order: 'created_at.desc', limit: 200 });
  return { status: 200, body: { reports: rows } };
}

async function getOr404(id) {
  const row = await supabase.selectOne('partner_reports', { id });
  if (!row) throw httpError(404, 'NOT_FOUND', 'Rapport introuvable.');
  return row;
}
async function get(ctx) {
  return { status: 200, body: { report: await getOr404(ctx.params.id) } };
}

const usd = (n) => `${Number(n).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;

function reportEmail(r) {
  const lines = [
    `Période : **${r.period_from}** au **${r.period_to}** (${r.mode === 'live' ? 'argent réel' : 'Sandbox'})`,
    `Bénéfice de la période : **${usd(r.profit_usd)}**`,
  ];
  const exp = r.expenses || [];
  if (exp.length) {
    lines.push('Dépenses :');
    exp.forEach((e) => lines.push(`- ${e.label} : ${usd(e.amount_usd)}`));
    lines.push(`Total des dépenses : **${usd(r.expenses_total_usd)}**`);
  } else lines.push('Dépenses : aucune.');
  lines.push(`Bénéfice net (bénéfice - dépenses) : **${usd(r.net_usd)}**`);
  lines.push(`Part de ${r.partner_name} (${Number(r.profit_pct)} %) : **${usd(r.partner_share_usd)}**`);
  lines.push(`Part Freda Pay Issuing : **${usd(r.our_share_usd)}**`);
  if (r.notes) lines.push(`Note : ${r.notes}`);
  return buildEmail({ subject: `${r.title} : Freda Pay Issuing`, eyebrow: 'Rapport', heading: r.title, paragraphs: [...lines, 'Le rapport officiel (PDF, avec les mentions légales et la signature du CEO) est joint à cet email.'], tone: 'info' });
}

/** The official PDF. Refused while the company identity or the CEO's signature is missing: an unsigned report is not official. */
async function pdfFor(report) {
  const company = await companyProfile.get();
  const lacking = companyProfile.missing(company);
  if (lacking.length) throw httpError(409, 'COMPANY_PROFILE_INCOMPLETE', `Complétez d'abord l'identité légale : il manque ${lacking.join(', ')}.`);
  const buf = await partnerReportPdf.build(report, company);
  const slug = String(report.partner_name).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'partenaire';
  return { buf, filename: `rapport-${slug}-${report.period_from}-${report.period_to}.pdf` };
}

/** GET /admin/partner-reports/:id/pdf : the PDF as base64 (the admin page turns it into a download). */
async function pdf(ctx) {
  const { buf, filename } = await pdfFor(await getOr404(ctx.params.id));
  return { status: 200, body: { filename, base64: buf.toString('base64') } };
}

/** POST /admin/partner-reports/:id/send { to } : the PDF emailed to an address typed in by hand, nobody else. */
async function send(ctx) {
  const to = String((ctx.body && ctx.body.to) || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw httpError(400, 'INVALID_EMAIL', 'Adresse email invalide.');
  const r = await getOr404(ctx.params.id);
  const { buf, filename } = await pdfFor(r);
  const built = reportEmail(r);
  await brevo.sendEmail({
    to, toName: to, subject: built.subject, html: built.html, text: built.text,
    senderEmail: config.brevo.adminSenderEmail, senderName: config.brevo.adminSenderName,
    attachments: [{ name: filename, content: buf.toString('base64') }],
  });
  await supabase.update('partner_reports', { id: r.id }, { last_sent_to: to, last_sent_at: new Date().toISOString() });
  return { status: 200, body: { sent: true, to, filename } };
}

/** GET / PUT /admin/company-profile : legal identity + the CEO's signature used on official documents. */
async function getCompany() {
  const p = await companyProfile.get();
  return { status: 200, body: { profile: Object.assign({}, p, { signature: p.signature ? { type: p.signature.type, image: p.signature.image } : null }), missing: companyProfile.missing(p) } };
}
async function putCompany(ctx) {
  const body = ctx.body || {};
  const signature = body.signature ? require('./contracts').cleanSignature(body.signature) : null;
  const saved = await companyProfile.save(body, signature, ctx.admin && ctx.admin.email);
  return { status: 200, body: { profile: Object.assign({}, saved, { signature: saved.signature ? { type: saved.signature.type, image: saved.signature.image } : null }), missing: companyProfile.missing(saved) } };
}

async function remove(ctx) {
  await getOr404(ctx.params.id);
  await supabase.delete('partner_reports', { id: ctx.params.id });
  return { status: 200, body: { deleted: true } };
}

module.exports = { preview, create, list, get, pdf, send, remove, getCompany, putCompany };
