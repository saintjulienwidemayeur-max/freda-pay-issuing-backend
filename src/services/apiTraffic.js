'use strict';

/**
 * Live view of who calls the public API (/v1/...) and how hard: an in-memory log of the last five minutes of requests per
 * merchant. Nothing is stored: it resets when the server restarts and covers this instance only (one on Render today).
 */
const WINDOW_MS = 5 * 60 * 1000;
const MAX_EVENTS = 4000;           // per merchant, so a runaway client cannot grow memory
const IDLE_DROP_MS = 10 * 60 * 1000;
const UNKNOWN = '_unauthenticated';

const perMerchant = new Map();     // merchantId -> { events: [{t, route, status, ip, mode}], last }

function record({ merchantId, route, status, ip, mode }) {
  const now = Date.now();
  const key = merchantId || UNKNOWN;
  let m = perMerchant.get(key);
  if (!m) { m = { events: [], last: now }; perMerchant.set(key, m); }
  m.last = now;
  m.events.push({ t: now, route: route || '?', status: Number(status) || 0, ip: ip || '', mode: mode || '' });
  if (m.events.length > MAX_EVENTS) m.events.splice(0, m.events.length - MAX_EVENTS);
}

function prune(now) {
  for (const [key, m] of perMerchant) {
    const cut = now - WINDOW_MS;
    let i = 0;
    while (i < m.events.length && m.events[i].t < cut) i++;
    if (i) m.events.splice(0, i);
    if (!m.events.length && now - m.last > IDLE_DROP_MS) perMerchant.delete(key);
  }
}

function summarize(events, now) {
  const inLast = (ms) => events.filter((e) => e.t >= now - ms);
  const last5s = inLast(5000);
  const last60 = inLast(60000);
  const perSecond = new Map();
  for (const e of events) { const s = Math.floor(e.t / 1000); perSecond.set(s, (perSecond.get(s) || 0) + 1); }
  const peak = perSecond.size ? Math.max(...perSecond.values()) : 0;
  const routes = new Map();
  for (const e of last60) routes.set(e.route, (routes.get(e.route) || 0) + 1);
  const ips = new Map();
  for (const e of events) if (e.ip) ips.set(e.ip, (ips.get(e.ip) || 0) + 1);
  const last = events[events.length - 1];
  return {
    rps_now: Math.round((last5s.length / 5) * 10) / 10,
    rps_peak_5min: peak,
    req_60s: last60.length,
    req_5min: events.length,
    limited_5min: events.filter((e) => e.status === 429).length,
    errors_5min: events.filter((e) => e.status >= 400 && e.status !== 429).length,
    live_5min: events.filter((e) => e.mode === 'live').length,
    sandbox_5min: events.filter((e) => e.mode === 'sandbox').length,
    top_endpoints: [...routes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([route, count]) => ({ route, count })),
    top_ips: [...ips.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([ip, count]) => ({ ip, count })),
    last_seen: last ? new Date(last.t).toISOString() : null,
  };
}

/** Snapshot for the admin panel: per merchant (busiest first), the unauthenticated calls, and the totals. */
function snapshot() {
  const now = Date.now();
  prune(now);
  const merchants = [];
  let all = [];
  let unauthenticated = null;
  for (const [key, m] of perMerchant) {
    all = all.concat(m.events);
    const s = summarize(m.events, now);
    if (key === UNKNOWN) { unauthenticated = s; continue; }
    merchants.push(Object.assign({ merchant_id: key }, s));
  }
  merchants.sort((a, b) => b.rps_now - a.rps_now || b.req_60s - a.req_60s);
  const total = summarize(all, now);
  return {
    window_seconds: WINDOW_MS / 1000,
    generated_at: new Date(now).toISOString(),
    total: { rps_now: total.rps_now, rps_peak_5min: total.rps_peak_5min, req_60s: total.req_60s, req_5min: total.req_5min, limited_5min: total.limited_5min },
    unauthenticated,
    merchants,
  };
}

function reset() { perMerchant.clear(); }

module.exports = { record, snapshot, reset };
