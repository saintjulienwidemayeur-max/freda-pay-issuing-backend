'use strict';
const jwt = require('../utils/jwt');
const config = require('../config');
const supabase = require('../lib/supabase');

// Team members can be removed at any time, so their session is re-checked
// against the database (briefly cached; eviction on removal is immediate).
const MEMBER_CACHE_MS = 10 * 1000;
const memberCache = new Map(); // userId -> { ok, expires }

function forgetMember(userId) {
  memberCache.delete(userId);
}

async function memberIsActive(userId, merchantId) {
  const hit = memberCache.get(userId);
  if (hit && Date.now() < hit.expires) return hit.ok;
  const row = await supabase.selectOne('team_members', { id: userId, merchant_id: merchantId, status: 'active' });
  memberCache.set(userId, { ok: !!row, expires: Date.now() + MEMBER_CACHE_MS });
  return !!row;
}

// Same idea for the account owner: if an admin deactivates the account mid-
// session, an already-issued token should stop working within a few seconds,
// not stay valid for the rest of its 7-day life.
const merchantActiveCache = new Map(); // merchantId -> { ok, expires }
function forgetMerchant(merchantId) {
  merchantActiveCache.delete(merchantId);
}
async function merchantIsActive(merchantId) {
  const hit = merchantActiveCache.get(merchantId);
  if (hit && Date.now() < hit.expires) return hit.ok;
  const row = await supabase.selectOne('merchants', { id: merchantId });
  const ok = !!row && !row.deleted_at;
  merchantActiveCache.set(merchantId, { ok, expires: Date.now() + MEMBER_CACHE_MS });
  return ok;
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

  if (ctx.role !== 'owner') {
    if (!ctx.userId || !(await memberIsActive(ctx.userId, ctx.merchantId))) {
      throw httpError(401, 'INVALID_TOKEN', 'Votre accès à ce compte a été retiré.');
    }
    const ownPasswordChange = ctx.req.method === 'POST' && (ctx.req.url || '').split('?')[0] === '/dashboard/account/password';
    if (ctx.role === 'viewer' && ctx.req.method !== 'GET' && !ownPasswordChange) {
      throw httpError(403, 'READ_ONLY', "Votre accès est en lecture seule : cette action n'est pas autorisée.");
    }
  } else if (!(await merchantIsActive(ctx.merchantId))) {
    throw httpError(401, 'INVALID_TOKEN', 'Ce compte a été désactivé.');
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
