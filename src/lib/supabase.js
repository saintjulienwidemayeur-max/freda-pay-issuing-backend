'use strict';
const config = require('../config');

function restUrl(path) {
  return `${config.supabase.url.replace(/\/+$/, '')}/rest/v1${path}`;
}

function headers(extra) {
  return Object.assign(
    {
      apikey: config.supabase.serviceRoleKey,
      Authorization: `Bearer ${config.supabase.serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    extra || {}
  );
}

/**
 * Explicit PostgREST operators. Only values created through these helpers are
 * sent as operators; a plain string (e.g. one coming from a request body, a
 * path or a query string) is always an equality on that literal text.
 */
class FilterOp {
  constructor(expr) { this.expr = expr; }
}
const SAFE_LIST_ITEM = /^[A-Za-z0-9_.:@-]+$/;
const isNull = () => new FilterOp('is.null');
const notNull = () => new FilterOp('not.is.null');
const lt = (v) => new FilterOp(`lt.${v}`);
const lte = (v) => new FilterOp(`lte.${v}`);
const gt = (v) => new FilterOp(`gt.${v}`);
const gte = (v) => new FilterOp(`gte.${v}`);
const neq = (v) => new FilterOp(`neq.${v}`);
/** `in.(a,b,c)`: every item is validated so it cannot smuggle in a comma/parenthesis. */
const inList = (items) => {
  const list = Array.from(items, String);
  if (!list.every((x) => SAFE_LIST_ITEM.test(x))) throw new Error('Valeur de filtre invalide.');
  return new FilterOp(`in.(${list.join(',')})`);
};

function filterValue(val) {
  if (val instanceof FilterOp) return val.expr;
  return `eq.${val}`;
}

async function handle(res) {
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (e) {
      // A gateway/proxy error page is not JSON: surface it as a normal upstream error.
      if (res.ok) throw Object.assign(new Error('Réponse invalide de la base de données.'), { httpStatus: 502, code: 'SUPABASE_ERROR' });
    }
  }
  if (!res.ok) {
    const message = (data && (data.message || data.error || data.hint)) || `Supabase error (HTTP ${res.status})`;
    const err = new Error(message);
    err.httpStatus = 502;
    err.code = 'SUPABASE_ERROR';
    err.details = data;
    throw err;
  }
  return data;
}

/**
 * SELECT rows from a table.
 * filters: { column: value } -> translated to `column=eq.value`.
 *   A plain value is ALWAYS a literal equality, even when it looks like an
 *   operator ('neq.x', 'like.mch_a*'): request data must never become a filter.
 *   Internal callers that need an operator pass an explicit marker built by
 *   supabase.isNull / notNull / lt / lte / gt / gte / neq / inList.
 * options: { select, order, limit }
 */
async function select(table, filters, options) {
  const params = new URLSearchParams();
  params.set('select', (options && options.select) || '*');
  Object.entries(filters || {}).forEach(([col, val]) => {
    params.append(col, filterValue(val));
  });
  if (options && options.order) params.set('order', options.order);
  if (options && options.limit) params.set('limit', String(options.limit));
  if (options && options.offset) params.set('offset', String(options.offset));

  const res = await fetch(`${restUrl(`/${table}`)}?${params.toString()}`, { headers: headers() });
  return handle(res);
}

async function selectOne(table, filters, options) {
  const rows = await select(table, filters, options);
  return rows && rows.length ? rows[0] : null;
}

/** INSERT one row (or an array of rows). Returns the inserted row(s). */
async function insert(table, row) {
  const res = await fetch(restUrl(`/${table}`), {
    method: 'POST',
    headers: headers({ Prefer: 'return=representation' }),
    body: JSON.stringify(row),
  });
  const data = await handle(res);
  return Array.isArray(row) ? data : data[0];
}

/** UPDATE rows matching filters with the given patch. Returns updated row(s). */
async function update(table, filters, patch) {
  const params = new URLSearchParams();
  Object.entries(filters || {}).forEach(([col, val]) => {
    params.append(col, filterValue(val));
  });

  const res = await fetch(`${restUrl(`/${table}`)}?${params.toString()}`, {
    method: 'PATCH',
    headers: headers({ Prefer: 'return=representation' }),
    body: JSON.stringify(patch),
  });
  return handle(res);
}

/** Call a Postgres function exposed via PostgREST RPC. */
async function rpc(fnName, args) {
  const res = await fetch(restUrl(`/rpc/${fnName}`), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(args || {}),
  });
  return handle(res);
}

// Buckets the platform uses. Created automatically on first use if missing.
const PUBLIC_BUCKETS = new Set(['blog-images']);

function isMissingBucket(status, text) {
  return (status === 404 || status === 400) && /bucket not found|NoSuchBucket/i.test(text || '');
}

/** Creates a Storage bucket (private unless listed in PUBLIC_BUCKETS). Idempotent. */
async function ensureBucket(bucket) {
  const base = config.supabase.url.replace(/\/+$/, '');
  const res = await fetch(`${base}/storage/v1/bucket`, {
    method: 'POST',
    headers: {
      apikey: config.supabase.serviceRoleKey,
      Authorization: `Bearer ${config.supabase.serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ id: bucket, name: bucket, public: PUBLIC_BUCKETS.has(bucket) }),
  });
  if (res.ok) return true;
  const text = await res.text().catch(() => '');
  if (/already exists|Duplicate/i.test(text)) return true; // created concurrently
  const err = new Error(`Impossible de créer le dossier de stockage "${bucket}" (HTTP ${res.status}): ${text}`);
  err.httpStatus = 502;
  err.code = 'STORAGE_ERROR';
  throw err;
}

