'use strict';
const supabase = require('../lib/supabase');
const ledger = require('../services/ledger');
const pricing = require('../services/pricing');
const notify = require('../services/notify');
const { randomHex } = require('../utils/ids');
const { planKeyFor } = require('../services/plans');
const adminStats = require('../services/adminStats');

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
        kyc_status: m.kyc_status, kyb_status: m.kyb_status, live_enabled: !!m.gateway_live_enabled,
        gateway_live_enabled: !!m.gateway_live_enabled, issuing_live_enabled: !!m.issuing_live_enabled,
        gateway_plan: planKeyFor(m, 'gateway', 'live'), issuing_plan: planKeyFor(m, 'issuing', 'live'), created_at: m.created_at,
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
  const [balances, sandboxBalances, pricingOverride, stats] = await Promise.all([
    balancesFor(merchant.id, 'live'),
    balancesFor(merchant.id, 'sandbox'),
    supabase.selectOne('merchant_pricing', { merchant_id: merchant.id }),
    adminStats.merchantStats(merchant.id, revenueMode),
  ]);

  return {
    status: 200,
    body: {
      merchant: {
        id: merchant.id, business_name: merchant.business_name, email: merchant.email, account_type: merchant.account_type,
        kyc_status: merchant.kyc_status, kyb_status: merchant.kyb_status, live_enabled: !!merchant.gateway_live_enabled,
        gateway_live_enabled: !!merchant.gateway_live_enabled, issuing_live_enabled: !!merchant.issuing_live_enabled,
        gateway_plan: planKeyFor(merchant, 'gateway', 'live'), issuing_plan: planKeyFor(merchant, 'issuing', 'live'), sandbox_gateway_plan: planKeyFor(merchant, 'gateway', 'sandbox'), sandbox_issuing_plan: planKeyFor(merchant, 'issuing', 'sandbox'), created_at: merchant.created_at,
        deleted_at: merchant.deleted_at || null,
        phone: merchant.phone || null, entity_type: merchant.entity_type || null, email_verified: !!merchant.email_verified,
        onboarding: merchant.onboarding || null, // answers given in the signup wizard
      },
      balances,
      sandbox_balances: sandboxBalances,
      revenue_mode: revenueMode,
      pricing: pricingOverride ? toPublicPricing(pricingOverride) : null,
      revenue: stats.revenue,
      stats, // cards issued, money spent, card spending, gateway money: all real, for the selected environment
    },
  };
}

