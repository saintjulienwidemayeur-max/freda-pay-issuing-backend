'use strict';
const supabase = require('../lib/supabase');
const { randomHex } = require('../utils/ids');

function slugify(title) {
  return String(title)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || `post-${randomHex(4)}`;
}

async function uniqueSlug(base) {
  let slug = base;
  let n = 2;
  while (await supabase.selectOne('blog_posts', { slug })) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

/** Cover URL: empty, or a plain https URL (it ends up in img src and og:image). */
function cleanCover(v) {
  if (v == null || v === '') return null;
  let u;
  try { u = new URL(String(v)); } catch (_) { u = null; }
  if (!u || u.protocol !== 'https:' || String(v).length > 1000 || /[\s"'<>]/.test(String(v))) {
    throw httpError(400, 'INVALID_COVER', "L'image de couverture doit être une adresse https:// valide.");
  }
  return u.href;
}
function cleanString(v, max, field) {
  if (typeof v !== 'string') throw httpError(400, 'INVALID_BODY', `${field} doit être du texte.`);
  if (v.length > max) throw httpError(400, 'INVALID_BODY', `${field} est trop long (max ${max} caractères).`);
  return v;
}

async function list(ctx) {
  const rows = await supabase.select('blog_posts', {}, { order: 'created_at.desc' });
  return { status: 200, body: { posts: rows.map(toAdminPublic) } };
}

async function get(ctx) {
  const row = await supabase.selectOne('blog_posts', { id: ctx.params.id });
  if (!row) throw httpError(404, 'NOT_FOUND', 'Article introuvable.');
  return { status: 200, body: { post: toAdminPublic(row) } };
}

async function create(ctx) {
  const b = ctx.body || {};
  if (!b.title || !b.content_markdown) {
    throw httpError(400, 'MISSING_FIELDS', 'title et content_markdown sont requis.');
  }
  cleanString(b.title, 200, 'title');
  cleanString(b.content_markdown, 200000, 'content_markdown');
  if (b.excerpt != null) cleanString(b.excerpt, 500, 'excerpt');
  if (b.meta_description != null) cleanString(b.meta_description, 300, 'meta_description');
  const cover = cleanCover(b.cover_image_url);
  const slug = await uniqueSlug(slugify(typeof b.slug === 'string' && b.slug ? b.slug : b.title));
  const row = await supabase.insert('blog_posts', {
    id: `blog_${randomHex(8)}`,
    slug,
    title: b.title,
    excerpt: b.excerpt || null,
    cover_image_url: cover,
    content_markdown: b.content_markdown,
    tags: Array.isArray(b.tags) ? b.tags.filter((t) => typeof t === 'string' && t.trim()).slice(0, 10) : [],
    status: 'draft',
    author_id: ctx.adminId,
    author_name: ctx.admin.name,
    meta_description: (b.meta_description || b.excerpt || '').slice(0, 300) || null,
  });
  return { status: 201, body: { post: toAdminPublic(row) } };
}

async function update(ctx) {
  const existing = await supabase.selectOne('blog_posts', { id: ctx.params.id });
  if (!existing) throw httpError(404, 'NOT_FOUND', 'Article introuvable.');
  const b = ctx.body || {};
  const patch = { updated_at: new Date().toISOString() };
  if (b.title != null) patch.title = cleanString(b.title, 200, 'title');
  if (b.excerpt != null) patch.excerpt = cleanString(b.excerpt, 500, 'excerpt');
  if (b.cover_image_url != null) patch.cover_image_url = cleanCover(b.cover_image_url);
  if (b.content_markdown != null) patch.content_markdown = cleanString(b.content_markdown, 200000, 'content_markdown');
  if (b.meta_description != null) patch.meta_description = String(b.meta_description).slice(0, 300);
  if (Array.isArray(b.tags)) patch.tags = b.tags.filter((t) => typeof t === 'string' && t.trim()).slice(0, 10);
  if (b.slug && typeof b.slug === 'string' && b.slug !== existing.slug) patch.slug = await uniqueSlug(slugify(b.slug));
  const [updated] = await supabase.update('blog_posts', { id: existing.id }, patch);
  return { status: 200, body: { post: toAdminPublic(updated) } };
}

async function publish(ctx) {
  const existing = await supabase.selectOne('blog_posts', { id: ctx.params.id });
  if (!existing) throw httpError(404, 'NOT_FOUND', 'Article introuvable.');
  const patch = { status: 'published', updated_at: new Date().toISOString() };
  if (!existing.published_at) patch.published_at = new Date().toISOString();
  const [updated] = await supabase.update('blog_posts', { id: existing.id }, patch);
  return { status: 200, body: { post: toAdminPublic(updated) } };
}

async function unpublish(ctx) {
  const existing = await supabase.selectOne('blog_posts', { id: ctx.params.id });
  if (!existing) throw httpError(404, 'NOT_FOUND', 'Article introuvable.');
  const [updated] = await supabase.update('blog_posts', { id: existing.id }, { status: 'draft', updated_at: new Date().toISOString() });
  return { status: 200, body: { post: toAdminPublic(updated) } };
}

async function remove(ctx) {
  const existing = await supabase.selectOne('blog_posts', { id: ctx.params.id });
  if (!existing) throw httpError(404, 'NOT_FOUND', 'Article introuvable.');
  await supabase.delete('blog_posts', { id: existing.id });
  return { status: 200, body: { deleted: true } };
}

/** Cover image upload, same size policy as other image uploads in the dashboard. */
async function uploadCover(ctx) {
  const { base64, content_type } = ctx.body || {};
  if (!base64 || typeof base64 !== 'string') throw httpError(400, 'MISSING_FIELDS', 'base64 est requis.');
  const type = content_type || 'image/jpeg';
  if (!IMAGE_TYPES[type]) throw httpError(400, 'INVALID_IMAGE', 'Format accepté : JPEG, PNG, WebP ou GIF.');
  if (base64.length > 4 * 1024 * 1024) throw httpError(400, 'IMAGE_TOO_LARGE', 'Image trop volumineuse (max ~3 Mo).');
  const buffer = Buffer.from(base64, 'base64');
  const ext = IMAGE_TYPES[type]; // from the validated content type, never from the client file name
  const path = `covers/${randomHex(10)}.${ext}`;
  await supabase.uploadFile('blog-images', path, buffer, type);
  const base = require('../config').supabase.url.replace(/\/+$/, '');
  return { status: 201, body: { url: `${base}/storage/v1/object/public/blog-images/${path}` } };
}

function toAdminPublic(p) {
  return {
    id: p.id, slug: p.slug, title: p.title, excerpt: p.excerpt, cover_image_url: p.cover_image_url,
    content_markdown: p.content_markdown, tags: p.tags || [], status: p.status,
    author_name: p.author_name, meta_description: p.meta_description,
    published_at: p.published_at, created_at: p.created_at, updated_at: p.updated_at,
  };
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

module.exports = { list, get, create, update, publish, unpublish, remove, uploadCover };
