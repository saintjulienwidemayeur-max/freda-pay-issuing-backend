'use strict';
const supabase = require('../lib/supabase');
const ledger = require('../services/ledger');
const pricing = require('../services/pricing');
const brevo = require('../services/brevo');
const { walletCreditedEmail } = require('../templates/walletCreditedEmail');
const { randomHex } = require('../utils/ids');

/** Both balances of one merchant for one mode (live = real money, sandbox = play money), fetched in parallel. */
async function balancesFor(merchantId, mode) {
  const [gateway, masterWallet] = await Promise.all([
    ledger.getBalance(merchantId, 'gateway', 'HTG', mode),
    ledger.getBalance(merchantId, 'master_wallet', 'USD', mode),
  ]);
  return { gateway, master_wallet: masterWallet };
}

async function list(ctx) {
  const rows = await supabase.select('merchants', {}, { order: 'created_at.desc', limit: 200 });
  const balances = await Promise.all(rows.map((m) => balancesFor(m.id, 'live')));
  const sandboxBalances = await Promise.all(rows.map((m) => balancesFor(m.id, 'sandbox')));
  return {
    status: 200,
    body: {
      merchants: rows.map((m, i) => ({
        id: m.id, business_name: m.business_name, email: m.email, account_type: m.account_type,
        kyc_status: m.kyc_status, kyb_status: m.kyb_status, live_enabled: m.live_enabled,
        gateway_live_enabled: !!m.gateway_live_enabled, issuing_live_enabled: !!m.issuing_live_enabled,
        gateway_plan: m.gateway_plan, issuing_plan: m.issuing_plan, created_at: m.created_at,
        deleted_at: m.deleted_at || null, balances: balances[i], sandbox_balances: sandboxBalances[i],
      })),
    },
  };
}

async function get(ctx) {
  const merchant = await supabase.selectOne('merchants', { id: ctx.params.id });
  if (!merchant) throw httpError(404, 'NOT_FOUND', 'Marchand introuvable.');
  // Revenue/profit are only meaningful for REAL money, so the default view is
  // live; pass ?mode=sandbox to look at the play-money figures instead.
  const revenueMode = ctx.query && ctx.query.mode === 'sandbox' ? 'sandbox' : 'live';
  const [balances, sandboxBalances, pricingOverride, feeRows] = await Promise.all([
    balancesFor(merchant.id, 'live'),
    balancesFor(merchant.id, 'sandbox'),
    supabase.selectOne('merchant_pricing', { merchant_id: merchant.id }),
    supabase.select('fee_revenue', { merchant_id: merchant.id, mode: revenueMode }, { order: 'created_at.desc', limit: 2000 }),
  ]);

  return {
    status: 200,
    body: {
      merchant: {
        id: merchant.id, business_name: merchant.business_name, email: merchant.email, account_type: merchant.account_type,
        kyc_status: merchant.kyc_status, kyb_status: merchant.kyb_status, live_enabled: merchant.live_enabled,
        gateway_live_enabled: !!merchant.gateway_live_enabled, issuing_live_enabled: !!merchant.issuing_live_enabled,
        gateway_plan: merchant.gateway_plan, issuing_plan: merchant.issuing_plan, created_at: merchant.created_at,
        deleted_at: merchant.deleted_at || null,
      },
      balances,
      sandbox_balances: sandboxBalances,
      revenue_mode: revenueMode,
      pricing: pricingOverride ? toPublicPricing(pricingOverride) : null,
      revenue: summarizeRevenue(feeRows),
    },
  };
}

/** Revenue/profit summary: total, by kind, and the last 14 days + 8 weeks as simple day/week buckets. */
function summarizeRevenue(rows) {
  const config = require('../config');
  const byKind = {};
  let totalUsdEquivalent = 0;
  let totalProfitUsd = 0;
  const dayBuckets = {}; // 'YYYY-MM-DD' -> amount USD-equivalent
  const weekBuckets = {}; // 'YYYY-Www' -> amount USD-equivalent

  for (const r of rows) {
    const amountUsd = r.currency === 'USD' ? Number(r.amount) : Number(r.amount) / config.exchangeRateHtgPerUsd;
    byKind[r.kind] = (byKind[r.kind] || 0) + amountUsd;
    totalUsdEquivalent += amountUsd;

    const issuingCostKey = { card_creation: 'cardCreation', card_recharge: 'cardRecharge', card_withdrawal: 'cardWithdrawal' }[r.kind];
    if (issuingCostKey) {
      const profit = pricing.issuingProfitUSD(issuingCostKey, amountUsd);
      if (profit != null) totalProfitUsd += profit;
    } else if (r.kind !== 'wallet_funding') {
      totalProfitUsd += amountUsd; // no confirmed provider cost for Gateway/payout yet - treat as pure margin
    }

    const d = new Date(r.created_at);
    const dayKey = d.toISOString().slice(0, 10);
    dayBuckets[dayKey] = (dayBuckets[dayKey] || 0) + amountUsd;
    const weekKey = isoWeekKey(d);
    weekBuckets[weekKey] = (weekBuckets[weekKey] || 0) + amountUsd;
  }

  const round2 = (n) => Math.round(n * 100) / 100;
  return {
    total_revenue_usd: round2(totalUsdEquivalent),
    total_profit_usd: round2(totalProfitUsd),
    by_kind_usd: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, round2(v)])),
    by_day: Object.entries(dayBuckets).sort().slice(-14).map(([date, usd]) => ({ date, usd: round2(usd) })),
    by_week: Object.entries(weekBuckets).sort().slice(-8).map(([week, usd]) => ({ week, usd: round2(usd) })),
  };
}

