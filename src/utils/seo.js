'use strict';

const BRAND = 'Freda Pay Issuing';

/** A title with the markdown heading marks ("# ", "## ") that sometimes slip in from a pasted article removed. */
function cleanTitle(title) {
  return String(title == null ? '' : title).replace(/^\s*#+\s*/, '').replace(/\s+/g, ' ').trim();
}

/** Cuts at a word boundary, never in the middle of a word; no ellipsis. */
function clip(text, max) {
  const s = String(text == null ? '' : text).trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.5 ? cut.slice(0, space) : s.slice(0, max)).replace(/[\s,;:.\-]+$/, '');
}

/** URL slug: lowercase, no accents, words joined by "-", at most `max` characters and always ending on a whole word. */
function slugFrom(text, max) {
  const limit = max || 60;
  const full = String(text == null ? '' : text)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (full.length <= limit) return full;
  const cut = full.slice(0, limit + 1);
  const dash = cut.lastIndexOf('-');
  return (dash > limit * 0.5 ? cut.slice(0, dash) : full.slice(0, limit)).replace(/-+$/, '');
}

/** <title> tag: "Title | Freda Pay Issuing" when it fits in 60 characters, otherwise the title alone (clipped to 60). */
function seoTitle(title) {
  const t = cleanTitle(title);
  const withBrand = `${t} | ${BRAND}`;
  return withBrand.length <= 60 ? withBrand : clip(t, 60);
}

module.exports = { cleanTitle, clip, slugFrom, seoTitle };
