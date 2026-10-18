'use strict';
const supabase = require('../lib/supabase');
const apiTraffic = require('../services/apiTraffic');
const apiUsage = require('../services/apiUsage');
const apiBlocks = require('../services/apiBlocks');
const apiKeyMiddleware = require('../middleware/apiKey');
const { API_RATE_LIMIT } = require('../router');

/** Who is calling the public API right now, and how many requests per second (last five minutes, this instance). */
async function snapshot() {
  const snap = apiTraffic.snapshot();
  const ids = snap.merchants.map((m) => m.merchant_id);
  const names = {};
  if (ids.length) {
    const rows = await supabase.select('merchants', { id: supabase.inList(ids) }, { select: 'id,business_name,email', limit: 200 });
    for (const r of rows) names[r.id] = r;
  }
  return {
    status: 200,
    body: Object.assign(snap, {
      limit_per_minute: API_RATE_LIMIT,
      merchants: snap.merchants.map((m) => Object.assign({}, m, {
        business_name: (names[m.merchant_id] && names[m.merchant_id].business_name) || null,
        email: (names[m.merchant_id] && names[m.merchant_id].email) || null,
        pct_of_limit: Math.round((m.req_60s / API_RATE_LIMIT) * 100),
        blocked: !!apiBlocks.get(m.merchant_id),
      })),
    }),
  };
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}
const iso = (d) => d.toISOString().slice(0, 10);
/** Today in Haiti as a Date at 00:00 UTC of that calendar day: all the day arithmetic below is then plain date maths. */
const haitiToday = () => new Date(`${require('../utils/haitiTime').day(Date.now())}T00:00:00Z`);
const addDays = (d, n) => { const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate() + n); return x; };
const monthStart = (d, back) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (back || 0), 1));
const blockView = (b) => (b ? { reason: b.reason, until: b.until ? new Date(b.until).toISOString() : null, blocked_at: b.blocked_at } : null);

async function namesFor(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 100) {
    const rows = await supabase.select('merchants', { id: supabase.inList(ids.slice(i, i + 100)) }, { select: 'id,business_name,email', limit: 200 });
    for (const r of rows) out[r.id] = r;
  }
  return out;
}

/** Every merchant that has created an API key, with requests today / 7 days / 30 days / this month / last month. */
async function usage() {
  await apiBlocks.refresh();
  const now = haitiToday();
  const today = iso(now), d7 = iso(addDays(now, -6)), d30 = iso(addDays(now, -29));
  const thisMonth = iso(monthStart(now, 0)), lastMonth = iso(monthStart(now, 1));
  const keys = await supabase.select('api_keys', {}, { select: 'id,merchant_id,mode,created_at,revoked_at', limit: 5000 });
  const byMerchant = new Map();
  for (const k of keys) {
    const m = byMerchant.get(k.merchant_id) || { active: 0, live: 0, test: 0, revoked: 0, last_created_at: null };
    if (k.revoked_at) m.revoked += 1; else { m.active += 1; if (k.mode === 'live') m.live += 1; else m.test += 1; }
    if (!m.last_created_at || k.created_at > m.last_created_at) m.last_created_at = k.created_at;
    byMerchant.set(k.merchant_id, m);
  }
  const rows = await apiUsage.rows(lastMonth);
  const sums = new Map();
  for (const r of rows) {
    const m = sums.get(r.merchant_id) || { today: 0, last7: 0, last30: 0, this_month: 0, last_month: 0, limited_30: 0, errors_30: 0, live_30: 0 };
    if (r.day === today) m.today += r.requests;
    if (r.day >= d7) m.last7 += r.requests;
    if (r.day >= d30) { m.last30 += r.requests; m.limited_30 += r.limited; m.errors_30 += r.errors; m.live_30 += r.live; }
    if (r.day >= thisMonth) m.this_month += r.requests; else if (r.day >= lastMonth) m.last_month += r.requests;
    sums.set(r.merchant_id, m);
  }
  const ids = [...new Set([...byMerchant.keys(), ...sums.keys()])];
  const names = ids.length ? await namesFor(ids) : {};
  const empty = { today: 0, last7: 0, last30: 0, this_month: 0, last_month: 0, limited_30: 0, errors_30: 0, live_30: 0 };
  const merchants = ids.map((id) => Object.assign({
    merchant_id: id, business_name: (names[id] && names[id].business_name) || null, email: (names[id] && names[id].email) || null,
    keys: byMerchant.get(id) || { active: 0, live: 0, test: 0, revoked: 0, last_created_at: null },
    block: blockView(apiBlocks.get(id)),
  }, sums.get(id) || empty)).sort((a, b) => b.this_month - a.this_month || b.today - a.today);
  const total = merchants.reduce((t, m) => ({ today: t.today + m.today, last7: t.last7 + m.last7, last30: t.last30 + m.last30, this_month: t.this_month + m.this_month }), { today: 0, last7: 0, last30: 0, this_month: 0 });
  return { status: 200, body: { generated_at: new Date().toISOString(), timezone: 'America/Port-au-Prince', limit_per_minute: API_RATE_LIMIT, total, merchants } };
}

