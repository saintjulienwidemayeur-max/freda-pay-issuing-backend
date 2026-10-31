'use strict';
const { planKeyFor } = require('../services/plans');
const loginOtp = require('../services/loginOtp');
const supabase = require('../lib/supabase');
const { hashPassword, verifyPassword } = require('../utils/password');
const { generateMerchantId } = require('../utils/ids');
const jwt = require('../utils/jwt');
const config = require('../config');
const ledger = require('../services/ledger');
const otpService = require('../services/otpService');
const rateLimit = require('../utils/rateLimit');

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const MAX_PASSWORD_LENGTH = 200; // scrypt on a huge string is a cheap way to burn CPU
// A password hash nobody can match, so a login for an unknown email costs the same time as a real one (no timing oracle).
const DUMMY_PASSWORD_HASH = hashPassword(require('crypto').randomBytes(16).toString('hex'));

function publicMerchant(m) {
  return {
    id: m.id,
    business_name: m.business_name,
    entity_type: m.entity_type,
    account_type: m.account_type,
    email: m.email,
    phone: m.phone,
    kyc_status: m.kyc_status,
    kyb_status: m.kyb_status,
    live_enabled: !!m.gateway_live_enabled, // mirror of the real flag, kept for older clients
    gateway_live_enabled: !!m.gateway_live_enabled,
    issuing_live_enabled: !!m.issuing_live_enabled,
    active_mode: m.active_mode || 'sandbox',
    email_verified: !!m.email_verified,
    // The plan of the environment the dashboard is currently in; both are exposed so nothing has to guess.
    gateway_plan: planKeyFor(m, 'gateway', m.active_mode === 'live' ? 'live' : 'sandbox'),
    issuing_plan: planKeyFor(m, 'issuing', m.active_mode === 'live' ? 'live' : 'sandbox'),
    plans: {
      sandbox: { gateway: planKeyFor(m, 'gateway', 'sandbox'), issuing: planKeyFor(m, 'issuing', 'sandbox') },
      live: { gateway: planKeyFor(m, 'gateway', 'live'), issuing: planKeyFor(m, 'issuing', 'live') },
    },
    // Live plans renew monthly: the next date, and whether the last renewal could not be paid (null in Sandbox / on free plans).
    plan_renewal: {
      gateway: { renews_at: m.live_gateway_renews_at || null, unpaid_since: m.live_gateway_unpaid_since || null },
      issuing: { renews_at: m.live_issuing_renews_at || null, unpaid_since: m.live_issuing_unpaid_since || null },
    },
    created_at: m.created_at,
  };
}

function issueSession(merchantId, role, userId) {
  const payload = { merchantId };
  if (role && role !== 'owner') Object.assign(payload, { role, userId }); // owner tokens stay as before
  return jwt.sign(payload, config.sessionSecret, 60 * 60 * 24 * 7); // 7 days
}

const ONBOARDING_KEYS = ['website', 'country', 'product', 'business_description', 'monthly_volume', 'monthly_cards', 'card_use_case', 'source_of_funds'];

/**
 * Keeps only the known onboarding answers, as short strings. Everything is
 * optional here (API-created accounts skip the signup wizard); the wizard
 * itself enforces which questions are required.
 */
function sanitizeOnboarding(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const k of ONBOARDING_KEYS) {
    if (typeof raw[k] === 'string' && raw[k].trim()) out[k] = raw[k].trim().slice(0, 400);
  }
  return Object.keys(out).length ? out : null;
}


/** A website the merchant typed: keeps http(s) addresses, adds https:// to a bare domain. Returns null when it is not one. */
function normalizeWebsite(raw) {
  let v = String(raw || '').trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  try {
    const u = new URL(v);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.') || u.hostname.length > 120) return null;
    return u.toString().replace(/\/$/, '').slice(0, 200);
  } catch (e) { return null; }
}

