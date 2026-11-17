'use strict';
const supabase = require('../lib/supabase');
const ledger = require('./ledger');
const revenue = require('./revenue');
const webhookDispatcher = require('./webhookDispatcher');

/**
 * The new card program: tokenized Visa / Mastercard cards (Apple Pay, Google Pay), issued by the new issuer.
 *   - A merchant joins once per environment: join_fee_usd (20 $) from the LIVE Master Wallet; free in Sandbox, to test.
 *   - Members' NEW individual cards go to the new issuer, at the program's prices; cards created before keep their issuer and prices.
 *   - Members top up their Master Wallet by at least min_topup_usd (200 $) each time.
 *   - Live joining opens when the team switches the new issuer's Live on (Admin > Monerails).
 * Settings (platform_settings "card_program"): join_fee_usd, min_topup_usd, prices (fields left empty = the merchant's plan price).
 */
const KEY = 'card_program';
const PRICE_FIELDS = ['card_creation_usd', 'card_recharge_usd', 'card_withdrawal_usd', 'card_decline_usd', 'card_spend_usd', 'card_closure_usd', 'monthly_usd'];
const DEFAULTS = { join_fee_usd: 20, min_topup_usd: 200, prices: Object.fromEntries(PRICE_FIELDS.map((f) => [f, null])) };
let cache = null; let at = 0;
const round2 = (n) => Math.round(Number(n) * 100) / 100;

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}
const missingTable = (err) => { const d = (err && err.details) || {}; return d.code === 'PGRST205' || d.code === '42P01' || /Could not find the table|does not exist/i.test(String((err && err.message) || '')); };

async function settings() {
  if (cache && Date.now() - at < 15000) return cache;
  let saved = {};
  try { const row = await supabase.selectOne('platform_settings', { key: KEY }); if (row) saved = JSON.parse(row.value) || {}; } catch (e) { /* defaults */ }
  cache = Object.assign({}, DEFAULTS, saved, { prices: Object.assign({}, DEFAULTS.prices, saved.prices || {}) });
  at = Date.now();
  return cache;
}
async function saveSettings(patch, adminEmail) {
  const next = JSON.parse(JSON.stringify(await settings()));
  const num = (v, max) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= max ? round2(n) : undefined; };
  if (patch.join_fee_usd !== undefined && num(patch.join_fee_usd, 10000) !== undefined) next.join_fee_usd = num(patch.join_fee_usd, 10000);
  if (patch.min_topup_usd !== undefined && num(patch.min_topup_usd, 100000) !== undefined) next.min_topup_usd = num(patch.min_topup_usd, 100000);
  if (patch.prices && typeof patch.prices === 'object') {
    for (const f of PRICE_FIELDS) {
      if (!(f in patch.prices)) continue;
      const v = patch.prices[f];
      next.prices[f] = v === null || v === '' ? null : (num(v, 10000) === undefined ? next.prices[f] : num(v, 10000));
    }
  }
  const row = { value: JSON.stringify(next), updated_by: adminEmail || null, updated_at: new Date().toISOString() };
  if (await supabase.selectOne('platform_settings', { key: KEY })) await supabase.update('platform_settings', { key: KEY }, row);
  else await supabase.insert('platform_settings', Object.assign({ key: KEY }, row));
  cache = next; at = Date.now();
  return next;
}

async function membership(merchantId, mode) {
  try { return await supabase.selectOne('card_program_members', { merchant_id: merchantId, mode: mode === 'live' ? 'live' : 'sandbox' }); } catch (err) { if (missingTable(err)) return null; throw err; }
}
const isMember = async (merchantId, mode) => !!(await membership(merchantId, mode));

/** Whether a merchant can join now in this environment (the new issuer must be ready there). */
async function openFor(mode) {
  const monerails = require('./monerails');
  if (mode === 'live') return monerails.configured('live') && !!(await require('./cardIssuer').settings()).live_enabled;
  return monerails.configured('sandbox');
}

