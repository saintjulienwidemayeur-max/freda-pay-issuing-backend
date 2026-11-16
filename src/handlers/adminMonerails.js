'use strict';
const config = require('../config');
const supabase = require('../lib/supabase');
const mr = require('../services/monerails');
const twoFactor = require('../services/twoFactor');

/**
 * Admin panel > "Monerails (Sandbox)": the team tests the second card issuer with Monerails' TEST key.
 * Fully separate from the merchants: no merchant, merchant card, ledger entry or Master Wallet is read or written here.
 * Monerails is the source of truth for holders and cards (they are read from its API); only the webhook events are kept here (monerails_events).
 */
const { httpError } = mr;
const who = (ctx) => (ctx.admin && ctx.admin.email) || ctx.adminId || null;
const str = (v, max) => (v == null || v === '' ? undefined : String(v).trim().slice(0, max || 200));
const audit = (ctx, action, ref) => console.log(`[monerails-sandbox] ${action} ${ref || ''} by ${who(ctx)}`); // eslint-disable-line no-console
const out = (r, extra) => ({ status: 200, body: Object.assign({ sandbox: true }, r.data, extra || {}) });

async function status() {
  const body = { sandbox: true, configured: mr.configured(), base_url: config.monerails.baseUrl, key_hint: config.monerails.testKey ? `${config.monerails.testKey.slice(0, 8)}…${config.monerails.testKey.slice(-4)}` : null, webhook_secret_set: !!config.monerails.webhookSecret, webhook_url: `${config.apiUrl}/webhooks/monerails` };
  if (body.configured) {
    try { body.balance = (await mr.balance()).data; } catch (e) { body.balance_error = e.message; }
    try { const w = (await mr.listWebhookEndpoints()).data; body.webhook_endpoints = (w.data || []).map((x) => ({ id: x.id, url: x.url, status: x.status, events: x.events })); } catch (e) { body.webhook_error = e.message; }
  }
  try { await supabase.select('monerails_events', {}, { limit: 1 }); body.events_table = true; } catch (e) { body.events_table = !twoFactor.isMissingTable(e); }
  return { status: 200, body };
}

// ----- Holders -----
async function listCardholders() { return out(await mr.listCardholders()); }
async function getCardholder(ctx) { return out(await mr.getCardholder(ctx.params.id)); }

function documentsFrom(d) {
  if (!d || !d.front) return undefined;
  const ok = (x) => typeof x === 'string' && /^(data:image\/(jpeg|jpg|png);base64,)?[A-Za-z0-9+/=\s]+$/.test(x.slice(0, 200)) && x.length < 6 * 1024 * 1024;
  if (!ok(d.front) || (d.back && !ok(d.back))) throw httpError(400, 'INVALID_DOCUMENT', 'Photo invalide : JPEG ou PNG, 4 Mo maximum.');
  return d.back ? { front: d.front, back: d.back } : { front: d.front };
}
function addressFrom(a) {
  if (!a) return undefined;
  const x = { line1: str(a.line1, 120), line2: str(a.line2, 120), city: str(a.city, 60), state: str(a.state, 60), postal_code: str(a.postal_code, 20) };
  Object.keys(x).forEach((k) => x[k] === undefined && delete x[k]);
  return Object.keys(x).length ? x : undefined;
}

async function createCardholder(ctx) {
  const b = ctx.body || {};
  const body = {
    first_name: str(b.first_name, 50), last_name: str(b.last_name, 50), email: str(b.email, 200), country: str(b.country, 2) && String(b.country).toUpperCase(),
    phone: str(b.phone, 20), birth_date: str(b.birth_date, 10), type: b.type === 'team' ? 'team' : 'customer',
    id_document: ['national_id', 'passport', 'driver_license', 'voters_card'].includes(b.id_document) ? b.id_document : 'passport',
    id_number: str(b.id_number, 30), city: str(b.city, 60), address: addressFrom(b.address), documents: documentsFrom(b.documents),
  };
  for (const f of ['first_name', 'last_name', 'email', 'country', 'phone', 'birth_date']) if (!body[f]) throw httpError(400, 'MISSING_FIELDS', `Champ requis : ${f}.`);
  if (!body.documents) throw httpError(400, 'MISSING_FIELDS', "Photo du recto de la pièce d'identité requise.");
  if (body.id_document !== 'passport' && !body.documents.back) throw httpError(400, 'MISSING_FIELDS', 'Photo du verso requise (sauf passeport).');
  Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);
  const r = await mr.createCardholder(body);
  audit(ctx, 'cardholder.create', r.data && r.data.id);
  return { status: 201, body: Object.assign({ sandbox: true }, r.data) };
}

