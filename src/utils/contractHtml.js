'use strict';

/**
 * Contract text: the admin writes it in a rich-text editor, so what arrives is HTML. Only a small whitelist of tags
 * survives (no attributes except a text alignment), so the same text can be shown in a page and drawn in a PDF
 * safely. Blanks the signer must fill are written [[Label]].
 */
const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'li', 'blockquote']);
const VOID = new Set(['br', 'hr']);
const ALLOWED = new Set(['p', 'div', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote', 'span', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
const ALIGN = new Set(['left', 'center', 'right', 'justify']);
const FIELD_RE = /\[\[([^\[\]\n]{1,80})\]\]/g;
/** [[Signature de ...]] marks where a signature goes: the electronic signature fills it, so it is never a blank to type. */
const isSignatureLabel = (label) => /^signature\b/i.test(String(label).trim());

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
/** One pass, so typed text such as "&amp;lt;" stays "&lt;" instead of being decoded twice. */
function decode(s) {
  return String(s).replace(/&(nbsp|amp|lt|gt|quot|apos|#0?39|#x27|#\d{1,6}|#x[0-9a-f]{1,6});/gi, (m, e) => {
    const k = e.toLowerCase();
    if (ENTITIES[k] !== undefined) return ENTITIES[k];
    if (k === '#39' || k === '#039' || k === '#x27') return "'";
    const c = k[1] === 'x' ? parseInt(k.slice(2), 16) : Number(k.slice(1));
    return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : '';
  });
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

/**
 * A blank [[Label]] split by formatting ("[[Nom <b>du</b> rep]]") is merged back into one plain label, and its spaces are
 * collapsed, so the page, the signing check and the PDF all see exactly the same label. Idempotent.
 */
const MARK_RE = /\[\[((?:[^\[\]<]|<\/?(?:strong|b|em|i|u|span)>){1,400}?)\]\]/g;
function normalizeMarks(html) {
  return String(html).replace(MARK_RE, (m, inner) => {
    const label = inner.replace(/<[^>]*>/g, '').replace(/(?:&nbsp;|\s)+/gi, ' ').trim();
    return `[[${label}]]`;
  });
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
  return normalizeMarks(out.join(''));
}

/** The distinct blanks written [[Label]] in a text, in order of appearance. */
function fieldLabels(cleanHtml) {
  const labels = [];
  let m;
  const text = normalizeMarks(cleanHtml).replace(/<[^>]*>/g, '');
  FIELD_RE.lastIndex = 0;
  while ((m = FIELD_RE.exec(decode(text)))) {
    const label = m[1].replace(/\s+/g, ' ').trim();
    if (label && !isSignatureLabel(label) && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

/** Clean HTML for on-screen display: each blank becomes a marked span the page turns into an input. */
function viewHtml(cleanHtml) {
  return normalizeMarks(cleanHtml).replace(/\[\[([^\[\]\n]{1,80})\]\]/g, (m, label) => (isSignatureLabel(decode(label))
    ? '<span class="ctr-sigmark">(signature électronique)</span>'
    : `<span class="ctr-field" data-field="${esc(decode(label).trim())}">${label}</span>`));
}

/** Blocks for the PDF: [{ kind, align, runs: [{ text, b, i, u, field }] , indent, prefix }]. */
function toBlocks(cleanHtml, values) {
  const blocks = [];
  const lists = [];
  const style = { b: 0, i: 0, u: 0 };
  let cur = null;
  let table = null, row = null, cell = null;
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
  const lastRunOf = (c) => c.runs[c.runs.length - 1];
  const start = (kind, align, extra) => { flush(); cur = Object.assign({ kind, align: align || null, runs: [] }, extra || {}); };
  const addText = (txt) => {
    if (!cur) start('p', null);
    const text = txt.replace(/\s+/g, ' ');
    let last = 0, m;
    FIELD_RE.lastIndex = 0;
    while ((m = FIELD_RE.exec(text))) {
      if (m.index > last) cur.runs.push({ text: text.slice(last, m.index), b: style.b > 0, i: style.i > 0, u: style.u > 0 });
      const label = m[1].trim();
      if (isSignatureLabel(label)) { cur.runs.push({ text: '(signature électronique)', b: false, i: true, u: false, sigmark: true }); last = m.index + m[0].length; continue; }
      cur.runs.push({ field: label, text: hasOwn(values, label) && values[label] ? String(values[label]) : '', b: true, i: false, u: true });
      last = m.index + m[0].length;
    }
    if (last < text.length) cur.runs.push({ text: text.slice(last), b: style.b > 0, i: style.i > 0, u: style.u > 0 });
  };
  const hasOwn = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  let lastOl = null; // a numbered list split in two (loose items) keeps counting
  let nested = 0;    // depth of a table inside a table cell: flattened into the cell
  for (const k of tokenize(normalizeMarks(cleanHtml))) {
    if (k.t === 'text') { if (cur || k.text.trim()) addText(k.text); continue; }
    const tag = k.tag;
    // Tables: every cell is one run list; blocks inside a cell are flattened into it.
    if (table && cell && nested > 0 && tag !== 'table' && (tag === 'tr' || tag === 'td' || tag === 'th' || tag === 'thead' || tag === 'tbody')) {
      if (k.t === 'close' && (tag === 'tr' || tag === 'td' || tag === 'th')) cell.runs.push(tag === 'tr' ? { br: true } : { text: ' ', b: false, i: false, u: false });
      continue;
    }
    if (table && cell && tag === 'table') {
      if (k.t === 'open') { nested += 1; if (cell.runs.length && !cell.runs[cell.runs.length - 1].br) cell.runs.push({ br: true }); }
      else if (nested > 0) nested -= 1;
      continue;
    }
    if (tag === 'table') {
      if (k.t === 'open') { flush(); table = { kind: 'table', rows: [] }; }
      else if (table) { if (row && row.cells.length) table.rows.push(row); row = null; if (table.rows.length) blocks.push(table); table = null; cur = null; }
      continue;
    }
    if (table) {
      if (tag === 'tr') {
        if (k.t === 'open') { if (row && row.cells.length) table.rows.push(row); row = { cells: [] }; }
        else if (row) { if (row.cells.length) table.rows.push(row); row = null; }
        continue;
      }
      if (tag === 'th' || tag === 'td') {
        if (k.t === 'open') { if (!row) row = { cells: [] }; cur = { kind: 'cell', align: k.align, runs: [], head: tag === 'th', lists: [] }; cell = cur; nested = 0; }
        else if (cell) { row.cells.push({ runs: cell.runs, head: cell.head, align: cell.align }); cell = null; cur = null; }
        continue;
      }
      if (tag === 'thead' || tag === 'tbody') continue;
      if (cell && (BLOCK.has(tag) || tag === 'ul' || tag === 'ol' || tag === 'hr')) {
        const lineBreak = () => { if (cell.runs.length && !(lastRunOf(cell) && lastRunOf(cell).br)) cell.runs.push({ br: true }); };
        if (tag === 'ul' || tag === 'ol') {
          if (k.t === 'open') { lineBreak(); cell.lists.push({ type: tag, n: 0 }); } else { cell.lists.pop(); lineBreak(); }
        } else if (tag === 'li' && k.t === 'open') {
          lineBreak();
          const l = cell.lists[cell.lists.length - 1] || { type: 'ul', n: 0 };
          l.n += 1;
          cell.runs.push({ text: l.type === 'ol' ? `${l.n}. ` : '• ', b: false, i: false, u: false });
        } else if (k.t === 'close' || tag === 'hr') lineBreak();
        continue;
      }
    }
    if (k.t === 'open') {
      if (tag === 'ul' || tag === 'ol') {
        flush();
        const resume = tag === 'ol' && lastOl && blocks.slice(lastOl.at).every((b) => b.kind === 'space') ? lastOl.n : 0;
        lists.push({ type: tag, n: resume });
      }
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
      if (tag === 'ul' || tag === 'ol') { flush(); const done = lists.pop(); lastOl = done && done.type === 'ol' && !lists.length ? { n: done.n, at: blocks.length } : null; }
      else if (BLOCK.has(tag)) flush();
      else if (tag === 'strong' || tag === 'b') style.b = Math.max(0, style.b - 1);
      else if (tag === 'em' || tag === 'i') style.i = Math.max(0, style.i - 1);
      else if (tag === 'u') style.u = Math.max(0, style.u - 1);
    }
  }
  flush();
  return blocks;
}

module.exports = { normalizeMarks, sanitize, fieldLabels, viewHtml, toBlocks, FIELD_RE };