/** The owner's date of birth, ID number and address, as the partner's Tier 1 needs them. Throws a clear 400 when something is wrong. */
function readOwner(o, signupCountry) {
  const a = o.address && typeof o.address === 'object' ? o.address : {};
  const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  const dob = text(o.date_of_birth, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
  const date = m ? new Date(`${dob}T00:00:00Z`) : null;
  if (!date || Number.isNaN(date.getTime()) || date > new Date()) throw httpError(400, 'INVALID_OWNER', 'La date de naissance est invalide (format AAAA-MM-JJ).');
  const age = (Date.now() - date.getTime()) / (365.25 * 24 * 3600 * 1000);
  if (age < 18) throw httpError(400, 'OWNER_UNDERAGE', 'Le propriétaire du compte doit avoir au moins 18 ans.');
  const out = {
    date_of_birth: dob,
    identification_number: text(o.identification_number, 60),
    address: { street: text(a.street, 120), city: text(a.city, 80), state: text(a.state, 80), postal_code: text(a.postal_code, 20), country: text(a.country || signupCountry, 2).toUpperCase() },
  };
  if (!out.identification_number || !out.address.street || !out.address.city || !out.address.state || !out.address.postal_code) {
    throw httpError(400, 'INVALID_OWNER', "Les informations du propriétaire sont incomplètes : date de naissance, pièce d'identité et adresse (rue, ville, département, code postal).");
  }
  return out;
}

async function register(ctx) {
  const { business_name, entity_type, account_type, email, phone, password, onboarding, owner } = ctx.body || {};

  if (!business_name || !email || !password) {
    throw httpError(400, 'MISSING_FIELDS', 'business_name, email et password sont requis.');
  }
  if (typeof business_name !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
    throw httpError(400, 'INVALID_FIELDS', 'business_name, email et password doivent être du texte.');
  }
  if (String(password).length < 8) {
    throw httpError(400, 'WEAK_PASSWORD', 'Le mot de passe doit contenir au moins 8 caractères.');
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw httpError(400, 'INVALID_PASSWORD', `Le mot de passe ne doit pas dépasser ${MAX_PASSWORD_LENGTH} caractères.`);
  }
  if (!EMAIL_RE.test(email.trim())) throw httpError(400, 'INVALID_EMAIL', 'Entrez une adresse email valide.');

  const country = String((onboarding && onboarding.country) || '').trim().toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) throw httpError(400, 'INVALID_COUNTRY', 'Le pays doit être un code à 2 lettres (ex. US, FR, NG).');
  if (country && config.restrictedCountries.includes(country)) {
    throw httpError(403, 'COUNTRY_NOT_SUPPORTED', "Nos services ne sont pas disponibles dans ce pays, qui fait l'objet de sanctions économiques des États-Unis.");
  }

  // The website is optional; when given it must look like one (a bare domain gets https://).
  const sanitizedOnboarding = sanitizeOnboarding(onboarding);
  if (sanitizedOnboarding && sanitizedOnboarding.website) {
    const site = normalizeWebsite(sanitizedOnboarding.website);
    if (!site) throw httpError(400, 'INVALID_WEBSITE', "Le site web n'est pas valide (ex. https://monsite.com). Laissez-le vide si vous n'en avez pas.");
    sanitizedOnboarding.website = site;
  }
  // The owner's identity (asked at signup so a Tier 1 customer can be created later): optional for accounts created by API, validated when given.
  const identity = owner && typeof owner === 'object' ? readOwner(owner, country) : null;

  const normalizedEmail = email.trim().toLowerCase();
  // An address already invited to someone's team counts as taken too (otherwise login would resolve to the wrong account).
  const existing = (await supabase.selectOne('merchants', { email: normalizedEmail }))
    || (await supabase.selectOne('team_members', { email: normalizedEmail }));
  if (existing) {
    throw httpError(409, 'EMAIL_TAKEN', 'Un compte existe déjà avec cet email.');
  }

  const id = generateMerchantId();
  const merchant = await supabase.insert('merchants', {
    id,
    business_name,
    entity_type: entity_type || null,
    account_type: account_type === 'business' ? 'business' : 'individual',
    email: normalizedEmail,
    phone: phone || null,
    password_hash: hashPassword(password),
    gateway_plan: 'standard',
    issuing_plan: 'startup',
    live_gateway_plan: 'standard',
    live_issuing_plan: 'startup',
    email_verified: false,
    kyc_status: 'not_started',
    kyb_status: 'not_started',
    live_enabled: false,
    gateway_live_enabled: false,
    issuing_live_enabled: false,
    active_mode: 'sandbox',
    onboarding: sanitizedOnboarding,
  });
  if (identity) {
    // Kept for our records (never returned by the API); a failure here must not block the signup, the details are asked again when needed.
    await supabase.insert('merchant_identity', Object.assign({ merchant_id: id, phone: phone || null, source: 'signup' }, identity)).catch((e) => console.error(`Owner identity not saved for ${id}: ${e.message}`)); // eslint-disable-line no-console
  }

  // Sandbox play money: every new account starts as sandbox (live_enabled=false),
  // so merchants can test billing, card issuance, payouts, etc. right away.
  const seed = config.sandbox.masterWalletSeedUsd;
  if (seed > 0) {
    await ledger.creditMasterWallet(id, seed, 'USD', 'sandbox-welcome-bonus', id);
  }

  // No session token yet: the account must verify its email via OTP first.
  try {
    await otpService.createAndSendOtp(merchant, 'signup');
  } catch (err) {
    // The account already exists at this point; don't fail registration just
    // because the email couldn't be sent (e.g. Brevo not configured yet in
    // this environment) - the merchant can request a resend once it's fixed.
    // eslint-disable-next-line no-console
    console.error('Failed to send signup OTP:', err.message);
  }

  return {
    status: 201,
    body: { merchant_id: id, email: normalizedEmail, email_verified: false, otp_required: true },
  };
}

