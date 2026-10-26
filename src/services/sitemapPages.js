'use strict';

/**
 * Every PUBLIC page of the website, for the sitemap Google reads.
 *
 * When you create a new page on the website, add it here (and nowhere else): the sitemap is generated from
 * this list plus the published blog posts, so Google learns about it without anyone editing a file.
 * Private pages (dashboard, checkout, admin) and pages marked noindex (signup) never belong here.
 *
 * `updated` is the date the page's content last changed meaningfully (YYYY-MM-DD).
 */
const PAGES = [
  { path: '/', changefreq: 'weekly', priority: '1.0', updated: '2026-10-26', alternates: [{ lang: 'fr', path: '/' }, { lang: 'en', path: '/en/' }, { lang: 'x-default', path: '/' }] },
  { path: '/api-moncash-natcash', changefreq: 'monthly', priority: '0.9', updated: '2026-10-26' },
  { path: '/en/', changefreq: 'weekly', priority: '0.8', updated: '2026-10-26', alternates: [{ lang: 'fr', path: '/' }, { lang: 'en', path: '/en/' }, { lang: 'x-default', path: '/' }] },
  { path: '/en/card-payments-haiti', changefreq: 'monthly', priority: '0.8', updated: '2026-10-17', alternates: [{ lang: 'fr', path: '/paiement-par-carte-haiti' }, { lang: 'en', path: '/en/card-payments-haiti' }, { lang: 'x-default', path: '/paiement-par-carte-haiti' }] },
  { path: '/tarifs', changefreq: 'monthly', priority: '0.8', updated: '2026-10-26' },
  { path: '/api-moncash-haiti', changefreq: 'monthly', priority: '0.8', updated: '2026-10-26' },
  { path: '/api-natcash-haiti', changefreq: 'monthly', priority: '0.8', updated: '2026-10-26' },
  { path: '/passerelle-de-paiement-haiti', changefreq: 'monthly', priority: '0.7', updated: '2026-10-26' },
  { path: '/docs/creer-un-paiement', changefreq: 'monthly', priority: '0.7', updated: '2026-10-26' },
  { path: '/docs/verifier-un-paiement', changefreq: 'monthly', priority: '0.7', updated: '2026-10-26' },
  { path: '/docs/webhooks', changefreq: 'monthly', priority: '0.7', updated: '2026-10-26' },
  { path: '/docs/tester-ma-cle-api', changefreq: 'monthly', priority: '0.7', updated: '2026-10-26' },
  { path: '/docs/retraits-et-solde', changefreq: 'monthly', priority: '0.7', updated: '2026-10-26' },
  { path: '/docs/titulaires-de-cartes', changefreq: 'monthly', priority: '0.7', updated: '2026-10-26' },
  { path: '/docs/creer-une-carte', changefreq: 'monthly', priority: '0.7', updated: '2026-10-26' },
  { path: '/docs/gerer-une-carte', changefreq: 'monthly', priority: '0.7', updated: '2026-10-26' },
  { path: '/docs/restrictions-cartes', changefreq: 'monthly', priority: '0.7', updated: '2026-10-26' },
  { path: '/docs/liens-et-bouton-de-paiement', changefreq: 'monthly', priority: '0.7', updated: '2026-10-26' },
  { path: '/docs/plugins-et-sdks', changefreq: 'monthly', priority: '0.7', updated: '2026-10-26' },
  { path: '/docs/limites-pagination-versions', changefreq: 'monthly', priority: '0.7', updated: '2026-10-26' },
  { path: '/docs/erreurs-et-bonnes-pratiques', changefreq: 'monthly', priority: '0.7', updated: '2026-10-26' },
  { path: '/a-propos', changefreq: 'monthly', priority: '0.7', updated: '2026-10-26' },
  { path: '/paiement-par-carte-haiti', changefreq: 'monthly', priority: '0.9', updated: '2026-10-26', alternates: [{ lang: 'fr', path: '/paiement-par-carte-haiti' }, { lang: 'en', path: '/en/card-payments-haiti' }, { lang: 'x-default', path: '/paiement-par-carte-haiti' }] },
  { path: '/cartes-virtuelles-haiti', changefreq: 'monthly', priority: '0.9', updated: '2026-10-26' },
  { path: '/docs', changefreq: 'weekly', priority: '0.9', updated: '2026-10-26' },
  // `images`: pictures that belong to the page, so Google Images finds every one of them (both team portraits).
  { path: '/notre-equipe', changefreq: 'monthly', priority: '0.6', updated: '2026-10-04', images: ['/team/widemayeur-saint-julien.jpg', '/team/loudjina-tanis.jpg'] },
  { path: '/press-kit', changefreq: 'monthly', priority: '0.5', updated: '2026-10-04' },
  { path: '/regulatory-disclosure', changefreq: 'monthly', priority: '0.5', updated: '2026-10-04' },
  { path: '/terms', changefreq: 'yearly', priority: '0.4', updated: '2026-10-17' },
  { path: '/privacy', changefreq: 'yearly', priority: '0.4', updated: '2026-10-04' },
  { path: '/cookie-policy', changefreq: 'yearly', priority: '0.3', updated: '2026-10-04' },
];

module.exports = { PAGES };
