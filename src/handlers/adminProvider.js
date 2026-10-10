'use strict';
const maplerad = require('../services/maplerad');
const config = require('../config');
const proxyRequest = require('../utils/proxyRequest');

/** Asks one IP-echo service what address it sees us coming from. Accepts {"ip":"..."} or a bare IP. */
async function askForIp(url) {
  // Measured the same way the partner is called: through the static-IP proxy when one is configured.
  const res = config.maplerad.proxyUrl
    ? await proxyRequest.proxiedFetch(config.maplerad.proxyUrl, url, { headers: { Accept: 'application/json, text/plain' }, timeoutMs: 8000 })
    : await fetch(url, { signal: AbortSignal.timeout(4000), headers: { Accept: 'application/json, text/plain' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = (await res.text()).trim();
  let ip = text;
  try { ip = JSON.parse(text).ip || text; } catch (e) { /* plain text */ }
  if (!/^[0-9a-f:.]{3,45}$/i.test(String(ip))) throw new Error('unexpected answer');
  return String(ip);
}

/**
 * The public address this server is calling out from, right now. Three parallel samples on the first
 * working service: a host with a pool of outbound addresses can show more than one, and the provider
 * must be told about all of them.
 */
async function outboundIp() {
  const errors = [];
  for (const url of config.egressIpUrls) {
    const samples = await Promise.allSettled([askForIp(url), askForIp(url), askForIp(url)]);
    const ips = samples.filter((s) => s.status === 'fulfilled').map((s) => s.value);
    if (ips.length) {
      const counts = ips.reduce((m, ip) => m.set(ip, (m.get(ip) || 0) + 1), new Map());
      const observed = [...counts.keys()];
      const ip = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      return { ip, observed, source: new URL(url).host, error: null, via_proxy: !!config.maplerad.proxyUrl };
    }
    errors.push(`${new URL(url).host}: ${samples[0].reason && samples[0].reason.message}`);
  }
  return { ip: null, observed: [], source: null, error: `Impossible de joindre un service d'adresse IP (${errors.join(' ; ')}).`, via_proxy: !!config.maplerad.proxyUrl };
}

const KEY_PROBLEM = {
  missing: (m) => `Aucune clé ${m} n'est configurée (variable ${m === 'live' ? 'MAPLERAD_LIVE_SECRET_KEY' : 'MAPLERAD_SECRET_KEY'}).`,
  wrong_environment: (m) => `La clé ${m} configurée appartient à l'autre environnement : elle serait refusée par sécurité.`,
  malformed: (m) => `La clé ${m} contient un espace ou un retour à la ligne au milieu : elle a été mal collée.`,
};

/**
 * Admin > Paramètres > Diagnostic Maplerad.
 * Always answers (no call to the card provider): the outbound IP, the format of both provider keys
 * (first 8 characters only) and whether the configuration is complete.
 * With ?probe=live or ?probe=sandbox it also makes ONE read-only call to the provider with that key,
 * to see what the provider answers from this IP.
 */
async function diagnostic(ctx) {
  const probeMode = ctx.query && (ctx.query.probe === 'live' || ctx.query.probe === 'sandbox') ? ctx.query.probe : null;
  const keys = { sandbox: maplerad.keyDiagnostics('sandbox'), live: maplerad.keyDiagnostics('live') };
  const webhookSecrets = { sandbox: !!config.maplerad.webhookSecret, live: !!config.maplerad.liveWebhookSecret };

  const issues = [];
  for (const mode of ['live', 'sandbox']) {
    const problem = KEY_PROBLEM[keys[mode].status];
    if (problem) issues.push(problem(mode));
    if (keys[mode].status === 'unrecognized') issues.push(`Le format de la clé ${mode} n'est pas reconnu (attendu : ${keys[mode].expected_prefix}…). Vérifiez-la.`);
    if (!webhookSecrets[mode]) issues.push(`Le secret de webhook ${mode} n'est pas configuré : les cartes ${mode} ne pourraient pas être confirmées.`);
  }

  const ip = await outboundIp();
  if (!ip.ip) issues.push(ip.error);

  let provider = null;
  if (probeMode) {
    provider = { mode: probeMode, ok: false, http: null, code: null, message: null, hints: [] };
    try {
      await maplerad.forMode(probeMode).listCards({ page: 1, page_size: 1 });
      provider.ok = true;
      provider.http = 200;
      provider.hints.push("Le fournisseur accepte la clé et l'adresse IP de ce serveur.");
    } catch (err) {
      provider.code = err.code || null;
      provider.http = err.providerStatus || err.httpStatus || null;
      provider.message = err.providerRawMessage || err.message;
      if (provider.http === 401 || provider.http === 403) {
        provider.hints.push(
          `Le fournisseur refuse nos identifiants (HTTP ${provider.http}). Causes possibles, à confirmer avec le support Maplerad : ` +
          "(1) l'accès Live / Issuing n'est pas activé sur votre compte Maplerad ; " +
          "(2) Maplerad n'autorise que certaines adresses IP : demandez-leur d'autoriser l'adresse sortante affichée ci-dessus ; " +
          "(3) la clé n'est pas la bonne. Envoyez ce diagnostic tel quel à Maplerad."
        );
      } else if (provider.http) {
        provider.hints.push(`Le fournisseur a répondu HTTP ${provider.http} : les identifiants sont acceptés, mais cette requête a été refusée (voir message).`);
      } else {
        provider.hints.push('Aucune réponse du fournisseur (réseau).');
      }
    }
  }

  const broken = ['wrong_environment', 'malformed'].some((s) => keys.live.status === s || keys.sandbox.status === s);
  const incomplete = keys.live.status === 'missing' || keys.sandbox.status === 'missing' || !webhookSecrets.live || !webhookSecrets.sandbox || !ip.ip;
  const status = broken ? 'misconfigured' : incomplete ? 'incomplete' : 'ready';

  return {
    status: 200,
    body: {
      checked_at: new Date().toISOString(),
      status,
      outbound_ip: {
        ...ip,
        looks_fixed: ip.observed.length === 1,
        note: ip.via_proxy
          ? "Mesurée à travers votre proxy à IP fixe : c'est l'adresse que Maplerad voit. Ajoutez-la dans la liste d'adresses autorisées du dashboard Maplerad."
          : "Maplerad exige une IP fixe. Sur Render, un service sort par une plage d'adresses PARTAGÉE : n'importe laquelle peut servir, donc ce n'est pas une IP fixe. Deux solutions : (1) l'option « Dedicated IPs » de Render (payante, 3 adresses fixes : donnez-les toutes à Maplerad), ou (2) un proxy à IP fixe (ex. QuotaGuard) à renseigner dans MAPLERAD_PROXY_URL.",
        proxy: proxyRequest.describe(config.maplerad.proxyUrl),
      },
      keys,
      webhook_secrets: webhookSecrets,
      issues,
      provider,
    },
  };
}

module.exports = { diagnostic };
