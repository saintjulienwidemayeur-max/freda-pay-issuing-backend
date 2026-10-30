'use strict';
const supabase = require('../lib/supabase');
const apiTraffic = require('../services/apiTraffic');
const apiUsage = require('../services/apiUsage');
const apiBlocks = require('../services/apiBlocks');
const apiKeyMiddleware = require('../middleware/apiKey');
const { API_RATE_LIMIT } = require('../router');

/** Who is calling the public API right now, and how many requests per second (last five minutes, this instance). */
async function snapshot() {
  const snap = apiTraffic.snapshot();
  const ids = snap.merchants.map((m) => m.merchant_id);
  const names = {};
  if (ids.length) {
    const rows = await supabase.select('merchants', { id: supabase.inList(ids) }, { select: 'id,business_name,email', limit: 200 });
    for (const r of rows) names[r.id] = r;
  }
  return {
    status: 200,
    body: Object.assign(snap, {
      limit_per_minute: API_RATE_LIMIT,
      merchants: snap.merchants.map((m) => Object.assign({}, m, {
        business_name: (names[m.merchant_id] && names[m.merchant_id].business_name) || null,
        email: (names[m.merchant_id] && names[m.merchant_id].email) || null,
        pct_of_limit: Math.round((m.req_60s / API_RATE_LIMIT) * 100),
        blocked: !!apiBlocks.get(m.merchant_id),
      })),
    }),
  };
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}
const iso = (d) => d.toISOString().slice(0, 10);
/** Today in Haiti as a Date at 00:00 UTC of that calendar day: all the day arithmetic below is then plain date maths. */
const haitiToday = () => new Date(`${require('../utils/haitiTime').day(Date.now())}T00:00:00Z`);
const addDays = (d, n) => { const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate() + n); return x; };
const monthStart = (d, back) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (back || 0), 1));
const blockView = (b) => (b ? { reason: b.reason, until: b.until ? new Date(b.until).toISOString() : null, blocked_at: b.blocked_at } : null);

async function namesFor(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 100) {
    const rows = await supabase.select('merchants', { id: supabase.inList(ids.slice(i, i + 100)) }, { select: 'id,business_name,email', limit: 200 });
    for (const r of rows) out[r.id] = r;
  }
  return out;
}

/** Every merchant that has created an API key, with requests today / 7 days / 30 days / this month / last month. */
async function usage() {
  await apiBlocks.refresh();
  const now = haitiToday();
  const today = iso(now), d7 = iso(addDays(now, -6)), d30 = iso(addDays(now, -29));
  const thisMonth = iso(monthStart(now, 0)), lastMonth = iso(monthStart(now, 1));
  const keys = await supabase.select('api_keys', {}, { select: 'id,merchant_id,mode,created_at,revoked_at', limit: 5000 });
  const byMerchant = new Map();
  for (const k of keys) {
    const m = byMerchant.get(k.merchant_id) || { active: 0, live: 0, test: 0, revoked: 0, last_created_at: null };
    if (k.revoked_at) m.revoked += 1; else { m.active += 1; if (k.mode === 'live') m.live += 1; else m.test += 1; }
    if (!m.last_created_at || k.created_at > m.last_created_at) m.last_created_at = k.created_at;
    byMerchant.set(k.merchant_id, m);
  }
  const rows = await apiUsage.rows(lastMonth);
  const sums = new Map();
  for (const r of rows) {
    const m = sums.get(r.merchant_id) || { today: 0, last7: 0, last30: 0, this_month: 0, last_month: 0, limited_30: 0, errors_30: 0, live_30: 0 };
    if (r.day === today) m.today += r.requests;
    if (r.day >= d7) m.last7 += r.requests;
    if (r.day >= d30) { m.last30 += r.requests; m.limited_30 += r.limited; m.errors_30 += r.errors; m.live_30 += r.live; }
    if (r.day >= thisMonth) m.this_month += r.requests; else if (r.day >= lastMonth) m.last_month += r.requests;
    sums.set(r.merchant_id, m);
  }
  const ids = [...new Set([...byMerchant.keys(), ...sums.keys()])];
  const names = ids.length ? await namesFor(ids) : {};
  const empty = { today: 0, last7: 0, last30: 0, this_month: 0, last_month: 0, limited_30: 0, errors_30: 0, live_30: 0 };
  const merchants = ids.map((id) => Object.assign({
    merchant_id: id, business_name: (names[id] && names[id].business_name) || null, email: (names[id] && names[id].email) || null,
    keys: byMerchant.get(id) || { active: 0, live: 0, test: 0, revoked: 0, last_created_at: null },
    block: blockView(apiBlocks.get(id)),
  }, sums.get(id) || empty)).sort((a, b) => b.this_month - a.this_month || b.today - a.today);
  const total = merchants.reduce((t, m) => ({ today: t.today + m.today, last7: t.last7 + m.last7, last30: t.last30 + m.last30, this_month: t.this_month + m.this_month }), { today: 0, last7: 0, last30: 0, this_month: 0 });
  return { status: 200, body: { generated_at: new Date().toISOString(), timezone: 'America/Port-au-Prince', limit_per_minute: API_RATE_LIMIT, total, merchants } };
}

