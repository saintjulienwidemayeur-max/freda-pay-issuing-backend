'use strict';
const supabase = require('../lib/supabase');

/**
 * Public API usage kept per merchant and per day (Haiti time), so the admin panel can show days, weeks and months (the live
 * five-minute view is apiTraffic). Requests are counted in memory and added to the database every 30 s: a restart loses
 * at most that much, and SIGTERM flushes first.
 */
const pending = new Map(); // `${merchantId}|${day}` -> { merchantId, day, requests, limited, errors, live, sandbox }
const MAX_PENDING = 5000;
let lastWarn = 0;

const dayOf = (t) => require('../utils/haitiTime').day(t); // the day changes at midnight in Haiti

function add({ merchantId, status, mode, code }) {
  if (!merchantId) return;
  const day = dayOf(Date.now());
  const key = `${merchantId}|${day}`;
  let p = pending.get(key);
  if (!p) {
    if (pending.size >= MAX_PENDING) return;
    p = { merchantId, day, requests: 0, limited: 0, errors: 0, live: 0, sandbox: 0, codes: {} };
    pending.set(key, p);
  }
  p.requests += 1;
  if (status === 429) p.limited += 1;
  else if (status >= 400) p.errors += 1;
  if (mode === 'live') p.live += 1; else if (mode) p.sandbox += 1;
  if (code && status >= 400) p.codes[code] = (p.codes[code] || 0) + 1;
}

const mergeCodes = (a, b) => { const o = Object.assign({}, a || {}); for (const [k, v] of Object.entries(b || {})) o[k] = (o[k] || 0) + v; return o; };

let flushing = false;
async function flush() {
  if (flushing || !pending.size) return;
  flushing = true;
  try {
    for (const [key, p] of [...pending]) {
      try {
        const row = await supabase.selectOne('api_usage_daily', { merchant_id: p.merchantId, day: p.day });
        const now = new Date().toISOString();
        if (row) {
          await supabase.update('api_usage_daily', { merchant_id: p.merchantId, day: p.day }, {
            requests: row.requests + p.requests, limited: row.limited + p.limited, errors: row.errors + p.errors,
            live: row.live + p.live, sandbox: row.sandbox + p.sandbox, codes: mergeCodes(row.codes, p.codes), updated_at: now,
          });
        } else {
          await supabase.insert('api_usage_daily', { merchant_id: p.merchantId, day: p.day, requests: p.requests, limited: p.limited, errors: p.errors, live: p.live, sandbox: p.sandbox, codes: p.codes, updated_at: now });
        }
        pending.delete(key);
      } catch (err) {
        if (Date.now() - lastWarn > 10 * 60 * 1000) {
          lastWarn = Date.now();
          // eslint-disable-next-line no-console
          console.error('API usage could not be saved (is the api_usage_daily table created?):', err.message);
        }
        break; // keep the counts and try again next time
      }
    }
  } finally { flushing = false; }
}

function start() {
  const t = setInterval(flush, 30 * 1000);
  if (t.unref) t.unref();
}

/** Daily rows since `sinceDay` (YYYY-MM-DD), with what is still waiting in memory added on top. */
async function rows(sinceDay, merchantId) {
  const filters = { day: require('../lib/supabase').gte(sinceDay) };
  if (merchantId) filters.merchant_id = merchantId;
  let list = [];
  try { list = await supabase.select('api_usage_daily', filters, { limit: 20000 }); } catch (err) { /* table missing: only memory */ }
  const merged = new Map(list.map((r) => [`${r.merchant_id}|${r.day}`, Object.assign({}, r)]));
  for (const p of pending.values()) {
    if (p.day < sinceDay || (merchantId && p.merchantId !== merchantId)) continue;
    const k = `${p.merchantId}|${p.day}`;
    const r = merged.get(k) || { merchant_id: p.merchantId, day: p.day, requests: 0, limited: 0, errors: 0, live: 0, sandbox: 0, codes: {} };
    r.codes = mergeCodes(r.codes, p.codes);
    r.requests += p.requests; r.limited += p.limited; r.errors += p.errors; r.live += p.live; r.sandbox += p.sandbox;
    merged.set(k, r);
  }
  return [...merged.values()];
}

/** Monday of the UTC week of a YYYY-MM-DD day. */
function weekStart(day) {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

function reset() { pending.clear(); }

module.exports = { add, flush, start, rows, weekStart, dayOf, reset };
