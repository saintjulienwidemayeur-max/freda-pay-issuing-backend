'use strict';

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

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

module.exports = { hit, reset, isLimited, middleware, clientIp };