async function submitVerification(ctx) {
  const b = ctx.body || {};
  const body = { id_number: str(b.id_number, 30), address: addressFrom(b.address), birth_date: str(b.birth_date, 10), place_of_birth: str(b.place_of_birth, 80), phone: str(b.phone, 20), documents: documentsFrom(b.documents) };
  if (!body.id_number) throw httpError(400, 'MISSING_FIELDS', "Numéro de la pièce d'identité requis.");
  if (!body.address || !body.address.line1 || !body.address.city || !body.address.state) throw httpError(400, 'MISSING_FIELDS', 'Adresse requise : rue, ville et département/état.');
  Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);
  const r = await mr.submitVerification(ctx.params.id, body);
  audit(ctx, 'cardholder.verification', ctx.params.id);
  return out(r);
}

async function testVerification(ctx) {
  const b = ctx.body || {};
  const result = b.result === 'rejected' ? 'rejected' : 'approved';
  const r = await mr.testVerification(ctx.params.id, result, str(b.reason, 200));
  audit(ctx, `cardholder.test_${result}`, ctx.params.id);
  return out(r);
}

// ----- Cards -----
async function listCards() { return out(await mr.listCards()); }
async function getCard(ctx) { return out(await mr.getCard(ctx.params.id)); }

async function createCard(ctx) {
  const b = ctx.body || {};
  const type = ['customer', 'team', 'agent'].includes(b.type) ? b.type : 'customer';
  const body = { amount: mr.cents(b.amount_usd), type, network: b.network === 'mastercard' ? 'mastercard' : 'visa', label: str(b.label, 60) };
  if (type === 'agent') { body.agent_name = str(b.agent_name, 60); if (!body.agent_name) throw httpError(400, 'MISSING_FIELDS', 'Nom de l\'agent requis pour une carte agent.'); } else {
    body.cardholder = str(b.cardholder, 80);
    if (!body.cardholder) throw httpError(400, 'MISSING_FIELDS', 'Choisissez un titulaire vérifié.');
  }
  if (b.single_use) body.single_use = true;
  else if (b.spending_limit_usd) body.spending_limit = { amount: mr.cents(b.spending_limit_usd), interval: b.spending_interval === 'per_transaction' ? 'per_transaction' : 'daily' };
  Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);
  const r = await mr.createCard(body);
  audit(ctx, 'card.create', r.data && r.data.id);
  return { status: r.status === 202 ? 202 : 201, body: Object.assign({ sandbox: true, pending: r.status === 202 }, r.data) };
}

async function cardAction(ctx) {
  const id = ctx.params.id; const action = ctx.params.action; const b = ctx.body || {};
  let r;
  if (action === 'fund') r = await mr.fund(id, mr.cents(b.amount_usd));
  else if (action === 'withdraw') r = await mr.withdraw(id, mr.cents(b.amount_usd));
  else if (action === 'freeze') r = await mr.freeze(id);
  else if (action === 'unfreeze') r = await mr.unfreeze(id);
  else if (action === 'terminate') r = await mr.terminate(id);
  else throw httpError(404, 'NOT_FOUND', 'Action inconnue.');
  audit(ctx, `card.${action}`, id);
  return { status: 200, body: Object.assign({ sandbox: true, pending: r.status === 202 }, r.data) };
}

/** The full number and CVC, shown once to the admin and never stored or logged (only the fact that they were read). */
async function cardDetails(ctx) {
  const r = await mr.details(ctx.params.id);
  audit(ctx, 'card.details_read', ctx.params.id);
  const d = r.data || {};
  return { status: 200, headers: { 'Cache-Control': 'no-store' }, body: { sandbox: true, card: d.card || ctx.params.id, number: d.number, cvc: d.cvc, exp_month: d.exp_month, exp_year: d.exp_year, cardholder_name: d.cardholder_name } };
}

async function testAuthorization(ctx) {
  const b = ctx.body || {};
  const r = await mr.testAuthorization(ctx.params.id, { amount: mr.cents(b.amount_usd), merchant: str(b.merchant, 40) || 'Test Freda Pay', status: b.status === 'declined' ? 'declined' : 'approved' });
  audit(ctx, 'card.test_authorization', ctx.params.id);
  return out(r);
}

