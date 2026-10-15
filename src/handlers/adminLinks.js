'use strict';
const config = require('../config');
const supabase = require('../lib/supabase');
const siteUrl = require('../services/siteUrl');
const notify = require('../services/notify');
const rateLimit = require('../utils/rateLimit');

async function probe(label, url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(7000), redirect: 'follow' });
    return { label, url, status: res.status, ok: res.ok, content_type: (res.headers.get('content-type') || '').split(';')[0] };
  } catch (err) {
    return { label, url, status: null, ok: false, content_type: null, error: 'Aucune réponse' };
  }
}

/**
 * "Why does the logo not show / why does the button give a 404?" answered with facts: the address the
 * emails really use, and a live check (from the server) of every address an email or the blog points to.
 */
async function links(ctx) {
  const site = await siteUrl.verify(); // re-check now, so what is shown is current
  const base = siteUrl.get();
  const checks = await Promise.all([
    probe("Logo des emails et du blog (servi par l'API)", config.emailLogoUrl),
    probe('Bouton « Tableau de bord »', `${base}/dashboard`),
    probe('Lien de connexion / réinitialisation / invitation', `${base}/signup`),
    probe('Documentation', `${base}/docs`),
    probe('Blog', `${base}/blog`),
    probe('Sitemap', `${base}/sitemap.xml`),
    ...(config.adminUrl ? [probe('Panneau admin (ADMIN_URL)', `${config.adminUrl}/admin.html`)] : []),
  ]);
  const issues = [];
  if (site.fell_back) issues.push(site.note);
  else if (!/^https:\/\/issuing\./.test(config.siteUrl)) issues.push(`SITE_URL vaut « ${config.siteUrl} » : ce doit être l'adresse du site public (https://issuing.fredapay.com), pas l'API ni un autre domaine.`);
  for (const c of checks) if (!c.ok) issues.push(`${c.label} : ${c.url} répond ${c.status || 'rien'}.`);
  if (!config.adminUrl) issues.push("ADMIN_URL n'est pas défini : les invitations d'administrateur utilisent l'adresse du panneau d'où vous les envoyez (c'est suffisant).");
  return {
    status: 200,
    body: {
      checked_at: new Date().toISOString(),
      site: { configured: config.siteUrl, used: base, fell_back: site.fell_back, note: site.note },
      api_url: config.apiUrl,
      checks,
      issues,
    },
  };
}

/** Sends the real email layout (logo + button) to the admin who asks, so the result can be seen on a phone or in Gmail. */
async function emailTest(ctx) {
  if (rateLimit.hit(`email-test:${ctx.adminId}`, 5, 10 * 60 * 1000).limited) {
    const err = new Error("Trop d'essais. Réessayez dans quelques minutes.");
    err.httpStatus = 429; err.code = 'RATE_LIMITED';
    throw err;
  }
  const admin = await supabase.selectOne('admin_users', { id: ctx.adminId });
  if (!admin || !admin.email) { const err = new Error('Adresse introuvable.'); err.httpStatus = 404; err.code = 'NOT_FOUND'; throw err; }
  const sent = await notify.diagnosticTest(admin.email, admin.name);
  if (!sent) { const err = new Error("L'email n'a pas pu être envoyé (fournisseur d'emails).") ; err.httpStatus = 502; err.code = 'EMAIL_FAILED'; throw err; }
  return { status: 200, body: { sent_to: admin.email, logo_url: config.emailLogoUrl, button_url: `${siteUrl.get()}/dashboard` } };
}

module.exports = { links, emailTest };
