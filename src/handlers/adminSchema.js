'use strict';
const fs = require('fs');
const path = require('path');
const supabase = require('../lib/supabase');
const maplerad = require('../services/maplerad');
const { randomHex } = require('../utils/ids');

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

/** The tables the application expects, read from supabase-schema.sql (the single source of truth). */
function expectedTables() {
  try {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase-schema.sql'), 'utf8');
    return [...new Set([...sql.matchAll(/create table if not exists\s+([a-z_0-9]+)/gi)].map((m) => m[1]))];
  } catch (err) { return []; }
}

/** Which expected tables are missing in the real database, and which migration file creates each. */
async function schemaCheck() {
  const tables = expectedTables();
  const missing = [];
  for (const t of tables) {
    try { await supabase.select(t, {}, { limit: 1 }); } catch (err) {
      const d = err && err.details;
      if (d && (d.code === 'PGRST205' || d.code === '42P01' || /Could not find the table|does not exist/i.test(String(d.message || err.message)))) missing.push(t);
    }
  }
  let migrations = [];
  try { migrations = fs.readdirSync(path.join(__dirname, '..', '..', 'migrations')).filter((f) => f.endsWith('.sql')); } catch (e) { /* none */ }
  const fileFor = (t) => migrations.filter((f) => { try { return new RegExp(`create table if not exists\\s+${t}\\b`, 'i').test(fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', f), 'utf8')); } catch (e) { return false; } });
  return { status: 200, body: { checked: tables.length, missing: missing.map((t) => ({ table: t, migrations: fileFor(t) })) } };
}

/**
 * What the card partner really sends us: counts by event type and the latest events, each with whether its card is known and whether
 * a transaction was stored for it. Answers "do the purchase notifications arrive, and are they processed?".
 */
async function webhookEvents() {
  let rows = [];
  try { rows = await supabase.select('webhook_events', { provider: 'maplerad' }, { order: 'created_at.desc', limit: 200 }); } catch (err) { rows = []; }
  const counts = {};
  for (const r of rows) counts[r.event_type || '?'] = (counts[r.event_type || '?'] || 0) + 1;
  const latest = [];
  for (const r of rows.slice(0, 25)) {
    const p = r.payload || {};
    const cardId = p.card_id || (p.card && p.card.id) || null;
    const card = cardId ? await supabase.selectOne('cards', { maplerad_card_id: cardId }).catch(() => null) : null;
    let stored = null;
    if (r.event_type === 'issuing.transaction' && card) {
      const ref = p.reference ? String(p.reference) : `${p.card_id}:${String(p.type || '').toUpperCase()}:${p.amount}:${p.created_at || ''}`;
      stored = !!(await supabase.selectOne('card_transactions', { card_id: card.id, provider_reference: ref }).catch(() => null));
    }
    // Crypto deposit notifications: is the address one of ours, and was the deposit read and credited?
    let cryptoKnown = null; let cryptoStored = null; let cryptoNote = null;
    const dep = require('../services/cryptoWallet').parseDepositEvent(p);
    if (dep) {
      const addr = dep.address ? await supabase.selectOne('crypto_addresses', { address: dep.address }).catch(() => null) : (dep.addressId ? await supabase.selectOne('crypto_addresses', { maplerad_address_id: dep.addressId }).catch(() => null) : null);
      cryptoKnown = !!addr;
      cryptoStored = dep.reference ? !!(await supabase.selectOne('crypto_deposits', { provider_reference: dep.reference }).catch(() => null)) : false;
      cryptoNote = !dep.ok ? 'not a successful deposit' : (dep.amount == null ? 'amount not readable' : (!addr ? 'address unknown' : null));
    }
    latest.push({ at: r.created_at, event: r.event_type, type: p.type || null, direction: p.mode || null, status: p.status || null, amount_cents: p.amount == null ? null : p.amount, card_known: cardId ? !!card : (cryptoKnown !== null ? cryptoKnown : null), stored: stored !== null ? stored : cryptoStored, note: cryptoNote });
  }
  // The MonCash / Natcash partner's own notifications (transaction.created / transaction.status_changed): is it really calling us?
  let plop = [];
  try { plop = await supabase.select('webhook_events', { provider: 'plopplop' }, { order: 'created_at.desc', limit: 50 }); } catch (err) { plop = []; }
  const plopplop = {
    received: plop.length,
    last_at: plop[0] ? plop[0].created_at : null,
    latest: plop.slice(0, 10).map((r) => { const t = (r.payload && r.payload.transaction) || {}; return { at: r.created_at, event: r.event_type, reference: t.reference_id || null, new_status: t.new_status || t.status || null, amount: t.amount == null ? null : t.amount, method: t.method || null }; }),
  };
  return { status: 200, body: { received: rows.length, counts, latest, plopplop } };
}

/**
 * Brings in the transactions the partner holds for the active live cards (60 newest) and stores the ones we do not have. A transaction we never
 * stored was never applied, so the card balance follows it too (then it is aligned with the partner's figure).
 */
async function importTransactions(ctx) {
  const mode = ctx.body && ctx.body.mode === 'sandbox' ? 'sandbox' : 'live';
  const cards = await supabase.select('cards', { status: supabase.inList(['active', 'disabled']), mode, deleted_at: supabase.isNull() }, { order: 'created_at.desc', limit: 60 });
  let imported = 0; let checked = 0; const errors = [];
  for (const c of cards) {
    if (!c.maplerad_card_id) continue;
    checked += 1;
    try {
      imported += (await require('../services/cardOrchestrator').syncCardTransactionsFromPartner(c)).imported;
    } catch (err) { errors.push(`${c.own_reference}: ${err.message}`); }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { status: 200, body: { mode, cards_checked: checked, imported, errors: errors.slice(0, 10) } };
}

module.exports = { schemaCheck, webhookEvents, importTransactions, expectedTables };
