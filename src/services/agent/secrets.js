'use strict';
const supabase = require('../../lib/supabase');
const config = require('../../config');
const totp = require('../../utils/totp');
const fmKeys = require('../../utils/fredaMailKeys');

/**
 * API keys typed by an admin in the admin panel (Agent IA > Clés API), for people who cannot edit the host's environment variables.
 * Stored ENCRYPTED (AES-256-GCM, key derived from the server secret) in platform_settings "agent_secrets"; never returned by the API (only "set / source / last 4").
 * A key saved here wins over the environment variable of the same purpose; removing it falls back to the environment.
 */
const KEY = 'agent_secrets';
const NAMES = ['gemini_api_key', 'anthropic_api_key', 'freda_mail_keys', 'freda_mail_webhook_secret', 'monerails_test_key', 'monerails_webhook_secret', 'monerails_live_key', 'monerails_live_webhook_secret'];
const encKey = () => config.twoFactor.key || config.sessionSecret;

// What the environment gave, kept so that removing an admin-entered key restores it.
const env = {
  agent: { provider: config.agent.provider, apiKey: config.agent.apiKey, baseUrl: config.agent.baseUrl, model: config.agent.model },
  monerails: { testKey: config.monerails.testKey, webhookSecret: config.monerails.webhookSecret, liveKey: config.monerails.liveKey, liveWebhookSecret: config.monerails.liveWebhookSecret },
  fm: { keys: Object.assign({}, config.fredaMail.keys), problems: config.fredaMail.keyProblems, names: config.fredaMail.envNamesFound, webhookSecret: config.fredaMail.webhookSecret },
};
let stored = {}; // name -> plain value

async function readRow() {
  try {
    const row = await supabase.selectOne('platform_settings', { key: KEY });
    return row ? JSON.parse(row.value) || {} : {};
  } catch (e) { return {}; }
}

function apply() {
  // Model: a key typed in the admin wins; Gemini first, as with the environment.
  const gem = stored.gemini_api_key; const ant = stored.anthropic_api_key;
  if (gem || ant) {
    const provider = process.env.AGENT_PROVIDER || (gem ? 'gemini' : 'anthropic');
    config.agent.provider = provider;
    config.agent.apiKey = provider === 'gemini' ? (gem || '') : (ant || '');
    if (!process.env.AGENT_MODEL) config.agent.model = provider === 'gemini' ? 'gemini-flash-latest' : 'claude-sonnet-5-5';
    config.agent.baseUrl = (provider === 'gemini' ? (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com') : (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com')).replace(/\/+$/, '');
  } else Object.assign(config.agent, env.agent);
  // Freda Mail: mutate in place (other modules hold the object).
  const keysObj = config.fredaMail.keys;
  Object.keys(keysObj).forEach((k) => delete keysObj[k]);
  if (stored.freda_mail_keys) {
    const parsed = fmKeys.parse({ FREDA_MAIL_KEYS: stored.freda_mail_keys });
    Object.assign(keysObj, parsed.keys);
    config.fredaMail.keyProblems = parsed.problems;
  } else { Object.assign(keysObj, env.fm.keys); config.fredaMail.keyProblems = env.fm.problems; }
  config.fredaMail.webhookSecret = stored.freda_mail_webhook_secret || env.fm.webhookSecret;
  config.monerails.testKey = stored.monerails_test_key || env.monerails.testKey;
  config.monerails.webhookSecret = stored.monerails_webhook_secret || env.monerails.webhookSecret;
  config.monerails.liveKey = stored.monerails_live_key || env.monerails.liveKey;
  config.monerails.liveWebhookSecret = stored.monerails_live_webhook_secret || env.monerails.liveWebhookSecret;
}

/** Reads the saved keys and applies them. Called at start-up, after a save and every few minutes (other instances). */
async function load() {
  const raw = await readRow();
  const next = {};
  for (const n of NAMES) {
    if (!raw[n]) continue;
    try { next[n] = totp.decrypt(raw[n], encKey()); } catch (e) { /* unreadable (server secret changed): ignored */ }
  }
  stored = next;
  apply();
  return status();
}

async function save(patch, adminEmail) {
  const raw = await readRow();
  for (const n of NAMES) {
    if (patch[n] === undefined) continue;
    const v = String(patch[n] || '').trim();
    if (!v) { delete raw[n]; continue; }
    if (n === 'monerails_live_key' && !/^mr_live_/.test(v)) { const e = new Error('La clé Live Monerails doit commencer par mr_live_.'); e.httpStatus = 400; e.code = 'MONERAILS_LIVE_KEY_INVALID'; throw e; }
    if (/^monerails_.*webhook_secret$/.test(n) && !/^whsec_/.test(v)) { const e = new Error('Le secret du webhook Monerails commence par whsec_.'); e.httpStatus = 400; e.code = 'VALIDATION_ERROR'; throw e; }
    if (n === 'monerails_test_key' && !/^mr_test_/.test(v)) { const e = new Error("Seule une clé de TEST Monerails (mr_test_...) est acceptée : l'intégration est en sandbox."); e.httpStatus = 400; e.code = 'MONERAILS_LIVE_KEY_REFUSED'; throw e; }
    if (v.length > 4000) { const e = new Error('Valeur trop longue.'); e.httpStatus = 400; e.code = 'VALIDATION_ERROR'; throw e; }
    raw[n] = totp.encrypt(v, encKey());
  }
  const row = { value: JSON.stringify(raw), updated_by: adminEmail || null, updated_at: new Date().toISOString() };
  const existing = await supabase.selectOne('platform_settings', { key: KEY });
  if (existing) await supabase.update('platform_settings', { key: KEY }, row);
  else await supabase.insert('platform_settings', Object.assign({ key: KEY }, row));
  require('./settings').clear();
  return load();
}

const hint = (v) => (v ? `…${String(v).slice(-4)}` : null);
function status() {
  const entry = (name, envValue) => ({ set: !!(stored[name] || envValue), source: stored[name] ? 'admin' : envValue ? 'environnement' : null, hint: hint(stored[name] || envValue) });
  const mailboxes = Object.keys(config.fredaMail.keys || {});
  return {
    gemini_api_key: entry('gemini_api_key', process.env.GEMINI_API_KEY),
    anthropic_api_key: entry('anthropic_api_key', process.env.ANTHROPIC_API_KEY),
    freda_mail_keys: { set: mailboxes.length > 0, source: stored.freda_mail_keys ? 'admin' : mailboxes.length ? 'environnement' : null, mailboxes, problems: config.fredaMail.keyProblems || [] },
    freda_mail_webhook_secret: entry('freda_mail_webhook_secret', env.fm.webhookSecret),
    monerails_test_key: entry('monerails_test_key', env.monerails.testKey),
    monerails_webhook_secret: entry('monerails_webhook_secret', env.monerails.webhookSecret),
    monerails_live_key: entry('monerails_live_key', env.monerails.liveKey),
    monerails_live_webhook_secret: entry('monerails_live_webhook_secret', env.monerails.liveWebhookSecret),
    provider: config.agent.provider || null,
  };
}

module.exports = { load, save, status, NAMES };
