'use strict';
const crypto = require('crypto');
const config = require('../config');
const supabase = require('../lib/supabase');
const jwt = require('../utils/jwt');
const totp = require('../utils/totp');
const rateLimit = require('../utils/rateLimit');
const siteUrl = require('./siteUrl');
const { randomHex } = require('../utils/ids');

/**
 * Mandatory authenticator-app 2FA for merchant dashboards (owners and team members).
 * A "subject" is { type: 'merchant'|'member', id, merchantId, role, email }.
 *
 * Fail-open on purpose for ONE case only: if the user_2fa table does not exist yet (migration not run), logins keep
 * working exactly as before instead of locking every merchant out.
 */
const FAIL_LIMIT = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const TOKEN_SECONDS = 15 * 60;
const RECOVERY_COUNT = 10;

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

const rowId = (sub) => `${sub.type}:${sub.id}`;
const encKey = () => config.twoFactor.key || config.sessionSecret;
const tokenSecret = () => crypto.createHmac('sha256', config.sessionSecret).update('2fa-flow-token').digest('hex');

function isMissingTable(err) {
  const d = (err && err.details) || {};
  return d.code === 'PGRST205' || d.code === '42P01' || /Could not find the table|does not exist/i.test(String((err && err.message) || ''));
}

/** { available, row }: available=false means the table is missing and 2FA can't be enforced yet. */
async function load(sub) {
  try {
    const row = await supabase.selectOne('user_2fa', { id: rowId(sub) });
    return { available: true, row: row || null };
  } catch (err) {
    if (isMissingTable(err)) return { available: false, row: null };
    throw err;
  }
}

const isEnabled = (row) => !!(row && row.enabled_at && row.secret_enc);

async function status(sub) {
  const { available, row } = await load(sub);
  return { available, enabled: isEnabled(row), enabled_at: row && row.enabled_at ? row.enabled_at : null, recovery_codes_left: row ? (row.recovery_hashes || []).length : 0 };
}

// ---- Short-lived flow tokens (login challenge / setup). Not a session: they carry no merchantId claim and are signed with a derived key. ----
function issueToken(sub, purpose) {
  return jwt.sign({ st: sub.type, sid: sub.id, mid: sub.merchantId, role: sub.role || 'owner', email: sub.email, purpose }, tokenSecret(), TOKEN_SECONDS);
}
function readToken(token, purpose) {
  let p;
  try { p = jwt.verify(token, tokenSecret()); } catch (e) { throw httpError(401, 'TWOFA_TOKEN_INVALID', 'Connexion expirée. Reconnectez-vous.'); }
  if (p.purpose !== purpose) throw httpError(401, 'TWOFA_TOKEN_INVALID', 'Connexion expirée. Reconnectez-vous.');
  return { type: p.st, id: p.sid, merchantId: p.mid, role: p.role, email: p.email };
}

function newRecoveryCodes() {
  const plain = [];
  for (let i = 0; i < RECOVERY_COUNT; i += 1) plain.push(`${randomHex(3)}-${randomHex(3)}`.toUpperCase());
  return plain;
}
const hashRecovery = (c) => crypto.createHmac('sha256', config.sessionSecret).update(`2fa-recovery:${String(c).toUpperCase().replace(/[^A-Z0-9]/g, '')}`).digest('hex');

function limited(sub) {
  const key = `2fa-fail:${rowId(sub)}`;
  const st = rateLimit.isLimited(key, FAIL_LIMIT);
  if (st.limited) throw httpError(429, 'TWOFA_LOCKED', `Trop de codes incorrects. Réessayez dans ${Math.max(1, Math.ceil(st.retryAfterMs / 60000))} minute(s).`);
  return key;
}

/** Starts (or restarts) enrolment: a fresh secret is stored, not yet active until a valid code proves the app has it. */
async function beginSetup(sub) {
  const { available, row } = await load(sub);
  if (!available) throw httpError(503, 'TWOFA_UNAVAILABLE', "La double authentification n'est pas encore disponible. Réessayez bientôt.");
  if (isEnabled(row)) throw httpError(409, 'TWOFA_ALREADY_ENABLED', "La double authentification est déjà activée.");
  const secret = totp.generateSecret();
  const patch = { secret_enc: totp.encrypt(secret, encKey()), updated_at: new Date().toISOString() };
  if (row) await supabase.update('user_2fa', { id: rowId(sub) }, patch);
  else await supabase.insert('user_2fa', Object.assign({ id: rowId(sub), subject_type: sub.type, subject_id: sub.id, merchant_id: sub.merchantId, recovery_hashes: [] }, patch));
  return { secret, otpauth_uri: totp.otpauthUri({ secret, account: sub.email || sub.id, issuer: config.twoFactor.issuer, image: `${siteUrl.get()}/logo.png` }), issuer: config.twoFactor.issuer, account: sub.email || sub.id };
}

