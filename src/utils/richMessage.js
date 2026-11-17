'use strict';

/**
 * Turns the text an admin types or pastes (from a document, a web page, a spreadsheet) into email blocks, so it looks right:
 *   - an ALL-CAPS line (or "# Title") is a heading;
 *   - the lines right after a heading, or lines starting with "-", "•" or "*", are a bullet list;
 *   - lines separated by TABS (pasted table) or written as | a | b | form a table, first row = header;
 *   - everything else is a paragraph (line breaks kept);
 *   - **bold** and web links work inside the text.
 * A first "Objet : ..." line and a first "Bonjour," line are dropped (the subject is a separate field, and the greeting is added per merchant).
 */
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const BULLET = /^\s*(?:[-•*–·]|\d+[.)])\s+/;

function isHeading(line) {
  const t = line.replace(/^#+\s*/, '').trim();
  if (/^#+\s/.test(line)) return true;
  if (t.length < 4 || t.length > 90) return false;
  const base = t.replace(/\([^)]*\)/g, '').replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]/g, '');
  return base.length >= 3 && base === base.toUpperCase() && !/[.!?]$/.test(t);
}

function parseTable(lines) {
  let rows;
  if (lines.some((l) => l.includes('\t'))) rows = lines.map((l) => l.split('\t').map((c) => c.trim()));
  else rows = lines.filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l)).map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  const width = Math.max(...rows.map((r) => r.length));
  return rows.map((r) => (r.length < width && r === rows[0] ? [...Array(width - r.length).fill(''), ...r] : [...r, ...Array(Math.max(0, width - r.length)).fill('')]));
}

function parse(text) {
  const raw = String(text || '').replace(/\r\n?/g, '\n').trim();
  let blocks = raw.split(/\n\s*\n/).map((b) => b.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '')).filter((b) => b.length);
  // A heading pasted without a blank line before it (browsers drop them) still starts its own block.
  blocks = blocks.flatMap((lines) => {
    if (lines.length < 2 || lines.some((l) => l.includes('\t') && isHeading(l))) return [lines];
    const parts = []; let cur = [];
    for (const l of lines) {
      if (isHeading(l) && !l.includes('\t')) { if (cur.length) parts.push(cur); parts.push([l]); cur = []; } else cur.push(l);
    }
    if (cur.length) parts.push(cur);
    return parts;
  });
  if (blocks.length && blocks[0].length && /^objet\s*:/i.test(blocks[0][0].trim())) { blocks[0].shift(); if (!blocks[0].length) blocks.shift(); }
  if (blocks.length && blocks[0].length === 1 && /^(bonjour|bonsoir|hello|bonjou)\b[^\n]{0,40},?$/i.test(blocks[0][0].trim())) blocks.shift();
  const out = []; let prevHeading = false;
  for (const lines of blocks) {
    if (lines.some((l) => l.includes('\t')) || (lines.length >= 2 && lines.every((l) => l.trim().startsWith('|')))) { out.push({ type: 'table', rows: parseTable(lines) }); prevHeading = false; continue; }
    if (lines.length === 1 && isHeading(lines[0])) { out.push({ type: 'h', text: lines[0].replace(/^#+\s*/, '').trim() }); prevHeading = true; continue; }
    if (lines.every((l) => BULLET.test(l)) || (prevHeading && lines.length >= 2)) {
      let items = lines.map((l) => l.replace(BULLET, '').trim()); let tail = null;
      // "Label : value" lines followed by a closing sentence without a colon ("Une question ? ..."): that last line is a paragraph, not an item.
      if (!lines.every((l) => BULLET.test(l)) && items.length >= 3 && items.slice(0, -1).every((i) => i.includes(':')) && !items[items.length - 1].includes(':')) tail = items.pop();
      out.push({ type: 'ul', items });
      if (tail) out.push({ type: 'p', lines: [tail] });
      prevHeading = false; continue;
    }
    out.push({ type: 'p', lines: lines.map((l) => l.trim()) }); prevHeading = false;
  }
  return out;
}

function inline(t) {
  return esc(t)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(https?:\/\/[^\s<]+?)([.,;:!?)]*)(?=\s|<|$)/g, '<a href="$1" style="color:#ff4081;text-decoration:underline;">$1</a>$2');
}

function renderHtml(blocks) {
  const P = 'margin:0 0 14px;font-size:15px;line-height:1.6;color:#4b4b4b;';
  return blocks.map((b) => {
    if (b.type === 'h') return `<p style="margin:24px 0 8px;font-size:13px;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:#ff4081;">${inline(b.text)}</p>`;
    if (b.type === 'ul') return `<ul style="margin:0 0 16px;padding-left:20px;">${b.items.map((i) => `<li style="margin:0 0 6px;font-size:15px;line-height:1.55;color:#4b4b4b;">${inline(i)}</li>`).join('')}</ul>`;
    if (b.type === 'table') {
      const [head, ...body] = b.rows;
      const th = (c, i) => `<th style="padding:9px 10px;background:#faf6f8;border:1px solid #ece4e8;font-size:13px;color:#111;text-align:${i === 0 ? 'left' : 'center'};">${inline(c)}</th>`;
      const td = (c, i) => `<td style="padding:9px 10px;border:1px solid #ece4e8;font-size:13px;line-height:1.45;color:#333;${i === 0 ? 'text-align:left;font-weight:600;' : 'text-align:center;'}">${inline(c)}</td>`;
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:6px 0 18px;"><thead><tr>${head.map(th).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map(td).join('')}</tr>`).join('')}</tbody></table>`;
    }
    return `<p style="${P}">${b.lines.map(inline).join('<br>')}</p>`;
  }).join('\n');
}

function renderText(blocks) {
  const plain = (t) => String(t).replace(/\*\*/g, '');
  return blocks.map((b) => {
    if (b.type === 'h') return `\n${plain(b.text).toUpperCase()}`;
    if (b.type === 'ul') return b.items.map((i) => `- ${plain(i)}`).join('\n');
    if (b.type === 'table') return b.rows.map((r) => r.map(plain).join(' | ')).join('\n');
    return b.lines.map(plain).join('\n');
  }).join('\n\n');
}

const hasTable = (blocks) => blocks.some((b) => b.type === 'table');

module.exports = { parse, renderHtml, renderText, hasTable };
