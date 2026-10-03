'use strict';
const supabase = require('../lib/supabase');
const { markdownToHtml, escapeHtml, readingTimeMinutes } = require('../utils/markdown');
const config = require('../config');

const SITE = config.siteUrl;
const LOGO_URL = `${SITE}/logo.png`;

const PAGE_CSS = `
:root{--ink:#111;--pink:#ff4081;--muted:#5f5560;--line:#ece4e8;--soft:#faf6f8}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:var(--ink);line-height:1.7;background:#fff}
a{color:var(--pink)}img{max-width:100%;border-radius:12px}
.wrap{max-width:760px;margin:0 auto;padding:0 22px}
header{border-bottom:1px solid var(--line);position:sticky;top:0;background:#fff;z-index:10}
.bar{display:flex;align-items:center;justify-content:space-between;gap:16px;height:66px;max-width:1040px;margin:0 auto;padding:0 22px}
.logo{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--ink);font-weight:800}
.logo img{width:32px;height:32px;border-radius:8px}.logo b{color:var(--pink)}
.btn{display:inline-block;background:var(--ink);color:#fff !important;padding:11px 20px;border-radius:10px;text-decoration:none;font-weight:700;font-size:.92rem}
.crumbs{font-size:.84rem;color:var(--muted);padding-top:18px}.crumbs a{color:var(--muted)}
.eyebrow{font-size:.78rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--pink)}
h1{font-size:clamp(1.7rem,4vw,2.4rem);line-height:1.2;margin:10px 0 14px;letter-spacing:-.02em}
.meta{color:var(--muted);font-size:.86rem;margin-bottom:26px}
.cover{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:16px;margin-bottom:28px;background:var(--soft)}
article h2{font-size:1.35rem;margin:32px 0 12px}
article h3{font-size:1.1rem;margin:26px 0 10px}
article p{margin:0 0 16px;font-size:1rem;color:#2a2a2a}
article ul,article ol{margin:0 0 16px 22px}article li{margin-bottom:6px}
article blockquote{margin:20px 0;padding:4px 18px;border-left:3px solid var(--pink);color:var(--muted);font-style:italic}
article pre{background:#1a1216;color:#f4eef1;padding:16px 18px;border-radius:12px;overflow-x:auto;font-size:.86rem}
article code{font-family:ui-monospace,Menlo,Consolas,monospace}
article p code{background:var(--soft);border:1px solid var(--line);padding:1px 6px;border-radius:6px;font-size:.88em}
.tags{display:flex;gap:8px;flex-wrap:wrap;margin:22px 0}
.tag{background:var(--soft);border:1px solid var(--line);border-radius:999px;padding:4px 12px;font-size:.78rem;color:var(--muted)}
footer{border-top:1px solid var(--line);padding:32px 0;font-size:.88rem;color:var(--muted);margin-top:50px}
.flinks{display:flex;gap:18px;flex-wrap:wrap;margin-bottom:12px;max-width:1040px;margin-left:auto;margin-right:auto;padding:0 22px}
.footwrap{max-width:1040px;margin:0 auto;padding:0 22px}
.plist{display:grid;gap:20px;margin-top:24px}
.pcard{display:flex;gap:18px;border:1px solid var(--line);border-radius:14px;padding:16px;text-decoration:none;color:inherit}
.pcard:hover{border-color:var(--pink)}
.pcard img{width:140px;height:100px;object-fit:cover;border-radius:10px;flex-shrink:0;background:var(--soft)}
.pcard h2{font-size:1.05rem;margin:0 0 6px;color:var(--ink)}
.pcard p{margin:0;color:var(--muted);font-size:.86rem}
.empty{color:var(--muted);padding:40px 0;text-align:center}
@media(max-width:560px){.pcard{flex-direction:column}.pcard img{width:100%;height:160px}}
`;

function layout({ title, description, canonical, ogImage, jsonLd, bodyHtml, robots }) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="robots" content="${robots || 'index, follow, max-snippet:-1, max-image-preview:large'}">
<link rel="canonical" href="${canonical}">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" type="image/png" href="/favicon-96.png" sizes="96x96">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Freda Pay Issuing">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${ogImage}">
<meta property="og:locale" content="fr_FR">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${ogImage}">
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ''}
<style>${PAGE_CSS}</style>
</head>
<body>
<header><div class="bar">
  <a class="logo" href="/"><img src="/logo.png" alt="Logo Freda Pay Issuing"><span>FREDA PAY <b>ISSUING</b></span></a>
  <a class="btn" href="/freda-pay-signup.html">Créer un compte</a>
</div></header>
<main>
${bodyHtml}
</main>
<footer>
  <div class="flinks">
    <a href="/">Accueil</a><a href="/blog">Blog</a><a href="/api-moncash-natcash">API MonCash et Natcash</a><a href="/cartes-virtuelles-haiti">Cartes virtuelles</a><a href="/freda-pay-docs">Documentation</a><a href="/freda-pay-terms">Conditions d'utilisation</a><a href="/freda-pay-privacy">Confidentialité</a>
  </div>
  <div class="footwrap">© ${new Date().getFullYear()} Freda Pay LLC · <a href="mailto:issuing@fredapay.com">issuing@fredapay.com</a></div>
