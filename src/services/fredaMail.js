'use strict';
const crypto = require('crypto');
const config = require('../config');
const supabase = require('../lib/supabase');
const { randomHex } = require('../utils/ids');

/**
 * Freda Mail (https://fredaworkspace.com/api/v1/docs): one API key per mailbox (read + send). Emails arrive by signed webhook and, as a safety net,
 * by a background pass over each mailbox's unread messages. Replies go through POST /api/v1/messages/send with reply_to_message_id, so they stay in the
 * customer's thread. Message content is written by third parties: it is always treated as untrusted.
 */
function fmError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

const mailboxes = () => Object.keys(config.fredaMail.keys || {});
const configured = () => mailboxes().length > 0;
const keyFor = (mailbox) => {
  const keys = config.fredaMail.keys || {};
  const k = String(mailbox || '').toLowerCase();
  const exact = Object.keys(keys).find((m) => m.toLowerCase() === k);
  return exact ? keys[exact] : (mailboxes().length === 1 ? keys[mailboxes()[0]] : null);
};

async function call(mailbox, method, path, body, extraHeaders) {
  const key = keyFor(mailbox);
  if (!key) throw fmError(409, 'FREDA_MAIL_NO_KEY', `Aucune clé Freda Mail pour la boîte ${mailbox || '?'} (FREDA_MAIL_KEYS).`);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  let res;
  try {
    res = await fetch(`${config.fredaMail.baseUrl}${path}`, { method, headers: Object.assign({ Authorization: `Bearer ${key}`, Accept: 'application/json' }, body ? { 'Content-Type': 'application/json' } : {}, extraHeaders || {}), body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
  } catch (e) {
    throw fmError(424, 'FREDA_MAIL_UNREACHABLE', e.name === 'AbortError' ? "Freda Mail n'a pas répondu à temps." : `Freda Mail est injoignable : ${e.message}`);
  } finally { clearTimeout(timer); }
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    const retry = res.headers.get('retry-after');
    throw fmError(424, `FREDA_MAIL_${res.status}`, `Freda Mail a refusé la requête (HTTP ${res.status}${data && data.code ? `, ${data.code}` : ''}) : ${String((data && data.message) || '').slice(0, 200)}${retry ? ` Réessayer dans ${retry} s.` : ''}`);
  }
  return data || {};
}

const me = (mailbox) => call(mailbox, 'GET', '/api/v1/me');
const listUnread = (mailbox, limit) => call(mailbox, 'GET', `/api/v1/messages?unread=true&limit=${Math.min(50, limit || 20)}`);
const readMessage = (mailbox, id) => call(mailbox, 'GET', `/api/v1/messages/${encodeURIComponent(id)}`);
const markRead = (mailbox, id) => call(mailbox, 'PATCH', `/api/v1/messages/${encodeURIComponent(id)}`, { unread: false });

/** A reply in the same thread. The idempotency key makes a retry harmless (the same text is never sent twice). */
async function reply(mailbox, replyToId, text) {
  const idem = `fa-${crypto.createHash('sha256').update(`${replyToId}|${text}`).digest('hex').slice(0, 40)}`;
  return call(mailbox, 'POST', '/api/v1/messages/send', { reply_to_message_id: replyToId, text }, { 'Idempotency-Key': idem });
}

/** X-Freda-Signature = "sha256=" + HMAC-SHA256("<timestamp>.<raw body>", whsec_...). Rejects bad signatures and replays older than 5 minutes. */
function verifySignature(headers, rawBody, secret) {
  if (!secret) return false;
  const ts = String(headers['x-freda-timestamp'] || '');
  if (!/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')}`;
  const got = String(headers['x-freda-signature'] || '');
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

const parseFrom = (v) => {
  if (!v) return { email: '', name: '' };
  if (typeof v === 'object') return { email: String(v.address || v.email || '').toLowerCase().trim(), name: String(v.name || '').trim() };
  const m = String(v).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { email: m[2].toLowerCase().trim(), name: m[1].trim() } : { email: String(v).toLowerCase().trim(), name: '' };
};
const addr = (v) => parseFrom(v).email;
const stripHtml = (h) => String(h || '').replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();

/**
 * Stores one Freda Mail message (the "MessageFull" shape) in the admin inbox, once. Returns the row, or null when it was already there / is our own.
 * The agent is started by the caller.
 */
async function storeMessage(msg, mailbox) {
  if (!msg || !msg.id) return null;
  const from = parseFrom(msg.from);
  if (!from.email) return null;
  const boxes = mailboxes().map((m) => m.toLowerCase());
  if (boxes.includes(from.email)) return null; // never answer our own mailboxes: that is how mail loops start
  const key = `fm:${msg.id}`;
  if (await supabase.selectOne('admin_inbox', { message_id: key })) return null;
  const to = Array.isArray(msg.to) && msg.to[0] ? addr(msg.to[0]) : '';
  const box = String(mailbox || to || '').toLowerCase();
  const { detectMailbox } = require('./agent/emailAgent');
  const merchant = await supabase.selectOne('merchants', { email: from.email });
  const text = String(msg.text || '').trim() || stripHtml(msg.html);
  try {
    return await supabase.insert('admin_inbox', {
      id: `in_${randomHex(8)}`, message_id: key, from_email: from.email, from_name: from.name.slice(0, 200) || null, subject: String(msg.subject || '(sans objet)').slice(0, 300),
      body: text.slice(0, 20000), merchant_id: merchant ? merchant.id : null, is_read: false, source: 'freda_mail', mailbox: detectMailbox({ mailbox: box, to_email: box }),
      fm_id: msg.id, fm_mailbox: box, fm_thread_id: msg.thread_id || null,
    });
  } catch (e) {
    if (await supabase.selectOne('admin_inbox', { message_id: key }).catch(() => null)) return null; // inserted meanwhile (webhook and poll at once)
    throw e;
  }
}

/** Safety net: the unread messages of every mailbox (last 3 days), whatever the webhook did or missed. */
async function pollUnread(limit) {
  let stored = 0; const errors = [];
  for (const box of mailboxes()) {
    try {
      const list = await listUnread(box, limit || 20);
      const since = Date.now() - 3 * 24 * 3600 * 1000;
      for (const m of (list.messages || list.items || list.data || []).slice(0, limit || 20)) {
        if (m.date && new Date(m.date).getTime() < since) continue;
        if (await supabase.selectOne('admin_inbox', { message_id: `fm:${m.id}` })) continue;
        const full = await readMessage(box, m.id);
        const row = await storeMessage(full.message || full, box);
        if (row) { stored += 1; require('./agent/emailAgent').enqueue(row.id); }
      }
    } catch (e) { errors.push(`${box}: ${e.message}`); }
  }
  return { stored, errors };
}

module.exports = { configured, mailboxes, keyFor, me, listUnread, readMessage, markRead, reply, verifySignature, storeMessage, pollUnread, fmError };
