'use strict';
const supabase = require('../lib/supabase');
const rateLimit = require('../utils/rateLimit');

/**
 * The team's emergency brakes on signup (platform_settings "signup_guard"), editable from the admin panel:
 *  - paused: nobody can sign up;
 *  - require_site: only the website's own form (Origin / Referer on fredapay.com): a script calling the API directly is refused;
 *  - blocked_ips: addresses (a.b.c.d) or IPv4 ranges (a.b.c.d/24) refused;
 *  - blocked_domains: email domains refused on top of the built-in disposable list.
 * The answer never says which rule fired.
 */
const KEY = 'signup_guard';
const DEFAULTS = { paused: false, require_site: process.env.NODE_ENV === 'production', blocked_ips: [], blocked_domains: [] };
const SITE = /(^|\.)fredapay\.com$/i;
let cache = null; let at = 0;

async function settings() {
  if (cache && Date.now() - at < 10000) return cache;
  let saved = {};
  try { const row = await supabase.selectOne('platform_settings', { key: KEY }); if (row) saved = JSON.parse(row.value) || {}; } catch (e) { /* defaults */ }
  cache = Object.assign({}, DEFAULTS, saved); at = Date.now();
  return cache;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
function cleanIps(list) {
  const arr = Array.isArray(list) ? list : String(list || '').split(/[\s,;]+/);
  return [...new Set(arr.map((x) => String(x).trim()).filter((x) => /^(\d{1,3}(\.\d{1,3}){3}(\/(\d|[12]\d|3[0-2]))?|[0-9a-fA-F:]{3,45})$/.test(x)))].slice(0, 500);
}
function cleanDomains(list) {
  const arr = Array.isArray(list) ? list : String(list || '').split(/[\s,;]+/);
  return [...new Set(arr.map((x) => String(x).trim().toLowerCase().replace(/^@/, '')).filter((x) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(x)))].slice(0, 500);
}
async function save(patch, adminEmail) {
  const next = Object.assign({}, await settings());
  if (patch.paused !== undefined) next.paused = patch.paused === true;
  if (patch.require_site !== undefined) next.require_site = patch.require_site === true;
  if (patch.blocked_ips !== undefined) next.blocked_ips = cleanIps(patch.blocked_ips);
  if (patch.add_ip) next.blocked_ips = cleanIps([...(next.blocked_ips || []), patch.add_ip]);
  if (patch.blocked_domains !== undefined) next.blocked_domains = cleanDomains(patch.blocked_domains);
  const row = { value: JSON.stringify(next), updated_by: adminEmail || null, updated_at: new Date().toISOString() };
  if (await supabase.selectOne('platform_settings', { key: KEY })) await supabase.update('platform_settings', { key: KEY }, row);
  else await supabase.insert('platform_settings', Object.assign({ key: KEY }, row));
  cache = next; at = Date.now();
  return next;
}

const toInt = (ip) => ip.split('.').reduce((n, p) => (n * 256) + Number(p), 0);
function ipBlocked(ip, list) {
  if (!ip) return false;
  const clean = String(ip).replace(/^::ffff:/, '');
  for (const rule of list || []) {
    if (rule === clean) return true;
    const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(rule);
    if (m && IPV4.test(clean)) { const bits = Number(m[2]); const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0; if ((toInt(clean) & mask) >>> 0 === (toInt(m[1]) & mask) >>> 0) return true; }
  }
  return false;
}
function hostOf(v) { try { return new URL(String(v)).hostname; } catch (e) { return ''; } }
function siteOk(req) {
  const h = (req && req.headers) || {};
  const host = hostOf(h.origin) || hostOf(h.referer);
  if (!host) return false;
  const extra = String(process.env.SIGNUP_ALLOWED_ORIGINS || '').split(/[\s,;]+/).filter(Boolean);
  return SITE.test(host) || extra.includes(host);
}

/** Throws a generic refusal when a brake applies. */
async function check(req, email) {
  const s = await settings();
  const refuse = (code, why) => {
    const e = new Error("L'inscription n'est pas disponible pour le moment. Réessayez plus tard ou écrivez-nous à issuing@fredapay.com.");
    e.httpStatus = 403; e.code = code; e.why = why;
    return e;
  };
  if (s.paused) throw refuse('SIGNUPS_PAUSED', 'paused');
  const ip = rateLimit.clientIp(req);
  if (ipBlocked(ip, s.blocked_ips)) throw refuse('SIGNUP_BLOCKED', 'ip');
  if (s.require_site && !siteOk(req)) throw refuse('SIGNUP_BLOCKED', 'not-from-site');
  const d = require('../utils/emailRisk').domainOf(email);
  if (d && (s.blocked_domains || []).some((b) => d === b || d.endsWith(`.${b}`))) throw refuse('SIGNUP_BLOCKED', 'domain');
}

module.exports = { settings, save, check, ipBlocked, cleanIps };
