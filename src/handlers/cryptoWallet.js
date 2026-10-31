'use strict';
const supabase = require('../lib/supabase');
const cryptoWallet = require('../services/cryptoWallet');
const cryptoFees = require('../services/cryptoFees');
const pricing = require('../services/pricing');
const { planKeyFor } = require('../services/plans');
const { resolveMode } = require('../utils/mode');

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

async function loadMerchant(ctx, mode) {
  const merchant = ctx.merchant || (await supabase.selectOne('merchants', { id: ctx.merchantId }));
  if (mode === 'live' && !cryptoWallet.liveEnabled()) throw httpError(403, 'CRYPTO_SANDBOX_ONLY', "Le portefeuille crypto est disponible en mode Sandbox pour le moment. Le mode Live arrive bientôt.");
  if (mode === 'live' && !(merchant && merchant.issuing_live_enabled)) {
    throw httpError(403, 'LIVE_NOT_ENABLED', "Le portefeuille crypto en mode Live s'active avec l'accès Live de Freda Pay Issuing.");
  }
  return merchant;
}

async function fundingPctFor(merchant, mode) {
  const override = await supabase.selectOne('merchant_pricing', { merchant_id: merchant.id });
  return pricing.walletFundingPct(planKeyFor(merchant, 'issuing', mode), override);
}

/** GET /dashboard/crypto : what the page needs in one call (coins, chains, our rates, the wallet's balances, addresses and history). */
async function overview(ctx) {
  const mode = await resolveMode(ctx);
  if (mode === 'live' && !cryptoWallet.liveEnabled()) return { status: 200, body: { mode, enabled: false, message: 'Le portefeuille crypto est disponible en mode Sandbox pour le moment. Le mode Live arrive bientôt.' } };
  const merchant = ctx.merchant || (await supabase.selectOne('merchants', { id: ctx.merchantId }));
  const fees = await cryptoFees.get();
  const [addresses, balances, history, fundingPct] = await Promise.all([
    supabase.select('crypto_addresses', { merchant_id: ctx.merchantId, mode }, { order: 'created_at.asc', limit: 50 }),
    cryptoWallet.balances(ctx.merchantId, mode),
    cryptoWallet.history(ctx.merchantId, mode, 30),
    fundingPctFor(merchant, mode),
  ]);
  return {
    status: 200,
    body: {
      mode, enabled: true, sandbox: mode === 'sandbox',
      ...cryptoWallet.catalog(),
      fees: {
        deposit_pct: fees.deposit_pct, conversion_pct: fees.conversion_pct, master_wallet_funding_pct: Math.round(fundingPct * 10000) / 100,
        withdrawal_under_pct: fees.withdrawal_under_pct, withdrawal_over_pct: fees.withdrawal_over_pct, withdrawal_threshold: fees.withdrawal_threshold_usd, min_deposit: fees.min_deposit_usd,
      },
      balances,
      addresses: addresses.map(cryptoWallet.toPublicAddress),
      transactions: history,
    },
  };
}

/** POST /dashboard/crypto/addresses { chain, coin } : the deposit address for this coin on this chain (created the first time). */
async function createAddress(ctx) {
  const { chain, coin, profile } = ctx.body || {};
  const mode = await resolveMode(ctx);
  const merchant = await loadMerchant(ctx, mode);
  const addr = await cryptoWallet.getOrCreateAddress(merchant, mode, String(chain || '').toLowerCase(), String(coin || '').toUpperCase(), profile);
  return { status: 201, body: cryptoWallet.toPublicAddress(addr) };
}

/** GET /dashboard/crypto/quote?action=send|convert&amount=100 : the exact fee lines, before the merchant confirms. */
async function quote(ctx) {
  const amount = Number(ctx.query && ctx.query.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e7) throw httpError(400, 'INVALID_AMOUNT', 'Montant invalide.');
  const mode = await resolveMode(ctx);
  const merchant = ctx.merchant || (await supabase.selectOne('merchants', { id: ctx.merchantId }));
  const fees = await cryptoFees.get();
  if (ctx.query.action === 'send') {
    const c = cryptoFees.computeSend(amount, fees);
    return { status: 200, body: { amount, fee_pct: c.pct, fee: c.fee, total_debited: c.total } };
  }
  const fundingPct = await fundingPctFor(merchant, mode);
  const c = cryptoFees.computeConvert(amount, fees, fundingPct);
  return { status: 200, body: { amount, conversion_pct: fees.conversion_pct, conversion_fee: c.conversionFee, funding_pct: Math.round(fundingPct * 10000) / 100, funding_fee: c.fundingFee, usd_credited: c.credited } };
}

