'use strict';
const supabase = require('../lib/supabase');
const ledger = require('../services/ledger');
const pricing = require('../services/pricing');
const notify = require('../services/notify');
const { randomHex } = require('../utils/ids');
const { planKeyFor } = require('../services/plans');
const adminStats = require('../services/adminStats');
const guarantee = require('../services/guarantee');
const config = require('../config');

/** Both balances of one merchant for one mode (live = real money, sandbox = play money), fetched in parallel. */
async function balancesFor(merchantId, mode) {
  const [gateway, gatewayUsd, masterWallet] = await Promise.all([
    ledger.getBalance(merchantId, 'gateway', 'HTG', mode),
    ledger.getBalance(merchantId, 'gateway', 'USD', mode), // card payments credit the Gateway in dollars
    ledger.getBalance(merchantId, 'master_wallet', 'USD', mode),
  ]);
  return { gateway, gateway_usd: gatewayUsd, master_wallet: masterWallet };
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
    supabase.select('admin_inbox', { is_read: false }, { limit: 1000 }),
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
  if (!['master_wallet', 'gateway', 'gateway_usd'].includes(wallet)) throw httpError(400, 'INVALID_WALLET', "wallet doit être 'master_wallet', 'gateway' (HTG) ou 'gateway_usd'.");
  const amountNum = Number(amount);
  if (!(amountNum > 0) || !Number.isFinite(amountNum)) throw httpError(400, 'INVALID_AMOUNT', 'amount doit être un nombre positif.');
  if (amountNum > 100000) throw httpError(400, 'AMOUNT_TOO_HIGH', 'Un crédit manuel est limité à 100 000 par opération.');

  // Which wallet gets the money: real (live) or play (sandbox). Explicit wins;
  // otherwise a live-enabled merchant is credited live, anyone else sandbox.
  const requested = ctx.body && ctx.body.mode;
  if (requested != null && requested !== 'live' && requested !== 'sandbox') throw httpError(400, 'INVALID_MODE', "mode doit être 'live' ou 'sandbox'.");
  const mode = requested || (merchant.gateway_live_enabled ? 'live' : 'sandbox');

  const currency = wallet === 'master_wallet' || wallet === 'gateway_usd' ? 'USD' : 'HTG';
  const ledgerWallet = wallet === 'gateway_usd' ? 'gateway' : wallet;
  if (wallet === 'master_wallet') {
    await ledger.creditMasterWallet(merchant.id, amountNum, 'USD', `admin-credit:${ctx.adminId}`, null, mode);
  } else {
    await ledger.creditGateway(merchant.id, amountNum, currency, `admin-credit:${ctx.adminId}`, null, mode);
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

  const newBalance = await ledger.getBalance(merchant.id, ledgerWallet, currency, mode);
  await notify.walletCredited(merchant, {
    amount: amountNum, currency, walletLabel: wallet === 'master_wallet' ? 'Master Wallet' : (wallet === 'gateway_usd' ? 'solde Gateway USD' : 'solde Gateway'), newBalance, note, mode,
  });

  return { status: 200, body: { credited: true, mode, new_balance: newBalance } };
}

/**
 * Admin takes money back from a merchant's wallet (for example after a payment warning or a dispute). A reason is required and
 * is shown to the merchant by e-mail. By default the amount cannot exceed what the wallet holds; the owner can force a debit that
 * leaves the balance negative (money already spent). Every debit is kept in the ledger and in the admin credit history.
 */
async function debit(ctx) {
  const merchant = await supabase.selectOne('merchants', { id: ctx.params.id });
  if (!merchant) throw httpError(404, 'NOT_FOUND', 'Marchand introuvable.');
  const { wallet, amount, reason, force } = ctx.body || {};
  if (!['master_wallet', 'gateway', 'gateway_usd'].includes(wallet)) throw httpError(400, 'INVALID_WALLET', "wallet doit être 'master_wallet', 'gateway' (HTG) ou 'gateway_usd'.");
  const amountNum = Number(amount);
  if (!(amountNum > 0) || !Number.isFinite(amountNum) || Math.round(amountNum * 100) !== amountNum * 100 && Math.abs(Math.round(amountNum * 100) - amountNum * 100) > 1e-6) throw httpError(400, 'INVALID_AMOUNT', 'amount doit être un nombre positif avec 2 décimales au maximum.');
  if (amountNum > 100000) throw httpError(400, 'AMOUNT_TOO_HIGH', 'Un débit manuel est limité à 100 000 par opération.');
  const why = String(reason == null ? '' : reason).replace(/[\u0000-\u001f]/g, ' ').trim();
  if (why.length < 5) throw httpError(400, 'REASON_REQUIRED', 'Un motif d\'au moins 5 caractères est obligatoire : le marchand le reçoit par e-mail.');
  const requested = ctx.body && ctx.body.mode;
  if (requested != null && requested !== 'live' && requested !== 'sandbox') throw httpError(400, 'INVALID_MODE', "mode doit être 'live' ou 'sandbox'.");
  const mode = requested || (merchant.gateway_live_enabled ? 'live' : 'sandbox');
  const currency = wallet === 'master_wallet' || wallet === 'gateway_usd' ? 'USD' : 'HTG';
  const ledgerWallet = wallet === 'gateway_usd' ? 'gateway' : wallet;
  const available = await ledger.getBalance(merchant.id, ledgerWallet, currency, mode);
  if (amountNum > available + 1e-9) {
    if (force !== true) throw httpError(400, 'INSUFFICIENT_BALANCE', `Ce portefeuille ne contient que ${available} ${currency}. Débitez au plus ce montant, ou demandez au propriétaire de forcer le débit.`);
    if (ctx.adminRole !== 'owner') throw httpError(403, 'INSUFFICIENT_ROLE', 'Seul le propriétaire peut forcer un débit qui rend le solde négatif.');
  }
  await ledger.adminDebit(merchant.id, ledgerWallet, amountNum, currency, `admin-debit:${ctx.adminId}:${why.slice(0, 120)}`, mode);
  await supabase.insert('admin_wallet_credits', { id: `awc_${randomHex(8)}`, merchant_id: merchant.id, admin_id: ctx.adminId, wallet, amount: -amountNum, currency, note: `DÉBIT : ${why}`.slice(0, 300), mode });
  const newBalance = await ledger.getBalance(merchant.id, ledgerWallet, currency, mode);
  await notify.walletDebited(merchant, { amount: amountNum, currency, walletLabel: wallet === 'master_wallet' ? 'Master Wallet' : (wallet === 'gateway_usd' ? 'solde Gateway USD' : 'solde Gateway'), newBalance, reason: why, mode });
  return { status: 200, body: { debited: true, mode, new_balance: newBalance } };
}

/** The merchant's guarantee deposit (locked part of the Master Wallet): the current amount, the default, the balance and what is spendable. */
async function getGuarantee(ctx) {
  const merchant = await supabase.selectOne('merchants', { id: ctx.params.id });
  if (!merchant) throw httpError(404, 'NOT_FOUND', 'Marchand introuvable.');
  const mode = ctx.query && ctx.query.mode === 'sandbox' ? 'sandbox' : 'live';
  const [value, balance, history] = await Promise.all([
    guarantee.get(merchant.id),
    ledger.getBalance(merchant.id, 'master_wallet', 'USD', mode),
    supabase.select('admin_wallet_credits', { merchant_id: merchant.id, wallet: 'guarantee' }, { order: 'created_at.desc', limit: 20 }),
  ]);
  return { status: 200, body: { mode, guarantee_usd: value, default_usd: config.masterWallet.minimumBalanceUsd, max_usd: guarantee.MAX_USD, master_wallet_balance: balance, spendable_usd: Math.max(0, Math.round((balance - value) * 100) / 100), history: history.map((h) => ({ at: h.created_at, new_value: Number(h.amount), note: h.note })) } };
}

/** Raises or lowers the guarantee deposit of ONE merchant. The reason is required and e-mailed to the merchant with the new amounts. */
async function setGuarantee(ctx) {
  const merchant = await supabase.selectOne('merchants', { id: ctx.params.id });
  if (!merchant) throw httpError(404, 'NOT_FOUND', 'Marchand introuvable.');
  const b = ctx.body || {};
  const value = Number(b.guarantee_usd);
  if (!Number.isFinite(value) || value < 0 || value > guarantee.MAX_USD || Math.abs(Math.round(value * 100) - value * 100) > 1e-6) throw httpError(400, 'INVALID_AMOUNT', `guarantee_usd doit être entre 0 et ${guarantee.MAX_USD} $, avec 2 décimales au maximum.`);
  const why = String(b.reason == null ? '' : b.reason).replace(/[\u0000-\u001f]/g, ' ').trim();
  if (why.length < 5) throw httpError(400, 'REASON_REQUIRED', "Un motif d'au moins 5 caractères est obligatoire : le marchand le reçoit par e-mail.");
  const mode = b.mode === 'sandbox' ? 'sandbox' : 'live';
  const { previous } = await guarantee.set(merchant.id, value, ctx.adminId);
  if (Math.abs(previous - value) < 0.005) return { status: 200, body: { changed: false, guarantee_usd: value } };
  await supabase.insert('admin_wallet_credits', { id: `awc_${randomHex(8)}`, merchant_id: merchant.id, admin_id: ctx.adminId, wallet: 'guarantee', amount: value, currency: 'USD', note: `GARANTIE ${previous} → ${value} : ${why}`.slice(0, 300), mode });
  const balance = await ledger.getBalance(merchant.id, 'master_wallet', 'USD', mode);
  await notify.guaranteeChanged(merchant, { previous, value, balance, reason: why });
  return { status: 200, body: { changed: true, previous_usd: previous, guarantee_usd: value, master_wallet_balance: balance, spendable_usd: Math.max(0, Math.round((balance - value) * 100) / 100) } };
}

/**
 * "Émetteurs de cartes": the merchants who have LIVE access to issue cards, with their real Master Wallet: balance, locked guarantee,
 * spendable amount, money already on their cards, and whether they are running low. Lowest spendable amount first.
 */
async function issuers(ctx) {
  const rows = (await supabase.select('merchants', { issuing_live_enabled: true }, { order: 'created_at.desc', limit: 200 })).filter((m) => !m.deleted_at);
  const out = [];
  for (let i = 0; i < rows.length; i += 10) {
    const batch = await Promise.all(rows.slice(i, i + 10).map(async (m) => {
      const [balance, locked, cards] = await Promise.all([
        ledger.getBalance(m.id, 'master_wallet', 'USD', 'live'),
        guarantee.get(m.id),
        supabase.select('cards', { merchant_id: m.id, mode: 'live', deleted_at: supabase.isNull() }, { limit: 2000 }),
      ]);
      const active = cards.filter((c) => c.status === 'active' || c.status === 'disabled');
      return {
        id: m.id, business_name: m.business_name, email: m.email, issuing_plan: planKeyFor(m, 'issuing', 'live'),
        master_wallet_usd: Math.round(balance * 100) / 100, guarantee_usd: locked, spendable_usd: Math.max(0, Math.round((balance - locked) * 100) / 100),
        reserved_on_cards_usd: Math.round(active.reduce((s, c) => s + Number(c.balance || 0), 0) * 100) / 100, active_cards: active.length, total_cards: cards.length,
        low_balance: balance <= guarantee.alertLevelFor(locked), below_guarantee: balance < locked,
      };
    }));
    out.push(...batch);
  }
  out.sort((a, b) => a.spendable_usd - b.spendable_usd);
  const sum = (k) => Math.round(out.reduce((s, r) => s + r[k], 0) * 100) / 100;
  return { status: 200, body: { issuers: out, totals: { issuers: out.length, master_wallet_usd: sum('master_wallet_usd'), guarantee_usd: sum('guarantee_usd'), spendable_usd: sum('spendable_usd'), reserved_on_cards_usd: sum('reserved_on_cards_usd'), low_balance: out.filter((r) => r.low_balance).length } } };
}

const PRICING_FIELDS = ['card_creation_usd', 'card_recharge_usd', 'card_withdrawal_usd', 'card_decline_usd', 'wallet_funding_pct', 'gateway_pct', 'gateway_fixed_htg', 'payout_mobile_pct', 'payout_bank_fee_htg', 'payout_fee_htg', 'gateway_card_pct', 'gateway_card_fixed_usd', 'payout_bank_fee_usd'];

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

/** GET /admin/merchants/:id/diagnostic : why a merchant cannot connect the payment service or the cards (read only). */
async function diagnostic(ctx) {
  const result = await require('../services/merchantDiagnostic').diagnose(ctx.params.id);
  if (!result) throw httpError(404, 'NOT_FOUND', 'Marchand introuvable.');
  return { status: 200, body: result };
}

module.exports = { diagnostic, list, get, overview, credit, setPricing, clearPricing, setLive, setFreePlan, remove, restore, debit, getGuarantee, setGuarantee, issuers };
