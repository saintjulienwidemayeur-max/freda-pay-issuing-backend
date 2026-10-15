'use strict';
const supabase = require('../lib/supabase');

/**
 * Platform settings the admin can change without a redeploy. Today: the exchange rate (HTG per 1 USD), used for
 * card prices on payment links, Master Wallet top-ups, plan fees paid in USD, revenue reports...
 * The value lives in the database (table platform_settings) and is cached in memory, refreshed every minute so
 * every server instance converges quickly. config.exchangeRateHtgPerUsd reads it through rate().
 */
const RATE_KEY = 'exchange_rate_htg_per_usd';
const DEFAULT_RATE = 133;
const MIN_RATE = 50;
const MAX_RATE = 1000;

let cached = null;

function rate() {
  return cached || DEFAULT_RATE;
}

async function load() {
  const row = await supabase.selectOne('platform_settings', { key: RATE_KEY });
  const v = row ? Number(row.value) : null;
  cached = v >= MIN_RATE && v <= MAX_RATE ? v : null;
  return row;
}

async function getRateInfo() {
  const row = await load();
  return { rate: rate(), default_rate: DEFAULT_RATE, min: MIN_RATE, max: MAX_RATE, updated_at: row ? row.updated_at : null, updated_by: row ? row.updated_by : null };
}

/** Saves the new rate (the caller has validated it). Returns { previous, rate }. */
async function setRate(value, adminEmail) {
  const previous = rate();
  const existing = await supabase.selectOne('platform_settings', { key: RATE_KEY });
  const patch = { value: String(value), updated_by: adminEmail || null, updated_at: new Date().toISOString() };
  if (existing) await supabase.update('platform_settings', { key: RATE_KEY }, patch);
  else await supabase.insert('platform_settings', Object.assign({ key: RATE_KEY }, patch));
  cached = value;
  return { previous, rate: value };
}

function startRefresh() {
  load().catch(() => {});
  setInterval(() => load().catch(() => {}), 60 * 1000).unref();
}

module.exports = { rate, load, getRateInfo, setRate, startRefresh, DEFAULT_RATE, MIN_RATE, MAX_RATE };
