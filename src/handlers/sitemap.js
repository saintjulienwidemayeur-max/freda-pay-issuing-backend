'use strict';
const supabase = require('../lib/supabase');
const siteUrl = require('../services/siteUrl');
const { PAGES } = require('../services/sitemapPages');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const day = (d) => new Date(d).toISOString().slice(0, 10);

function url(loc, { lastmod, changefreq, priority, images }) {
  const imgs = (images || []).map((i) => `    <image:image>\n      <image:loc>${esc(i)}</image:loc>\n    </image:image>\n`).join('');
  return `  <url>\n    <loc>${esc(loc)}</loc>\n${lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : ''}${changefreq ? `    <changefreq>${changefreq}</changefreq>\n` : ''}${priority ? `    <priority>${priority}</priority>\n` : ''}${imgs}  </url>`;
}

/**
 * sitemap.xml, generated on every request from the fixed pages plus the PUBLISHED blog posts. Publishing a post
 * adds it, unpublishing or deleting removes it: nothing to edit by hand. The website forwards /sitemap.xml here
 * (see _redirects), so Google always reads the current version at https://<site>/sitemap.xml.
 */
async function sitemap(ctx) {
  const base = siteUrl.get();
  const posts = await supabase.select('blog_posts', { status: 'published' }, { order: 'published_at.desc', limit: 5000 });
  const newest = posts.reduce((m, p) => Math.max(m, new Date(p.updated_at || p.published_at || 0).getTime()), 0);

  const entries = [];
  for (const p of PAGES) entries.push(url(`${base}${p.path === '/' ? '/' : p.path}`, { lastmod: p.updated, changefreq: p.changefreq, priority: p.priority, images: (p.images || []).map((i) => `${base}${i}`) }));
  entries.push(url(`${base}/blog`, { lastmod: newest ? day(newest) : undefined, changefreq: 'daily', priority: '0.7' }));
  for (const post of posts) {
    entries.push(url(`${base}/blog/${post.slug}`, { lastmod: day(post.updated_at || post.published_at || Date.now()), changefreq: 'monthly', priority: '0.6' }));
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${entries.join('\n')}\n</urlset>\n`;
  ctx.res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=600' });
  ctx.res.end(xml);
}

module.exports = { sitemap };