/** One merchant: its keys, and requests per day (30), per week (12) and per month (6). */
async function usageDetail(ctx) {
  const id = String(ctx.params.merchantId);
  const merchant = await supabase.selectOne('merchants', { id });
  if (!merchant) throw httpError(404, 'MERCHANT_NOT_FOUND', 'Marchand introuvable.');
  const now = haitiToday();
  const since = iso(monthStart(now, 5));
  const rows = await apiUsage.rows(since, id);
  const by = new Map(rows.map((r) => [r.day, r]));
  const sum = (from, to) => rows.filter((r) => r.day >= from && r.day <= to).reduce((t, r) => ({ requests: t.requests + r.requests, limited: t.limited + r.limited, errors: t.errors + r.errors }), { requests: 0, limited: 0, errors: 0 });
  const daily = [];
  for (let i = 29; i >= 0; i--) { const day = iso(addDays(now, -i)); const r = by.get(day); daily.push({ day, requests: r ? r.requests : 0, limited: r ? r.limited : 0, errors: r ? r.errors : 0 }); }
  const weekly = [];
  const thisWeek = apiUsage.weekStart(iso(now));
  for (let i = 11; i >= 0; i--) { const start = iso(addDays(new Date(`${thisWeek}T00:00:00Z`), -7 * i)); weekly.push(Object.assign({ week_start: start }, sum(start, iso(addDays(new Date(`${start}T00:00:00Z`), 6))))); }
  const monthly = [];
  for (let i = 5; i >= 0; i--) { const start = monthStart(now, i), end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)); monthly.push(Object.assign({ month: iso(start).slice(0, 7) }, sum(iso(start), iso(end)))); }
  const keys = await supabase.select('api_keys', { merchant_id: id }, { select: 'id,key_id,mode,created_at,revoked_at', order: 'created_at.desc', limit: 50 });
  await apiBlocks.refresh();
  return { status: 200, body: { merchant: { id, business_name: merchant.business_name, email: merchant.email }, timezone: 'America/Port-au-Prince', keys, block: blockView(apiBlocks.get(id)), daily, weekly, monthly } };
}

/** Blocks the whole API access of a merchant (every key). hours: 1..8760, or empty for "until an admin lifts it". */
async function block(ctx) {
  const b = ctx.body || {};
  const merchantId = String(b.merchant_id || '');
  const merchant = merchantId && (await supabase.selectOne('merchants', { id: merchantId }));
  if (!merchant) throw httpError(404, 'MERCHANT_NOT_FOUND', 'Marchand introuvable.');
  let hours = null;
  if (b.hours != null && b.hours !== '') {
    hours = Number(b.hours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 8760) throw httpError(400, 'INVALID_DURATION', 'La durée doit être entre 1 heure et 365 jours.');
  }
  const reason = String(b.reason || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300) || null;
  const row = await apiBlocks.block({ merchantId, reason, hours, adminId: ctx.adminId });
  return { status: 200, body: { block: { merchant_id: merchantId, reason: row.reason, until: row.until, blocked_at: row.blocked_at } } };
}

async function unblock(ctx) {
  await apiBlocks.unblock(String(ctx.params.merchantId));
  return { status: 200, body: { ok: true } };
}

/** Permanently revokes one key (the merchant creates a new one if needed). */
async function revokeKey(ctx) {
  const key = await supabase.selectOne('api_keys', { id: String(ctx.params.id) });
  if (!key) throw httpError(404, 'KEY_NOT_FOUND', 'Clé introuvable.');
  if (!key.revoked_at) await supabase.update('api_keys', { id: key.id }, { revoked_at: new Date().toISOString() });
  apiKeyMiddleware.invalidateKey(key.id);
  return { status: 200, body: { ok: true } };
}