</footer>
</body>
</html>`;
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' });
}

/** GET /blog - list published posts, newest first. */
async function listPage(ctx) {
  const posts = await supabase.select('blog_posts', { status: 'published' }, { order: 'published_at.desc', limit: 50 });
  const cards = posts.length
    ? posts.map((p) => `
      <a class="pcard" href="/blog/${p.slug}">
        <img src="${p.cover_image_url || '/og-image.png'}" alt="">
        <div>
          <h2>${escapeHtml(p.title)}</h2>
          <p>${escapeHtml(p.excerpt || '')}</p>
          <p style="margin-top:6px;font-size:.78rem">${fmtDate(p.published_at)}</p>
        </div>
      </a>`).join('\n')
    : '<p class="empty">Aucun article pour le moment. Revenez bientôt.</p>';

  const body = `
    <div class="wrap" style="padding-top:36px">
      <span class="eyebrow">Blog</span>
      <h1>Actualités et ressources Freda Pay</h1>
      <p style="color:var(--muted)">Paiements, cartes virtuelles, et l'écosystème financier en Haïti.</p>
      <div class="plist">${cards}</div>
    </div>`;

  const html = layout({
    title: 'Blog Freda Pay : paiements, cartes virtuelles et Haïti',
    description: "Articles de Freda Pay sur les paiements MonCash et Natcash, les cartes virtuelles, et l'actualité économique et financière en Haïti.",
    canonical: `${SITE}/blog`,
    ogImage: `${SITE}/og-image.png`,
    bodyHtml: body,
    jsonLd: {
      '@context': 'https://schema.org', '@type': 'Blog', name: 'Blog Freda Pay',
      url: `${SITE}/blog`, publisher: { '@type': 'Organization', name: 'Freda Pay LLC', logo: LOGO_URL },
    },
  });
  return rawHtml(ctx, html);
}

/** GET /blog/:slug - one published post, fully server-rendered for SEO. */
async function postPage(ctx) {
  const post = await supabase.selectOne('blog_posts', { slug: ctx.params.slug, status: 'published' });
  if (!post) return rawHtml(ctx, notFoundPage(), 404);

  const contentHtml = markdownToHtml(post.content_markdown);
  const minutes = readingTimeMinutes(post.content_markdown);
  const tagsHtml = (post.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('');

  const body = `
    <div class="wrap" style="padding-top:36px">
      <div class="crumbs" style="padding-top:0"><a href="/">Accueil</a> / <a href="/blog">Blog</a></div>
      <span class="eyebrow">Article</span>
      <h1>${escapeHtml(post.title)}</h1>
      <div class="meta">${escapeHtml(post.author_name || 'Freda Pay')} · ${fmtDate(post.published_at)} · ${minutes} min de lecture</div>
      ${post.cover_image_url ? `<img class="cover" src="${post.cover_image_url}" alt="${escapeHtml(post.title)}">` : ''}
      <article>${contentHtml}</article>
      ${tagsHtml ? `<div class="tags">${tagsHtml}</div>` : ''}
    </div>`;

  const canonical = `${SITE}/blog/${post.slug}`;
  const description = post.meta_description || post.excerpt || post.title;
  const html = layout({
    title: `${post.title} : Blog Freda Pay`,
    description,
    canonical,
    ogImage: post.cover_image_url || `${SITE}/og-image.png`,
    bodyHtml: body,
    jsonLd: {
      '@context': 'https://schema.org', '@type': 'BlogPosting',
      headline: post.title, description, image: post.cover_image_url || `${SITE}/og-image.png`,
      datePublished: post.published_at, dateModified: post.updated_at || post.published_at,
      author: { '@type': 'Person', name: post.author_name || 'Freda Pay' },
      publisher: { '@type': 'Organization', name: 'Freda Pay LLC', logo: { '@type': 'ImageObject', url: LOGO_URL } },
      mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
      keywords: (post.tags || []).join(', ') || undefined,
    },
  });
  return rawHtml(ctx, html);
}

function notFoundPage() {
  return layout({
    title: 'Article introuvable : Blog Freda Pay',
    description: "Cet article n'existe pas ou plus.",
    canonical: `${SITE}/blog`,
    ogImage: `${SITE}/og-image.png`,
    robots: 'noindex, follow',
    bodyHtml: `<div class="wrap" style="padding-top:60px;text-align:center"><h1>Article introuvable</h1><p><a href="/blog">Retour au blog</a></p></div>`,
  });
}

/** Writes a raw HTML response, bypassing the JSON envelope (see router.js). */
function rawHtml(ctx, html, status) {
  ctx.res.writeHead(status || 200, { 'Content-Type': 'text/html; charset=utf-8' });
  ctx.res.end(html);
}

/** JSON API used by nothing external yet, but handy for the sitemap generator and future use. */
async function listPublicJson(ctx) {
  const posts = await supabase.select('blog_posts', { status: 'published' }, { order: 'published_at.desc', limit: 200 });
  return { status: 200, body: { posts: posts.map((p) => ({ slug: p.slug, title: p.title, published_at: p.published_at, updated_at: p.updated_at })) } };
}

module.exports = { listPage, postPage, listPublicJson };
