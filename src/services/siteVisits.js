'use strict';
const crypto = require('crypto');
const config = require('../config');
const supabase = require('../lib/supabase');

/**
 * Audience of the PUBLIC website, without cookies and without storing IP addresses.
 * A visitor is recognised by HMAC(secret, ip + browser): the same person on the same device counts once per period,
 * and the address cannot be recovered from the stored value.
 */
const TRACKED_PATHS = new Set(['/', '/api-moncash-natcash', '/cartes-virtuelles-haiti', '/docs', '/signup', '/notre-equipe', '/press-kit', '/regulatory-disclosure', '/terms', '/privacy', '/cookie-policy', '/blog']);
const BOT = /bot|crawl|spider|slurp|bing|facebookexternalhit|preview|headless|lighthouse|pingdom|uptime|monitor|curl|wget|python-requests|axios|node-fetch|go-http/i;

function secret() { return process.env.VISITOR_HASH_SECRET || config.sessionSecret; }

function normalizePath(p) {
  let path = String(p || '/').split(/[?#]/)[0].replace(/\.html$/, '');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (path === '/index') path = '/';
  if (path.startsWith('/blog/')) return '/blog/*'; // all articles together; the admin sees "blog" as one line
  return TRACKED_PATHS.has(path) ? path : null;
}

function referrerHost(ref, ownHost) {
  try {
    const h = new URL(ref).hostname.replace(/^www\./, '');
    return h && h !== ownHost && !h.endsWith('fredapay.com') ? h.slice(0, 80) : null;
  } catch (e) { return null; }
}

/** Records one page view. Returns false when it is ignored (robot, unknown page, browser asking not to be tracked). */
async function record({ ip, userAgent, path, referrer, now = new Date() }) {
  if (!userAgent || BOT.test(userAgent)) return false;
  const clean = normalizePath(path);
  if (!clean) return false;
  const visitor = crypto.createHmac('sha256', secret()).update(`${ip}|${userAgent}`).digest('hex').slice(0, 32);
  await supabase.insert('site_visits', {
    day: now.toISOString().slice(0, 10),
    visitor_hash: visitor,
    path: clean,
    referrer_host: referrerHost(referrer, ''),
    device: /mobile|android|iphone|ipad/i.test(userAgent) ? 'mobile' : 'desktop',
  });
  return true;
}

const dayKey = (d) => d;
function weekKey(day) { // ISO week, Monday-based, from a YYYY-MM-DD string
  const d = new Date(`${day}T00:00:00Z`);
  const n = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - n);
  const y = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return `${d.getUTCFullYear()}-W${String(Math.ceil(((d - y) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}
const monthKey = (day) => day.slice(0, 7);

function bucketize(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r.day);
    const b = m.get(k) || { views: 0, visitors: new Set() };
    b.views += 1; b.visitors.add(r.visitor_hash);
    m.set(k, b);
  }
  return m;
}
const shape = (m, keys) => keys.map((k) => ({ key: k, views: (m.get(k) || { views: 0 }).views, visitors: m.get(k) ? m.get(k).visitors.size : 0 }));

async function loadRows(sinceDay) {
  const out = [];
  for (let offset = 0; offset < 200000; offset += 1000) {
    const page = await supabase.select('site_visits', { day: supabase.gte(sinceDay) }, { select: 'day,visitor_hash,path,referrer_host,device', order: 'day.asc', limit: 1000, offset });
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

const addDays = (day, n) => new Date(new Date(`${day}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

/** Visits per day / week / month and the totals the admin overview shows. Days are UTC, like the rest of the panel. */
async function stats(now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const rows = await loadRows(addDays(today, -366));
  const days = Array.from({ length: 30 }, (_, i) => addDays(today, i - 29));
  const weeks = []; for (let i = 11; i >= 0; i -= 1) { const k = weekKey(addDays(today, -7 * i)); if (!weeks.includes(k)) weeks.push(k); }
  const months = []; for (let i = 11; i >= 0; i -= 1) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)); months.push(d.toISOString().slice(0, 7)); }

  const within = (n) => rows.filter((r) => r.day >= addDays(today, -(n - 1)));
  const total = (list) => ({ views: list.length, visitors: new Set(list.map((r) => r.visitor_hash)).size });
  const last30 = within(30);
  const countBy = (list, f, limit) => {
    const c = new Map(); for (const r of list) { const k = f(r); if (k) c.set(k, (c.get(k) || 0) + 1); }
    return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name, views]) => ({ name, views }));
  };
  return {
    today: total(rows.filter((r) => r.day === today)),
    last_7_days: total(within(7)),
    last_30_days: total(last30),
    this_month: total(rows.filter((r) => monthKey(r.day) === monthKey(today))),
    last_365_days: total(rows),
    by_day: shape(bucketize(rows, dayKey), days).map(({ key, ...x }) => ({ date: key, ...x })),
    by_week: shape(bucketize(rows, weekKey), weeks).map(({ key, ...x }) => ({ week: key, ...x })),
    by_month: shape(bucketize(rows, monthKey), months).map(({ key, ...x }) => ({ month: key, ...x })),
    top_pages_30d: countBy(last30, (r) => r.path, 8),
    top_referrers_30d: countBy(last30, (r) => r.referrer_host, 8),
    devices_30d: countBy(last30, (r) => r.device, 2),
  };
}

module.exports = { record, stats, normalizePath, TRACKED_PATHS };