/** Coarse counts for the admin dashboard home screen. Simple select-and-count, fine at this scale. */
async function overview(ctx) {
  const [merchants, pendingVerifications, cards, payments, pendingDeposits, pendingIssuing, pendingBankPayouts, unreadInbox] = await Promise.all([
    supabase.select('merchants', {}, { limit: 1000 }),
    supabase.select('verification_submissions', { status: 'submitted' }, { limit: 1000 }),
    supabase.select('cards', { mode: 'live' }, { limit: 1000 }),
    supabase.select('payments', { status: 'succeeded', mode: 'live' }, { limit: 1000 }),
    supabase.select('wallet_topups', { status: 'awaiting_review' }, { limit: 1000 }),
    supabase.select('issuing_access_requests', { status: 'pending' }, { limit: 1000 }),
    supabase.select('payouts', { method: 'bank', status: 'pending', mode: 'live' }, { limit: 1000 }),
    supabase.select('admin_inbox', { is_read: 'eq.false' }, { limit: 1000 }),
  ]);
  const active = merchants.filter((m) => !m.deleted_at); // suspended accounts are neither live nor sandbox right now
  const platform = await adminStats.platformStats('live', 14);
  const liveCount = active.filter((m) => m.gateway_live_enabled).length;
  const volumeHtg = payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);

  return {
    status: 200,
    body: {
      merchants_total: active.length,
      merchants_live: liveCount,
      merchants_sandbox: active.length - liveCount,
      merchants_suspended: merchants.length - active.length,
      pending_verifications: pendingVerifications.length,
      pending_deposits: pendingDeposits.length,
      pending_bank_payouts: pendingBankPayouts.length,
      unread_inbox: unreadInbox.length,
      pending_issuing_requests: pendingIssuing.length,
      cards_issued: cards.length,
      payments_volume_htg: volumeHtg,
      platform,
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
  await notify.walletCredited(merchant, {
    amount: amountNum, currency, walletLabel: wallet === 'master_wallet' ? 'Master Wallet' : 'solde Gateway', newBalance, note, mode,
  });

  return { status: 200, body: { credited: true, mode, new_balance: newBalance } };
}

const PRICING_FIELDS = ['card_creation_usd', 'card_recharge_usd', 'card_withdrawal_usd', 'card_decline_usd', 'wallet_funding_pct', 'gateway_pct', 'gateway_fixed_htg', 'payout_mobile_pct', 'payout_bank_fee_htg', 'payout_fee_htg'];

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
  if (patch.gateway_live_enabled === true && !merchant.gateway_live_enabled) await notify.liveGranted(updated);
  if (patch.issuing_live_enabled === true && !merchant.issuing_live_enabled) await notify.issuingDecision(updated, true);
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
  // A complimentary plan applies to both environments, so Sandbox tests show the same (zero) fees the merchant gets in Live.
  const patch = grant
    ? { gateway_plan: 'free', issuing_plan: 'free', live_gateway_plan: 'free', live_issuing_plan: 'free' }
    : { gateway_plan: 'standard', issuing_plan: 'startup', live_gateway_plan: 'standard', live_issuing_plan: 'startup' };
  const [updated] = await supabase.update('merchants', { id: merchant.id }, patch);
  return { status: 200, body: { gateway_plan: planKeyFor(updated, 'gateway', 'live'), issuing_plan: planKeyFor(updated, 'issuing', 'live') } };
}

/**
 * Deactivates a merchant account: login is blocked and the account is
 * flagged deleted, but the row (and its payment/card history) is kept for
 * accounting and regulatory record-keeping rather than hard-deleted.
 */
async function remove(ctx) {
  const merchant = await supabase.selectOne('merchants', { id: ctx.params.id });
  if (!merchant) throw httpError(404, 'NOT_FOUND', 'Marchand introuvable.');
  // Suspension BLOCKS the account; it must not change what the merchant was granted. Live access (and its
  // legacy mirror flag) stay exactly as they were, so reactivating puts the merchant back where they were.
  await supabase.update('merchants', { id: merchant.id }, { deleted_at: new Date().toISOString() });
  require('../middleware/session').forgetMerchant(merchant.id); // any open session dies immediately, not after the cache TTL
  require('../middleware/apiKey').clearAuthCache(); // ...and so do the API keys
  await notify.accountSuspended(merchant);
  return { status: 200, body: { deleted: true } };
}

async function restore(ctx) {
  const merchant = await supabase.selectOne('merchants', { id: ctx.params.id });
  if (!merchant) throw httpError(404, 'NOT_FOUND', 'Marchand introuvable.');
  // Re-sync the legacy mirror flag from the real one: accounts suspended before this fix had it switched off.
  const patch = { deleted_at: null, live_enabled: !!merchant.gateway_live_enabled };
  // No plan is billed while an account is suspended: a renewal that fell due during the suspension starts a fresh month now.
  for (const p of ['gateway', 'issuing']) {
    const due = merchant[`live_${p}_renews_at`];
    if (due && new Date(due) < new Date()) patch[`live_${p}_renews_at`] = require('../services/planRenewals').addMonths(new Date(), 1).toISOString();
    if (merchant[`live_${p}_unpaid_since`]) patch[`live_${p}_unpaid_since`] = null;
  }
  await supabase.update('merchants', { id: merchant.id }, patch);
  require('../middleware/session').forgetMerchant(merchant.id);
  require('../middleware/apiKey').clearAuthCache();
  await notify.accountRestored(merchant);
  return { status: 200, body: { restored: true } };
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { list, get, overview, credit, setPricing, clearPricing, setLive, setFreePlan, remove, restore };
