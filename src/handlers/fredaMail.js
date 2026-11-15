'use strict';
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const config = require('../config');
const emailAgent = require('../services/agent/emailAgent');
const { randomHex } = require('../utils/ids');

/**
 * POST /webhooks/freda-mail?token=<FREDA_MAIL_SECRET> : Freda Mail (the team's mail platform) tells us a new email arrived in one of the
 * support / compliance / finance mailboxes. The message is stored in the admin inbox and the agent picks it up.
 * Accepted body (the first match wins): one message, { messages: [...] } or { items: [...] }. Each message:
 *   { id | message_id, from: "Name <a@b.c>" | { email, name }, to: "support@..." | [..], mailbox?: "support|compliance|finance",
 *     subject, text | body | plain, html?, received_at? }
 */
function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}
const safeEqual = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function parseAddress(v) {
  if (!v) return { email: '', name: '' };
  if (typeof v === 'object') return { email: String(v.email || v.address || v.Address || '').toLowerCase().trim(), name: String(v.name || v.Name || '').trim() };
  const m = String(v).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { email: m[2].toLowerCase().trim(), name: m[1].trim() } : { email: String(v).toLowerCase().trim(), name: '' };
}
const stripHtml = (h) => String(h || '').replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();

async function receive(ctx) {
  const secret = config.fredaMail.secret;
  const token = (ctx.query && ctx.query.token) || String(ctx.req.headers['x-freda-mail-token'] || '');
  if (!secret || !safeEqual(token, secret)) throw httpError(401, 'INVALID_TOKEN', 'Jeton invalide.');
  const b = ctx.body || {};
  const list = Array.isArray(b.messages) ? b.messages : Array.isArray(b.items) ? b.items : [b];
  let stored = 0; let duplicates = 0;
  for (const m of list.slice(0, 50)) {
    const from = parseAddress(m.from);
    if (!from.email) continue;
    const messageId = String(m.message_id || m.id || '').slice(0, 300) || null;
    if (messageId && (await supabase.selectOne('admin_inbox', { message_id: `fm:${messageId}` }))) { duplicates += 1; continue; }
    const to = Array.isArray(m.to) ? parseAddress(m.to[0]).email : parseAddress(m.to).email;
    const text = String(m.text || m.body || m.plain || '').trim() || stripHtml(m.html);
    const mailbox = emailAgent.detectMailbox({ mailbox: m.mailbox, to_email: to });
    const merchant = await supabase.selectOne('merchants', { email: from.email });
    const row = await supabase.insert('admin_inbox', {
      id: `in_${randomHex(8)}`, message_id: messageId ? `fm:${messageId}` : null, from_email: from.email, from_name: from.name.slice(0, 200) || null,
      subject: String(m.subject || '(sans objet)').slice(0, 300), body: text.slice(0, 20000), merchant_id: merchant ? merchant.id : null, is_read: false,
      source: 'freda_mail', mailbox,
    });
    stored += 1;
    emailAgent.enqueue(row.id);
  }
  return { status: 200, body: { received: stored, duplicates } };
}

module.exports = { receive };
