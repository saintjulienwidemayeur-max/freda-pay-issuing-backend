'use strict';
const supabase = require('../lib/supabase');

/**
 * Crypto wallet rates, in percent. They live in the database (platform_settings, key crypto_fees) so the admin changes them without a
 * redeploy. For each operation there is OUR rate (what the merchant pays) and the PARTNER's rate (what it keeps), so the admin sees the real margin.
 *   deposit      : a stablecoin deposit that stays as crypto          conversion : stablecoin -> USD (off-ramp)
 *   withdrawal   : crypto sent out, below / from the threshold amount
 */
const KEY = 'crypto_fees';
const DEFAULTS = {
  deposit_pct: 0.5, provider_deposit_pct: 0,
  conversion_pct: 0.7, provider_conversion_pct: 0.5,
  withdrawal_under_pct: 2, provider_withdrawal_under_pct: 1.5,
  withdrawal_over_pct: 3, provider_withdrawal_over_pct: 2,
  withdrawal_threshold_usd: 6000,
  min_deposit_usd: 5,
};
const FIELDS = Object.keys(DEFAULTS);

function round2(n) { return Math.round(n * 100) / 100; }

async function get() {
  let stored = {};
  try {
    const row = await supabase.selectOne('platform_settings', { key: KEY });
    if (row && row.value) stored = JSON.parse(row.value);
  } catch (e) { stored = {}; }
  const out = {};
  for (const f of FIELDS) out[f] = Number.isFinite(Number(stored[f])) && stored[f] !== null && stored[f] !== '' ? Number(stored[f]) : DEFAULTS[f];
  return out;
}

/** Validates and saves the rates the admin sent (only known fields). Returns { previous, fees }. */
async function set(input, adminEmail) {
  const previous = await get();
  const next = Object.assign({}, previous);
  for (const f of FIELDS) {
    if (input && input[f] === undefined) continue;
    const v = Number(input[f]);
    const max = f === 'withdrawal_threshold_usd' || f === 'min_deposit_usd' ? 1e7 : 20;
    if (input[f] === '' || input[f] === null || !Number.isFinite(v) || v < 0 || v > max) {
      const err = new Error(`Valeur invalide pour ${f} (0 à ${max}).`);
      err.httpStatus = 400; err.code = 'INVALID_FEE';
      throw err;
    }
    next[f] = v;
  }
  const patch = { value: JSON.stringify(next), updated_by: adminEmail || null, updated_at: new Date().toISOString() };
  const existing = await supabase.selectOne('platform_settings', { key: KEY });
  if (existing) await supabase.update('platform_settings', { key: KEY }, patch);
  else await supabase.insert('platform_settings', Object.assign({ key: KEY }, patch));
  return { previous, fees: next };
}

/**
 * A deposit the partner converted to USD. `settledUsd` is what it credited to our business wallet, after its own conversion rate.
 * The customer sent gross = settled / (1 - partner rate); the merchant pays OUR rate on that gross and receives the rest.
 * Example (0.50 % partner, 0.70 % ours): 1000 sent, 995 settled, 993 credited, 2 kept by us.
 */
function computeConversion(settledUsd, fees) {
  const pp = fees.provider_conversion_pct / 100;
  const op = Math.max(fees.conversion_pct, fees.provider_conversion_pct) / 100; // never below what the partner keeps
  const gross = round2(settledUsd / (1 - pp));
  const feeUsd = round2(gross * op);
  const providerCostUsd = round2(gross - settledUsd);
  const creditedUsd = Math.max(0, round2(gross - feeUsd));
  return { grossUsd: gross, feeUsd, providerCostUsd, creditedUsd, marginUsd: round2(settledUsd - creditedUsd) };
}

/** What the merchant would receive for an amount SENT, for the quote shown before depositing. */
function quoteConversion(sentUsd, fees) {
  const feeUsd = round2(sentUsd * fees.conversion_pct / 100);
  return { sent_usd: round2(sentUsd), fee_pct: fees.conversion_pct, fee_usd: feeUsd, credited_usd: Math.max(0, round2(sentUsd - feeUsd)) };
}

module.exports = { get, set, computeConversion, quoteConversion, DEFAULTS, FIELDS, KEY };
