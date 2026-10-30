'use strict';
const supabase = require('../lib/supabase');
const maplerad = require('./maplerad');
const ledger = require('./ledger');
const revenue = require('./revenue');
const notify = require('./notify');
const pricing = require('./pricing');
const config = require('../config');
const cryptoFees = require('./cryptoFees');
const { planKeyFor } = require('./plans');
const { randomHex } = require('../utils/ids');

/**
 * The crypto wallet: the merchant's own wallet of stablecoins, kept apart from the Master Wallet. Money received stays in crypto
 * (ledger wallet 'crypto', one currency per coin). The merchant can send it out, or ask to convert it to USD: the conversion debits
 * the crypto balance and credits the Master Wallet, after our conversion rate and the plan's fee for adding money to the Master Wallet.
 */
const COINS = ['USDT', 'USDC'];
const CHAINS = {
  solana: { label: 'Solana', provider: 'solana', coins: ['USDT', 'USDC'], send: true },
  ethereum: { label: 'Ethereum', provider: 'eth', coins: ['USDT', 'USDC'], send: false },
  polygon: { label: 'Polygon', provider: 'polygon', coins: ['USDT', 'USDC'], send: false },
  bsc: { label: 'BSC', provider: 'bsc', coins: ['USDT', 'USDC'], send: false },
  tron: { label: 'Tron', provider: 'tron', coins: ['USDT', 'USDC'], send: false },
};
const ADDRESS_FORMAT = {
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  ethereum: /^0x[0-9a-fA-F]{40}$/, polygon: /^0x[0-9a-fA-F]{40}$/, bsc: /^0x[0-9a-fA-F]{40}$/,
  tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
};
// The crypto wallet is Sandbox-only for now: Live opens by setting CRYPTO_LIVE_ENABLED=true.
const liveEnabled = () => process.env.CRYPTO_LIVE_ENABLED === 'true';
const round2 = (n) => Math.round(n * 100) / 100;
const AUTO_CREDIT_MAX = 25000; // above this, a deposit waits for the team instead of crediting by itself

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

function catalog() {
  return { coins: COINS, chains: Object.entries(CHAINS).map(([key, c]) => ({ key, label: c.label, coins: c.coins, can_send: c.send })) };
}

function toPublicAddress(a) {
  return { id: a.id, chain: a.chain, chain_label: (CHAINS[a.chain] || {}).label || a.chain, coin: a.coin, address: a.address, mode: a.mode, created_at: a.created_at };
}

async function balances(merchantId, mode) {
  const out = {};
  for (const c of COINS) out[c] = round2(await ledger.getBalance(merchantId, 'crypto', c, mode));
  return out;
}

/** The merchant's crypto timeline: deposits, sends and conversions, newest first. */
async function history(merchantId, mode, limit) {
  const [deposits, txs] = await Promise.all([
    supabase.select('crypto_deposits', { merchant_id: merchantId, mode }, { order: 'created_at.desc', limit: limit || 50 }),
    supabase.select('crypto_transactions', { merchant_id: merchantId, mode }, { order: 'created_at.desc', limit: limit || 50 }),
  ]);
  const rows = [
    ...deposits.filter((d) => d.status === 'credited').map((d) => ({ id: d.id, type: 'deposit', coin: d.coin, chain: d.chain, amount: Number(d.gross_usd), fee: Number(d.fee_usd), net: Number(d.credited_usd), tx_hash: d.tx_hash, status: 'completed', created_at: d.created_at })),
    ...txs.map((t) => ({ id: t.id, type: t.type, coin: t.coin, chain: t.chain, address: t.address, amount: Number(t.amount), fee: Number(t.fee), net: t.type === 'convert' ? Number(t.usd_credited || 0) : Number(t.amount), usd_credited: t.usd_credited == null ? null : Number(t.usd_credited), tx_hash: t.tx_hash, status: t.status, failure_reason: t.failure_reason, created_at: t.created_at })),
  ];
  return rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, limit || 50);
}

