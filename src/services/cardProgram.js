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
 * Settings (platform_settings "card_program"): join_fee_usd, min_topup_usd, plans (startup / pro / premium, editable by the owner).
 */
const KEY = 'card_program';
/**
 * The program's price list (official grid of 17/11/2026), one column per Issuing plan: a member stays on the Issuing plan they already
 * have (Startup, Pro, Premium; its subscription is billed as before) and their program cards follow that plan's column. Joining costs the
 * entry fee only. Paid by the merchant: card creation (Premium: 50 free cards a month, then the price) and recharge (Master Wallet),
 * Master Wallet deposit %. Taken from the CARD: card withdrawal % (kept from the amount withdrawn), the Startup 1 % purchase commission,
 * and the issuer's own charges (international 2.30 % + 0.50 $, monthly maintenance, refused authorizations).
 */
const PLAN_KEYS = ['startup', 'pro', 'premium'];
const PLAN_FIELDS = ['monthly_usd', 'card_creation_usd', 'free_cards_per_month', 'card_recharge_usd', 'deposit_pct', 'withdrawal_pct', 'purchase_pct', 'maintenance_usd', 'decline_usd', 'international_pct', 'international_fixed_usd'];
const DEFAULT_PLANS = {
  startup: { label: 'Startup', monthly_usd: 0, card_creation_usd: 3, free_cards_per_month: 0, card_recharge_usd: 1, deposit_pct: 4, withdrawal_pct: 3, purchase_pct: 1, maintenance_usd: 0.5, decline_usd: 0.5, international_pct: 2.3, international_fixed_usd: 0.5 },
  pro: { label: 'Pro', monthly_usd: 150, card_creation_usd: 2, free_cards_per_month: 0, card_recharge_usd: 0.5, deposit_pct: 2.7, withdrawal_pct: 2, purchase_pct: 0, maintenance_usd: 0.5, decline_usd: 0.5, international_pct: 2.3, international_fixed_usd: 0.5 },
  premium: { label: 'Premium', monthly_usd: 500, card_creation_usd: 2.5, free_cards_per_month: 50, card_recharge_usd: 1.1, deposit_pct: 2.5, withdrawal_pct: 1.5, purchase_pct: 0, maintenance_usd: 0, decline_usd: 0.5, international_pct: 2.3, international_fixed_usd: 0.5 },
};
const PRICE_FIELDS = PLAN_FIELDS;
// What the card partner charges US (internal price list, never shown to merchants). Used only to compute profit in the admin.
// Maintenance (0.50 $/card/month), international fees and refused authorizations are charged on the card itself: pass-through, no cost for us.
const DEFAULT_PROVIDER_COSTS = { card_creation_usd: 1, card_recharge_usd: 0, deposit_pct: 2.5, withdrawal_pct: 1.5, purchase_usd: 0 };
const DEFAULTS = { join_fee_usd: 20, min_topup_usd: 200, plans: DEFAULT_PLANS, provider_costs: DEFAULT_PROVIDER_COSTS };
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
  const plans = {};
  for (const k of PLAN_KEYS) plans[k] = Object.assign({}, DEFAULT_PLANS[k], (saved.plans || {})[k] || {});
  cache = Object.assign({}, DEFAULTS, saved, { plans, provider_costs: Object.assign({}, DEFAULT_PROVIDER_COSTS, saved.provider_costs || {}) });
  delete cache.prices;
  at = Date.now();
  return cache;
}
async function saveSettings(patch, adminEmail) {
  const next = JSON.parse(JSON.stringify(await settings()));
  const num = (v, max) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= max ? round2(n) : undefined; };
  if (patch.join_fee_usd !== undefined && num(patch.join_fee_usd, 10000) !== undefined) next.join_fee_usd = num(patch.join_fee_usd, 10000);
  if (patch.min_topup_usd !== undefined && num(patch.min_topup_usd, 100000) !== undefined) next.min_topup_usd = num(patch.min_topup_usd, 100000);
  if (patch.provider_costs && typeof patch.provider_costs === 'object') {
    next.provider_costs = Object.assign({}, DEFAULT_PROVIDER_COSTS, next.provider_costs || {});
    for (const f of Object.keys(DEFAULT_PROVIDER_COSTS)) { const v = num(patch.provider_costs[f], 1000); if (patch.provider_costs[f] !== undefined && v !== undefined) next.provider_costs[f] = v; }
  }
  if (patch.plans && typeof patch.plans === 'object') {
    for (const k of PLAN_KEYS) {
      const pp = patch.plans[k];
      if (!pp || typeof pp !== 'object') continue;
      for (const f of PLAN_FIELDS) {
        if (!(f in pp)) continue;
        const v = num(pp[f], 100000);
        if (v !== undefined) next.plans[k][f] = f === 'free_cards_per_month' ? Math.round(v) : v;
      }
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
  // Claim the membership FIRST: the (merchant, environment) primary key lets only one of two simultaneous requests through, so the entry
  // fee can never be charged twice. If the charge then fails, the claim is released.
  let member;
  try {
    member = await supabase.insert('card_program_members', { merchant_id: merchantId, mode: env, joined_at: new Date().toISOString(), fee_usd: fee, ledger_reference: fee > 0 ? ref : null });
  } catch (err) {
    if (missingTable(err)) throw httpError(503, 'FEATURE_NOT_READY', "Le programme n'est pas encore activé sur le serveur. Rien n'a été débité.");
    const raced = await membership(merchantId, env);
    if (raced) return { member: raced, already: true };
    throw err;
  }
  if (fee > 0) {
    try {
      const available = await ledger.getBalance(merchantId, 'master_wallet', 'USD', env);
      if (available < fee) throw httpError(400, 'INSUFFICIENT_BALANCE', `Il faut ${fee.toFixed(2)} $ sur votre Master Wallet pour rejoindre le programme (disponible : ${round2(available).toFixed(2)} $).`);
      if (!(await supabase.selectOne('ledger_entries', { merchant_id: merchantId, reference: ref }))) {
        await ledger.debitMasterWallet(merchantId, fee, 'USD', ref, null, env);
        await revenue.log(merchantId, 'card_program_join', fee, 'USD', null, env, 0).catch(() => {});
      }
    } catch (err) {
      await supabase.delete('card_program_members', { merchant_id: merchantId, mode: env }).catch(() => {});
      throw err;
    }
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

const monthKey = (d) => new Date(d || Date.now()).toISOString().slice(0, 7);

/** The merchant's Issuing plan key in this environment (the program's price column). */
async function currentPlanKey(merchantId, mode) {
  const merchant = await supabase.selectOne('merchants', { id: merchantId });
  return require('./plans').planKeyFor(merchant, 'issuing', mode === 'live' ? 'live' : 'sandbox');
}

/**
 * The price column of a member: the Issuing plan they already have. The "Offert" plan (granted by the team) stays free of Freda Pay fees
 * (the issuer's own charges on the card remain). Null for a merchant outside the program.
 */
async function planFor(merchantId, mode) {
  if (!(await membership(merchantId, mode))) return null;
  const issuingKey = await currentPlanKey(merchantId, mode);
  const s = await settings();
  if (issuingKey === 'free') {
    return Object.assign({}, s.plans.startup, { key: 'free', label: 'Offert', monthly_usd: 0, card_creation_usd: 0, free_cards_per_month: 0, card_recharge_usd: 0, deposit_pct: 0, withdrawal_pct: 0, purchase_pct: 0 });
  }
  const key = PLAN_KEYS.includes(issuingKey) ? issuingKey : 'startup';
  return Object.assign({ key }, s.plans[key]);
}

/**
 * Pricing override for a card: a card of the program uses the member's plan (creation, recharge); any other card keeps the merchant's
 * usual pricing. A custom price an admin set for this merchant still wins.
 */
async function pricingOverrideFor(merchantId, card) {
  const merchantOverride = await supabase.selectOne('merchant_pricing', { merchant_id: merchantId }).catch(() => null);
  if (!card || card.provider !== 'monerails') return merchantOverride;
  const plan = (await planFor(merchantId, card.mode || 'sandbox')) || Object.assign({ key: 'startup' }, (await settings()).plans.startup);
  const pick = (f, v) => (merchantOverride && merchantOverride[f] != null ? merchantOverride[f] : v);
  return {
    card_creation_usd: pick('card_creation_usd', plan.card_creation_usd),
    card_recharge_usd: pick('card_recharge_usd', plan.card_recharge_usd),
    card_withdrawal_usd: pick('card_withdrawal_usd', null),
    card_decline_usd: 0, // refused authorizations are charged by the issuer on the card
    wallet_funding_pct: merchantOverride && merchantOverride.wallet_funding_pct != null ? merchantOverride.wallet_funding_pct : null,
  };
}

/** Creation price of the next program card: Premium includes free cards every month, then the plan price. Counts the card when used. */
async function creationFeeFor(merchantId, mode) {
  const plan = await planFor(merchantId, mode);
  const s = await settings();
  const p = plan || Object.assign({ key: 'startup' }, s.plans.startup);
  const override = await supabase.selectOne('merchant_pricing', { merchant_id: merchantId }).catch(() => null);
  if (override && override.card_creation_usd != null) return { fee: Number(override.card_creation_usd), free: false };
  if (plan && Number(p.free_cards_per_month) > 0) {
    const m = await membership(merchantId, mode);
    // Without the counter column (migration not run) the free cards cannot be counted: the plan price applies rather than unlimited free cards.
    if (m && 'free_cards_used' in m) {
      const used = m.free_cards_month === monthKey() ? Number(m.free_cards_used || 0) : 0;
      if (used < Number(p.free_cards_per_month)) return { fee: 0, free: true, used };
    }
  }
  return { fee: round2(p.card_creation_usd), free: false };
}
async function countFreeCard(merchantId, mode) {
  // Compare-and-set on the counter: two cards created at once cannot both take the same free slot.
  for (let i = 0; i < 5; i += 1) {
    const m = await membership(merchantId, mode);
    if (!m) return;
    const used = m.free_cards_month === monthKey() ? Number(m.free_cards_used || 0) : 0;
    const done = await supabase.update('card_program_members', { merchant_id: merchantId, mode: mode === 'live' ? 'live' : 'sandbox', free_cards_used: Number(m.free_cards_used || 0) }, { free_cards_month: monthKey(), free_cards_used: used + 1 }).catch(() => []);
    if (done && done.length) return;
  }
}

/** Card withdrawal fee of a program card: a percentage of the amount (custom fixed price of the merchant wins). */
async function withdrawalFeeFor(merchantId, mode, amountUsd) {
  const override = await supabase.selectOne('merchant_pricing', { merchant_id: merchantId }).catch(() => null);
  if (override && override.card_withdrawal_usd != null) return Number(override.card_withdrawal_usd);
  const p = (await planFor(merchantId, mode)) || (await settings()).plans.startup;
  return round2(Number(amountUsd) * Number(p.withdrawal_pct || 0) / 100);
}

/** Commission on a successful purchase of a program card (Startup 1 %), taken from the card. */
async function purchaseFeeFor(merchantId, mode, amountUsd) {
  const p = (await planFor(merchantId, mode)) || (await settings()).plans.startup;
  return round2(Number(amountUsd) * Number(p.purchase_pct || 0) / 100);
}

/** Master Wallet deposit fee (fraction) of a member; null outside the program (the usual plan fee applies). A custom rate still wins. */
async function depositPctFor(merchantId, mode) {
  const plan = await planFor(merchantId, mode);
  if (!plan) return null;
  const override = await supabase.selectOne('merchant_pricing', { merchant_id: merchantId }).catch(() => null);
  if (override && override.wallet_funding_pct != null) return Number(override.wallet_funding_pct);
  return Math.round(Number(plan.deposit_pct || 0) * 1000) / 100000; // e.g. 2.7 (%) -> 0.027
}

/** What the card partner charges us on one operation (USD), for the admin profit. kind: creation | recharge | withdrawal | deposit | purchase. */
async function providerCostFor(kind, amountUsd) {
  const c = (await settings()).provider_costs || DEFAULT_PROVIDER_COSTS;
  const amt = Number(amountUsd || 0);
  const v = kind === 'creation' ? c.card_creation_usd : kind === 'recharge' ? c.card_recharge_usd : kind === 'withdrawal' ? amt * c.withdrawal_pct / 100
    : kind === 'deposit' ? amt * c.deposit_pct / 100 : kind === 'purchase' ? c.purchase_usd : 0;
  return round2(v);
}
/** Partner cost of a Master Wallet deposit: the program's rate for members, the usual rate for the others. */
async function depositCostFor(merchantId, mode, amountUsd) {
  if (await planFor(merchantId, mode).catch(() => null)) return providerCostFor('deposit', amountUsd);
  return round2(require('../config').issuingProviderCostsUSD.walletFundingPct * Number(amountUsd || 0));
}

/**
 * Who looked at the program: 'seen' = the dashboard showed the banner (at most one count per 30 minutes), 'opened' = the merchant opened
 * the program window. Best effort: never breaks the dashboard (and does nothing until the table exists).
 */
async function recordView(merchantId, kind) {
  try {
    const now = new Date().toISOString();
    const row = await supabase.selectOne('card_program_views', { merchant_id: merchantId });
    if (!row) { await supabase.insert('card_program_views', Object.assign({ merchant_id: merchantId, first_seen_at: now, last_seen_at: now, seen_count: 1, open_count: 0 }, kind === 'opened' ? { opened_at: now, last_opened_at: now, open_count: 1 } : {})); return; }
    if (kind === 'opened') await supabase.update('card_program_views', { merchant_id: merchantId }, { opened_at: row.opened_at || now, last_opened_at: now, open_count: Number(row.open_count || 0) + 1, last_seen_at: now });
    else if (Date.now() - new Date(row.last_seen_at || 0).getTime() > 30 * 60 * 1000) await supabase.update('card_program_views', { merchant_id: merchantId }, { last_seen_at: now, seen_count: Number(row.seen_count || 0) + 1 });
  } catch (e) { /* optional statistic */ }
}

/** Admin: how many merchants joined, how many looked at it, and who. */
async function adminOverview() {
  const [members, views, merchants] = await Promise.all([
    supabase.select('card_program_members', {}, { order: 'joined_at.desc', limit: 5000 }).catch(() => []),
    supabase.select('card_program_views', {}, { limit: 5000 }).catch(() => []),
    supabase.select('merchants', { deleted_at: supabase.isNull() }, { limit: 20000 }).catch(() => []),
  ]);
  const byId = new Map(merchants.map((m) => [m.id, m]));
  const memberIds = (mode) => new Set(members.filter((m) => m.mode === mode).map((m) => m.merchant_id));
  const live = memberIds('live'); const sandbox = memberIds('sandbox');
  const joined = new Set([...live, ...sandbox]);
  const visitors = views.map((v) => {
    const m = byId.get(v.merchant_id) || {};
    return { merchant_id: v.merchant_id, business_name: m.business_name || null, email: m.email || null, first_seen_at: v.first_seen_at, last_seen_at: v.last_seen_at, seen_count: Number(v.seen_count || 0), opened_at: v.opened_at || null, last_opened_at: v.last_opened_at || null, open_count: Number(v.open_count || 0), joined_live: live.has(v.merchant_id), joined_sandbox: sandbox.has(v.merchant_id) };
  }).sort((a, b) => String(b.last_opened_at || b.last_seen_at).localeCompare(String(a.last_opened_at || a.last_seen_at)));
  return {
    stats: { merchants: merchants.length, members_live: live.size, members_sandbox: sandbox.size, members_total: joined.size, seen: views.length, opened: views.filter((v) => v.opened_at).length, joined_after_opening: views.filter((v) => v.opened_at && joined.has(v.merchant_id)).length },
    visitors,
  };
}

/** What the dashboard shows. */
async function status(merchantId, mode) {
  const s = await settings();
  const [live, sandbox] = await Promise.all([membership(merchantId, 'live'), membership(merchantId, 'sandbox')]);
  return {
    member: { live: !!live, sandbox: !!sandbox }, joined_at: { live: live ? live.joined_at : null, sandbox: sandbox ? sandbox.joined_at : null },
    open: { live: await openFor('live'), sandbox: await openFor('sandbox') },
    plan: await currentPlanKey(merchantId, mode),
    join_fee_usd: s.join_fee_usd, min_topup_usd: s.min_topup_usd, plans: s.plans, mode: mode === 'live' ? 'live' : 'sandbox',
  };
}

/** The settings last read (or the defaults), without waiting: for text that is built synchronously (the AI agent's knowledge). */
const cachedSettings = () => cache || Object.assign({}, DEFAULTS);

module.exports = { recordView, adminOverview, providerCostFor, depositCostFor, DEFAULT_PROVIDER_COSTS, cachedSettings, PLAN_KEYS, planFor, creationFeeFor, countFreeCard, withdrawalFeeFor, purchaseFeeFor, depositPctFor, currentPlanKey, settings, saveSettings, membership, isMember, join, assertTopupAllowed, pricingOverrideFor, status, openFor, PRICE_FIELDS };
