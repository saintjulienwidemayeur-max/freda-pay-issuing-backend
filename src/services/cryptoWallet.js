'use strict';
const supabase = require('../lib/supabase');
const maplerad = require('./maplerad');
const ledger = require('./ledger');
const revenue = require('./revenue');
const notify = require('./notify');
const cryptoFees = require('./cryptoFees');
const { randomHex } = require('../utils/ids');

/** Coins and chains offered (our names). The partner calls Ethereum "eth". */
const COINS = ['USDT', 'USDC'];
const CHAINS = {
  solana: { label: 'Solana', provider: 'solana', coins: ['USDT', 'USDC'] },
  ethereum: { label: 'Ethereum', provider: 'eth', coins: ['USDT', 'USDC'] },
  polygon: { label: 'Polygon', provider: 'polygon', coins: ['USDT', 'USDC'] },
  bsc: { label: 'BSC', provider: 'bsc', coins: ['USDT', 'USDC'] },
  tron: { label: 'Tron', provider: 'tron', coins: ['USDT', 'USDC'] },
};
const AUTO_CREDIT_MAX_USD = 25000; // above this, a deposit waits for the team instead of crediting by itself

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

function catalog() {
  return {
    coins: COINS,
    chains: Object.entries(CHAINS).map(([key, c]) => ({ key, label: c.label, coins: c.coins })),
  };
}

function toPublicAddress(a) {
  return { id: a.id, chain: a.chain, chain_label: (CHAINS[a.chain] || {}).label || a.chain, coin: a.coin, address: a.address, mode: a.mode, created_at: a.created_at };
}
function toPublicDeposit(d) {
  return {
    id: d.id, chain: d.chain, coin: d.coin, tx_hash: d.tx_hash, status: d.status,
    sent_usd: d.gross_usd == null ? null : Number(d.gross_usd), fee_usd: d.fee_usd == null ? null : Number(d.fee_usd),
    credited_usd: d.credited_usd == null ? null : Number(d.credited_usd), created_at: d.created_at,
  };
}

/** The partner customer that owns this merchant's crypto addresses (created once per merchant and mode). */
async function customerFor(merchant, mode) {
  const rows = await supabase.select('crypto_addresses', { merchant_id: merchant.id, mode }, { limit: 1 });
  if (rows && rows[0]) return rows[0].maplerad_customer_id;
  const email = String(merchant.email || '').trim();
  const at = email.indexOf('@');
  const aliased = at > 0 ? `${email.slice(0, at)}+crypto${email.slice(at)}` : email; // a separate customer from any card holder with the same e-mail
  const res = await maplerad.forMode(mode).createCustomer({ firstName: String(merchant.business_name || 'Freda').slice(0, 60), lastName: 'Business', email: aliased, country: merchant.country || 'HT' });
  const id = res && ((res.data && (res.data.id || res.data.customer_id)) || res.id || res.customer_id);
  if (!id) throw httpError(502, 'CRYPTO_UNAVAILABLE', 'Le service crypto est momentanément indisponible. Réessayez dans un instant.');
  return id;
}

