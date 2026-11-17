'use strict';
const supabase = require('../lib/supabase');
const webhookDispatcher = require('./webhookDispatcher');

/**
 * Spending rules a merchant sets on a card (table card_rules, one row per card that has rules):
 *   - spending_limit { amount (USD), interval: daily | per_transaction }
 *   - single_use : one purchase, then the card is frozen for good; no funding, no withdrawal; closed after 30 days if never used.
 * The current card issuer has no limit of its own, so the rules are applied on each purchase it reports: as soon as a purchase
 * reaches the daily limit (or goes over the per-purchase limit), the card is frozen — until the next day (UTC) for a daily limit,
 * until the merchant unfreezes it for a per-purchase limit. Cards without rules never read this table.
 */
const INTERVALS = ['daily', 'per_transaction'];
const round2 = (n) => Math.round(Number(n) * 100) / 100;

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}
const isMissingTable = (err) => {
  const d = (err && err.details) || {};
  return d.code === 'PGRST205' || d.code === '42P01' || /Could not find the table|does not exist/i.test(String((err && err.message) || ''));
};

/** Reads and checks the request's rules. Returns null when the card has none. Throws 400 INVALID_SPENDING_LIMIT. */
function parse(body) {
  const b = body || {};
  const singleUse = b.single_use === true || b.single_use === 'true';
  const sl = b.spending_limit;
  if (sl == null || sl === '') return singleUse ? { single_use: true, limit_amount: null, limit_interval: null } : null;
  if (singleUse) throw httpError(400, 'INVALID_SPENDING_LIMIT', 'Une carte à usage unique ne peut pas avoir de spending_limit.');
  if (typeof sl !== 'object') throw httpError(400, 'INVALID_SPENDING_LIMIT', 'spending_limit doit être un objet : { "amount": 20, "interval": "daily" }.');
  const amount = typeof sl.amount === 'number' ? sl.amount : NaN;
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) throw httpError(400, 'INVALID_SPENDING_LIMIT', 'spending_limit.amount doit être un nombre positif, en dollars (maximum 100 000).');
  if (!INTERVALS.includes(sl.interval)) throw httpError(400, 'INVALID_SPENDING_LIMIT', "spending_limit.interval doit être 'daily' (par jour) ou 'per_transaction' (par achat).");
  return { single_use: false, limit_amount: round2(amount), limit_interval: sl.interval };
}

/** Before any money moves: the rules can only be honoured if the table exists. */
async function assertAvailable() {
  try { await supabase.select('card_rules', {}, { limit: 1 }); } catch (err) {
    if (isMissingTable(err)) throw httpError(503, 'FEATURE_NOT_READY', "Les plafonds et les cartes à usage unique ne sont pas encore activés sur ce serveur. Aucun montant n'a été débité ; créez la carte sans spending_limit ni single_use, ou réessayez plus tard.");
    throw err;
  }
}

async function save(card, rules) {
  const now = new Date().toISOString();
  return supabase.insert('card_rules', { card_id: card.id, merchant_id: card.merchant_id, mode: card.mode || 'sandbox', ...rules, created_at: now, updated_at: now });
}

async function get(cardId) {
  try { return await supabase.selectOne('card_rules', { card_id: cardId }); } catch (err) { if (isMissingTable(err)) return null; throw err; }
}
async function getMany(cardIds) {
  if (!cardIds.length) return new Map();
  try {
    const rows = await supabase.select('card_rules', { card_id: supabase.inList(cardIds) }, { limit: cardIds.length });
    return new Map(rows.map((r) => [r.card_id, r]));
  } catch (err) { if (isMissingTable(err)) return new Map(); throw err; }
}

/** The public view of a card's rules (added to the card object). */
function publicFields(r) {
  return {
    spending_limit: r && r.limit_amount != null ? { amount: Number(r.limit_amount), interval: r.limit_interval } : null,
    single_use: !!(r && r.single_use),
    ...(r && r.limit_frozen_until ? { limit_reached_until: r.limit_frozen_until } : {}),
    ...(r && r.single_use_consumed_at ? { single_use_consumed_at: r.single_use_consumed_at } : {}),
  };
}

async function assertCanMoveFunds(cardId) {
  const r = await get(cardId);
  if (r && r.single_use) throw httpError(400, 'CARD_SINGLE_USE', 'Carte à usage unique : elle ne peut être ni rechargée ni vidée.');
}

/** Manual unfreeze: refused once a single-use card has been used; otherwise it lifts a limit freeze too. */
async function beforeUnfreeze(cardId) {
  const r = await get(cardId);
  if (!r) return;
  if (r.single_use && r.single_use_consumed_at) throw httpError(400, 'CARD_SINGLE_USE', 'Carte à usage unique déjà utilisée : elle ne peut plus être dégelée.');
  if (r.limit_frozen_until) await supabase.update('card_rules', { card_id: cardId }, { limit_frozen_until: null, updated_at: new Date().toISOString() });
}

async function freezeFor(card, reason, extra) {
  if (card.status === 'active' && require('./cardIssuer').providerCardId(card)) {
    await require('./cardIssuer').call(card, (o) => o.freeze());
    await supabase.update('cards', { id: card.id, status: 'active' }, { status: 'disabled', updated_at: new Date().toISOString() });
    webhookDispatcher.dispatch(card.merchant_id, 'card.frozen', { id: card.id, reference: card.own_reference, reason, ...(extra || {}) });
    return true;
  }
  return false;
}

const isPurchase = (row) => row && row.type === 'AUTHORIZATION' && row.direction === 'DEBIT' && !/DECLIN|FAIL|REJECT/.test(String(row.status || ''));
const nextUtcMidnight = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();