async function healthDraft(ctx) {
  const d = await require('../services/apiHealth').draftMessage(String(ctx.params.merchantId));
  if (!d.found) throw httpError(404, 'MERCHANT_NOT_FOUND', 'Marchand introuvable ou sans activité API.');
  if (!d.message) throw httpError(409, 'NO_PROBLEM', "Cette intégration est bien connectée : il n'y a rien à signaler.");
  return { status: 200, body: { status: d.status, message: d.message, merchant: d.merchant } };
}

/** Sends the (editable) message to the merchant: in its dashboard chat, and by email when asked. */
async function healthSend(ctx) {
  const merchantId = String(ctx.params.merchantId);
  const merchant = await supabase.selectOne('merchants', { id: merchantId });
  if (!merchant) throw httpError(404, 'MERCHANT_NOT_FOUND', 'Marchand introuvable.');
  const message = String((ctx.body && ctx.body.message) || '').trim();
  if (message.length < 5) throw httpError(400, 'EMPTY_MESSAGE', 'Le message est vide.');
  if (message.length > 2000) throw httpError(400, 'MESSAGE_TOO_LONG', 'Message trop long (2000 caractères maximum).');
  await require('./chat').postAdminMessage({ merchantId, body: message, adminName: ctx.admin && ctx.admin.name });
  let emailed = false;
  if (ctx.body && ctx.body.email) {
    const { buildEmail } = require('../templates/notificationEmail');
    const brevo = require('../services/brevo');
    const config = require('../config');
    try {
      const built = buildEmail({ subject: 'Votre connexion API : ce que nous avons trouvé', eyebrow: 'Connexion API', heading: 'Votre intégration API demande votre attention', paragraphs: message.split(/\n{2,}/).map((p) => p.replace(/\n/g, ' ')), tone: 'warning' });
      await brevo.sendEmail({ to: merchant.email, toName: merchant.business_name || merchant.email, subject: built.subject, html: built.html, text: built.text, senderEmail: config.brevo.adminSenderEmail, senderName: config.brevo.adminSenderName });
      emailed = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('API health email failed:', err.message);
    }
  }
  return { status: 200, body: { sent: true, emailed } };
}

async function webhookTest(ctx) {
  const merchantId = String(ctx.params.merchantId);
  if (!(await supabase.selectOne('merchants', { id: merchantId }))) throw httpError(404, 'MERCHANT_NOT_FOUND', 'Marchand introuvable.');
  return { status: 200, body: await require('../services/webhookDispatcher').probe(merchantId) };
}
async function webhookTestAll() {
  return { status: 200, body: { results: await require('../services/webhookDispatcher').probeAll() } };
}

/** Recent failures of the card provider, with its own message and what to check. */
async function providerErrors() {
  const rows = await require('../services/providerErrors').list(100);
  const ids = [...new Set(rows.map((r) => r.merchant_id).filter(Boolean))];
  const names = ids.length ? await namesFor(ids) : {};
  return { status: 200, body: { errors: rows.map((r) => Object.assign({}, r, { merchant_name: r.merchant_id && names[r.merchant_id] ? (names[r.merchant_id].business_name || names[r.merchant_id].email) : null })) } };
}

/**
 * Support tool: what does the payment partner say about ONE payment right now? Body: { payment: "pay_... | our reference | partner
 * reference", settle: true|false }. Shows our row and the partner's raw answer; with settle=true the normal confirmation runs
 * (credits the merchant once if the partner says the payment is done).
 */
