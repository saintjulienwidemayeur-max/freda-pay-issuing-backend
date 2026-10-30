'use strict';
const supabase = require('../lib/supabase');
const cryptoWallet = require('../services/cryptoWallet');
const cryptoFees = require('../services/cryptoFees');
const ledger = require('../services/ledger');
const { resolveMode } = require('../utils/mode');

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

async function loadMerchant(ctx, mode) {
  const merchant = ctx.merchant || (await supabase.selectOne('merchants', { id: ctx.merchantId }));
  if (mode === 'live' && !(merchant && merchant.issuing_live_enabled)) {
    throw httpError(403, 'LIVE_NOT_ENABLED', "Le portefeuille crypto en mode Live s'active avec l'accès Live de Freda Pay Issuing.");
  }
  return merchant;
}

/** GET /dashboard/crypto : what the page needs in one call (coins, chains, our rate, the merchant's addresses and latest deposits). */
async function overview(ctx) {
  const mode = await resolveMode(ctx);
  const fees = await cryptoFees.get();
  const [addresses, deposits, balance] = await Promise.all([
    supabase.select('crypto_addresses', { merchant_id: ctx.merchantId, mode }, { order: 'created_at.asc', limit: 50 }),
    supabase.select('crypto_deposits', { merchant_id: ctx.merchantId, mode }, { order: 'created_at.desc', limit: 50 }),
    ledger.getBalance(ctx.merchantId, 'master_wallet', 'USD', mode),
  ]);
  return {
    status: 200,
    body: {
      mode,
      ...cryptoWallet.catalog(),
      fees: { conversion_pct: fees.conversion_pct, min_deposit_usd: fees.min_deposit_usd },
      master_wallet_usd: balance,
      addresses: addresses.map(cryptoWallet.toPublicAddress),
      deposits: deposits.filter((d) => d.status === 'credited').map(cryptoWallet.toPublicDeposit),
    },
  };
}

/** POST /dashboard/crypto/addresses { chain, coin } : the deposit address for this coin on this chain (created the first time). */
async function createAddress(ctx) {
  const { chain, coin } = ctx.body || {};
  const mode = await resolveMode(ctx);
  const merchant = await loadMerchant(ctx, mode);
  const addr = await cryptoWallet.getOrCreateAddress(merchant, mode, String(chain || '').toLowerCase(), String(coin || '').toUpperCase());
  return { status: 201, body: cryptoWallet.toPublicAddress(addr) };
}

/** GET /dashboard/crypto/quote?amount=1000 : what the Master Wallet receives for an amount sent (our rate only). */
async function quote(ctx) {
  const amount = Number(ctx.query && ctx.query.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e7) throw httpError(400, 'INVALID_AMOUNT', 'Montant invalide.');
  return { status: 200, body: cryptoFees.quoteConversion(amount, await cryptoFees.get()) };
}

/** Admin: GET /admin/settings/crypto-fees */
async function getFees() {
  return { status: 200, body: { fees: await cryptoFees.get(), defaults: cryptoFees.DEFAULTS } };
}

/** Admin: PUT /admin/settings/crypto-fees { ...rates } */
async function setFees(ctx) {
  const email = (ctx.admin && ctx.admin.email) || null;
  const { previous, fees } = await cryptoFees.set(ctx.body || {}, email);
  try {
    await supabase.insert('admin_audit_log', {
      id: 'aud_' + require('../utils/ids').randomHex(8), admin_id: ctx.adminId, admin_email: email, action: 'crypto_fees_changed',
      target_type: 'setting', target_id: cryptoFees.KEY, merchant_id: null, details: { from: previous, to: fees },
    });
  } catch (_) { /* the change itself is saved */ }
  return { status: 200, body: { fees, defaults: cryptoFees.DEFAULTS } };
}

/** Admin: GET /admin/crypto/deposits : every crypto deposit with what we earned and what the partner kept. */
async function adminDeposits(ctx) {
  const mode = ctx.query && ctx.query.mode === 'sandbox' ? 'sandbox' : 'live';
  const rows = await supabase.select('crypto_deposits', { mode }, { order: 'created_at.desc', limit: 500 });
  const credited = rows.filter((r) => r.status === 'credited');
  const sum = (f) => Math.round(credited.reduce((t, r) => t + Number(f(r) || 0), 0) * 100) / 100;
  const names = new Map();
  for (const id of [...new Set(rows.map((r) => r.merchant_id))]) {
    const m = await supabase.selectOne('merchants', { id }).catch(() => null);
    names.set(id, m ? m.business_name : id);
  }
  return {
    status: 200,
    body: {
      mode,
      totals: {
        deposits: credited.length,
        sent_usd: sum((r) => r.gross_usd),
        merchant_fees_usd: sum((r) => r.fee_usd),
        partner_cost_usd: sum((r) => r.provider_cost_usd),
        margin_usd: sum((r) => Number(r.fee_usd) - Number(r.provider_cost_usd)),
        credited_usd: sum((r) => r.credited_usd),
        to_review: rows.filter((r) => r.status === 'review').length,
      },
      deposits: rows.map((r) => ({
        id: r.id, merchant: names.get(r.merchant_id), chain: r.chain, coin: r.coin, tx_hash: r.tx_hash, status: r.status, note: r.note,
        sent_usd: r.gross_usd == null ? null : Number(r.gross_usd), settled_usd: r.settled_usd == null ? null : Number(r.settled_usd),
        fee_usd: r.fee_usd == null ? null : Number(r.fee_usd), partner_cost_usd: r.provider_cost_usd == null ? null : Number(r.provider_cost_usd),
        margin_usd: r.fee_usd == null ? null : Math.round((Number(r.fee_usd) - Number(r.provider_cost_usd)) * 100) / 100,
        credited_usd: r.credited_usd == null ? null : Number(r.credited_usd), created_at: r.created_at,
      })),
    },
  };
}

module.exports = { overview, createAddress, quote, getFees, setFees, adminDeposits };
