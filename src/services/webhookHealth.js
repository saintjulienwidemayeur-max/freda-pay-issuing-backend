'use strict';

/** Outcome of the webhook deliveries to each merchant's server (last 24 h, in memory): used by the admin integration health view. */
const WINDOW_MS = 24 * 60 * 60 * 1000;
const stats = new Map(); // merchantId -> { ok: [t], failed: [{t, error}], lastOk, lastFailed }

function record(merchantId, ok, error) {
  if (!merchantId) return;
  const s = stats.get(merchantId) || { ok: [], failed: [], lastOk: null, lastFailed: null };
  const now = Date.now();
  if (ok) { s.ok.push(now); s.lastOk = now; } else { s.failed.push({ t: now, error: String(error || '').slice(0, 160) }); s.lastFailed = now; }
  const cut = now - WINDOW_MS;
  s.ok = s.ok.filter((t) => t >= cut).slice(-500);
  s.failed = s.failed.filter((f) => f.t >= cut).slice(-500);
  stats.set(merchantId, s);
}

function get(merchantId) {
  const s = stats.get(merchantId);
  if (!s) return { delivered_24h: 0, failed_24h: 0, last_ok: null, last_failed: null, last_error: null };
  const cut = Date.now() - WINDOW_MS;
  const failed = s.failed.filter((f) => f.t >= cut);
  return {
    delivered_24h: s.ok.filter((t) => t >= cut).length, failed_24h: failed.length,
    last_ok: s.lastOk ? new Date(s.lastOk).toISOString() : null, last_failed: s.lastFailed ? new Date(s.lastFailed).toISOString() : null,
    last_error: failed.length ? failed[failed.length - 1].error : null,
  };
}

function reset() { stats.clear(); }

module.exports = { record, get, reset };