/**
 * Upload a file to Supabase Storage (receipts, KYC documents, blog images).
 * `buffer` is raw bytes (a Node Buffer). Returns the storage path on success.
 * If the bucket does not exist yet it is created on the fly (private, except
 * the public blog-images bucket) and the upload is retried once.
 */
async function uploadFile(bucket, path, buffer, contentType) {
  const url = `${config.supabase.url.replace(/\/+$/, '')}/storage/v1/object/${bucket}/${path}`;
  const attempt = () => fetch(url, {
    method: 'POST',
    headers: {
      apikey: config.supabase.serviceRoleKey,
      Authorization: `Bearer ${config.supabase.serviceRoleKey}`,
      'Content-Type': contentType || 'application/octet-stream',
      'x-upsert': 'true',
    },
    body: buffer,
  });
  let res = await attempt();
  let text = '';
  if (!res.ok) {
    text = await res.text().catch(() => '');
    if (isMissingBucket(res.status, text)) {
      await ensureBucket(bucket);
      res = await attempt();
      text = res.ok ? '' : await res.text().catch(() => '');
    }
  }
  if (!res.ok) {
    const err = new Error(`Échec du téléversement du reçu (HTTP ${res.status}): ${text}`);
    err.httpStatus = 502;
    err.code = 'STORAGE_ERROR';
    throw err;
  }
  return path;
}

/**
 * Creates a short-lived signed URL for a private Storage object (e.g. a KYC
 * document), so an admin's browser can view it without ever holding the
 * service-role key. `expiresInSeconds` defaults to 5 minutes.
 */
async function signedUrl(bucket, path, expiresInSeconds) {
  const base = config.supabase.url.replace(/\/+$/, '');
  const res = await fetch(`${base}/storage/v1/object/sign/${bucket}/${path}`, {
    method: 'POST',
    headers: {
      apikey: config.supabase.serviceRoleKey,
      Authorization: `Bearer ${config.supabase.serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: expiresInSeconds || 300 }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Échec de la génération du lien sécurisé (HTTP ${res.status}): ${text}`);
    err.httpStatus = 502;
    err.code = 'STORAGE_ERROR';
    throw err;
  }
  const data = await res.json();
  const signedPath = data.signedURL || data.signedUrl;
  return `${base}/storage/v1${signedPath}`;
}

/** Deletes rows matching the filters (PostgREST DELETE). Returns the deleted rows. */
async function del(table, filters) {
  const params = new URLSearchParams();
  Object.entries(filters || {}).forEach(([col, val]) => {
    params.append(col, filterValue(val));
  });
  if (!params.toString()) throw new Error('Refusing to DELETE without a filter.');
  const res = await fetch(`${restUrl(`/${table}`)}?${params.toString()}`, {
    method: 'DELETE',
    headers: headers({ Prefer: 'return=representation' }),
  });
  return handle(res);
}

module.exports = { isNull, notNull, lt, lte, gt, gte, neq, inList, select, selectOne, insert, update, delete: del, rpc, uploadFile, signedUrl };