async function verifyEmailOtp(ctx) {
  const { merchant_id, code } = ctx.body || {};
  if (!merchant_id || !code) {
    throw httpError(400, 'MISSING_FIELDS', 'merchant_id et code sont requis.');
  }
  if (typeof merchant_id !== 'string' || (typeof code !== 'string' && typeof code !== 'number')) {
    throw httpError(400, 'INVALID_FIELDS', 'merchant_id et code sont invalides.');
  }

  const merchant = await supabase.selectOne('merchants', { id: merchant_id });
  if (!merchant) throw httpError(404, 'NOT_FOUND', 'Compte introuvable.');
  // This endpoint only ever proves ownership of the email at signup. Once verified it must NOT hand out a
  // session (that would be a passwordless takeover): signing in goes through /auth/login + the emailed code.
  if (merchant.email_verified) {
    throw httpError(409, 'ALREADY_VERIFIED', 'Cet email est déjà vérifié. Connectez-vous.');
  }

  await otpService.verifyOtp(merchant_id, code, 'signup'); // throws a specific error on any failure

  const [updated] = await supabase.update('merchants', { id: merchant_id }, { email_verified: true });
  rateLimit.reset(`login-fail:${merchant.email}`);
  return { status: 200, body: { merchant: publicMerchant(updated), session_token: issueSession(updated.id) } };
}

async function resendEmailOtp(ctx) {
  const { merchant_id } = ctx.body || {};
  if (!merchant_id) throw httpError(400, 'MISSING_FIELDS', 'merchant_id est requis.');
  if (typeof merchant_id !== 'string') throw httpError(400, 'INVALID_FIELDS', 'merchant_id est invalide.');

  const merchant = await supabase.selectOne('merchants', { id: merchant_id });
  if (!merchant) throw httpError(404, 'NOT_FOUND', 'Compte introuvable.');
  if (merchant.email_verified) {
    throw httpError(409, 'ALREADY_VERIFIED', 'Cet email est déjà vérifié.');
  }

  // Per account (the per-IP limit alone can be spread over many addresses): caps both the mails sent to
  // one inbox and the number of fresh 5-guess windows an attacker gets on the signup code.
  if (rateLimit.hit(`resend-otp-merchant:${merchant.id}`, 5, 60 * 60 * 1000).limited) {
    throw httpError(429, 'RATE_LIMITED', 'Trop de codes demandés. Réessayez dans une heure.');
  }
  await otpService.resendOtp(merchant, 'signup');
  return { status: 200, body: { sent: true } };
}

const LOGIN_FAIL_LIMIT = 10;
const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;

