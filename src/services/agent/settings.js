'use strict';
const supabase = require('../../lib/supabase');
const config = require('../../config');
const { randomHex } = require('../../utils/ids');

/**
 * Agent settings (platform_settings key "agent_settings"), read with a short cache:
 *   email_enabled / chat_enabled : each channel can be switched off without touching the keys
 *   auto_send_safe : "autonomous mode": every reply the guardrails and the model both rate safe is sent by itself (any mailbox). Sensitive topics
 *                    (refund, blocking, limits, legal, secrets...) always wait as a draft for an admin.
 *   kyc_review / kyc_auto_approve : the agent examines each KYC/KYB file; it approves a clear one only when kyc_auto_approve is on (off by default),
 *                    and never rejects: a doubt goes to a human.
 *   learning_enabled : once a day it turns what the team answered into knowledge entries (source "learned").
 *   model : overrides AGENT_MODEL
 */
const KEY = 'agent_settings';
const DEFAULTS = { email_enabled: true, chat_enabled: true, auto_send_safe: true, kyc_review: true, kyc_auto_approve: false, learning_enabled: true, model: '' };
let cache = null;
let cachedAt = 0;

async function get() {
  if (cache && Date.now() - cachedAt < 15 * 1000) return cache;
  let saved = {};
  try {
    const row = await supabase.selectOne('platform_settings', { key: KEY });
    if (row) saved = JSON.parse(row.value) || {};
  } catch (e) { /* defaults */ }
  cache = Object.assign({}, DEFAULTS, saved);
  cachedAt = Date.now();
  return cache;
}

async function save(patch, adminEmail) {
  const current = await get();
  const next = Object.assign({}, current);
  for (const k of ['email_enabled', 'chat_enabled', 'auto_send_safe', 'kyc_review', 'kyc_auto_approve', 'learning_enabled']) if (patch[k] !== undefined) next[k] = !!patch[k];
  if (patch.model !== undefined) next.model = String(patch.model || '').trim().slice(0, 80);
  const row = { value: JSON.stringify(next), updated_by: adminEmail || null, updated_at: new Date().toISOString() };
  const existing = await supabase.selectOne('platform_settings', { key: KEY });
  if (existing) await supabase.update('platform_settings', { key: KEY }, row);
  else await supabase.insert('platform_settings', Object.assign({ key: KEY }, row));
  cache = next; cachedAt = Date.now();
  return next;
}

const clear = () => { cache = null; };
const model = async () => (await get()).model || config.agent.model;

/** One line per run, never allowed to break the work it records. */
async function logRun(run) {
  try {
    await supabase.insert('agent_runs', Object.assign({ id: `run_${randomHex(8)}`, tools_used: [] }, run));
  } catch (e) { /* the log is best effort */ }
}

module.exports = { get, save, clear, model, logRun };
