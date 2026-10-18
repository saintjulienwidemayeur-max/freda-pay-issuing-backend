'use strict';
const net = require('net');

/**
 * Simple in-memory fixed-window rate limiter, keyed by an arbitrary string
 * (e.g. `${ip}:${action}` or `${email}:${action}`). Good enough for a single
 * server instance; if this ever runs on multiple instances behind a load
 * balancer, replace with a shared store (Redis) using the same interface.
 */
const buckets = new Map(); // key -> { count, resetAt }

function hit(key, limit, windowMs) {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { limited: false, remaining: limit - 1, retryAfterMs: 0 };
  }

  bucket.count += 1;
  if (bucket.count > limit) {
    return { limited: true, remaining: 0, retryAfterMs: bucket.resetAt - now };
  }
  return { limited: false, remaining: limit - bucket.count, retryAfterMs: 0 };
}

/** Clears a key early (e.g. reset login attempts after a successful login). */
function reset(key) {
  buckets.delete(key);
}

/** Checks whether a key is currently over its limit, WITHOUT incrementing it. */
function isLimited(key, limit) {
  const bucket = buckets.get(key);
  if (!bucket || Date.now() > bucket.resetAt) return { limited: false, retryAfterMs: 0 };
  return { limited: bucket.count >= limit, retryAfterMs: bucket.resetAt - Date.now() };
}

// Periodic cleanup so this map doesn't grow forever on a long-running server.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    if (now > bucket.resetAt) buckets.delete(key);
  }
}, 5 * 60 * 1000).unref();

/**
 * Builds a router middleware that rate-limits by a key derived from the
 * request (defaults to client IP + action name). Throws a 429 error when
 * the limit is exceeded.
 */
function middleware(action, limit, windowMs, keyFn) {
  return async function rateLimitMiddleware(ctx) {
    const key = keyFn ? `${action}:${keyFn(ctx)}` : `${action}:${clientIp(ctx.req)}`;
    const result = hit(key, limit, windowMs);
    if (result.limited) {
      const seconds = Math.ceil(result.retryAfterMs / 1000);
      const err = new Error(`Trop de tentatives. Réessayez dans ${seconds} seconde${seconds > 1 ? 's' : ''}.`);
      err.httpStatus = 429;
      err.code = 'RATE_LIMITED';
      throw err;
    }
  };
}

/**
 * Real client address, used for per-IP rate limits and as the signer IP kept
 * as e-signature evidence. Never trust the first X-Forwarded-For entry: that
 * one is written by the client and can be rotated on every request.
 *
 * Deployment model (Render behind Cloudflare):
 *  - Cloudflare sets `CF-Connecting-IP` itself (a client-supplied copy is
 *    overwritten), so it is trusted when TRUST_CF_CONNECTING_IP=1. That is the
 *    default in production, and off elsewhere (local runs / tests are reachable
 *    directly, where the header would be forgeable).
 *  - Otherwise the proxy-appended hop of X-Forwarded-For is used: the entry
 *    TRUSTED_PROXY_HOPS from the END of the list (default 1 = the last entry,
 *    i.e. the address the closest proxy saw; Render appends exactly one).
 *    Entries further left are client-controlled and ignored.
 *  - With no usable header, the TCP peer address is used.
 */
function trustedHops() {
  const n = parseInt(process.env.TRUSTED_PROXY_HOPS || '1', 10);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : 1;
}

function trustCloudflareHeader() {
  const v = process.env.TRUST_CF_CONNECTING_IP;
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

function clientIp(req) {
  const peer = (req.socket && req.socket.remoteAddress) || 'unknown';
  const headers = req.headers || {};
  if (trustCloudflareHeader()) {
    const cf = String(headers['cf-connecting-ip'] || '').trim();
    if (net.isIP(cf)) return cf;
  }
  const forwarded = headers['x-forwarded-for'];
  if (forwarded) {
    const parts = String(forwarded).split(',').map((s) => s.trim()).filter(Boolean);
    const hops = trustedHops();
    if (parts.length >= hops) {
      const candidate = parts[parts.length - hops];
      if (net.isIP(candidate)) return candidate;
    }
  }
  return peer;
}

module.exports = { hit, reset, isLimited, middleware, clientIp };
