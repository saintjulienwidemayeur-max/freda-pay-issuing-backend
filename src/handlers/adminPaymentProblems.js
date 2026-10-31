'use strict';
const supabase = require('../lib/supabase');
const paymentOrchestrator = require('../services/paymentOrchestrator');
const paymentHealth = require('../services/paymentHealth');
const apiCallLog = require('../services/apiCallLog');
const apiHealth = require('../services/apiHealth');

/**
 * Admin "Paiements à vérifier": the merchants whose payments do not settle or whose integration returns errors, with every transaction of
 * a merchant and a way to ask the partner again (which credits the merchant ONLY when the partner confirms the payment).
 */
function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

const day = 24 * 3600 * 1000;
const STUCK_MIN = 15; // a pending payment older than this is worth a look

function ageMin(p) { return Math.round((Date.now() - new Date(p.created_at).getTime()) / 60000); }
const isCard = (p) => p.provider === 'tranzak';

function answerOf(p) {
  const a = paymentHealth.lastAnswer(p.id);
  return a ? { kind: a.kind, label: paymentHealth.LABEL[a.kind], at: new Date(a.at).toISOString(), http_status: a.http_status, trans_status: a.trans_status, message: a.message } : null;
}

function modeOf(ctx) { return ctx.query && ctx.query.mode === 'sandbox' ? 'sandbox' : 'live'; }

/** What an integration error means for the merchant and how he fixes it (reuses the API health texts). */
function describe(e) { return Object.assign({}, e, { explain: apiHealth.explain(e.code), fix: apiHealth.fixFor(e.code) }); }

/** GET /admin/payments/problems?mode=live : one row per merchant that has a problem. */
async function overview(ctx) {
  const mode = modeOf(ctx);
  const since = new Date(Date.now() - 14 * day).toISOString();
  const [payments, hooks] = await Promise.all([
    supabase.select('payments', { mode, created_at: supabase.gt(since) }, { order: 'created_at.desc', limit: 5000 }),
    supabase.select('webhook_endpoints', {}, { limit: 5000 }),
  ]);
  const hookOf = new Map(hooks.map((h) => [h.merchant_id, h]));
  const per = new Map();
  const row = (id) => { if (!per.has(id)) per.set(id, { merchant_id: id, stuck: 0, stuck_oldest_min: 0, stuck_amount: {}, kinds: {}, card_failed: 0, card_stuck: 0, total: 0, succeeded: 0 }); return per.get(id); };
  for (const p of payments) {
    const r = row(p.merchant_id);
    r.total += 1;
    if (p.status === 'succeeded') r.succeeded += 1;
    if (isCard(p)) {
      if (p.status === 'failed') r.card_failed += 1;
      if (p.status === 'pending' && ageMin(p) >= 60) r.card_stuck += 1;
    } else if (p.status === 'pending' && ageMin(p) >= STUCK_MIN) {
      r.stuck += 1;
      r.stuck_oldest_min = Math.max(r.stuck_oldest_min, ageMin(p));
      r.stuck_amount[p.currency] = Math.round(((r.stuck_amount[p.currency] || 0) + Number(p.amount)) * 100) / 100;
      const a = paymentHealth.lastAnswer(p.id);
      const k = a ? a.kind : 'none';
      r.kinds[k] = (r.kinds[k] || 0) + 1;
    }
  }
  // integration errors on the payment routes (what a merchant gets while integrating)
  const calls = await apiCallLog.recent({ sinceIso: new Date(Date.now() - 7 * day).toISOString(), limit: 5000 }).catch(() => []);
  const errs = new Map();
  for (const c of calls) {
    if (c.status < 400 || !/payments/.test(String(c.route || c.path || '')) || (mode === 'live' ? c.mode !== 'live' : c.mode === 'live')) continue;
    const e = errs.get(c.merchant_id) || { total: 0, codes: {}, last: null };
    e.total += 1;
    e.codes[c.code || `HTTP_${c.status}`] = (e.codes[c.code || `HTTP_${c.status}`] || 0) + 1;
    if (!e.last) e.last = c;
    errs.set(c.merchant_id, e);
  }
  for (const id of errs.keys()) row(id);
  const ids = [...per.keys()];
  const names = {};
  for (let i = 0; i < ids.length; i += 100) for (const m of await supabase.select('merchants', { id: supabase.inList(ids.slice(i, i + 100)) }, { select: 'id,business_name,email', limit: 200 })) names[m.id] = m;
  const merchants = ids.map((id) => {
    const r = per.get(id);
    const e = errs.get(id) || { total: 0, codes: {}, last: null };
    const hook = hookOf.get(id);
    const problems = [];
    if (r.stuck) problems.push(`${r.stuck} paiement(s) MonCash/Natcash en attente`);
    if (r.card_failed >= 3 && r.succeeded === 0) problems.push(`${r.card_failed} paiement(s) par carte échoué(s)`);
    if (r.card_stuck) problems.push(`${r.card_stuck} paiement(s) par carte bloqué(s)`);
    if (e.total) problems.push(`${e.total} erreur(s) d'intégration`);
    if (r.stuck && !hook) problems.push('aucun webhook');
    return {
      merchant_id: id, business_name: names[id] ? names[id].business_name : null, email: names[id] ? names[id].email : null,
      total: r.total, succeeded: r.succeeded, stuck: r.stuck, stuck_oldest_min: r.stuck_oldest_min, stuck_amount: r.stuck_amount, partner_answers: r.kinds,
      card_failed: r.card_failed, card_stuck: r.card_stuck, integration_errors: e.total, integration_codes: e.codes, last_integration_error: e.last ? describe({ at: e.last.created_at, route: e.last.route, status: e.last.status, code: e.last.code, message: e.last.message }) : null,
      webhook: hook ? { url: hook.url, active: hook.active !== false } : null, problems,
    };
  }).filter((m) => m.problems.length).sort((a, b) => (b.stuck + b.card_stuck + b.card_failed + b.integration_errors) - (a.stuck + a.card_stuck + a.card_failed + a.integration_errors));
  return { status: 200, body: { mode, stuck_after_min: STUCK_MIN, merchants } };
}