/** Called for every card movement the issuer reports. Never throws: a rule that cannot be applied is logged. */
async function afterTransaction(card, row) {
  try {
    if (!isPurchase(row)) return null;
    const r = await get(card.id);
    if (!r || r.native) return null; // the issuer applies this card's rules itself, at payment time
    const now = new Date().toISOString();
    if (r.single_use) {
      if (r.single_use_consumed_at) return null;
      const [claimed] = await supabase.update('card_rules', { card_id: card.id, single_use_consumed_at: supabase.isNull() }, { single_use_consumed_at: now, updated_at: now });
      if (claimed) await freezeFor(card, 'single_use');
      return 'single_use';
    }
    const limit = Number(r.limit_amount);
    if (r.limit_interval === 'per_transaction') {
      if (Number(row.amount_usd || 0) >= limit) { await freezeFor(card, 'spending_limit', { limit: { amount: limit, interval: 'per_transaction' } }); return 'per_transaction'; }
      return null;
    }
    if (r.limit_interval === 'daily') {
      const start = new Date(); start.setUTCHours(0, 0, 0, 0);
      const today = await supabase.select('card_transactions', { card_id: card.id, type: 'AUTHORIZATION', direction: 'DEBIT', occurred_at: supabase.gte(start.toISOString()) }, { limit: 1000 });
      const spent = round2(today.filter(isPurchase).reduce((t, x) => t + Number(x.amount_usd || 0), 0));
      if (spent >= limit) {
        const until = nextUtcMidnight(new Date());
        await supabase.update('card_rules', { card_id: card.id }, { limit_frozen_until: until, updated_at: now });
        await freezeFor(card, 'spending_limit', { limit: { amount: limit, interval: 'daily' }, spent_today: spent, until });
        return 'daily';
      }
    }
    return null;
  } catch (err) {
    console.error(`Card rules not applied on ${card.id}: ${err.message}`); // eslint-disable-line no-console
    return null;
  }
}

/** Background: cards frozen by a daily limit are unfrozen once the day has changed (UTC); unused single-use cards close after 30 days. */
async function housekeeping() {
  const out = { unfrozen: 0, closed: 0 };
  let due;
  try { due = await supabase.select('card_rules', { limit_frozen_until: supabase.lte(new Date().toISOString()) }, { limit: 100 }); } catch (err) { if (isMissingTable(err)) return out; throw err; }
  for (const r of due) {
    const card = await supabase.selectOne('cards', { id: r.card_id });
    await supabase.update('card_rules', { card_id: r.card_id }, { limit_frozen_until: null, updated_at: new Date().toISOString() });
    if (card && card.status === 'disabled' && require('./cardIssuer').providerCardId(card) && !card.deleted_at) {
      try {
        await require('./cardIssuer').call(card, (o) => o.unfreeze());
        await supabase.update('cards', { id: card.id, status: 'disabled' }, { status: 'active', updated_at: new Date().toISOString() });
        webhookDispatcher.dispatch(card.merchant_id, 'card.unfrozen', { id: card.id, reference: card.own_reference, reason: 'spending_limit_reset' });
        out.unfrozen += 1;
      } catch (e) { console.error(`Daily limit reset failed for ${card.id}: ${e.message}`); } // eslint-disable-line no-console
    }
  }
  const old = new Date(Date.now() - 30 * 86400000).toISOString();
  const singles = await supabase.select('card_rules', { single_use: true, single_use_consumed_at: supabase.isNull(), created_at: supabase.lt(old) }, { limit: 50 });
  for (const r of singles) {
    const card = await supabase.selectOne('cards', { id: r.card_id });
    if (!card || card.deleted_at || ['terminated', 'failed', 'pending'].includes(card.status)) continue;
    try { await require('./cardOrchestrator').terminateCard(card.merchant_id, card.id, { force: true }); out.closed += 1; } catch (e) { console.error(`Single-use card ${card.id} not closed: ${e.message}`); } // eslint-disable-line no-console
  }
  return out;
}

/**
 * Changes (or removes, with null) the spending limit of an existing card. A single-use card has no limit. A limit held by the issuer itself
 * (Monerails cards) is fixed at creation: 409 CARD_LIMIT_NOT_EDITABLE.
 */
async function setLimit(card, spendingLimit) {
  const parsed = spendingLimit == null ? null : parse({ spending_limit: spendingLimit });
  await assertAvailable();
  const r = await get(card.id);
  if (r && r.single_use) throw httpError(400, 'CARD_SINGLE_USE', "Une carte à usage unique n'a pas de plafond.");
  if (r && r.native) throw httpError(409, 'CARD_LIMIT_NOT_EDITABLE', 'Le plafond de cette carte est fixé à sa création et ne peut pas être modifié. Créez une nouvelle carte avec le plafond voulu.');
  const now = new Date().toISOString();
  const fields = { limit_amount: parsed ? parsed.limit_amount : null, limit_interval: parsed ? parsed.limit_interval : null, updated_at: now };
  if (!parsed) fields.limit_frozen_until = null;
  if (r) await supabase.update('card_rules', { card_id: card.id }, fields);
  else if (parsed) await supabase.insert('card_rules', { card_id: card.id, merchant_id: card.merchant_id, mode: card.mode || 'sandbox', single_use: false, ...fields, created_at: now });
  return get(card.id);
}

module.exports = { setLimit, parse, assertAvailable, save, get, getMany, publicFields, assertCanMoveFunds, beforeUnfreeze, afterTransaction, housekeeping, isPurchase };
