'use strict';

/**
 * Contract text: the admin writes it in a rich-text editor, so what arrives is HTML. Only a small whitelist of tags
 * survives (no attributes except a text alignment), so the same text can be shown in a page and drawn in a PDF
 * safely. Blanks the signer must fill are written [[Label]].
 */
const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'li', 'blockquote']);
const VOID = new Set(['br', 'hr']);
const ALLOWED = new Set(['p', 'div', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote', 'span']);
const ALIGN = new Set(['left', 'center', 'right', 'justify']);
const FIELD_RE = /\[\[([^\[\]\n]{1,80})\]\]/g;

function decode(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#0?39;|&#x27;|&apos;/gi, "'")
    .replace(/&#(\d{1,6});/g, (m, n) => { const c = Number(n); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; })
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, h) => { const c = parseInt(h, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; });
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function tokenize(html) {
  let src = String(html == null ? '' : html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed|svg|math|template)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/\u0000/g, '');
  const tokens = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|([^<]+|<)/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[2]) {
      const tag = m[2].toLowerCase();
      if (m[1]) tokens.push({ t: 'close', tag });
      else {
        const style = /style\s*=\s*"([^"]*)"|style\s*=\s*'([^']*)'/i.exec(m[3] || '');
        const al = style && /text-align\s*:\s*(left|center|right|justify)/i.exec(style[1] || style[2] || '');
        tokens.push({ t: 'open', tag, align: al ? al[1].toLowerCase() : null });
      }
    } else {
      tokens.push({ t: 'text', text: decode(m[4]) });
    }
  }
  return tokens;
}

/** Returns clean HTML: whitelisted tags only, balanced, text escaped. */
function sanitize(html) {
  const out = [];
  const stack = [];
  for (const k of tokenize(html)) {
    if (k.t === 'text') { out.push(esc(k.text)); continue; }
    if (!ALLOWED.has(k.tag)) continue;
    if (k.t === 'open') {
      if (VOID.has(k.tag)) { out.push(`<${k.tag}>`); continue; }
      stack.push(k.tag);
      const al = k.align && ALIGN.has(k.align) && k.tag !== 'span' && k.tag !== 'strong' && k.tag !== 'b' && k.tag !== 'em' && k.tag !== 'i' && k.tag !== 'u' ? ` style="text-align:${k.align}"` : '';
      out.push(`<${k.tag}${al}>`);
    } else if (!VOID.has(k.tag)) {
      const i = stack.lastIndexOf(k.tag);
      if (i === -1) continue;
      while (stack.length > i) out.push(`</${stack.pop()}>`);
    }
  }
  while (stack.length) out.push(`</${stack.pop()}>`);
  return out.join('');
}

/** The distinct blanks written [[Label]] in a text, in order of appearance. */
function fieldLabels(cleanHtml) {
  const labels = [];
  let m;
  const text = String(cleanHtml).replace(/<[^>]*>/g, '');
  FIELD_RE.lastIndex = 0;
  while ((m = FIELD_RE.exec(decode(text)))) {
    const label = m[1].trim();
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

/** Clean HTML for on-screen display: each blank becomes a marked span the page turns into an input. */
function viewHtml(cleanHtml) {
  return String(cleanHtml).replace(/\[\[([^\[\]\n]{1,80})\]\]/g, (m, label) => `<span class="ctr-field" data-field="${esc(decode(label).trim())}">${label}</span>`);
}

/** Blocks for the PDF: [{ kind, align, runs: [{ text, b, i, u, field }] , indent, prefix }]. */
function toBlocks(cleanHtml, values) {
  const blocks = [];
  const lists = [];
  const style = { b: 0, i: 0, u: 0 };
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const runs = cur.runs;
    const onlyBreaks = runs.every((r) => r.br || (r.text !== undefined && !String(r.text).trim() && !r.field));
    if (cur.kind === 'li' || !onlyBreaks) {
      // trim edge spaces
      for (let i = 0; i < runs.length && runs[i].text !== undefined; i++) { runs[i].text = runs[i].text.replace(/^\s+/, ''); if (runs[i].text) break; }
      blocks.push(cur);
    } else if (cur.kind === 'p' || cur.kind === 'div') {
      blocks.push({ kind: 'space' });
    }
    cur = null;
  };
  const start = (kind, align, extra) => { flush(); cur = Object.assign({ kind, align: align || null, runs: [] }, extra || {}); };
  const addText = (txt) => {
    if (!cur) start('p', null);
    const text = txt.replace(/\s+/g, ' ');
    let last = 0, m;
    FIELD_RE.lastIndex = 0;
    while ((m = FIELD_RE.exec(text))) {
      if (m.index > last) cur.runs.push({ text: text.slice(last, m.index), b: style.b > 0, i: style.i > 0, u: style.u > 0 });
      const label = m[1].trim();
      cur.runs.push({ field: label, text: values && values[label] ? String(values[label]) : '', b: true, i: false, u: true });
      last = m.index + m[0].length;
    }
    if (last < text.length) cur.runs.push({ text: text.slice(last), b: style.b > 0, i: style.i > 0, u: style.u > 0 });
  };
  for (const k of tokenize(cleanHtml)) {
    if (k.t === 'text') { if (cur || k.text.trim()) addText(k.text); continue; }
    const tag = k.tag;
    if (k.t === 'open') {
      if (tag === 'ul' || tag === 'ol') { flush(); lists.push({ type: tag, n: 0 }); }
      else if (tag === 'li') {
        const l = lists[lists.length - 1] || { type: 'ul', n: 0 };
        l.n += 1;
        start('li', k.align, { indent: Math.max(1, lists.length), prefix: l.type === 'ol' ? `${l.n}.` : '•' });
      } else if (tag === 'hr') { flush(); blocks.push({ kind: 'hr' }); }
      else if (tag === 'br') { if (!cur) start('p', null); cur.runs.push({ br: true }); }
      else if (BLOCK.has(tag)) start(tag === 'div' ? 'p' : tag, k.align);
      else if (tag === 'strong' || tag === 'b') style.b += 1;
      else if (tag === 'em' || tag === 'i') style.i += 1;
      else if (tag === 'u') style.u += 1;
    } else {
      if (tag === 'ul' || tag === 'ol') { flush(); lists.pop(); }
      else if (BLOCK.has(tag)) flush();
      else if (tag === 'strong' || tag === 'b') style.b = Math.max(0, style.b - 1);
      else if (tag === 'em' || tag === 'i') style.i = Math.max(0, style.i - 1);
      else if (tag === 'u') style.u = Math.max(0, style.u - 1);
    }
  }
  flush();
  return blocks;
}

module.exports = { sanitize, fieldLabels, viewHtml, toBlocks, FIELD_RE };