/** The partner customer that owns this merchant's crypto addresses (created once per merchant and mode). */
async function customerFor(merchant, mode) {
  const rows = await supabase.select('crypto_addresses', { merchant_id: merchant.id, mode }, { limit: 1 });
  if (rows && rows[0]) return rows[0].maplerad_customer_id;
  const email = String(merchant.email || '').trim();
  const at = email.indexOf('@');
  const aliased = at > 0 ? `${email.slice(0, at)}+crypto${email.slice(at)}` : email; // a separate customer from any card holder with the same e-mail
  const provider = maplerad.forMode(mode);
  const create = (mail) => provider.createCustomer({ firstName: String(merchant.business_name || 'Freda').slice(0, 60), lastName: 'Business', email: mail, country: merchant.country || 'HT' });
  const idOf = (res) => res && ((res.data && (res.data.id || res.data.customer_id)) || res.id || res.customer_id);
  let id;
  try {
    id = idOf(await create(aliased));
  } catch (err) {
    // A first attempt may have created the partner customer and then failed before saving anything: take that customer back.
    const cards = require('./cardOrchestrator');
    if (!cards.isAlreadyEnrolledError(err)) throw err;
    id = await cards.lookupProviderCustomerId(aliased, mode);
    if (!id) id = idOf(await create(at > 0 ? `${email.slice(0, at)}+crypto${randomHex(3)}${email.slice(at)}` : email)); // not found: a fresh customer with its own address
  }
  if (!id) throw httpError(502, 'CRYPTO_UNAVAILABLE', 'Le service crypto est momentanément indisponible. Réessayez dans un instant.');
  return id;
}

/** The merchant's deposit address for a coin on a chain, created at the partner the first time. Deposits stay in crypto (no auto-conversion). */
async function getOrCreateAddress(merchant, mode, chain, coin) {
  const c = CHAINS[chain];
  if (!c || !COINS.includes(coin) || !c.coins.includes(coin)) throw httpError(400, 'INVALID_CRYPTO', `${coin || '?'} sur ${chain || '?'} n'est pas disponible.`);
  const existing = await supabase.selectOne('crypto_addresses', { merchant_id: merchant.id, mode, chain, coin });
  if (existing) {
    if (existing.offramp && existing.maplerad_address_id) {
      // Created earlier with automatic conversion: the money must stay in crypto until the merchant asks to convert it.
      await maplerad.forMode(mode).updateCryptoOfframp(existing.maplerad_address_id, false).catch(() => {});
      const [fixed] = await supabase.update('crypto_addresses', { id: existing.id }, { offramp: false }).catch(() => []);
      return fixed || existing;
    }
    return existing;
  }
  const customerId = await customerFor(merchant, mode);
  const res = await maplerad.forMode(mode).createCryptoAddress({ customerId, coin, chain: c.provider, offramp: false });
  const d = (res && (res.data || res)) || {};
  if (!d.address) throw httpError(502, 'CRYPTO_UNAVAILABLE', "Le service crypto n'a pas renvoyé d'adresse. Réessayez dans un instant.");
  try {
    return await supabase.insert('crypto_addresses', {
      id: `cad_${randomHex(8)}`, merchant_id: merchant.id, mode, maplerad_customer_id: customerId, maplerad_address_id: d.id || null,
      address: d.address, chain, coin, offramp: false, active: d.active !== false,
    });
  } catch (err) {
    const again = await supabase.selectOne('crypto_addresses', { merchant_id: merchant.id, mode, chain, coin });
    if (again) return again;
    throw err;
  }
}

/** Pulls the useful fields out of a partner deposit notification, whatever nesting it uses. Returns null when it is not a crypto deposit. */
function parseDepositEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const name = String(event.event || event.type || '');
  if (!/^(collection|crypto|deposit)[._]/i.test(name)) return null;
  const d = Object.assign({}, event, event.data && typeof event.data === 'object' ? event.data : {});
  const address = d.address || d.to_address || d.wallet_address || d.deposit_address || null;
  const addressId = d.address_id || d.crypto_id || null;
  if (!address && !addressId) return null;
  const status = String(d.status || name).toLowerCase();
  const failed = /fail|reject|cancel/.test(status) || /fail/i.test(name);
  const ok = !failed && /success|complete|confirm|credited/.test(`${status} ${name}`.toLowerCase());
  // Partner amounts are in minor units (cents): 100000 = 1000.00 of the coin.
  const cents = Number(d.amount);
  const amount = Number.isFinite(cents) && cents > 0 ? Math.round(cents) / 100 : null;
  return {
    ok, failed, address, addressId, amount,
    reference: String(d.reference || d.id || d.tx_hash || d.hash || ''), txHash: d.tx_hash || d.hash || d.transaction_hash || null,
  };
}

