'use strict';
/**
 * Minimal in-memory mock of Supabase's PostgREST REST API, just enough to
 * exercise our src/lib/supabase.js client (select/insert/update/rpc) the same
 * way the real https://<project>.supabase.co/rest/v1 endpoint would respond.
 * NOT for production use - no real SQL, no real Postgres semantics.
 */
const http = require('http');

const PORT = parseInt(process.env.MOCK_SUPABASE_PORT || '4503', 10);
const SERVICE_KEY = process.env.MOCK_SUPABASE_SERVICE_KEY || 'mock_service_role_key';

const tables = {
  merchants: [],
  api_keys: [],
  ledger_entries: [],
  payments: [],
  payouts: [],
  wallet_topups: [],
  payment_links: [],
  maplerad_customers: [],
  cards: [],
  webhook_events: [],
  email_otps: [],
  webhook_endpoints: [],
  team_members: [],
  admin_users: [],
  verification_submissions: [],
  blog_posts: [],
  merchant_pricing: [],
  admin_wallet_credits: [],
  disputes: [],
  fee_revenue: [],
  issuing_access_requests: [],
};
let ledgerAutoId = 1;
const storedFiles = new Map();

function reset() {
  Object.keys(tables).forEach((k) => (tables[k] = []));
  ledgerAutoId = 1;
  storedFiles.clear();
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : null); } catch (e) { resolve(null); }
    });
  });
}

function send(res, status, body) {
  const s = body === null || body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(s);
}

/** Parse `?col=eq.val&col2=is.null` style query params into predicate fns. */
function parseFilters(searchParams) {
  const predicates = [];
  for (const [key, value] of searchParams.entries()) {
    if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
    if (value.startsWith('eq.')) {
      const target = value.slice(3);
      predicates.push((row) => String(row[key]) === target);
    } else if (value === 'is.null') {
      predicates.push((row) => row[key] === null || row[key] === undefined);
    } else if (value.startsWith('neq.')) {
      const target = value.slice(4);
      predicates.push((row) => String(row[key]) !== target);
    }
  }
  return predicates;
}

function applyOrder(rows, orderParam) {
  if (!orderParam) return rows;
  const [col, dir] = orderParam.split('.');
  const sorted = [...rows].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0));
  return dir === 'desc' ? sorted.reverse() : sorted;
}

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (err) {
    send(res, 500, { message: `mock server error: ${err.message}` });
  }
});

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://internal');

  if (url.pathname === '/__control/reset') {
    reset();
    return send(res, 200, { ok: true });
  }

  const apiKey = req.headers['apikey'];
  if (apiKey !== SERVICE_KEY) {
    return send(res, 401, { message: 'Invalid API key (mock)' });
  }

  // ---- Storage: sign a private object (mock just echoes a fake signed path) ----
  const signMatch = url.pathname.match(/^\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/);
  if (signMatch && req.method === 'POST') {
    const [, bucket, path] = signMatch;
    return send(res, 200, { signedURL: `/object/sign/${bucket}/${path}?token=mock-signed-token` });
  }

  // ---- Storage (receipts, verification documents, etc.) ----
  const storageMatch = url.pathname.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/);
  if (storageMatch && req.method === 'POST') {
    const [, bucket, path] = storageMatch;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    storedFiles.set(`${bucket}/${path}`, { size: buffer.length, contentType: req.headers['content-type'] });
    return send(res, 200, { Key: `${bucket}/${path}` });
  }

  const match = url.pathname.match(/^\/rest\/v1\/(.+)$/);
  if (!match) return send(res, 404, { message: 'Not found (mock)' });
  const resource = match[1];

  // ---- RPC ----
  if (resource.startsWith('rpc/')) {
    const fn = resource.slice(4);
    const body = await readJson(req);
    if (fn === 'get_balance') {
      const { p_merchant_id, p_wallet, p_currency } = body || {};
      const sum = tables.ledger_entries
        .filter((r) => r.merchant_id === p_merchant_id && r.wallet === p_wallet && r.currency === p_currency)
        .reduce((acc, r) => acc + Number(r.amount), 0);
      return send(res, 200, sum);
    }
    return send(res, 404, { message: `Unknown rpc function: ${fn}` });
  }

  const table = tables[resource];
  if (!table) return send(res, 404, { message: `Unknown table: ${resource}` });

  if (req.method === 'GET') {
    const predicates = parseFilters(url.searchParams);
    let rows = table.filter((row) => predicates.every((p) => p(row)));
    rows = applyOrder(rows, url.searchParams.get('order'));
    const offset = url.searchParams.get('offset');
    if (offset) rows = rows.slice(parseInt(offset, 10));
    const limit = url.searchParams.get('limit');
    if (limit) rows = rows.slice(0, parseInt(limit, 10));
    return send(res, 200, rows);
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    const rowsToInsert = Array.isArray(body) ? body : [body];
    try {
      const inserted = rowsToInsert.map((row) => {
        const full = Object.assign({}, row);
        if (resource === 'ledger_entries') {
          full.id = ledgerAutoId++;
          if (!full.created_at) full.created_at = new Date().toISOString();
        } else {
          if (!full.created_at) full.created_at = new Date().toISOString();
          if (!('updated_at' in full) && (resource === 'payments' || resource === 'payouts')) {
            full.updated_at = full.created_at;
          }
          if (!('revoked_at' in full) && resource === 'api_keys') full.revoked_at = null;
        }
        const uniqueViolation = checkUnique(resource, full, table);
        if (uniqueViolation) throw uniqueViolation;
        table.push(full);
        return full;
      });
      const wantsRepresentation = (req.headers['prefer'] || '').includes('return=representation');
      return send(res, 201, wantsRepresentation ? inserted : null);
    } catch (err) {
      return send(res, 409, { message: err.message });
    }
  }

  if (req.method === 'PATCH') {
    const predicates = parseFilters(url.searchParams);
    const patch = await readJson(req);
    const updated = [];
    table.forEach((row) => {
      if (predicates.every((p) => p(row))) {
        Object.assign(row, patch);
        updated.push(row);
      }
    });
    return send(res, 200, updated);
  }

  if (req.method === 'DELETE') {
    const predicates = parseFilters(url.searchParams);
    if (!predicates.length) return send(res, 400, { message: 'DELETE without filter (mock)' });
    const removed = [];
    for (let i = table.length - 1; i >= 0; i--) {
      if (predicates.every((p) => p(table[i]))) removed.push(...table.splice(i, 1));
    }
    return send(res, 200, removed);
  }

  send(res, 405, { message: 'Method not allowed (mock)' });
}

function checkUnique(resource, row, table) {
  const uniqueCols = {
    merchants: ['email'],
    api_keys: ['key_id', 'secret_hash'],
    payments: ['plopplop_reference'],
    payouts: ['plopplop_reference'],
    wallet_topups: ['plopplop_reference'],
    maplerad_customers: ['maplerad_customer_id'],
    webhook_endpoints: ['merchant_id'],
    team_members: ['email'],
    admin_users: ['email'],
    blog_posts: ['slug'],
    cards: ['maplerad_card_id', 'maplerad_reference'],
  }[resource];
  if (!uniqueCols) return null;
  for (const col of uniqueCols) {
    if (row[col] != null && table.some((r) => r[col] === row[col])) {
      return new Error(`duplicate key value violates unique constraint (mock): ${resource}.${col}`);
    }
  }
  return null;
}

if (require.main === module) {
  server.listen(PORT, () => console.log(`Mock Supabase (PostgREST) server on http://localhost:${PORT}`));
}

module.exports = { server, SERVICE_KEY, tables, reset };