/** GET /admin/payments/problems/:merchantId : every transaction of the merchant, what the partner last answered, and its integration errors. */
async function detail(ctx) {
  const merchant = await supabase.selectOne('merchants', { id: ctx.params.merchantId });
  if (!merchant) throw httpError(404, 'NOT_FOUND', 'Marchand introuvable.');
  const mode = modeOf(ctx);
  const rows = await supabase.select('payments', { merchant_id: merchant.id, mode }, { order: 'created_at.desc', limit: 300 });
  const calls = await apiCallLog.recent({ merchantId: merchant.id, sinceIso: new Date(Date.now() - 7 * day).toISOString(), limit: 1500 }).catch(() => []);
  const hook = await supabase.selectOne('webhook_endpoints', { merchant_id: merchant.id });
  // Where do this merchant's payments really go? (A merchant who thinks he is in Live while his key or site is on Sandbox shows up here.)
  const everywhere = await supabase.select('payments', { merchant_id: merchant.id }, { order: 'created_at.desc', limit: 1000 });
  const byMode = {};
  for (const p of everywhere) { const m = p.mode || 'sandbox'; byMode[m] = byMode[m] || { total: 0, pending: 0, succeeded: 0, failed: 0, last_at: null }; byMode[m].total += 1; byMode[m][p.status] = (byMode[m][p.status] || 0) + 1; byMode[m].last_at = byMode[m].last_at || p.created_at; }
  const causes = {};
  for (const p of rows.filter((x) => isCard(x) && x.status === 'failed')) { const k = String(p.failure_reason || 'raison inconnue').slice(0, 100); causes[k] = (causes[k] || 0) + 1; }
  const errors = calls.filter((c) => c.status >= 400 && /payments/.test(String(c.route || c.path || ''))).slice(0, 30).map((c) => describe({ at: c.created_at, method: c.method, route: c.route, status: c.status, code: c.code, message: c.message, mode: c.mode }));
  return {
    status: 200,
    body: {
      mode,
      merchant: { id: merchant.id, business_name: merchant.business_name, email: merchant.email, gateway_live_enabled: !!merchant.gateway_live_enabled },
      webhook: hook ? { url: hook.url, active: hook.active !== false } : null,
      by_mode: byMode,
      card_failure_causes: causes,
      counts: rows.reduce((o, p) => Object.assign(o, { [p.status]: (o[p.status] || 0) + 1 }), {}),
      transactions: rows.map((p) => ({
        id: p.id, reference: p.own_reference, method: p.method, provider: p.provider || 'plopplop', amount: Number(p.amount), currency: p.currency, status: p.status,
        fee: p.fee == null ? null : Number(p.fee), failure_reason: p.failure_reason || null, age_min: ageMin(p), created_at: p.created_at,
        customer: p.customer_name || p.customer_phone || p.customer_email || null, partner: p.status === 'pending' ? answerOf(p) : null,
      })),
      integration_errors: errors,
    },
  };
}

/** Asks the partner again about one payment. It is credited only if the partner confirms it (the same path as the background pass). */
async function recheckOne(payment) {
  const before = payment.status;
  let after = payment;
  let error = null;
  try { after = (await paymentOrchestrator.refreshStatus(payment.merchant_id, payment)) || payment; } catch (err) { error = err.message; }
  return { id: payment.id, reference: payment.own_reference, amount: Number(payment.amount), currency: payment.currency, before, after: after.status, settled: before === 'pending' && after.status !== 'pending', partner: answerOf(payment), error };
}

/** POST /admin/payments/:id/recheck */
async function recheckPayment(ctx) {
  const p = await supabase.selectOne('payments', { id: ctx.params.id });
  if (!p) throw httpError(404, 'NOT_FOUND', 'Paiement introuvable.');
  if (p.status !== 'pending') return { status: 200, body: { id: p.id, before: p.status, after: p.status, settled: false, note: 'Ce paiement est déjà réglé.' } };
  return { status: 200, body: await recheckOne(p) };
}

/** POST /admin/payments/problems/:merchantId/recheck : the oldest pending payments of the merchant, asked one by one (up to 30). */
async function recheckMerchant(ctx) {
  const mode = ctx.body && ctx.body.mode === 'sandbox' ? 'sandbox' : 'live';
  const pending = (await supabase.select('payments', { merchant_id: ctx.params.merchantId, mode, status: 'pending' }, { order: 'created_at.asc', limit: 30 }));
  const results = [];
  for (const p of pending) {
    results.push(await recheckOne(p));
    await new Promise((r) => setTimeout(r, 300)); // gentle with the partner
  }
  const kinds = {};
  for (const r of results) { const k = r.partner ? r.partner.kind : 'none'; kinds[k] = (kinds[k] || 0) + 1; }
  return { status: 200, body: { checked: results.length, settled: results.filter((r) => r.settled).length, partner_answers: kinds, results } };
}

module.exports = { overview, detail, recheckPayment, recheckMerchant };
