'use strict';
const supabase = require('../lib/supabase');
const rateLimit = require('../utils/rateLimit');

/**
 * Where each signup came from: address, browser / tool (user-agent), and the website that sent it (Origin or Referer). Kept as a rolling list of the
 * last 1000 signups in platform_settings (no migration). Signup is a public endpoint with no account behind it: this is the only trace of who called it.
 */
const KEY = 'signup_log';
const MAX = 1000;
const SITE = /(^|\.)fredapay\.com$/i;

function hostOf(v) { try { return new URL(String(v)).hostname; } catch (e) { return ''; } }

function describe(req) {
  const h = (req && req.headers) || {};
  const origin = hostOf(h.origin) || hostOf(h.referer) || '';
  return { ip: rateLimit.clientIp(req) || null, ua: String(h['user-agent'] || '').slice(0, 200) || null, origin: origin || null, from_site: !!origin && SITE.test(origin) };
}

async function read() {
  const row = await supabase.selectOne('platform_settings', { key: KEY }).catch(() => null);
  try { const v = row ? JSON.parse(row.value) : []; return Array.isArray(v) ? v : []; } catch (e) { return []; }
}

/** Best effort: a failure here never blocks a signup. */
async function record(req, merchantId) {
  try {
    const list = await read();
    list.unshift(Object.assign({ merchant_id: merchantId, at: new Date().toISOString() }, describe(req)));
    list.length = Math.min(list.length, MAX);
    const row = { value: JSON.stringify(list), updated_at: new Date().toISOString() };
    if (await supabase.selectOne('platform_settings', { key: KEY })) await supabase.update('platform_settings', { key: KEY }, row);
    else await supabase.insert('platform_settings', Object.assign({ key: KEY }, row));
  } catch (e) { /* optional trace */ }
}

async function summary(limit) {
  const list = await read();
  const ids = [...new Set(list.map((s) => s.merchant_id))];
  const merchants = ids.length ? await supabase.select('merchants', { id: supabase.inList(ids) }, { limit: 2000 }).catch(() => []) : [];
  const by = new Map(merchants.map((m) => [m.id, m]));
  const emailRisk = require('../utils/emailRisk');
  const recent = list.slice(0, limit || 200).map((s) => { const m = by.get(s.merchant_id) || {}; return Object.assign({}, s, { business_name: m.business_name || null, email: m.email || null, flags: m.id ? emailRisk.flagsFor(m) : [], suspended: !!m.deleted_at }); });
  const ips = new Map();
  for (const s of list) {
    const k = s.ip || '?';
    const g = ips.get(k) || { ip: k, count: 0, first: s.at, last: s.at, from_site: 0, user_agents: new Set(), merchant_ids: [] };
    g.count += 1; if (s.at < g.first) g.first = s.at; if (s.at > g.last) g.last = s.at; if (s.from_site) g.from_site += 1;
    if (s.ua) g.user_agents.add(s.ua.slice(0, 80)); if (g.merchant_ids.length < 20) g.merchant_ids.push(s.merchant_id);
    ips.set(k, g);
  }
  const by_ip = [...ips.values()].map((g) => ({ ip: g.ip, count: g.count, first: g.first, last: g.last, from_site: g.from_site, user_agents: [...g.user_agents].slice(0, 3), merchant_ids: g.merchant_ids })).sort((a, b) => b.count - a.count).slice(0, 50);
  return { total: list.length, since: list.length ? list[list.length - 1].at : null, recent, by_ip };
}

module.exports = { record, summary, describe };