/** A stablecoin deposit: the crypto balance is credited once (the partner's reference is the key), after our deposit rate. */
async function applyDepositEvent(event, webhookMode) {
  const dep = parseDepositEvent(event);
  if (!dep || !dep.ok || !dep.reference) return null;
  const addr = dep.address
    ? await supabase.selectOne('crypto_addresses', { address: dep.address })
    : await supabase.selectOne('crypto_addresses', { maplerad_address_id: dep.addressId });
  if (!addr) return null;
  if (addr.mode === 'live' && !liveEnabled()) return null; // Sandbox only for now
  if (webhookMode && addr.mode !== webhookMode) return null; // an event of the other environment never touches this address
  if (await supabase.selectOne('crypto_deposits', { provider_reference: dep.reference })) return null;

  const fees = await cryptoFees.get();
  const base = { id: `cdp_${randomHex(8)}`, merchant_id: addr.merchant_id, address_id: addr.id, mode: addr.mode, provider_reference: dep.reference, chain: addr.chain, coin: addr.coin, tx_hash: dep.txHash };
  if (dep.amount == null || dep.amount < fees.min_deposit_usd || dep.amount > AUTO_CREDIT_MAX) {
    // No readable amount, too small or unusually large: kept for the team, nothing is credited by itself.
    await supabase.insert('crypto_deposits', Object.assign(base, { settled_usd: dep.amount, status: 'review', note: dep.amount == null ? "Montant illisible dans la notification du fournisseur." : 'Montant hors limites automatiques.' })).catch(() => {});
    return null;
  }
  const calc = cryptoFees.computeDeposit(dep.amount, fees);
  let row;
  try {
    // The unique reference is the claim: of two copies of the same event, only one gets past this insert.
    row = await supabase.insert('crypto_deposits', Object.assign(base, { settled_usd: dep.amount, gross_usd: dep.amount, fee_usd: calc.fee, provider_cost_usd: calc.providerCost, credited_usd: calc.net, status: 'credited' }));
  } catch (err) {
    if (await supabase.selectOne('crypto_deposits', { provider_reference: dep.reference }).catch(() => null)) return null;
    throw err;
  }
  try {
    await ledger.creditCrypto(addr.merchant_id, calc.net, addr.coin, `crypto-deposit:${dep.reference}`, row.id, addr.mode);
  } catch (err) {
    await supabase.delete('crypto_deposits', { id: row.id }).catch(() => {}); // not credited: the partner's retry starts again
    throw err;
  }
  await revenue.log(addr.merchant_id, 'crypto_deposit', calc.fee, 'USD', row.id, addr.mode, calc.providerCost).catch((e) => console.error(`Revenue log failed for crypto deposit ${row.id}:`, e.message)); // eslint-disable-line no-console
  return row;
}

/** Hold the money first, then check nobody spent it at the same time (the same pattern as withdrawals). */
async function holdOrFail(merchantId, amount, coin, mode, reference, relatedId) {
  await ledger.debitCrypto(merchantId, amount, coin, `${reference}:hold`, relatedId, mode);
  if ((await ledger.getBalance(merchantId, 'crypto', coin, mode)) < 0) {
    await ledger.creditCrypto(merchantId, amount, coin, `${reference}:release`, relatedId, mode);
    throw httpError(400, 'INSUFFICIENT_CRYPTO_BALANCE', 'Solde crypto insuffisant.');
  }
}
const release = (merchantId, amount, coin, mode, reference, relatedId) => ledger.creditCrypto(merchantId, amount, coin, `${reference}:release`, relatedId, mode);

