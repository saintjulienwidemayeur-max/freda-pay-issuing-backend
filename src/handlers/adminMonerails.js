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
  body.issuer = await require('../services/cardIssuer').settings();
  const lk = config.monerails.liveKey;
  body.live = { configured: mr.configured('live'), key_hint: lk ? `${lk.slice(0, 8)}…${lk.slice(-4)}` : null, webhook_secret_set: !!config.monerails.liveWebhookSecret, enabled: !!body.issuer.live_enabled };
  if (body.live.configured) {
    try { body.live.balance = (await mr.forMode('live').balance()).data; } catch (e) { body.live.balance_error = e.message; }
  }
  if (body.balance && body.balance.cards && body.balance.cards.amount != null) body.low_balance = Number(body.balance.cards.amount) / 100 < Number(body.issuer.low_balance_usd || 0);
  try { body.merchant_cards = (await supabase.select('cards', { provider: 'monerails' }, { select: 'id,status', limit: 1000 })).length; } catch (e) { body.merchant_cards = null; body.provider_column = false; }
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
  // Monerails needs a separate "submit verification" step before the holder can be verified (and before the test approval works):
  // done right away with what the form already holds, so the admin does not have to think about it.
  const extra = {};
  if (body.id_number && body.address && body.address.line1 && body.address.city && body.address.state) {
    try {
      const v = await mr.submitVerification(r.data.id, { id_number: body.id_number, address: body.address, birth_date: body.birth_date, documents: body.documents });
      Object.assign(r.data, v.data && v.data.id ? v.data : {});
      extra.verification_submitted = true;
    } catch (e) { extra.verification_submitted = false; extra.verification_error = e.message; }
  } else {
    extra.verification_submitted = false;
    extra.verification_error = "Vérification pas encore envoyée : il manque le numéro de la pièce ou l'adresse (rue, ville, département). Complétez le formulaire puis cliquez « Soumettre ».";
  }
  return { status: 201, body: Object.assign({ sandbox: true }, r.data, extra) };
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
  let r;
  try { r = await mr.testVerification(ctx.params.id, result, str(b.reason, 200)); } catch (e) {
    if (e.code === 'MONERAILS_VERIFICATION_NOT_SUBMITTED') throw httpError(400, e.code, "La vérification de ce titulaire n'a pas encore été envoyée : remplissez le numéro de la pièce, l'adresse et les photos dans le formulaire, cliquez « Soumettre », puis « Approuver (test) ».");
    throw e;
  }
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
  if (!config.monerails.webhookSecret && mr.configured()) {
    const r = await mr.listEvents();
    return { status: 200, body: { sandbox: true, source: 'api', events: (r.data.data || []).map((e) => ({ id: e.id, type: e.type, livemode: e.livemode, received_at: e.created_at, object_id: e.data && e.data.object && e.data.object.id, summary: summaryOf(e.data && e.data.object) })), note: 'Webhook pas encore branché : événements lus directement chez Monerails.' } };
  }
  try {
    const rows = await supabase.select('monerails_events', { livemode: false }, { order: 'received_at.desc', limit: 100 });
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
  const live = ctx.body && ctx.body.mode === 'live';
  const api = mr.forMode(live ? 'live' : 'sandbox'); // the live webhook is registered with the live key, and its secret kept apart
  const url = `${config.apiUrl}/webhooks/monerails`;
  // Already registered (by this button or by hand in the Monerails dashboard): never create a second one; get a fresh secret instead.
  const existing = ((await api.listWebhookEndpoints()).data.data || []).find((w) => w.url === url);
  let r;
  if (existing) {
    r = await api.rotateWebhookSecret(existing.id);
    r.data = Object.assign({ id: existing.id, url: existing.url, events: existing.events, status: existing.status }, r.data);
  } else {
    r = await api.createWebhookEndpoint(url, ['card.*', 'cardholder.*', 'cards_balance.*']);
  }
  const secret = r.data && (r.data.secret || (r.data.webhook_endpoint && r.data.webhook_endpoint.secret));
  if (secret) await require('../services/agent/secrets').save({ [live ? 'monerails_live_webhook_secret' : 'monerails_webhook_secret']: secret }, who(ctx));
  audit(ctx, existing ? 'webhook.rotate_secret' : 'webhook.register', r.data && r.data.id);
  return { status: existing ? 200 : 201, body: { sandbox: !live, mode: live ? 'live' : 'sandbox', id: r.data.id, url: r.data.url || url, events: r.data.events, status: r.data.status, already_existed: !!existing, secret_saved: !!secret } };
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
  // The secret that validates the signature tells the environment (live or test): the only trusted source of the mode.
  let mode = null;
  if (mr.verifySignature(header, ctx.rawBody || '', config.monerails.liveWebhookSecret)) mode = 'live';
  else if (mr.verifySignature(header, ctx.rawBody || '', config.monerails.webhookSecret)) mode = 'sandbox';
  if (!mode) throw httpError(401, 'INVALID_SIGNATURE', 'Signature invalide.');
  let event;
  try { event = JSON.parse(ctx.rawBody); } catch (e) { throw httpError(400, 'INVALID_JSON', 'Corps invalide.'); }
  if (!event || !event.id || !event.type) throw httpError(400, 'INVALID_EVENT', 'Événement invalide.');
  if ((event.livemode === true) !== (mode === 'live')) return { status: 200, body: { received: true, ignored: 'environment mismatch' } };
  const obj = event.data && event.data.object;
  try {
    if (!(await supabase.selectOne('monerails_events', { id: event.id }))) {
      await supabase.insert('monerails_events', { id: event.id, type: String(event.type).slice(0, 60), livemode: mode === 'live', object_id: obj && obj.id ? String(obj.id) : null, summary: summaryOf(obj), payload: event, received_at: new Date().toISOString() });
    }
  } catch (err) {
    if (!twoFactor.isMissingTable(err)) throw err; // without the table the event is acknowledged (Monerails keeps it: GET /events)
  }
  // Events about merchants' cards and holders (pilot) are applied like the current issuer's. A failure answers 500 so Monerails retries
  // (each step is safe to run twice: transactions are stored once by their id, card results only apply to a pending card).
  try { await require('../services/monerailsBridge').handle(event, mode); } catch (err) {
    console.error(`Monerails event ${event.id} (${event.type}) not applied: ${err.message}`); // eslint-disable-line no-console
    throw httpError(500, 'EVENT_NOT_APPLIED', 'Événement non appliqué, réessayez.');
  }
  return { status: 200, body: { received: true } };
}