function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/** Coarse counts for the admin dashboard home screen. Simple select-and-count, fine at this scale. */
async function overview(ctx) {
  const [merchants, pendingVerifications, cards, payments] = await Promise.all([
    supabase.select('merchants', {}, { limit: 1000 }),
    supabase.select('verification_submissions', { status: 'submitted' }, { limit: 1000 }),
    supabase.select('cards', { mode: 'live' }, { limit: 1000 }),
    supabase.select('payments', { status: 'succeeded', mode: 'live' }, { limit: 1000 }),
  ]);
  const liveCount = merchants.filter((m) => m.live_enabled).length;
  const volumeHtg = payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);

  return {
    status: 200,
    body: {
      merchants_total: merchants.length,
      merchants_live: liveCount,
      merchants_sandbox: merchants.length - liveCount,
      pending_verifications: pendingVerifications.length,
      cards_issued: cards.length,
      payments_volume_htg: volumeHtg,
    },
  };
}

/** Admin manually credits a merchant's Master Wallet or Gateway balance (e.g. confirming a bank/Zelle transfer). Always emails the merchant. */
async function credit(ctx) {
  const merchant = await supabase.selectOne('merchants', { id: ctx.params.id });
  if (!merchant) throw httpError(404, 'NOT_FOUND', 'Marchand introuvable.');

  const { wallet, amount, note } = ctx.body || {};
  if (wallet !== 'master_wallet' && wallet !== 'gateway') throw httpError(400, 'INVALID_WALLET', "wallet doit être 'master_wallet' ou 'gateway'.");
  const amountNum = Number(amount);
  if (!(amountNum > 0)) throw httpError(400, 'INVALID_AMOUNT', 'amount doit être un nombre positif.');

  // Which wallet gets the money: real (live) or play (sandbox). Explicit wins;
  // otherwise a live-enabled merchant is credited live, anyone else sandbox.
  const requested = ctx.body && ctx.body.mode;
  if (requested != null && requested !== 'live' && requested !== 'sandbox') throw httpError(400, 'INVALID_MODE', "mode doit être 'live' ou 'sandbox'.");
  const mode = requested || (merchant.gateway_live_enabled ? 'live' : 'sandbox');

  const currency = wallet === 'master_wallet' ? 'USD' : 'HTG';
  if (wallet === 'master_wallet') {
    await ledger.creditMasterWallet(merchant.id, amountNum, 'USD', `admin-credit:${ctx.adminId}`, null, mode);
  } else {
    await ledger.creditGateway(merchant.id, amountNum, 'HTG', `admin-credit:${ctx.adminId}`, null, mode);
  }

  await supabase.insert('admin_wallet_credits', {
    id: `awc_${randomHex(8)}`,
    merchant_id: merchant.id,
    admin_id: ctx.adminId,
    wallet,
    amount: amountNum,
    currency,
    note: note ? `${note}` : null,
    mode,
  });

  const newBalance = await ledger.getBalance(merchant.id, wallet, currency, mode);
  const walletLabel = wallet === 'master_wallet' ? 'Master Wallet' : 'solde Gateway';
  if (merchant.email) {
    const { subject, html, text } = walletCreditedEmail({ businessName: merchant.business_name, amount: amountNum, currency, walletLabel, newBalance, note });
    brevo.sendEmail({ to: merchant.email, toName: merchant.business_name, subject, html, text }).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Failed to send admin-credit email:', err.message);
    });
  }

  return { status: 200, body: { credited: true, mode, new_balance: newBalance } };
}

const PRICING_FIELDS = ['card_creation_usd', 'card_recharge_usd', 'card_withdrawal_usd', 'card_decline_usd', 'wallet_funding_pct', 'gateway_pct', 'gateway_fixed_htg', 'payout_fee_htg'];

function toPublicPricing(row) {
  const out = {};
  for (const f of PRICING_FIELDS) out[f] = row[f] == null ? null : Number(row[f]);
  return out;
}

