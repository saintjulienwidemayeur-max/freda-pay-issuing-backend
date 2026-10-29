'use strict';
const supabase = require('../lib/supabase');
const haitiTime = require('../utils/haitiTime');

/**
 * A journal of the public API calls, one line per call (admin "Journal API"). Lines wait in memory and are saved in groups every
 * few seconds, so a call never waits for the database. Only what is needed to understand a failure is kept: the route, the status,
 * the error code and its message, the duration and a request id the merchant can quote. NEVER a request or response body (those
 * hold API keys, ID images and card data). Lines older than RETENTION_DAYS are deleted.
 */
const RETENTION_DAYS = 14;
const buffer = [];
const MAX_BUFFER = 3000;
let flushing = false;
let lastWarn = 0;

function record(e) {
  if (!e || !e.merchantId) return;
  buffer.push({
    created_at: new Date().toISOString(), merchant_id: e.merchantId, method: e.method, route: String(e.route || '').slice(0, 120),
    path: String(e.path || '').slice(0, 200), status: e.status, code: e.code || null, message: e.message ? String(e.message).slice(0, 300) : null,
    ms: e.ms == null ? null : Math.round(e.ms), mode: e.mode || null, request_id: e.requestId || null,
  });
  if (buffer.length > MAX_BUFFER) buffer.shift();
}

async function flush() {
  if (flushing || !buffer.length) return;
  flushing = true;
  const batch = buffer.splice(0, 300);
  try {
    await supabase.insert('api_call_log', batch);
  } catch (err) {
    buffer.unshift(...batch); // try again later
    if (Date.now() - lastWarn > 10 * 60 * 1000) {
      lastWarn = Date.now();
      // eslint-disable-next-line no-console
      console.error('API call journal could not be saved (is the api_call_log table created?):', err.message);
    }
  } finally { flushing = false; }
}

async function purge() {
  try {
    await supabase.delete('api_call_log', { created_at: supabase.lt(new Date(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000).toISOString()) });
  } catch (err) { /* table missing: nothing to purge */ }
}

function start() {
  const t = setInterval(flush, 5 * 1000);
  if (t.unref) t.unref();
  const p = setInterval(purge, 6 * 3600 * 1000);
  if (p.unref) p.unref();
  purge();
}

async function readRows(filters, limit) {
  let rows = [];
  try { rows = await supabase.select('api_call_log', filters, { order: 'created_at.desc', limit }); } catch (err) { rows = []; }
  return rows;
}

/** Saved lines plus what still waits in memory, newest first, with the merchant / time filters applied. */
async function recent({ merchantId, sinceIso, limit }) {
  const filters = {};
  if (merchantId) filters.merchant_id = merchantId;
  if (sinceIso) filters.created_at = supabase.gte(sinceIso);
  const saved = await readRows(filters, limit || 1000);
  const waiting = buffer.filter((r) => (!merchantId || r.merchant_id === merchantId) && (!sinceIso || r.created_at >= sinceIso));
  const seen = new Set(saved.map((r) => `${r.request_id}|${r.created_at}`));
  return waiting.filter((r) => !seen.has(`${r.request_id}|${r.created_at}`)).concat(saved).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, limit || 1000);
}

/** One row per merchant over the last `days` days: calls, errors, the last error and its code. */
async function merchants(days) {
  const rows = await recent({ sinceIso: new Date(Date.now() - (days || 7) * 24 * 3600 * 1000).toISOString(), limit: 20000 });
  const map = new Map();
  for (const r of rows) {
    let m = map.get(r.merchant_id);
    if (!m) { m = { merchant_id: r.merchant_id, calls: 0, errors: 0, last_call_at: r.created_at, last_error: null, codes: {} }; map.set(r.merchant_id, m); }
    m.calls += 1;
    if (r.status >= 400) {
      m.errors += 1;
      if (!m.last_error) m.last_error = { at: r.created_at, status: r.status, code: r.code, route: r.route, message: r.message };
      if (r.code) m.codes[r.code] = (m.codes[r.code] || 0) + 1;
    }
  }
  return [...map.values()].sort((a, b) => b.errors - a.errors || (a.last_call_at < b.last_call_at ? 1 : -1));
}

const atHaiti = (iso) => haitiTime.format ? haitiTime.format(iso) : iso;

module.exports = { record, flush, start, recent, merchants, atHaiti, RETENTION_DAYS };