const publicTx = (t) => ({ id: t.id, type: t.type, coin: t.coin, chain: t.chain, address: t.address, amount: Number(t.amount), fee: Number(t.fee), usd_credited: t.usd_credited == null ? null : Number(t.usd_credited), tx_hash: t.tx_hash, status: t.status, created_at: t.created_at });

/** The merchant's own key for a send or conversion: body.reference, or the Idempotency-Key header (public API). */
function withReference(ctx) {
  const body = Object.assign({}, ctx.body || {});
  const header = ctx.req && ctx.req.headers && ctx.req.headers['idempotency-key'];
  if (!body.reference && header) body.reference = String(header).slice(0, 64);
  return body;
}

/** POST /dashboard/crypto/send { coin, chain, address, amount, reference } */
async function send(ctx) {
  const mode = await resolveMode(ctx);
  const merchant = await loadMerchant(ctx, mode);
  const row = await cryptoWallet.send(merchant, mode, withReference(ctx));
  return { status: 201, body: publicTx(row) };
}

/** POST /dashboard/crypto/convert { coin, amount, reference } : crypto -> USD, credited to the Master Wallet. */
async function convert(ctx) {
  const mode = await resolveMode(ctx);
  const merchant = await loadMerchant(ctx, mode);
  const row = await cryptoWallet.convert(merchant, mode, withReference(ctx));
  return { status: 201, body: publicTx(row) };
}

/* ===== Public API (/v1/crypto/...), authenticated by API key: the same wallet as the dashboard, in the key's mode ===== */
const publicWallet = (a) => ({ id: a.id, object: 'crypto_wallet', coin: a.coin, chain: a.chain, address: a.address, mode: a.mode, created_at: a.created_at });
const publicTransaction = (t) => ({ id: t.id, object: 'crypto_transaction', type: t.type, coin: t.coin, chain: t.chain || null, address: t.address || null, amount: Number(t.amount), fee: Number(t.fee), net: t.net == null ? null : Number(t.net), usd_credited: t.usd_credited == null ? null : Number(t.usd_credited), tx_hash: t.tx_hash || null, status: t.status, created_at: t.created_at });

async function guardApi(ctx) {
  const mode = await resolveMode(ctx);
  const merchant = await loadMerchant(ctx, mode);
  return { mode, merchant };
}

/** GET /v1/crypto/balance */
async function apiBalance(ctx) {
  const { mode } = await guardApi(ctx);
  return { status: 200, body: { object: 'crypto_balance', mode, balances: await cryptoWallet.balances(ctx.merchantId, mode) } };
}

/** GET /v1/crypto/wallets */
async function apiListWallets(ctx) {
  const { mode } = await guardApi(ctx);
  const rows = await supabase.select('crypto_addresses', { merchant_id: ctx.merchantId, mode }, { order: 'created_at.asc', limit: 200 });
  return { status: 200, body: { object: 'list', mode, supported: cryptoWallet.catalog(), wallets: rows.map(publicWallet) } };
}

/** POST /v1/crypto/wallets { coin, chain } : creates the wallet (a deposit address) for a coin on a chain; asking again returns the same one. */
async function apiCreateWallet(ctx) {
  const { mode, merchant } = await guardApi(ctx);
  const { chain, coin, profile } = ctx.body || {};
  const existing = await supabase.selectOne('crypto_addresses', { merchant_id: merchant.id, mode, chain: String(chain || '').toLowerCase(), coin: String(coin || '').toUpperCase() });
  const addr = await cryptoWallet.getOrCreateAddress(merchant, mode, String(chain || '').toLowerCase(), String(coin || '').toUpperCase(), profile);
  return { status: existing ? 200 : 201, body: publicWallet(addr) };
}