/** Admin sets (or clears) this merchant's custom fees. Any field left out/null falls back to their plan's pricing. */
async function setPricing(ctx) {
  const merchant = await supabase.selectOne('merchants', { id: ctx.params.id });
  if (!merchant) throw httpError(404, 'NOT_FOUND', 'Marchand introuvable.');

  const b = ctx.body || {};
  const patch = { merchant_id: merchant.id, updated_at: new Date().toISOString() };
  for (const f of PRICING_FIELDS) {
    if (f in b) {
      const v = b[f];
      if (v !== null && (typeof v !== 'number' || v < 0)) throw httpError(400, 'INVALID_FIELD', `${f} doit être un nombre positif ou null.`);
      patch[f] = v;
    }
  }

  const existing = await supabase.selectOne('merchant_pricing', { merchant_id: merchant.id });
  const row = existing
    ? (await supabase.update('merchant_pricing', { merchant_id: merchant.id }, patch))[0]
    : await supabase.insert('merchant_pricing', Object.assign({}, Object.fromEntries(PRICING_FIELDS.map((f) => [f, null])), patch));

  return { status: 200, body: { pricing: toPublicPricing(row) } };
}

/** Removes all custom pricing for this merchant - they revert fully to their plan's standard rates. */
async function clearPricing(ctx) {
  const existing = await supabase.selectOne('merchant_pricing', { merchant_id: ctx.params.id });
  if (existing) await supabase.delete('merchant_pricing', { merchant_id: ctx.params.id });
  return { status: 200, body: { cleared: true } };
}

/** Admin override: turns Live mode on or off directly, bypassing the usual KYC/KYB gate. Use with judgment. */
async function setLive(ctx) {
  const merchant = await supabase.selectOne('merchants', { id: ctx.params.id });
  if (!merchant) throw httpError(404, 'NOT_FOUND', 'Marchand introuvable.');
  const b = ctx.body || {};
  const patch = {};
  if ('live_enabled' in b) {
    // "Live" for the Gateway. Keeps the legacy flag in step so nothing reading the old field disagrees.
    patch.live_enabled = !!b.live_enabled;
    patch.gateway_live_enabled = !!b.live_enabled;
    if (!b.live_enabled) {
      // Switching a merchant off live also pulls them back to sandbox and removes Issuing live.
      patch.active_mode = 'sandbox';
      patch.issuing_live_enabled = false;
    }
  }
  if ('issuing_live_enabled' in b && (b.live_enabled !== false)) {
    patch.issuing_live_enabled = !!b.issuing_live_enabled;
  }
  if (!Object.keys(patch).length) throw httpError(400, 'MISSING_FIELDS', 'live_enabled ou issuing_live_enabled requis.');
  const [updated] = await supabase.update('merchants', { id: merchant.id }, patch);
  // Live keys cache the merchant for a few seconds: drop it so a revocation is immediate.
  require('../middleware/apiKey').clearAuthCache();
  return {
    status: 200,
    body: {
      live_enabled: !!updated.live_enabled,
      gateway_live_enabled: !!updated.gateway_live_enabled,
      issuing_live_enabled: !!updated.issuing_live_enabled,
      active_mode: updated.active_mode || 'sandbox',
    },
  };
}

/** Grants (or revokes) a complimentary free plan for both Gateway and Issuing. */
async function setFreePlan(ctx) {
  const merchant = await supabase.selectOne('merchants', { id: ctx.params.id });
  if (!merchant) throw httpError(404, 'NOT_FOUND', 'Marchand introuvable.');
  const grant = !!(ctx.body && ctx.body.grant);
  const patch = grant
    ? { gateway_plan: 'free', issuing_plan: 'free' }
    : { gateway_plan: 'standard', issuing_plan: 'startup' };
  const [updated] = await supabase.update('merchants', { id: merchant.id }, patch);
  return { status: 200, body: { gateway_plan: updated.gateway_plan, issuing_plan: updated.issuing_plan } };
}

/**
 * Deactivates a merchant account: login is blocked and the account is
 * flagged deleted, but the row (and its payment/card history) is kept for
 * accounting and regulatory record-keeping rather than hard-deleted.
 */
async function remove(ctx) {
  const merchant = await supabase.selectOne('merchants', { id: ctx.params.id });
  if (!merchant) throw httpError(404, 'NOT_FOUND', 'Marchand introuvable.');
  await supabase.update('merchants', { id: merchant.id }, { deleted_at: new Date().toISOString(), live_enabled: false });
  require('../middleware/session').forgetMerchant(merchant.id); // any open session dies immediately, not after the cache TTL
  return { status: 200, body: { deleted: true } };
}

async function restore(ctx) {
  const merchant = await supabase.selectOne('merchants', { id: ctx.params.id });
  if (!merchant) throw httpError(404, 'NOT_FOUND', 'Marchand introuvable.');
  await supabase.update('merchants', { id: merchant.id }, { deleted_at: null });
  return { status: 200, body: { restored: true } };
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { list, get, overview, credit, setPricing, clearPricing, setLive, setFreePlan, remove, restore };
