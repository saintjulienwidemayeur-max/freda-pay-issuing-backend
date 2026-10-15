'use strict';
const jwt = require('../utils/jwt');
const config = require('../config');
const supabase = require('../lib/supabase');

// Team members can be removed at any time, so their session is re-checked
// against the database (briefly cached; eviction on removal is immediate).
const MEMBER_CACHE_MS = 10 * 1000;
const memberCache = new Map(); // userId -> { ok, validAfter, expires }

function forgetMember(userId) {
  memberCache.delete(userId);
}

async function memberIsActive(userId, merchantId) {
  const hit = memberCache.get(userId);
  if (hit && Date.now() < hit.expires) return hit.ok;
  const row = await supabase.selectOne('team_members', { id: userId, merchant_id: merchantId, status: 'active' });
  memberCache.set(userId, { ok: !!row, validAfter: row && row.sessions_valid_after, expires: Date.now() + MEMBER_CACHE_MS });
  return !!row;
}
async function memberSessionsValidAfter(userId) {
  const hit = memberCache.get(userId);
  return hit ? hit.validAfter : null;
}

// Same idea for the account owner: if an admin deactivates the account mid-
// session, an already-issued token should stop working within a few seconds,
// not stay valid for the rest of its 7-day life.
const merchantActiveCache = new Map(); // merchantId -> { ok, validAfter, expires }
function forgetMerchant(merchantId) {
  merchantActiveCache.delete(merchantId);
}
async function merchantIsActive(merchantId) {
  const hit = merchantActiveCache.get(merchantId);
  if (hit && Date.now() < hit.expires) return hit.ok;
  const row = await supabase.selectOne('merchants', { id: merchantId });
  const ok = !!row && !row.deleted_at;
  merchantActiveCache.set(merchantId, { ok, validAfter: row && row.sessions_valid_after, expires: Date.now() + MEMBER_CACHE_MS });
  return ok;
}
async function ownerSessionsValidAfter(merchantId) {
  const hit = merchantActiveCache.get(merchantId);
  return hit ? hit.validAfter : null;
}

/** A password reset ends every session opened before it. (Compared in whole seconds: a token's iat has no milliseconds.) */
function openedBeforeReset(iat, validAfter) {
  return !!validAfter && Number(iat || 0) < Math.floor(new Date(validAfter).getTime() / 1000);
}

/**
 * Requires a valid Freda Pay dashboard session token:
 *   Authorization: Bearer <session_jwt>
 * Sets ctx.merchantId, ctx.role ('owner' | 'admin' | 'viewer') and ctx.userId
 * (team members only). Tokens issued before roles existed are the owner's.
 * A 'viewer' can only read: every non-GET request is refused.
 */
async function requireSession(ctx) {
  const header = ctx.req.headers['authorization'] || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw httpError(401, 'MISSING_TOKEN', 'Jeton de session manquant.');
  }
  let payload;
  try {
    payload = jwt.verify(match[1], config.sessionSecret);
  } catch (err) {
    throw httpError(401, 'INVALID_TOKEN', 'Jeton de session invalide ou expiré.');
  }
  ctx.merchantId = payload.merchantId;
  ctx.role = payload.role || 'owner';
  ctx.userId = payload.userId || null;

  // Suspension is about the account, so it applies to every role, not only the owner.
  if (!(await merchantIsActive(ctx.merchantId))) {
    throw httpError(401, 'INVALID_TOKEN', 'Ce compte a été suspendu.');
  }

  if (ctx.role !== 'owner') {
    if (!ctx.userId || !(await memberIsActive(ctx.userId, ctx.merchantId))) {
      throw httpError(401, 'INVALID_TOKEN', 'Votre accès à ce compte a été retiré.');
    }
    if (openedBeforeReset(payload.iat, await memberSessionsValidAfter(ctx.userId))) {
      throw httpError(401, 'SESSION_ENDED', 'Votre mot de passe a été modifié : reconnectez-vous.');
    }
    const ownPasswordChange = ctx.req.method === 'POST' && (ctx.req.url || '').split('?')[0] === '/dashboard/account/password';
    if (ctx.role === 'viewer' && ctx.req.method !== 'GET' && !ownPasswordChange) {
      throw httpError(403, 'READ_ONLY', "Votre accès est en lecture seule : cette action n'est pas autorisée.");
    }
  } else if (openedBeforeReset(payload.iat, await ownerSessionsValidAfter(ctx.merchantId))) {
    throw httpError(401, 'SESSION_ENDED', 'Votre mot de passe a été modifié : reconnectez-vous.');
  }
}

/** Route guard: only the account owner (managing the team, etc.). */
function requireOwner(ctx) {
  if (ctx.role !== 'owner') {
    throw httpError(403, 'OWNER_ONLY', "Seul le propriétaire du compte peut faire cela.");
  }
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { requireSession, requireOwner, forgetMember, forgetMerchant };