function assertLiveClosed(mode) {
  if (mode === 'live' && !liveEnabled()) throw httpError(403, 'CRYPTO_SANDBOX_ONLY', 'Le portefeuille crypto est disponible en mode Sandbox pour le moment. Le mode Live arrive bientôt.');
}

/** Replays a request already done with the same reference: same answer, no second movement. */
async function replay(merchantId, reference, type, coin, amount) {
  const existing = await supabase.selectOne('crypto_transactions', { merchant_id: merchantId, reference });
  if (!existing) return null;
  if (existing.type !== type || existing.coin !== coin || Math.abs(Number(existing.amount) - amount) > 0.000001) throw httpError(409, 'REFERENCE_REUSED', 'Cette référence a déjà servi pour une autre opération.');
  return existing;
}

/** Sends crypto out of the wallet. The fee is on top of the amount (the wallet is debited amount + fee). */
async function send(merchant, mode, { coin, chain, address, amount, reference }) {
  assertLiveClosed(mode);
  coin = String(coin || '').toUpperCase(); chain = String(chain || '').toLowerCase();
  const c = CHAINS[chain];
  const value = Number(amount);
  if (!c || !COINS.includes(coin)) throw httpError(400, 'INVALID_CRYPTO', 'Coin ou chaîne invalide.');
  if (!c.send) throw httpError(400, 'SEND_NOT_AVAILABLE', `L'envoi n'est pas encore disponible sur ${c.label}. Utilisez Solana.`);
  if (!Number.isFinite(value) || value < 1 || value > 1e6) throw httpError(400, 'INVALID_AMOUNT', 'Montant invalide (minimum 1).');
  if (!ADDRESS_FORMAT[chain].test(String(address || '').trim()) && !(mode === 'sandbox' && String(address || '').startsWith('FAIL'))) throw httpError(400, 'INVALID_ADDRESS', `Adresse ${c.label} invalide.`);
  if (!reference) throw httpError(400, 'MISSING_FIELDS', 'reference est requis.');
  const done = await replay(merchant.id, reference, 'send', coin, value);
  if (done) return done;

  const calc = cryptoFees.computeSend(value, await cryptoFees.get());
  let row;
  try {
    row = await supabase.insert('crypto_transactions', { id: `ctx_${randomHex(8)}`, merchant_id: merchant.id, mode, type: 'send', coin, chain, address: String(address).trim(), amount: value, fee: calc.fee, provider_cost: calc.providerCost, reference, status: 'pending' });
  } catch (err) {
    const again = await replay(merchant.id, reference, 'send', coin, value).catch(() => null);
    if (again) return again;
    throw err;
  }
  const fail = async (reason) => { await supabase.update('crypto_transactions', { id: row.id, status: 'pending' }, { status: 'failed', failure_reason: reason }).catch(() => {}); };
  try { await holdOrFail(merchant.id, calc.total, coin, mode, row.id, row.id); } catch (err) { await fail(err.message); throw err; }
  try {
    const res = await maplerad.forMode(mode).cryptoTransfer({ amount: Math.round(value * 100), address: String(address).trim(), chain: c.provider, coin: coin.toLowerCase(), reference: row.id, reason: 'Freda Pay crypto send' });
    const d = (res && (res.data || res)) || {};
    const [updated] = await supabase.update('crypto_transactions', { id: row.id, status: 'pending' }, { status: 'completed', tx_hash: d.hash || null });
    await revenue.log(merchant.id, 'crypto_withdrawal', calc.fee, 'USD', row.id, mode, calc.providerCost).catch((e) => console.error(`Revenue log failed for crypto send ${row.id}:`, e.message)); // eslint-disable-line no-console
    return updated || row;
  } catch (err) {
    // Refund only when the partner clearly refused. After a timeout or a partner-side error the money may have left: the send stays
    // pending, held, for the team to settle.
    if (err.httpStatus && err.httpStatus < 500 && err.code !== 'CARD_SERVICE_UNAVAILABLE') {
      await release(merchant.id, calc.total, coin, mode, row.id, row.id);
      await fail(err.message);
      throw httpError(400, 'SEND_REFUSED', err.message);
    }
    console.error(`Crypto send ${row.id}: unclear answer (${err.message}), left pending.`); // eslint-disable-line no-console
    throw httpError(502, 'SEND_PENDING', "L'envoi est en cours de vérification. Les fonds sont bloqués jusqu'à confirmation.");
  }
}

