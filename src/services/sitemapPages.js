'use strict';

/**
 * Every PUBLIC page of the website, for the sitemap Google reads.
 *
 * When you create a new page on the website, add it here (and nowhere else): the sitemap is generated from
 * this list plus the published blog posts, so Google learns about it without anyone editing a file.
 * Private pages (dashboard, checkout, admin) never belong here.
 *
 * `updated` is the date the page's content last changed meaningfully (YYYY-MM-DD).
 */
const PAGES = [
  { path: '/', changefreq: 'weekly', priority: '1.0', updated: '2026-10-04' },
  { path: '/api-moncash-natcash', changefreq: 'monthly', priority: '0.9', updated: '2026-10-04' },
  { path: '/cartes-virtuelles-haiti', changefreq: 'monthly', priority: '0.9', updated: '2026-10-04' },
  { path: '/docs', changefreq: 'weekly', priority: '0.9', updated: '2026-10-04' },
  { path: '/signup', changefreq: 'monthly', priority: '0.8', updated: '2026-10-04' },
  // `images`: pictures that belong to the page, so Google Images finds every one of them (both team portraits).
  { path: '/notre-equipe', changefreq: 'monthly', priority: '0.6', updated: '2026-10-04', images: ['/team/widemayeur-saint-julien.jpg', '/team/loudjina-tanis.jpg'] },
  { path: '/press-kit', changefreq: 'monthly', priority: '0.5', updated: '2026-10-04' },
  { path: '/regulatory-disclosure', changefreq: 'monthly', priority: '0.5', updated: '2026-10-04' },
  { path: '/terms', changefreq: 'yearly', priority: '0.4', updated: '2026-10-04' },
  { path: '/privacy', changefreq: 'yearly', priority: '0.4', updated: '2026-10-04' },
  { path: '/cookie-policy', changefreq: 'yearly', priority: '0.3', updated: '2026-10-04' },
];

module.exports = { PAGES };
