'use strict';
const config = require('../config');

/**
 * The address every link in an email (and the blog) points to.
 *
 * A wrong SITE_URL silently breaks every button in every email (404) and sends the blog logo to the wrong
 * website, so it is CHECKED, not trusted: the configured site must really serve the logo. If it does not, and
 * the official site does, the official site is used and the problem is logged and shown in the admin.
 * A failed check on its own (network blip) never flips the address: only "configured is broken AND official works".
 */
let resolved = config.siteUrl;
let state = { configured: config.siteUrl, used: config.siteUrl, checked_at: null, fell_back: false, note: 'Pas encore vérifié.' };

async function serves(base, path = '/logo.png') {
  try {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(6000), redirect: 'follow' });
    const type = res.headers.get('content-type') || '';
    return { ok: res.ok && /^image\//.test(type), status: res.status };
  } catch (err) {
    return { ok: false, status: null };
  }
}

async function verify() {
  const configured = config.siteUrl;
  const check = await serves(configured);
  state = { configured, used: configured, checked_at: new Date().toISOString(), fell_back: false, note: check.ok ? 'Le site configuré répond correctement.' : `Le site configuré ne sert pas le logo (réponse ${check.status || 'aucune'}).` };
  if (!check.ok && configured !== config.defaultSiteUrl) {
    const official = await serves(config.defaultSiteUrl);
    if (official.ok) {
      resolved = config.defaultSiteUrl;
      state = { ...state, used: resolved, fell_back: true, note: `SITE_URL (${configured}) ne sert pas le site : les liens des emails utilisent ${resolved}. Corrigez la variable SITE_URL sur Render.` };
      // eslint-disable-next-line no-console
      console.error(`WARNING: ${state.note}`);
    }
  } else if (check.ok) {
    resolved = configured;
  }
  return state;
}

function get() {
  return resolved;
}
function status() {
  return { ...state, used: resolved };
}

module.exports = { get, verify, serves, status };
