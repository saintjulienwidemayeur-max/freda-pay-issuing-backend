'use strict';
const jwt = require('../utils/jwt');
const config = require('../config');
const supabase = require('../lib/supabase');

const ADMIN_CACHE_MS = 10 * 1000;
const cache = new Map(); // adminId -> { row, expires }

function forgetAdmin(adminId) {
  cache.delete(adminId);
}

async function loadAdmin(adminId) {
  const hit = cache.get(adminId);
  if (hit && Date.now() < hit.expires) return hit.row;
  const row = await supabase.selectOne('admin_users', { id: adminId });
  cache.set(adminId, { row, expires: Date.now() + ADMIN_CACHE_MS });
  return row;
}

/** Requires a valid Freda Pay ADMIN session token (separate from merchant sessions). Sets ctx.adminId, ctx.adminRole. */
async function requireAdminSession(ctx) {
  const header = ctx.req.headers['authorization'] || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw httpError(401, 'MISSING_TOKEN', 'Jeton administrateur manquant.');
  let payload;
  try {
    payload = jwt.verify(match[1], config.sessionSecret + ':admin'); // distinct signing context from merchant sessions
  } catch (err) {
    throw httpError(401, 'INVALID_TOKEN', 'Jeton administrateur invalide ou expiré.');
  }
  const admin = await loadAdmin(payload.adminId);
  if (!admin) throw httpError(401, 'INVALID_TOKEN', "Ce compte administrateur n'existe plus.");
  ctx.adminId = admin.id;
  ctx.adminRole = admin.role;
  ctx.admin = admin;
}

/** Route guard: compliance review requires 'owner' or 'admin' (not a blog-only 'editor'). */
function requireComplianceRole(ctx) {
  if (ctx.adminRole !== 'owner' && ctx.adminRole !== 'admin') {
    throw httpError(403, 'INSUFFICIENT_ROLE', "Ce rôle ne permet pas de revoir les vérifications KYC/KYB.");
  }
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { requireAdminSession, requireComplianceRole, forgetAdmin };
