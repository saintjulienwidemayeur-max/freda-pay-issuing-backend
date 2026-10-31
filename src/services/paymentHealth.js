'use strict';
const supabase = require('../lib/supabase');

/**
 * Diagnostic of the MonCash / Natcash payments that are still pending: what the partner last answered for each one (kept in
 * memory on this instance), how the background pass is doing, and which payments deserve a human look. The admin panel reads
 * snapshot(); stuck payments also raise an email alert (see alertIfStuck).
 */
const answers = new Map(); // payment id -> { at, http_status, trans_status, message, kind }
const run = { lastRunAt: null, lastChecked: 0, lastSettled: 0, runs: 0, errors: 0, lastError: null, lastErrorAt: null };

/**
 * The partner's payment status word, normalised (case and spaces do not matter: "OK", "ok " and "Ok" are the same answer).
 * Settling a payment and the admin diagnostic both read it through these two helpers, so they can never disagree.
 */
const CONFIRMED = new Set(['ok', 'success', 'successful', 'succeeded', 'completed', 'complete', 'paid', 'confirmed', 'approved']);
const WAITING = new Set(['no', 'pending', '', 'waiting', 'processing', 'initiated', 'created']);
function transStatusOf(d) { return String(d && d.trans_status != null ? d.trans_status : '').trim().toLowerCase(); }
function isConfirmed(d) { return !!d && CONFIRMED.has(transStatusOf(d)); }
function isWaiting(d) { return !!d && WAITING.has(transStatusOf(d)); }

function classify(res) {
  const d = res && res.data;
  const httpStatus = (res && res.httpStatus) || null;
  const msg = d && d.message ? String(d.message) : '';
  if (!d) return 'unreadable';
  if (isConfirmed(d)) return 'confirmed';
  if (!d.status && (httpStatus === 404 || /introuvable|not found/i.test(msg))) return 'not_found';
  if (!d.status) return 'error';
  if (isWaiting(d)) return 'waiting';
  return 'unexpected';
}

function note(payment, res) {
  const d = (res && res.data) || {};
  const entry = { at: Date.now(), http_status: (res && res.httpStatus) || null, trans_status: d.trans_status == null ? null : d.trans_status, message: d.message || null, kind: classify(res) };
  answers.set(payment.id, entry);
  if (answers.size > 5000) answers.delete(answers.keys().next().value);
  return entry;
}

function forget(paymentId) { answers.delete(paymentId); }
function lastAnswer(paymentId) { return answers.get(paymentId) || null; }

function recordRun({ checked, settled, error }) {
  run.runs += 1;
  run.lastRunAt = new Date().toISOString();
  run.lastChecked = checked || 0;
  run.lastSettled = settled || 0;
  if (error) { run.errors += 1; run.lastError = String(error).slice(0, 300); run.lastErrorAt = run.lastRunAt; }
}

const LABEL = {
  none: 'Pas encore relu depuis le dernier démarrage du serveur',
  confirmed: 'Confirmé chez le partenaire (le crédit devrait suivre)',
  waiting: 'En attente du client chez le partenaire',
  not_found: 'Introuvable chez le partenaire',
  unexpected: 'Réponse inattendue du partenaire',
  error: 'Le partenaire répond une erreur',
  unreadable: 'Réponse du partenaire illisible',
};

async function snapshot() {
  const since = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  const rows = (await supabase.select('payments', { status: 'pending', created_at: supabase.gt(since) }, { order: 'created_at.desc', limit: 300 })).filter((p) => p.provider !== 'tranzak');
  const now = Date.now();
  const items = rows.filter((p) => p.plopplop_reference).map((p) => {
    const ageMin = Math.round((now - new Date(p.created_at).getTime()) / 60000);
    const a = lastAnswer(p.id);
    const kind = a ? a.kind : 'none';
    let level = 'ok';
    if (kind === 'waiting') level = ageMin >= 120 ? 'info' : 'ok';
    else if (kind === 'none') level = ageMin >= 30 ? 'warn' : 'ok';
    else if (kind === 'confirmed') level = ageMin >= 5 ? 'bad' : 'ok';
    else level = ageMin >= 10 ? 'bad' : 'warn';
    return {
      id: p.id, merchant_id: p.merchant_id, method: p.method, amount: Number(p.amount), currency: p.currency, mode: p.mode, own_reference: p.own_reference,
      age_min: ageMin, level, kind, label: LABEL[kind],
      partner: a ? { at: new Date(a.at).toISOString(), http_status: a.http_status, trans_status: a.trans_status, message: a.message } : null,
    };
  });
  return {
    background: Object.assign({}, run),
    pending_total: items.length,
    to_check: items.filter((i) => i.level === 'bad' || i.level === 'warn').length,
    items: items.sort((x, y) => ({ bad: 0, warn: 1, info: 2, ok: 3 }[x.level] - { bad: 0, warn: 1, info: 2, ok: 3 }[y.level]) || y.age_min - x.age_min).slice(0, 100),
  };
}

module.exports = { note, forget, lastAnswer, recordRun, snapshot, classify, isConfirmed, isWaiting, transStatusOf, LABEL };