/** Joins the program: once per environment; the fee is taken from the Live Master Wallet (free in Sandbox). */
async function join(merchantId, mode) {
  const env = mode === 'live' ? 'live' : 'sandbox';
  const existing = await membership(merchantId, env);
  if (existing) return { member: existing, already: true };
  if (!(await openFor(env))) throw httpError(409, 'PROGRAM_NOT_OPEN', env === 'live' ? "Le nouveau programme de cartes n'est pas encore ouvert en Live. Vous serez prévenu dès son ouverture ; vous pouvez déjà l'essayer en Sandbox." : "Le nouveau programme de cartes n'est pas encore disponible. Réessayez plus tard.");
  const s = await settings();
  const fee = env === 'live' ? round2(s.join_fee_usd) : 0;
  const ref = `card-program-join:${merchantId}:${env}`;
  if (fee > 0) {
    const available = await ledger.getBalance(merchantId, 'master_wallet', 'USD', env);
    if (available < fee) throw httpError(400, 'INSUFFICIENT_BALANCE', `Il faut ${fee.toFixed(2)} $ sur votre Master Wallet pour rejoindre le programme (disponible : ${round2(available).toFixed(2)} $).`);
    if (!(await supabase.selectOne('ledger_entries', { merchant_id: merchantId, reference: ref }))) {
      await ledger.debitMasterWallet(merchantId, fee, 'USD', ref, null, env);
      await revenue.log(merchantId, 'card_program_join', fee, 'USD', null, env, 0).catch(() => {});
    }
  }
  let member;
  try {
    member = await supabase.insert('card_program_members', { merchant_id: merchantId, mode: env, joined_at: new Date().toISOString(), fee_usd: fee, ledger_reference: fee > 0 ? ref : null });
  } catch (err) {
    if (missingTable(err)) {
      if (fee > 0) await ledger.creditMasterWallet(merchantId, fee, 'USD', `refund:${ref}`, null, env).catch(() => {});
      throw httpError(503, 'FEATURE_NOT_READY', "Le programme n'est pas encore activé sur le serveur. Rien n'a été débité.");
    }
    member = await membership(merchantId, env);
    if (!member) throw err;
  }
  webhookDispatcher.dispatch(merchantId, 'card_program.joined', { mode: env, fee_usd: fee });
  return { member, already: false };
}

/** Members top up their Master Wallet by at least min_topup_usd each time (400 BELOW_PROGRAM_MINIMUM). */
async function assertTopupAllowed(merchantId, mode, amountUsd) {
  if (!(await isMember(merchantId, mode))) return;
  const s = await settings();
  if (Number(amountUsd) < Number(s.min_topup_usd)) throw httpError(400, 'BELOW_PROGRAM_MINIMUM', `Membre du nouveau programme de cartes : chaque recharge du Master Wallet doit être d'au moins ${Number(s.min_topup_usd).toFixed(0)} $.`);
}

/**
 * Pricing for a card: a card of the new program uses the program's prices (fields left empty = the plan's), and a custom price an admin
 * set for this merchant still wins. Any other card keeps the merchant's usual pricing.
 */
async function pricingOverrideFor(merchantId, card) {
  const merchantOverride = await supabase.selectOne('merchant_pricing', { merchant_id: merchantId }).catch(() => null);
  if (!card || card.provider !== 'monerails') return merchantOverride;
  const p = (await settings()).prices || {};
  const out = {};
  for (const f of ['card_creation_usd', 'card_recharge_usd', 'card_withdrawal_usd', 'card_decline_usd']) {
    const m = merchantOverride && merchantOverride[f] != null ? merchantOverride[f] : null;
    out[f] = m != null ? m : (p[f] != null ? p[f] : null);
  }
  if (merchantOverride && merchantOverride.wallet_funding_pct != null) out.wallet_funding_pct = merchantOverride.wallet_funding_pct;
  return out;
}

/** What the dashboard shows. */
async function status(merchantId, mode) {
  const s = await settings();
  const [live, sandbox] = await Promise.all([membership(merchantId, 'live'), membership(merchantId, 'sandbox')]);
  return {
    member: { live: !!live, sandbox: !!sandbox }, joined_at: { live: live ? live.joined_at : null, sandbox: sandbox ? sandbox.joined_at : null },
    open: { live: await openFor('live'), sandbox: await openFor('sandbox') },
    join_fee_usd: s.join_fee_usd, min_topup_usd: s.min_topup_usd, prices: s.prices, mode: mode === 'live' ? 'live' : 'sandbox',
  };
}

module.exports = { settings, saveSettings, membership, isMember, join, assertTopupAllowed, pricingOverrideFor, status, openFor, PRICE_FIELDS };