/** Confirms enrolment with a first valid code; returns the one-time recovery codes. */
async function enable(sub, code) {
  const { row } = await load(sub);
  if (!row || !row.secret_enc) throw httpError(400, 'TWOFA_NOT_STARTED', "Commencez d'abord la configuration.");
  if (isEnabled(row)) throw httpError(409, 'TWOFA_ALREADY_ENABLED', "La double authentification est déjà activée.");
  const key = limited(sub);
  const step = totp.verify(totp.decrypt(row.secret_enc, encKey()), code);
  if (step === null) {
    rateLimit.hit(key, FAIL_LIMIT, FAIL_WINDOW_MS);
    throw httpError(401, 'TWOFA_CODE_INVALID', "Code incorrect. Vérifiez l'heure de votre téléphone et réessayez.");
  }
  rateLimit.reset(key);
  const recovery = newRecoveryCodes();
  await supabase.update('user_2fa', { id: rowId(sub) }, { enabled_at: new Date().toISOString(), last_step: step, recovery_hashes: recovery.map(hashRecovery), updated_at: new Date().toISOString() });
  return { recovery_codes: recovery };
}

/** Login (or sensitive action) check: an authenticator code (never twice) or a single-use recovery code. */
async function check(sub, code) {
  const { row } = await load(sub);
  if (!isEnabled(row)) throw httpError(400, 'TWOFA_NOT_ENABLED', "La double authentification n'est pas activée.");
  const key = limited(sub);
  const raw = String(code || '').trim();
  const step = totp.verify(totp.decrypt(row.secret_enc, encKey()), raw);
  if (step !== null && !(row.last_step && Number(row.last_step) >= step)) {
    rateLimit.reset(key);
    await supabase.update('user_2fa', { id: rowId(sub) }, { last_step: step, updated_at: new Date().toISOString() });
    return { method: 'totp' };
  }
  const h = hashRecovery(raw);
  const left = row.recovery_hashes || [];
  if (raw.length >= 6 && left.includes(h)) {
    rateLimit.reset(key);
    await supabase.update('user_2fa', { id: rowId(sub) }, { recovery_hashes: left.filter((x) => x !== h), updated_at: new Date().toISOString() });
    return { method: 'recovery', recovery_codes_left: left.length - 1 };
  }
  rateLimit.hit(key, FAIL_LIMIT, FAIL_WINDOW_MS);
  throw httpError(401, 'TWOFA_CODE_INVALID', 'Code incorrect ou déjà utilisé.');
}

/** New recovery codes (the old ones stop working). The caller has already checked a current code. */
async function regenerateRecovery(sub) {
  const recovery = newRecoveryCodes();
  await supabase.update('user_2fa', { id: rowId(sub) }, { recovery_hashes: recovery.map(hashRecovery), updated_at: new Date().toISOString() });
  return recovery;
}

/** Admin: the person lost their phone AND recovery codes. They will have to enrol again at the next login. */
async function reset(sub) {
  await supabase.delete('user_2fa', { id: rowId(sub) });
}

async function markReminded(sub) {
  const { available, row } = await load(sub);
  if (!available) return;
  const now = new Date().toISOString();
  if (row) await supabase.update('user_2fa', { id: rowId(sub) }, { reminded_at: now });
  else await supabase.insert('user_2fa', { id: rowId(sub), subject_type: sub.type, subject_id: sub.id, merchant_id: sub.merchantId, recovery_hashes: [], reminded_at: now });
}

/** Every dashboard user (owners + active team members) of every merchant, with their 2FA state. */
async function overview() {
  const [merchants, members, rows] = await Promise.all([
    supabase.select('merchants', {}, { order: 'created_at.desc', limit: 5000 }),
    supabase.select('team_members', { status: 'active' }, { limit: 5000 }),
    supabase.select('user_2fa', {}, { limit: 10000 }).catch((e) => { if (isMissingTable(e)) return null; throw e; }),
  ]);
  const byId = new Map((rows || []).map((r) => [r.id, r]));
  const out = [];
  const nameOf = new Map(merchants.map((m) => [m.id, m.business_name || m.name || m.email]));
  for (const m of merchants) {
    if (m.deleted_at) continue;
    const r = byId.get(`merchant:${m.id}`);
    out.push({ type: 'merchant', id: m.id, merchant_id: m.id, merchant_name: nameOf.get(m.id), email: m.email, role: 'owner', enabled: isEnabled(r), enabled_at: r && r.enabled_at || null, reminded_at: r && r.reminded_at || null });
  }
  for (const t of members) {
    if (!nameOf.has(t.merchant_id)) continue;
    const r = byId.get(`member:${t.id}`);
    out.push({ type: 'member', id: t.id, merchant_id: t.merchant_id, merchant_name: nameOf.get(t.merchant_id), email: t.email, role: t.role, enabled: isEnabled(r), enabled_at: r && r.enabled_at || null, reminded_at: r && r.reminded_at || null });
  }
  return { available: rows !== null, users: out };
}

module.exports = { status, load, isEnabled, issueToken, readToken, beginSetup, enable, check, regenerateRecovery, reset, markReminded, overview, isMissingTable, httpError };