/** Returns the merchant's deposit address for a coin on a chain, creating it at the partner the first time. */
async function getOrCreateAddress(merchant, mode, chain, coin) {
  const c = CHAINS[chain];
  if (!c || !COINS.includes(coin) || !c.coins.includes(coin)) throw httpError(400, 'INVALID_CRYPTO', `${coin || '?'} sur ${chain || '?'} n'est pas disponible.`);
  const existing = await supabase.selectOne('crypto_addresses', { merchant_id: merchant.id, mode, chain, coin });
  if (existing) return existing;
  const customerId = await customerFor(merchant, mode);
  const res = await maplerad.forMode(mode).createCryptoAddress({ customerId, coin, chain: c.provider, offramp: true });
  const d = (res && (res.data || res)) || {};
  if (!d.address) throw httpError(502, 'CRYPTO_UNAVAILABLE', "Le service crypto n'a pas renvoyé d'adresse. Réessayez dans un instant.");
  try {
    return await supabase.insert('crypto_addresses', {
      id: `cad_${randomHex(8)}`, merchant_id: merchant.id, mode, maplerad_customer_id: customerId, maplerad_address_id: d.id || null,
      address: d.address, chain, coin, offramp: d.offramp !== false, active: d.active !== false,
    });
  } catch (err) {
    // two requests created it at the same time: the first one wins
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
  // Partner amounts are in minor units (cents of USD): 99500 = 995.00 $.
  const cents = Number(d.amount);
  const usd = Number.isFinite(cents) && cents > 0 && (!d.currency || String(d.currency).toUpperCase() === 'USD') ? Math.round(cents) / 100 : null;
  return {
    ok, failed, address, addressId, settledUsd: usd,
    reference: String(d.reference || d.id || d.tx_hash || d.hash || ''), txHash: d.tx_hash || d.hash || d.transaction_hash || null,
  };
}

/**
 * A stablecoin deposit the partner converted to USD: the merchant's Master Wallet is credited once (the partner's reference is the key),
 * the margin is logged as income and the partner's share as cost.
 */
async function applyDepositEvent(event, webhookMode) {
  const dep = parseDepositEvent(event);
  if (!dep || !dep.ok || !dep.reference) return null;
  const addr = dep.address
    ? await supabase.selectOne('crypto_addresses', { address: dep.address })
    : await supabase.selectOne('crypto_addresses', { maplerad_address_id: dep.addressId });
  if (!addr) return null;
  if (webhookMode && addr.mode !== webhookMode) return null; // an event of the other environment never touches this address
  if (await supabase.selectOne('crypto_deposits', { provider_reference: dep.reference })) return null;

  const fees = await cryptoFees.get();
  const base = { id: `cdp_${randomHex(8)}`, merchant_id: addr.merchant_id, address_id: addr.id, mode: addr.mode, provider_reference: dep.reference, chain: addr.chain, coin: addr.coin, tx_hash: dep.txHash };
  if (dep.settledUsd == null || dep.settledUsd < fees.min_deposit_usd || dep.settledUsd > AUTO_CREDIT_MAX_USD) {
    // No readable amount, too small or unusually large: kept for the team, nothing is credited by itself.
    await supabase.insert('crypto_deposits', Object.assign(base, { settled_usd: dep.settledUsd, status: 'review', note: dep.settledUsd == null ? "Montant illisible dans la notification du fournisseur." : 'Montant hors limites automatiques.' })).catch(() => {});
    return null;
  }
  const calc = cryptoFees.computeConversion(dep.settledUsd, fees);
  let row;
  try {
    // The unique reference is the claim: of two copies of the same event, only one gets past this insert.
    row = await supabase.insert('crypto_deposits', Object.assign(base, { settled_usd: dep.settledUsd, gross_usd: calc.grossUsd, fee_usd: calc.feeUsd, provider_cost_usd: calc.providerCostUsd, credited_usd: calc.creditedUsd, status: 'credited' }));
  } catch (err) {
    if (await supabase.selectOne('crypto_deposits', { provider_reference: dep.reference }).catch(() => null)) return null;
    throw err;
  }
  try {
    await ledger.creditMasterWallet(addr.merchant_id, calc.creditedUsd, 'USD', `crypto:${dep.reference}`, row.id, addr.mode);
  } catch (err) {
    await supabase.delete('crypto_deposits', { id: row.id }).catch(() => {}); // not credited: the partner's retry starts again
    throw err;
  }
  await revenue.log(addr.merchant_id, 'crypto_conversion', calc.feeUsd, 'USD', row.id, addr.mode, calc.providerCostUsd).catch((e) => console.error(`Revenue log failed for crypto deposit ${row.id}:`, e.message)); // eslint-disable-line no-console
  try {
    const merchant = await supabase.selectOne('merchants', { id: addr.merchant_id });
    const newBalance = await ledger.getBalance(addr.merchant_id, 'master_wallet', 'USD', addr.mode);
    await notify.walletCredited(merchant, { amount: calc.creditedUsd, currency: 'USD', walletLabel: 'Master Wallet', newBalance, note: `dépôt ${addr.coin} (${(CHAINS[addr.chain] || {}).label || addr.chain})`, mode: addr.mode });
  } catch (e) { /* the credit is done; a failed e-mail must not undo it */ }
  return row;
}

module.exports = { catalog, getOrCreateAddress, applyDepositEvent, parseDepositEvent, toPublicAddress, toPublicDeposit, CHAINS, COINS, AUTO_CREDIT_MAX_USD };
