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
 * The program's plans (official price list of 17/11/2026). What Freda Pay collects: subscription, card creation (Premium: 50 free cards a
 * month, then the price), recharge, Master Wallet deposit %, card withdrawal %, and the Startup 1 % purchase commission (collected on the
 * Master Wallet). International transactions (2.30 % + 0.50 $), monthly maintenance and refused authorizations are the issuer's own charges,
 * taken by the issuer on the card: they are shown, not collected again.
 */
const PLAN_KEYS = ['startup', 'pro', 'premium'];
const PLAN_FIELDS = ['monthly_usd', 'card_creation_usd', 'free_cards_per_month', 'card_recharge_usd', 'deposit_pct', 'withdrawal_pct', 'purchase_pct', 'maintenance_usd', 'decline_usd', 'international_pct', 'international_fixed_usd'];
const DEFAULT_PLANS = {
  startup: { label: 'Startup', monthly_usd: 0, card_creation_usd: 3, free_cards_per_month: 0, card_recharge_usd: 1, deposit_pct: 4, withdrawal_pct: 3, purchase_pct: 1, maintenance_usd: 0.5, decline_usd: 0.5, international_pct: 2.3, international_fixed_usd: 0.5 },
  pro: { label: 'Pro', monthly_usd: 150, card_creation_usd: 2, free_cards_per_month: 0, card_recharge_usd: 0.5, deposit_pct: 2.7, withdrawal_pct: 2, purchase_pct: 0, maintenance_usd: 0.5, decline_usd: 0.5, international_pct: 2.3, international_fixed_usd: 0.5 },
  premium: { label: 'Premium', monthly_usd: 500, card_creation_usd: 2.5, free_cards_per_month: 50, card_recharge_usd: 1.1, deposit_pct: 2.5, withdrawal_pct: 1.5, purchase_pct: 0, maintenance_usd: 0, decline_usd: 0.5, international_pct: 2.3, international_fixed_usd: 0.5 },
};
const PRICE_FIELDS = PLAN_FIELDS;
const DEFAULTS = { join_fee_usd: 20, min_topup_usd: 200, plans: DEFAULT_PLANS };
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
  cache = Object.assign({}, DEFAULTS, saved, { plans });
  delete cache.prices;
  at = Date.now();
  return cache;
}
async function saveSettings(patch, adminEmail) {
  const next = JSON.parse(JSON.stringify(await settings()));
  const num = (v, max) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= max ? round2(n) : undefined; };
  if (patch.join_fee_usd !== undefined && num(patch.join_fee_usd, 10000) !== undefined) next.join_fee_usd = num(patch.join_fee_usd, 10000);
  if (patch.min_topup_usd !== undefined && num(patch.min_topup_usd, 100000) !== undefined) next.min_topup_usd = num(patch.min_topup_usd, 100000);
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
async function join(merchantId, mode, planKey) {
  const env = mode === 'live' ? 'live' : 'sandbox';
  const plan = PLAN_KEYS.includes(planKey) ? planKey : 'startup';
  const existing = await membership(merchantId, env);
  if (existing) return { member: existing, already: true };
  if (!(await openFor(env))) throw httpError(409, 'PROGRAM_NOT_OPEN', env === 'live' ? "Le nouveau programme de cartes n'est pas encore ouvert en Live. Vous serez prévenu dès son ouverture ; vous pouvez déjà l'essayer en Sandbox." : "Le nouveau programme de cartes n'est pas encore disponible. Réessayez plus tard.");
  const s = await settings();
  const fee = env === 'live' ? round2(s.join_fee_usd) : 0;
  const monthly = env === 'live' ? round2(s.plans[plan].monthly_usd || 0) : 0; // the first month of the plan, paid with the entry
  const ref = `card-program-join:${merchantId}:${env}`;
  const monthRef = `card-program-plan:${merchantId}:${env}:${plan}:${new Date().toISOString().slice(0, 10)}`;
  if (fee + monthly > 0) {
    const available = await ledger.getBalance(merchantId, 'master_wallet', 'USD', env);
    if (available < fee + monthly) throw httpError(400, 'INSUFFICIENT_BALANCE', `Il faut ${(fee + monthly).toFixed(2)} $ sur votre Master Wallet pour rejoindre le programme${monthly ? ` (entrée ${fee.toFixed(2)} $ + premier mois du plan ${s.plans[plan].label} ${monthly.toFixed(2)} $)` : ''} : disponible ${round2(available).toFixed(2)} $.`);
    if (fee > 0 && !(await supabase.selectOne('ledger_entries', { merchant_id: merchantId, reference: ref }))) {
      await ledger.debitMasterWallet(merchantId, fee, 'USD', ref, null, env);
      await revenue.log(merchantId, 'card_program_join', fee, 'USD', null, env, 0).catch(() => {});
    }
    if (monthly > 0 && !(await supabase.selectOne('ledger_entries', { merchant_id: merchantId, reference: monthRef }))) {
      await ledger.debitMasterWallet(merchantId, monthly, 'USD', monthRef, null, env);
      await revenue.log(merchantId, 'plan_subscription', monthly, 'USD', null, env, 0).catch(() => {});
    }
  }
  let member;
  try {
    member = await supabase.insert('card_program_members', { merchant_id: merchantId, mode: env, joined_at: new Date().toISOString(), fee_usd: fee, ledger_reference: fee > 0 ? ref : null, plan, paid_until: addMonth(new Date()).toISOString() });
  } catch (err) {
    if (missingTable(err) || /plan|paid_until|column/i.test(String(err.message || ''))) {
      if (fee > 0) await ledger.creditMasterWallet(merchantId, fee, 'USD', `refund:${ref}`, null, env).catch(() => {});
      if (monthly > 0) await ledger.creditMasterWallet(merchantId, monthly, 'USD', `refund:${monthRef}`, null, env).catch(() => {});
      throw httpError(503, 'FEATURE_NOT_READY', "Le programme n'est pas encore activé sur le serveur. Rien n'a été débité.");
    }
    member = await membership(merchantId, env);
    if (!member) throw err;
  }
  webhookDispatcher.dispatch(merchantId, 'card_program.joined', { mode: env, fee_usd: fee, plan });
  return { member, already: false };
}