async function checkPayment(ctx) {
  const q = String((ctx.body && ctx.body.payment) || '').trim();
  if (!q) throw httpError(400, 'MISSING_FIELDS', 'payment est requis (identifiant pay_..., référence du marchand ou référence du partenaire).');
  let row = await supabase.selectOne('payments', { id: q });
  if (!row) row = await supabase.selectOne('payments', { plopplop_reference: q });
  if (!row) row = await supabase.selectOne('payments', { plopplop_transaction_id: q });
  if (!row) row = (await supabase.select('payments', { own_reference: q }, { order: 'created_at.desc', limit: 1 }))[0];
  if (!row) {
    // Last resort: the text may be only part of an identifier (or the partner's reference with a prefix), so look through the recent payments.
    const needle = q.toLowerCase();
    const recent = await supabase.select('payments', {}, { order: 'created_at.desc', limit: 1000 });
    row = recent.find((p) => [p.id, p.own_reference, p.plopplop_reference, p.plopplop_transaction_id].some((v) => v && (String(v).toLowerCase().includes(needle) || needle.includes(String(v).toLowerCase())))) || null;
  }
  if (!row) throw httpError(404, 'NOT_FOUND', "Aucun paiement de la plateforme ne correspond à cet identifiant. S'il apparaît chez le partenaire mais pas ici, le paiement n'a pas été enregistré chez nous (création interrompue) : notez le montant, l'heure et le numéro, et créditez le marchand manuellement après vérification.");
  const out = { payment: { id: row.id, merchant_id: row.merchant_id, own_reference: row.own_reference, method: row.method, amount: Number(row.amount), currency: row.currency, status: row.status, mode: row.mode, provider: row.provider || 'plopplop', partner_reference: row.plopplop_reference, created_at: row.created_at, updated_at: row.updated_at } };
  if (row.provider === 'tranzak') {
    out.partner = { note: 'Paiement par carte : le partenaire de cartes est relu par la réconciliation automatique.' };
  } else {
    const res = await require('../services/plopplop').verifyPayment({ refferenceId: row.plopplop_reference });
    out.partner = { http_status: res.httpStatus || null, answer: res.data == null ? null : res.data };
  }
  if (ctx.body && ctx.body.settle === true && row.status === 'pending') {
    const after = await require('../services/paymentOrchestrator').refreshStatus(row.merchant_id, row);
    out.after = { status: after && after.status };
  }
  return { status: 200, body: out };
}

async function paymentDiagnostic() {
  const snap = await require('../services/paymentHealth').snapshot();
  const ids = [...new Set(snap.items.map((i) => i.merchant_id).filter(Boolean))];
  const names = ids.length ? await namesFor(ids) : {};
  snap.items = snap.items.map((i) => Object.assign({}, i, { merchant_name: names[i.merchant_id] ? (names[i.merchant_id].business_name || names[i.merchant_id].email) : null }));
  return { status: 200, body: snap };
}

/** Admin "Journal API": the merchants with their calls and errors over the last days. */
async function callMerchants(ctx) {
  const days = Math.min(14, Math.max(1, parseInt(ctx.query && ctx.query.days, 10) || 7));
  const list = await require('../services/apiCallLog').merchants(days);
  const ids = list.map((m) => m.merchant_id);
  const names = ids.length ? await namesFor(ids) : {};
  const health = require('../services/apiHealth');
  return {
    status: 200,
    body: {
      days, retention_days: require('../services/apiCallLog').RETENTION_DAYS,
      merchants: list.map((m) => Object.assign({}, m, {
        business_name: names[m.merchant_id] ? names[m.merchant_id].business_name : null, email: names[m.merchant_id] ? names[m.merchant_id].email : null,
        last_error: m.last_error ? Object.assign({}, m.last_error, { explain: health.explain(m.last_error.code), fix: health.fixFor(m.last_error.code) }) : null,
      })),
    },
  };
}

/** The calls of ONE merchant, newest first; errors carry what the code means and how the merchant fixes it. */
async function callsOfMerchant(ctx) {
  const merchantId = ctx.params.merchantId;
  const days = Math.min(14, Math.max(1, parseInt(ctx.query && ctx.query.days, 10) || 7));
  const errorsOnly = ctx.query && ctx.query.errors === '1';
  const route = ctx.query && ctx.query.route ? String(ctx.query.route) : '';
  const health = require('../services/apiHealth');
  let rows = await require('../services/apiCallLog').recent({ merchantId, sinceIso: new Date(Date.now() - days * 24 * 3600 * 1000).toISOString(), limit: 1500 });
  if (errorsOnly) rows = rows.filter((r) => r.status >= 400);
  if (route) rows = rows.filter((r) => String(r.route).includes(route) || String(r.path).includes(route));
  const merchant = await supabase.selectOne('merchants', { id: merchantId });
  return {
    status: 200,
    body: {
      merchant: merchant ? { id: merchant.id, business_name: merchant.business_name, email: merchant.email } : { id: merchantId },
      days,
      total: rows.length,
      calls: rows.slice(0, 300).map((r) => Object.assign({}, r, r.status >= 400 ? { explain: health.explain(r.code), fix: health.fixFor(r.code) } : {})),
    },
  };
}

