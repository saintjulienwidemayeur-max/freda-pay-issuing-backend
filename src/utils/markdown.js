'use strict';

/**
 * Minimal, dependency-free Markdown -> HTML converter for blog posts.
 * Supports: # headers (1-3), **bold**, *italic*, [text](url), ![alt](url),
 * ```code blocks```, `inline code`, > blockquotes, - / 1. lists, paragraphs,
 * and blank-line-separated paragraphs. Raw HTML in the source is escaped,
 * so a post can never inject arbitrary markup even though only trusted
 * admin staff can write posts.
 */

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1" loading="lazy">');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  return out;
}

function markdownToHtml(src) {
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let i = 0;
  let para = [];
  let list = null; // 'ul' | 'ol'

  function flushPara() {
    if (para.length) {
      html.push('<p>' + inline(para.join(' ')) + '</p>');
      para = [];
    }
  }
  function closeList() {
    if (list) {
      html.push(`</${list}>`);
      list = null;
    }
  }

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      flushPara();
      closeList();
      const code = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      html.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
      i += 1;
      continue;
    }

    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      closeList();
      const level = h[1].length + 1; // start at h2 (h1 is the page title)
      html.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      flushPara();
      closeList();
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      html.push('<blockquote>' + inline(quote.join(' ')) + '</blockquote>');
      continue;
    }

    const ul = /^[-*]\s+(.*)$/.exec(line);
    const ol = /^\d+\.\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const kind = ul ? 'ul' : 'ol';
      if (list !== kind) {
        closeList();
        html.push(`<${kind}>`);
        list = kind;
      }
      html.push('<li>' + inline((ul || ol)[1]) + '</li>');
      i += 1;
      continue;
    }

    if (line.trim() === '') {
      flushPara();
      closeList();
      i += 1;
      continue;
    }

    para.push(line.trim());
    i += 1;
  }
  flushPara();
  closeList();
  return html.join('\n');
}

/** Rough reading time, for display ("5 min de lecture"). */
function readingTimeMinutes(markdown) {
  const words = String(markdown || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

module.exports = { markdownToHtml, escapeHtml, readingTimeMinutes };