async function login(ctx) {
  const { email, password } = ctx.body || {};
  if (!email || !password) {
    throw httpError(400, 'MISSING_FIELDS', 'email et password sont requis.');
  }
  if (typeof email !== 'string' || typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) {
    throw httpError(401, 'INVALID_CREDENTIALS', 'Email ou mot de passe incorrect.');
  }
  const normalizedEmail = email.trim().toLowerCase();
  const lockKey = `login-fail:${normalizedEmail}`;

  // Per-account lockout after repeated failures, in addition to the per-IP
  // rate limit already applied at the route level - slows down credential
  // stuffing against one specific account even from many different IPs.
  const lockState = rateLimit.isLimited(lockKey, LOGIN_FAIL_LIMIT);
  if (lockState.limited) {
    const seconds = Math.ceil(lockState.retryAfterMs / 1000);
    throw httpError(429, 'ACCOUNT_LOCKED', `Trop de tentatives échouées. Réessayez dans ${Math.ceil(seconds / 60)} minute(s).`);
  }

  const owner = await supabase.selectOne('merchants', { email: normalizedEmail });
  if (!owner) verifyPassword(password, DUMMY_PASSWORD_HASH); // same cost whether or not the account exists

  if (owner && verifyPassword(password, owner.password_hash)) {
    if (owner.deleted_at) {
      throw httpError(403, 'ACCOUNT_DEACTIVATED', 'Ce compte a été désactivé. Contactez-nous à issuing@fredapay.com.');
    }
    if (!owner.email_verified) {
      const err = httpError(403, 'EMAIL_NOT_VERIFIED', "Vérifiez d'abord votre adresse email avec le code envoyé à l'inscription.");
      err.details = { merchant_id: owner.id };
      throw err;
    }
    // Correct password is only step one: the session is issued after the emailed code.
    rateLimit.reset(lockKey);
    const challenge = await loginOtp.create({ subjectType: 'merchant', subjectId: owner.id, merchantId: owner.id, email: owner.email });
    return { status: 200, body: { otp_required: true, ...challenge } };
  }

  // Not an account owner: maybe a team member invited by one.
  const member = owner ? null : await supabase.selectOne('team_members', { email: normalizedEmail });
  if (member && member.status === 'active' && member.password_hash && verifyPassword(password, member.password_hash)) {
    const teamMerchant = await supabase.selectOne('merchants', { id: member.merchant_id });
    if (teamMerchant && !teamMerchant.deleted_at) {
      rateLimit.reset(lockKey);
      const challenge = await loginOtp.create({ subjectType: 'member', subjectId: member.id, merchantId: teamMerchant.id, role: member.role, email: member.email });
      return { status: 200, body: { otp_required: true, ...challenge } };
    }
  }

  rateLimit.hit(lockKey, LOGIN_FAIL_LIMIT, LOGIN_FAIL_WINDOW_MS);
  throw httpError(401, 'INVALID_CREDENTIALS', 'Email ou mot de passe incorrect.');
}

/** Step two of login: the emailed code turns a verified password into a session. */
async function verifyLogin(ctx) {
  const { challenge_id, code } = ctx.body || {};
  const row = await loginOtp.verify(challenge_id, code);
  if (row.subject_type === 'merchant') {
    const owner = await supabase.selectOne('merchants', { id: row.subject_id });
    if (!owner || owner.deleted_at) throw httpError(403, 'ACCOUNT_DEACTIVATED', 'Ce compte a été désactivé. Contactez-nous à issuing@fredapay.com.');
    return { status: 200, body: { merchant: publicMerchant(owner), session_token: issueSession(owner.id), role: 'owner' } };
  }
  if (row.subject_type === 'member') {
    const member = await supabase.selectOne('team_members', { id: row.subject_id });
    const teamMerchant = member && member.status === 'active' ? await supabase.selectOne('merchants', { id: row.merchant_id }) : null;
    if (!teamMerchant || teamMerchant.deleted_at) throw httpError(401, 'INVALID_CREDENTIALS', "Votre accès à ce compte n'est plus actif.");
    return { status: 200, body: { merchant: publicMerchant(teamMerchant), session_token: issueSession(teamMerchant.id, member.role, member.id), role: member.role } };
  }
  throw httpError(400, 'LOGIN_CHALLENGE_INVALID', 'Demande de connexion invalide. Reconnectez-vous.');
}

async function resendLoginOtp(ctx) {
  const challenge = await loginOtp.resend(ctx.body && ctx.body.challenge_id);
  return { status: 200, body: { otp_required: true, ...challenge } };
}

async function me(ctx) {
  const merchant = await supabase.selectOne('merchants', { id: ctx.merchantId });
  if (!merchant) throw httpError(404, 'NOT_FOUND', 'Marchand introuvable.');
  let email = merchant.email;
  if (ctx.role && ctx.role !== 'owner' && ctx.userId) {
    const member = await supabase.selectOne('team_members', { id: ctx.userId });
    if (member) email = member.email;
  }
  return { status: 200, body: { merchant: publicMerchant(merchant), user: { email, role: ctx.role || 'owner' } } };
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { register, login, verifyLogin, resendLoginOtp, verifyEmailOtp, resendEmailOtp, me, publicMerchant, issueSession };