/**
 * Support tool: for the active cards (newest first, at most 60 per call) compare OUR balance with the one the card partner reports.
 * Nothing is changed. The partner's figure is read in cents, like every amount it sends; a gap tells the team a card is out of line.
 */
async function cardBalanceCheck(ctx) {
  const mode = ctx.query && ctx.query.mode === 'sandbox' ? 'sandbox' : 'live';
  const cards = await supabase.select('cards', { status: 'active', mode, deleted_at: supabase.isNull() }, { order: 'created_at.desc', limit: 60 });
  const maplerad = require('../services/maplerad');
  const names = cards.length ? await namesFor([...new Set(cards.map((c) => c.merchant_id))]) : {};
  const out = [];
  for (const c of cards) {
    const row = { id: c.id, merchant_id: c.merchant_id, merchant_name: names[c.merchant_id] ? (names[c.merchant_id].business_name || names[c.merchant_id].email) : null, reference: c.own_reference, kind: c.kind, our_balance: Number(c.balance || 0), partner_balance: null, gap: null, error: null };
    if (!c.maplerad_card_id) { row.error = 'pas de carte chez le fournisseur'; out.push(row); continue; }
    try {
      const res = await maplerad.forMode(c.mode).getCard(c.maplerad_card_id);
      const d = (res && (res.data || res)) || {};
      const cents = Number(d.balance);
      if (Number.isFinite(cents)) { row.partner_balance = Math.round(cents) / 100; row.gap = Math.round((row.partner_balance - row.our_balance) * 100) / 100; } else row.error = 'le fournisseur ne donne pas de solde';
    } catch (err) { row.error = err.message; }
    out.push(row);
    await new Promise((r) => setTimeout(r, 250));
  }
  out.sort((a, b) => Math.abs(b.gap || 0) - Math.abs(a.gap || 0));
  return { status: 200, body: { mode, checked: out.length, out_of_line: out.filter((r) => r.gap != null && Math.abs(r.gap) >= 0.01).length, cards: out } };
}

/** Sets OUR balance of one card to what the partner reports (an admin decision, after looking at the check above). */
async function cardBalanceAlign(ctx) {
  const card = await supabase.selectOne('cards', { id: ctx.params.id });
  if (!card || !card.maplerad_card_id) throw httpError(404, 'NOT_FOUND', 'Carte introuvable.');
  const res = await require('../services/maplerad').forMode(card.mode).getCard(card.maplerad_card_id);
  const cents = Number(((res && (res.data || res)) || {}).balance);
  if (!Number.isFinite(cents) || cents < 0) throw httpError(502, 'CARD_SERVICE_ERROR', 'Le fournisseur ne donne pas de solde pour cette carte.');
  const partner = Math.round(cents) / 100;
  const [updated] = await supabase.update('cards', { id: card.id }, { balance: partner, updated_at: new Date().toISOString() });
  require('../services/webhookDispatcher').dispatch(card.merchant_id, 'card.balance_updated', require('../services/cardOrchestrator').balanceWebhookData(updated || Object.assign({}, card, { balance: partner }), card.balance, 'aligned'));
  return { status: 200, body: { id: card.id, previous: Number(card.balance || 0), balance: partner } };
}

/** Sends the merchant's server the card's CURRENT balance now (for example after an alignment done before this event existed). */
async function cardBalanceSend(ctx) {
  const card = await supabase.selectOne('cards', { id: ctx.params.id });
  if (!card || card.deleted_at) throw httpError(404, 'NOT_FOUND', 'Carte introuvable.');
  const result = await require('../services/webhookDispatcher').deliverNow(card.merchant_id, 'card.balance_updated', require('../services/cardOrchestrator').balanceWebhookData(card, null, 'requested'));
  return { status: 200, body: { sent: !!(result && result.sent), balance: Number(card.balance || 0), result } };
}

async function health() {
  return { status: 200, body: await require('../services/apiHealth').all() };
}

module.exports = { snapshot, usage, usageDetail, block, unblock, revokeKey, health, healthDraft, healthSend, webhookTest, webhookTestAll, providerErrors, checkPayment, paymentDiagnostic, callMerchants, callsOfMerchant, cardBalanceCheck, cardBalanceAlign, cardBalanceSend };