async function transactions(ctx) {
  const q = ctx.query || {};
  const r = await mr.transactions(q.type ? { type: String(q.type).slice(0, 40) } : {});
  const list = (r.data.data || []).filter((t) => !q.card || t.card === q.card);
  return { status: 200, body: { sandbox: true, data: list, has_more: !!r.data.has_more } };
}

// ----- Events / webhook -----
async function events() {
  try {
    const rows = await supabase.select('monerails_events', {}, { order: 'received_at.desc', limit: 100 });
    return { status: 200, body: { sandbox: true, source: 'webhook', events: rows.map((e) => ({ id: e.id, type: e.type, livemode: e.livemode, received_at: e.received_at, object_id: e.object_id, summary: e.summary })) } };
  } catch (err) {
    if (!twoFactor.isMissingTable(err)) throw err;
    const r = await mr.listEvents();
    return { status: 200, body: { sandbox: true, source: 'api', events: (r.data.data || []).map((e) => ({ id: e.id, type: e.type, livemode: e.livemode, received_at: e.created_at, object_id: e.data && e.data.object && e.data.object.id })), note: 'Table monerails_events absente : exécutez la migration 2026-11-16-monerails-sandbox.sql pour garder les événements reçus.' } };
  }
}

/** Registers our webhook URL at Monerails (card, holder and card-balance events) and keeps the signing secret it shows only once, encrypted. */
async function registerWebhook(ctx) {
  if (ctx.adminRole !== 'owner') throw httpError(403, 'INSUFFICIENT_ROLE', 'Seul le propriétaire peut enregistrer le webhook Monerails.');
  const url = `${config.apiUrl}/webhooks/monerails`;
  const r = await mr.createWebhookEndpoint(url, ['card.*', 'cardholder.*', 'cards_balance.*']);
  if (r.data && r.data.secret) await require('../services/agent/secrets').save({ monerails_webhook_secret: r.data.secret }, who(ctx));
  audit(ctx, 'webhook.register', r.data && r.data.id);
  return { status: 201, body: { sandbox: true, id: r.data.id, url: r.data.url, events: r.data.events, status: r.data.status, secret_saved: !!(r.data && r.data.secret) } };
}

const summaryOf = (o) => {
  if (!o) return null;
  if (o.object === 'card') return `${o.network || ''} •••• ${o.last4 || '----'} · ${o.status} · ${o.balance != null ? (o.balance / 100).toFixed(2) : '?'} $`;
  if (o.object === 'transaction') return `${o.type} ${(Number(o.amount || 0) / 100).toFixed(2)} $ ${o.status || ''} ${o.description || ''}`.trim();
  if (o.object === 'cardholder') return `${o.first_name || ''} ${o.last_name || ''} · ${(o.verification && o.verification.status) || ''}`.trim();
  if (o.object === 'authorization') return `refus ${(Number(o.amount || 0) / 100).toFixed(2)} $ chez ${o.merchant || '?'} : ${o.reason || ''}`;
  return o.object || null;
};

/** POST /webhooks/monerails : signed by Monerails (Monerail-Signature). Test events only; a live event is refused. Stored once per event id. */
async function receive(ctx) {
  const header = ctx.req.headers['monerail-signature'];
  if (!mr.verifySignature(header, ctx.rawBody || '', config.monerails.webhookSecret)) throw httpError(401, 'INVALID_SIGNATURE', 'Signature invalide.');
  let event;
  try { event = JSON.parse(ctx.rawBody); } catch (e) { throw httpError(400, 'INVALID_JSON', 'Corps invalide.'); }
  if (!event || !event.id || !event.type) throw httpError(400, 'INVALID_EVENT', 'Événement invalide.');
  if (event.livemode === true) return { status: 200, body: { received: true, ignored: 'live event (the integration is sandbox only)' } };
  const obj = event.data && event.data.object;
  try {
    if (!(await supabase.selectOne('monerails_events', { id: event.id }))) {
      await supabase.insert('monerails_events', { id: event.id, type: String(event.type).slice(0, 60), livemode: false, object_id: obj && obj.id ? String(obj.id) : null, summary: summaryOf(obj), payload: event, received_at: new Date().toISOString() });
    }
  } catch (err) {
    if (!twoFactor.isMissingTable(err)) throw err; // without the table the event is acknowledged (Monerails keeps it: GET /events)
  }
  return { status: 200, body: { received: true } };
}

module.exports = { status, listCardholders, getCardholder, createCardholder, submitVerification, testVerification, listCards, getCard, createCard, cardAction, cardDetails, testAuthorization, transactions, events, registerWebhook, receive, summaryOf };
