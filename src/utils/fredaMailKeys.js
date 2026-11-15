'use strict';

/**
 * Reads the Freda Mail API keys from the environment, forgivingly (a pasted value often carries smart quotes, a trailing comma or a different format):
 *   FREDA_MAIL_KEYS = {"support@x.com":"fmk_..."}  |  support@x.com=fmk_...,compliance@x.com=fmk_...  |  one or several bare keys fmk_...
 *   FREDA_MAIL_API_KEY / FREDA_MAIL_KEY / FREDA_API_KEY = fmk_...   (a single key; FREDA_MAIL_MAILBOX names its mailbox, optional)
 * A key given without a mailbox is labelled "key1", "key2"... : its real mailbox is read from Freda Mail (GET /api/v1/me).
 * Returns { keys, problems } : problems are readable sentences for the admin, never a key.
 */
const ALIASES = ['FREDA_MAIL_API_KEY', 'FREDA_MAIL_KEY', 'FREDA_API_KEY', 'FREDAMAIL_API_KEY'];
const SMART = /[\u201c\u201d\u201e\u201f\u2033]/g;
const SMART1 = /[\u2018\u2019\u201a\u201b\u2032]/g;

function parse(env) {
  const keys = {}; const problems = []; let n = 0;
  const add = (label, key) => {
    const k = String(key || '').trim().replace(/^["']|["']$/g, '');
    if (!k) return;
    if (!/^fmk_/.test(k)) problems.push(`Une clé ne commence pas par « fmk_ » (${k.slice(0, 4)}…) : copiez la clé telle qu'affichée par Freda Mail.`);
    keys[label || `key${(n += 1)}`] = k;
  };
  let raw = String(env.FREDA_MAIL_KEYS || '').trim();
  if (raw) {
    raw = raw.replace(SMART, '"').replace(SMART1, "'");
    let done = false;
    if (/^[{[]/.test(raw)) {
      try {
        const j = JSON.parse(raw.replace(/,\s*([}\]])/g, '$1'));
        if (Array.isArray(j)) j.forEach((k) => add(null, k));
        else Object.entries(j).forEach(([m, k]) => add(String(m).toLowerCase(), k));
        done = true;
      } catch (e) { problems.push(`FREDA_MAIL_KEYS n'est pas un JSON valide (${e.message}). Exemple : {"support@fredapay.com":"fmk_..."} ou plus simple : support@fredapay.com=fmk_...`); }
    }
    if (!done) {
      for (const part of raw.replace(/[{}"]/g, '').split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean)) {
        const m = part.match(/^([^\s=:]+@[^\s=:]+)\s*[=:]\s*(\S+)$/);
        if (m) add(m[1].toLowerCase(), m[2]); else if (/^fmk_/.test(part)) add(null, part); else problems.push(`Entrée ignorée dans FREDA_MAIL_KEYS : « ${part.slice(0, 12)}… » (format attendu : adresse=clé).`);
      }
    }
  }
  for (const name of ALIASES) {
    if (env[name] && String(env[name]).trim()) { const box = (env.FREDA_MAIL_MAILBOX || '').trim().toLowerCase(); add(box || null, env[name]); break; }
  }
  return { keys, problems, env_names_found: ['FREDA_MAIL_KEYS', ...ALIASES, 'FREDA_MAIL_WEBHOOK_SECRET', 'FREDA_MAIL_MAILBOX'].filter((k) => env[k] && String(env[k]).trim()) };
}

module.exports = { parse };