/** Members top up their Master Wallet by at least min_topup_usd each time (400 BELOW_PROGRAM_MINIMUM). */
async function assertTopupAllowed(merchantId, mode, amountUsd) {
  if (!(await isMember(merchantId, mode))) return;
  const s = await settings();
  if (Number(amountUsd) < Number(s.min_topup_usd)) throw httpError(400, 'BELOW_PROGRAM_MINIMUM', `Membre du nouveau programme de cartes : chaque recharge du Master Wallet doit être d'au moins ${Number(s.min_topup_usd).toFixed(0)} $.`);
}

const addMonth = (d) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + 1); return x; };
const monthKey = (d) => new Date(d || Date.now()).toISOString().slice(0, 7);

/** The plan (with its prices) of a member, or null for a merchant outside the program. */
async function planFor(merchantId, mode) {
  const m = await membership(merchantId, mode);
  if (!m) return null;
  const s = await settings();
  const key = PLAN_KEYS.includes(m.plan) ? m.plan : 'startup';
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
    const used = m.free_cards_month === monthKey() ? Number(m.free_cards_used || 0) : 0;
    if (used < Number(p.free_cards_per_month)) return { fee: 0, free: true, used };
  }
  return { fee: round2(p.card_creation_usd), free: false };
}
async function countFreeCard(merchantId, mode) {
  const m = await membership(merchantId, mode);
  if (!m) return;
  const used = m.free_cards_month === monthKey() ? Number(m.free_cards_used || 0) : 0;
  await supabase.update('card_program_members', { merchant_id: merchantId, mode: mode === 'live' ? 'live' : 'sandbox' }, { free_cards_month: monthKey(), free_cards_used: used + 1 }).catch(() => {});
}

/** Card withdrawal fee of a program card: a percentage of the amount (custom fixed price of the merchant wins). */
async function withdrawalFeeFor(merchantId, mode, amountUsd) {
  const override = await supabase.selectOne('merchant_pricing', { merchant_id: merchantId }).catch(() => null);
  if (override && override.card_withdrawal_usd != null) return Number(override.card_withdrawal_usd);
  const p = (await planFor(merchantId, mode)) || (await settings()).plans.startup;
  return round2(Number(amountUsd) * Number(p.withdrawal_pct || 0) / 100);
}

/** Commission on a successful purchase of a program card (Startup 1 %), collected on the Master Wallet. */
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

/** Changes a member's plan: the new plan's month is paid now (Live), and a new period starts. */
async function changePlan(merchantId, mode, planKey) {
  const env = mode === 'live' ? 'live' : 'sandbox';
  if (!PLAN_KEYS.includes(planKey)) throw httpError(400, 'INVALID_PLAN', 'Plan inconnu : startup, pro ou premium.');
  const m = await membership(merchantId, env);
  if (!m) throw httpError(409, 'NOT_A_MEMBER', "Rejoignez d'abord le programme.");
  if (m.plan === planKey) return m;
  const s = await settings();
  const monthly = env === 'live' ? round2(s.plans[planKey].monthly_usd || 0) : 0;
  const ref = `card-program-plan:${merchantId}:${env}:${planKey}:${new Date().toISOString().slice(0, 10)}`;
  if (monthly > 0 && !(await supabase.selectOne('ledger_entries', { merchant_id: merchantId, reference: ref }))) {
    const available = await ledger.getBalance(merchantId, 'master_wallet', 'USD', env);
    if (available < monthly) throw httpError(400, 'INSUFFICIENT_BALANCE', `Il faut ${monthly.toFixed(2)} $ sur votre Master Wallet pour passer au plan ${s.plans[planKey].label} (disponible : ${round2(available).toFixed(2)} $).`);
    await ledger.debitMasterWallet(merchantId, monthly, 'USD', ref, null, env);
    await revenue.log(merchantId, 'plan_subscription', monthly, 'USD', null, env, 0).catch(() => {});
  }
  const [row] = await supabase.update('card_program_members', { merchant_id: merchantId, mode: env }, { plan: planKey, paid_until: addMonth(new Date()).toISOString(), renewal_failed_at: null });
  webhookDispatcher.dispatch(merchantId, 'card_program.plan_changed', { mode: env, plan: planKey, monthly_usd: monthly });
  return row;
}