/** One merchant: its keys, and requests per day (30), per week (12) and per month (6). */
async function usageDetail(ctx) {
  const id = String(ctx.params.merchantId);
  const merchant = await supabase.selectOne('merchants', { id });
  if (!merchant) throw httpError(404, 'MERCHANT_NOT_FOUND', 'Marchand introuvable.');
  const now = haitiToday();
  const since = iso(monthStart(now, 5));
  const rows = await apiUsage.rows(since, id);
  const by = new Map(rows.map((r) => [r.day, r]));
  const sum = (from, to) => rows.filter((r) => r.day >= from && r.day <= to).reduce((t, r) => ({ requests: t.requests + r.requests, limited: t.limited + r.limited, errors: t.errors + r.errors }), { requests: 0, limited: 0, errors: 0 });
  const daily = [];
  for (let i = 29; i >= 0; i--) { const day = iso(addDays(now, -i)); const r = by.get(day); daily.push({ day, requests: r ? r.requests : 0, limited: r ? r.limited : 0, errors: r ? r.errors : 0 }); }
  const weekly = [];
  const thisWeek = apiUsage.weekStart(iso(now));
  for (let i = 11; i >= 0; i--) { const start = iso(addDays(new Date(`${thisWeek}T00:00:00Z`), -7 * i)); weekly.push(Object.assign({ week_start: start }, sum(start, iso(addDays(new Date(`${start}T00:00:00Z`), 6))))); }
  const monthly = [];
  for (let i = 5; i >= 0; i--) { const start = monthStart(now, i), end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)); monthly.push(Object.assign({ month: iso(start).slice(0, 7) }, sum(iso(start), iso(end)))); }
  const keys = await supabase.select('api_keys', { merchant_id: id }, { select: 'id,key_id,mode,created_at,revoked_at', order: 'created_at.desc', limit: 50 });
  await apiBlocks.refresh();
  return { status: 200, body: { merchant: { id, business_name: merchant.business_name, email: merchant.email }, timezone: 'America/Port-au-Prince', keys, block: blockView(apiBlocks.get(id)), daily, weekly, monthly } };
}

/** Blocks the whole API access of a merchant (every key). hours: 1..8760, or empty for "until an admin lifts it". */
async function block(ctx) {
  const b = ctx.body || {};
  const merchantId = String(b.merchant_id || '');
  const merchant = merchantId && (await supabase.selectOne('merchants', { id: merchantId }));
  if (!merchant) throw httpError(404, 'MERCHANT_NOT_FOUND', 'Marchand introuvable.');
  let hours = null;
  if (b.hours != null && b.hours !== '') {
    hours = Number(b.hours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 8760) throw httpError(400, 'INVALID_DURATION', 'La durée doit être entre 1 heure et 365 jours.');
  }
  const reason = String(b.reason || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300) || null;
  const row = await apiBlocks.block({ merchantId, reason, hours, adminId: ctx.adminId });
  return { status: 200, body: { block: { merchant_id: merchantId, reason: row.reason, until: row.until, blocked_at: row.blocked_at } } };
}

async function unblock(ctx) {
  await apiBlocks.unblock(String(ctx.params.merchantId));
  return { status: 200, body: { ok: true } };
}

/** Permanently revokes one key (the merchant creates a new one if needed). */
async function revokeKey(ctx) {
  const key = await supabase.selectOne('api_keys', { id: String(ctx.params.id) });
  if (!key) throw httpError(404, 'KEY_NOT_FOUND', 'Clé introuvable.');
  if (!key.revoked_at) await supabase.update('api_keys', { id: key.id }, { revoked_at: new Date().toISOString() });
  apiKeyMiddleware.invalidateKey(key.id);
  return { status: 200, body: { ok: true } };
}

async function health() {
  return { status: 200, body: await require('../services/apiHealth').all() };
}

module.exports = { snapshot, usage, usageDetail, block, unblock, revokeKey, health };