/** GET /v1/crypto/transactions */
async function apiTransactions(ctx) {
  const { mode } = await guardApi(ctx);
  const limit = Math.min(100, Math.max(1, parseInt(ctx.query && ctx.query.limit, 10) || 50));
  return { status: 200, body: { object: 'list', mode, transactions: (await cryptoWallet.history(ctx.merchantId, mode, limit)).map(publicTransaction) } };
}

/** GET /v1/crypto/quote?action=send|convert&amount=100 */
async function apiQuote(ctx) {
  await guardApi(ctx);
  return quote(ctx);
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

/** Admin: GET /admin/crypto/deposits : every crypto movement (deposits, sends, conversions) with what we earned and what the partner kept. */
async function adminDeposits(ctx) {
  const mode = ctx.query && ctx.query.mode === 'sandbox' ? 'sandbox' : 'live';
  const [deps, txs, wallets] = await Promise.all([
    supabase.select('crypto_deposits', { mode }, { order: 'created_at.desc', limit: 500 }),
    supabase.select('crypto_transactions', { mode }, { order: 'created_at.desc', limit: 500 }),
    supabase.select('crypto_addresses', { mode }, { order: 'created_at.desc', limit: 2000 }),
  ]);
  const names = new Map();
  for (const id of [...new Set([...deps, ...txs, ...wallets].map((r) => r.merchant_id))]) {
    const m = await supabase.selectOne('merchants', { id }).catch(() => null);
    names.set(id, m ? m.business_name : id);
  }
  const n = (v) => (v == null ? null : Number(v));
  const r2 = (v) => Math.round(v * 100) / 100;
  const rows = [
    ...deps.map((d) => ({ id: d.id, type: 'deposit', merchant: names.get(d.merchant_id), coin: d.coin, chain: d.chain, amount: n(d.gross_usd), fee: n(d.fee_usd), partner_cost: n(d.provider_cost_usd), margin: d.fee_usd == null ? null : r2(Number(d.fee_usd) - Number(d.provider_cost_usd)), status: d.status === 'credited' ? 'completed' : d.status, note: d.note, tx_hash: d.tx_hash, created_at: d.created_at })),
    ...txs.map((t) => ({ id: t.id, type: t.type, merchant: names.get(t.merchant_id), coin: t.coin, chain: t.chain, amount: n(t.amount), fee: n(t.fee), partner_cost: n(t.provider_cost), margin: t.status === 'completed' ? r2(Number(t.fee) - Number(t.provider_cost)) : null, usd_credited: n(t.usd_credited), status: t.status, note: t.failure_reason, tx_hash: t.tx_hash, created_at: t.created_at })),
  ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const done = rows.filter((r) => r.status === 'completed');
  const sum = (list, f) => r2(list.reduce((t, r) => t + Number(f(r) || 0), 0));
  const by = (type) => done.filter((r) => r.type === type);
  return {
    status: 200,
    body: {
      mode,
      totals: {
        operations: done.length,
        merchant_fees: sum(done, (r) => r.fee),
        partner_cost: sum(done, (r) => r.partner_cost),
        margin: sum(done, (r) => r.margin),
        deposits: by('deposit').length, sends: by('send').length, conversions: by('convert').length,
        converted_to_usd: sum(by('convert'), (r) => r.usd_credited),
        to_review: rows.filter((r) => r.status === 'review' || r.status === 'pending').length,
      },
      wallets: {
        total: wallets.length,
        merchants: new Set(wallets.map((w) => w.merchant_id)).size,
        by_coin: wallets.reduce((o, w) => Object.assign(o, { [w.coin]: (o[w.coin] || 0) + 1 }), {}),
        by_chain: wallets.reduce((o, w) => Object.assign(o, { [w.chain]: (o[w.chain] || 0) + 1 }), {}),
        list: wallets.slice(0, 200).map((w) => ({ id: w.id, merchant: names.get(w.merchant_id), coin: w.coin, chain: w.chain, address: w.address, created_at: w.created_at })),
      },
      operations: rows,
    },
  };
}

module.exports = { overview, createAddress, quote, send, convert, apiBalance, apiListWallets, apiCreateWallet, apiTransactions, apiQuote, getFees, setFees, adminDeposits };