/**
 * Monthly renewal of paid plans (Live): the month is taken from the Master Wallet when due. If it cannot be paid, it is tried again
 * every run for the grace period, then the member goes back to Startup (free) and is told.
 */
async function renewDue() {
  const out = { renewed: 0, downgraded: 0 };
  let due;
  try { due = await supabase.select('card_program_members', { mode: 'live', paid_until: supabase.lte(new Date().toISOString()) }, { limit: 200 }); } catch (err) { if (missingTable(err)) return out; return out; }
  const s = await settings();
  const graceMs = (require('../config').billing.graceDays || 3) * 86400000;
  for (const m of due) {
    const plan = s.plans[m.plan] || s.plans.startup;
    const monthly = round2(plan.monthly_usd || 0);
    if (!(monthly > 0)) { await supabase.update('card_program_members', { merchant_id: m.merchant_id, mode: 'live' }, { paid_until: addMonth(m.paid_until).toISOString() }); continue; }
    const ref = `card-program-renewal:${m.merchant_id}:${m.plan}:${String(m.paid_until).slice(0, 10)}`;
    if (await supabase.selectOne('ledger_entries', { merchant_id: m.merchant_id, reference: ref })) { await supabase.update('card_program_members', { merchant_id: m.merchant_id, mode: 'live' }, { paid_until: addMonth(m.paid_until).toISOString(), renewal_failed_at: null }); continue; }
    const available = await ledger.getBalance(m.merchant_id, 'master_wallet', 'USD', 'live');
    if (available >= monthly) {
      await ledger.debitMasterWallet(m.merchant_id, monthly, 'USD', ref, null, 'live');
      await revenue.log(m.merchant_id, 'plan_subscription', monthly, 'USD', null, 'live', 0).catch(() => {});
      await supabase.update('card_program_members', { merchant_id: m.merchant_id, mode: 'live' }, { paid_until: addMonth(m.paid_until).toISOString(), renewal_failed_at: null });
      out.renewed += 1;
    } else if (m.renewal_failed_at && Date.now() - new Date(m.renewal_failed_at).getTime() > graceMs) {
      await supabase.update('card_program_members', { merchant_id: m.merchant_id, mode: 'live' }, { plan: 'startup', paid_until: addMonth(new Date()).toISOString(), renewal_failed_at: null });
      webhookDispatcher.dispatch(m.merchant_id, 'card_program.plan_changed', { mode: 'live', plan: 'startup', reason: 'renewal_failed' });
      out.downgraded += 1;
    } else if (!m.renewal_failed_at) {
      await supabase.update('card_program_members', { merchant_id: m.merchant_id, mode: 'live' }, { renewal_failed_at: new Date().toISOString() });
    }
  }
  return out;
}

/** What the dashboard shows. */
async function status(merchantId, mode) {
  const s = await settings();
  const [live, sandbox] = await Promise.all([membership(merchantId, 'live'), membership(merchantId, 'sandbox')]);
  return {
    member: { live: !!live, sandbox: !!sandbox }, joined_at: { live: live ? live.joined_at : null, sandbox: sandbox ? sandbox.joined_at : null },
    open: { live: await openFor('live'), sandbox: await openFor('sandbox') },
    plan: { live: live ? live.plan || 'startup' : null, sandbox: sandbox ? sandbox.plan || 'startup' : null }, paid_until: { live: live ? live.paid_until || null : null },
    join_fee_usd: s.join_fee_usd, min_topup_usd: s.min_topup_usd, plans: s.plans, mode: mode === 'live' ? 'live' : 'sandbox',
  };
}

/** The settings last read (or the defaults), without waiting: for text that is built synchronously (the AI agent's knowledge). */
const cachedSettings = () => cache || Object.assign({}, DEFAULTS);

module.exports = { cachedSettings, PLAN_KEYS, planFor, creationFeeFor, countFreeCard, withdrawalFeeFor, purchaseFeeFor, depositPctFor, changePlan, renewDue, settings, saveSettings, membership, isMember, join, assertTopupAllowed, pricingOverrideFor, status, openFor, PRICE_FIELDS };
