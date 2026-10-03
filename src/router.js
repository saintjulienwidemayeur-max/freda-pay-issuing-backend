'use strict';
const rateLimit = require('./utils/rateLimit');

// Public API rate limit: 100 requests/minute per merchant (per API key,
// since ctx.merchantId comes from whichever key was presented). Generous
// enough for real integrations, tight enough to catch a runaway loop.
const API_RATE_LIMIT = 100;
const API_RATE_WINDOW_MS = 60 * 1000;

function applyApiRateLimit(ctx) {
  const result = rateLimit.hit(`api:${ctx.merchantId}`, API_RATE_LIMIT, API_RATE_WINDOW_MS);
  ctx.res.setHeader('X-RateLimit-Limit', String(API_RATE_LIMIT));
  ctx.res.setHeader('X-RateLimit-Remaining', String(Math.max(0, result.remaining)));
  if (result.limited) {
    const retryAfterSeconds = Math.ceil(result.retryAfterMs / 1000);
    ctx.res.setHeader('Retry-After', String(retryAfterSeconds));
    const err = new Error(`Limite de requêtes dépassée (${API_RATE_LIMIT}/minute). Réessayez dans ${retryAfterSeconds} seconde(s).`);
    err.httpStatus = 429;
    err.code = 'RATE_LIMITED';
    throw err;
  }
}

function compilePath(path) {
  const paramNames = [];
  const pattern = path
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        paramNames.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${pattern}$`), paramNames };
}

class Router {
  constructor() {
    this.routes = []; // { method, regex, paramNames, middlewares, handler }
  }

  add(method, path, ...fns) {
    const handler = fns.pop();
    const middlewares = fns;
    const { regex, paramNames } = compilePath(path);
    this.routes.push({ method, regex, paramNames, middlewares, handler });
  }

  get(path, ...fns) { this.add('GET', path, ...fns); }
  post(path, ...fns) { this.add('POST', path, ...fns); }
  put(path, ...fns) { this.add('PUT', path, ...fns); }
  del(path, ...fns) { this.add('DELETE', path, ...fns); }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      route.paramNames.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
      return { route, params };
    }
    return null;
  }
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    const MAX = 1024 * 1024; // 1MB cap
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX) {
        req.destroy();
        reject(Object.assign(new Error('Le corps de la requête est trop volumineux (max 1 Mo).'), { httpStatus: 413, code: 'PAYLOAD_TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({ body: {}, raw: '' });
      try {
        resolve({ body: JSON.parse(raw), raw });
      } catch (e) {
        reject(Object.assign(new Error('Le corps de la requête doit être du JSON valide.'), { httpStatus: 400, code: 'INVALID_JSON' }));
      }
    });
    req.on('error', (e) => reject(Object.assign(new Error('Erreur de connexion pendant la lecture de la requête.'), { httpStatus: 400, code: 'REQUEST_ERROR' })));
  });
}

function createHandler(router, options) {
  const onLog = (options && options.onLog) || (() => {});

  return async function handle(req, res) {
    const started = Date.now();
    res.__startedAt = started;
    const url = new URL(req.url, 'http://internal');
    const pathname = url.pathname;

    // Basic CORS support so browser-based merchant integrations can call the API directly.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

    // Standard hardening headers. This is a pure JSON API (no browser rendering
    // of responses), so these mainly guard against the API being embedded/
    // sniffed in unexpected ways.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const matched = router.match(req.method, pathname);
    if (!matched) {
      return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Route inconnue.' } });
    }

    const ctx = { req, res, params: matched.params, query: Object.fromEntries(url.searchParams) };

    try {
      if (req.method === 'POST' || req.method === 'PUT') {
        const parsed = await readJsonBody(req);
        ctx.body = parsed.body;
        ctx.rawBody = parsed.raw;
      }
      for (const mw of matched.route.middlewares) {
        await mw(ctx);
      }
      // Applied once here (rather than on each of the ~20 /v1/* route
      // definitions) so every public API endpoint is covered uniformly.
      // Runs AFTER the route's own auth middleware, so ctx.merchantId is
      // already resolved - the limit is per merchant (API key), not per IP,
      // matching how every other API documents its rate limits.
      if (pathname.startsWith('/v1/') && ctx.merchantId) {
        applyApiRateLimit(ctx);
      }
      const result = await matched.route.handler(ctx);
      // A handler that writes its own response (e.g. serving a raw file like
      // openapi.yaml with a non-JSON content-type) sets res.writableEnded
      // itself - skip the JSON envelope in that case.
      if (!res.writableEnded) {
        sendJson(res, (result && result.status) || 200, (result && result.body) || {});
      }
    } catch (err) {
      const status = err.httpStatus || 500;
      // Any error without an explicit httpStatus is unexpected (a bug, not a
      // handled business-logic case) - never leak its raw message to the
      // client (could be in English, or expose internals). Log it server-side
      // and return a generic French message instead.
      if (!err.httpStatus) {
        // eslint-disable-next-line no-console
        console.error('Unhandled error:', err);
        sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Une erreur interne est survenue. Réessayez dans un instant.' } });
        return;
      }
      const errorBody = { code: err.code || 'ERROR', message: err.message || 'Erreur interne.' };
      // Handlers can attach err.details = {...} for small, non-sensitive extra
      // context the client needs to react to a specific error (e.g. the
      // merchant_id to route an "email not verified" login error to the OTP
      // screen). Never used for anything sensitive - just routing hints.
      if (err.details && typeof err.details === 'object') Object.assign(errorBody, err.details);
      sendJson(res, status, { error: errorBody });
    } finally {
      onLog({ method: req.method, path: pathname, status: res.statusCode, ms: Date.now() - started });
    }
  };
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (res.__startedAt) headers['Server-Timing'] = `app;dur=${(Date.now() - res.__startedAt)}`;
  // Compress larger payloads (lists, docs-sized responses) when the client supports it.
  const acceptsGzip = res.req && /\bgzip\b/.test(res.req.headers['accept-encoding'] || '');
  if (acceptsGzip && data.length > 1024) {
    const zlib = require('zlib');
    const gz = zlib.gzipSync(data, { level: 4 });
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    res.writeHead(status, headers);
    return res.end(gz);
  }
  res.writeHead(status, headers);
  res.end(data);
}

module.exports = { Router, createHandler };