/**
 * Converts crypto to USD: the coin balance is debited and the Master Wallet credited at once. Fees: our conversion rate, then the plan's
 * fee for adding money to the Master Wallet. Both are income (the partner's share is the cost).
 */
async function convert(merchant, mode, { coin, amount, reference }) {
  assertLiveClosed(mode);
  coin = String(coin || '').toUpperCase();
  const value = Number(amount);
  if (!COINS.includes(coin)) throw httpError(400, 'INVALID_CRYPTO', 'Coin invalide.');
  if (!Number.isFinite(value) || value < 1 || value > 1e6) throw httpError(400, 'INVALID_AMOUNT', 'Montant invalide (minimum 1).');
  if (!reference) throw httpError(400, 'MISSING_FIELDS', 'reference est requis.');
  const done = await replay(merchant.id, reference, 'convert', coin, value);
  if (done) return done;

  const override = await supabase.selectOne('merchant_pricing', { merchant_id: merchant.id });
  const fundingPct = pricing.walletFundingPct(planKeyFor(merchant, 'issuing', mode), override);
  const calc = cryptoFees.computeConvert(value, await cryptoFees.get(), fundingPct);
  if (calc.credited <= 0) throw httpError(400, 'AMOUNT_TOO_SMALL', 'Ce montant ne couvre pas les frais.');
  let row;
  try {
    row = await supabase.insert('crypto_transactions', { id: `ctx_${randomHex(8)}`, merchant_id: merchant.id, mode, type: 'convert', coin, amount: value, fee: round2(calc.conversionFee + calc.fundingFee), provider_cost: calc.providerCost, conversion_fee: calc.conversionFee, funding_fee: calc.fundingFee, usd_credited: calc.credited, reference, status: 'pending' });
  } catch (err) {
    const again = await replay(merchant.id, reference, 'convert', coin, value).catch(() => null);
    if (again) return again;
    throw err;
  }
  const fail = async (reason) => { await supabase.update('crypto_transactions', { id: row.id, status: 'pending' }, { status: 'failed', failure_reason: reason }).catch(() => {}); };
  try { await holdOrFail(merchant.id, value, coin, mode, row.id, row.id); } catch (err) { await fail(err.message); throw err; }
  try {
    await ledger.creditMasterWallet(merchant.id, calc.credited, 'USD', `crypto-convert:${row.id}`, row.id, mode);
  } catch (err) {
    await release(merchant.id, value, coin, mode, row.id, row.id).catch(() => {});
    await fail(err.message);
    throw err;
  }
  const [updated] = await supabase.update('crypto_transactions', { id: row.id, status: 'pending' }, { status: 'completed' });
  await revenue.log(merchant.id, 'crypto_conversion', calc.conversionFee, 'USD', row.id, mode, calc.providerCost).catch((e) => console.error(`Revenue log failed for crypto conversion ${row.id}:`, e.message)); // eslint-disable-line no-console
  await revenue.log(merchant.id, 'wallet_funding', calc.fundingFee, 'USD', row.id, mode, round2(config.issuingProviderCostsUSD.walletFundingPct * calc.credited)).catch((e) => console.error(`Revenue log failed for crypto funding ${row.id}:`, e.message)); // eslint-disable-line no-console
  try {
    const newBalance = await ledger.getBalance(merchant.id, 'master_wallet', 'USD', mode);
    await notify.walletCredited(merchant, { amount: calc.credited, currency: 'USD', walletLabel: 'Master Wallet', newBalance, note: `conversion de ${value} ${coin}`, mode });
  } catch (e) { /* the credit is done; a failed e-mail must not undo it */ }
  return updated || row;
}

module.exports = { liveEnabled, catalog, balances, history, getOrCreateAddress, applyDepositEvent, parseDepositEvent, send, convert, toPublicAddress, CHAINS, COINS, AUTO_CREDIT_MAX };