/**
 * GET /admin/monerails/failures?q=&mode= : why cards and card operations failed at Monerails, one line per failure: what the merchant was
 * told, Monerails' own answer, and what to check. Failed cards stay listed here even after they are removed from the merchants' lists.
 * q: part of a card id, reference, holder name, merchant name, email or id.
 */
async function failures(ctx) {
  const providerErrors = require('../services/providerErrors');
  const q = String((ctx.query && ctx.query.q) || '').trim().toLowerCase().slice(0, 80);
  const mode = ctx.query && (ctx.query.mode === 'live' || ctx.query.mode === 'sandbox') ? ctx.query.mode : null;
  const errs = (await providerErrors.list(500)).filter((r) => String(r.path || '').startsWith('card:'));
  const failedCards = await supabase.select('cards', { provider: 'monerails', status: 'failed' }, { order: 'created_at.desc', limit: 300 }).catch(() => []);
  const ids = [...new Set([...errs.map((e) => e.path.slice(5)), ...failedCards.map((c) => c.id)])];
  const cards = ids.length ? await supabase.select('cards', { id: supabase.inList(ids) }, { limit: 1000 }).catch(() => []) : [];
  const byCard = new Map(cards.map((c) => [c.id, c]));
  const mids = [...new Set([...cards.map((c) => c.merchant_id), ...errs.map((e) => e.merchant_id)].filter(Boolean))];
  const merchants = mids.length ? await supabase.select('merchants', { id: supabase.inList(mids) }, { limit: 1000 }).catch(() => []) : [];
  const byMerchant = new Map(merchants.map((m) => [m.id, m]));
  const items = []; const seen = new Set();
  const base = (card, merchantId) => { const m = byMerchant.get((card && card.merchant_id) || merchantId) || {}; return { card_id: card ? card.id : null, reference: card ? card.own_reference : null, holder_name: card ? card.holder_name : null, merchant_id: (card && card.merchant_id) || merchantId || null, merchant_name: m.business_name || null, merchant_email: m.email || null, card_status: card ? card.status : null, removed: !!(card && card.deleted_at) }; };
  for (const e of errs) {
    const card = byCard.get(e.path.slice(5)) || null;
    if (card && card.provider !== 'monerails') continue;
    seen.add(card ? card.id : e.path);
    items.push({ ...base(card, e.merchant_id), at: e.created_at, mode: e.mode || (card && card.mode) || null, kind: card && card.status === 'failed' ? 'Création de la carte' : 'Opération sur la carte', shown_to_merchant: e.shown_to_merchant || (card && card.failure_reason) || null, raw: e.message, http_status: e.http_status || null, hint: e.hint });
  }
  // Failures from before the raw answer was kept: look for it elsewhere (the webhook event, the old error journal, Monerails itself).
  const events = await supabase.select('monerails_events', { type: 'card.issue_failed' }, { order: 'received_at.desc', limit: 500 }).catch(() => []);
  const oldErrors = errs.filter((e) => !String(e.path || '').startsWith('card:')).concat((await providerErrors.list(500)).filter((e) => !String(e.path || '').startsWith('card:')));
  const reasonOf = (o) => { const d = (o && (o.data && o.data.object ? o.data.object : o.data)) || o || {}; return d.failure_reason || d.reason || d.failure_message || d.error || null; };
  let lookups = 0; const listed = {};
  for (const c of failedCards) {
    if (seen.has(c.id)) continue;
    let raw = null; let source = null; let http = null;
    const ev = c.provider_card_id ? events.find((e) => e.object_id === c.provider_card_id) : null;
    if (ev) { const r = reasonOf(typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload); if (r) { raw = `card.issue_failed : ${typeof r === 'string' ? r : JSON.stringify(r)}`; source = "Retrouvée dans l'événement reçu de Monerails."; } }
    if (!raw) {
      const t0 = new Date(c.created_at).getTime();
      const near = oldErrors.filter((e) => e.merchant_id === c.merchant_id && /^POST/.test(String(e.route || '')) && Math.abs(new Date(e.created_at).getTime() - t0) < 3 * 60 * 1000 && e.message).sort((x, y) => Math.abs(new Date(x.created_at) - t0) - Math.abs(new Date(y.created_at) - t0))[0];
      if (near) { raw = near.message; http = near.http_status || null; source = "Retrouvée dans l'ancien journal d'erreurs."; }
    }
    if (!raw && !c.provider_card_id && lookups < 8) {
      // No Monerails id was ever saved: look for the card at Monerails by its label (our reference).
      lookups += 1;
      try {
        const mode = c.mode === 'live' ? 'live' : 'sandbox';
        if (!listed[mode]) listed[mode] = ((await mr.forMode(mode).listCards({ limit: 100 })).data.data) || [];
        const found = listed[mode].find((x) => x.label === String(c.own_reference).slice(0, 60));
        if (found) { const r = reasonOf(found); raw = `Monerails (maintenant) : statut ${found.status || '?'}${r ? ` · ${typeof r === 'string' ? r : JSON.stringify(r)}` : ''}`; source = "Retrouvée chez Monerails avec la référence de la carte."; }
      } catch (e) { /* Monerails cannot be asked */ }
    }
    if (!raw && c.provider_card_id && lookups < 8) {
      lookups += 1;
      try {
        const live = (await mr.forMode(c.mode === 'live' ? 'live' : 'sandbox').getCard(c.provider_card_id)).data || {};
        const r = reasonOf(live);
        raw = `Monerails (maintenant) : statut ${live.status || '?'}${r ? ` · ${typeof r === 'string' ? r : JSON.stringify(r)}` : ''}`; source = 'Demandée à Monerails à l\'instant.';
      } catch (e) { /* Monerails cannot be asked: nothing more to say */ }
    }
    items.push({ ...base(c), at: c.updated_at || c.created_at, mode: c.mode, kind: 'Création de la carte', shown_to_merchant: c.failure_reason, raw, http_status: http,
      hint: raw ? `${source} ${providerErrors.hintFor({ message: `MONERAILS_ISSUE_FAILED: ${raw}`, http_status: http })}` : "La réponse brute de Monerails n'a pas été gardée (échec survenu avant cette fonction) et on ne la retrouve ni dans les événements, ni dans le journal, ni chez Monerails. La phrase montrée au marchand est la seule trace." });
  }
  let rows = items.filter((i) => !mode || i.mode === mode);
  if (q) rows = rows.filter((i) => `${i.card_id || ''} ${i.reference || ''} ${i.holder_name || ''} ${i.merchant_name || ''} ${i.merchant_email || ''} ${i.merchant_id || ''}`.toLowerCase().includes(q));
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { status: 200, body: { total: rows.length, items: rows.slice(0, 200) } };
}

module.exports = { failures, status, listCardholders, getCardholder, createCardholder, submitVerification, testVerification, listCards, getCard, createCard, cardAction, cardDetails, testAuthorization, transactions, events, registerWebhook, receive, summaryOf };
