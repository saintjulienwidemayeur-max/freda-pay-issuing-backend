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

/** A key given without a mailbox name is labelled key1, key2...: ask Freda Mail which mailbox it opens and rename it (once). */
async function nameKeys() {
  const keys = config.fredaMail.keys;
  for (const label of Object.keys(keys).filter((l) => /^key\d+$/.test(l))) {
    try {
      const info = await call(label, 'GET', '/api/v1/me');
      const addr = String(info.mailbox || info.address || info.email || (info.mailbox && info.mailbox.address) || '').toLowerCase();
      if (addr && !keys[addr]) { keys[addr] = keys[label]; delete keys[label]; }
    } catch (e) { /* the status page shows the reason */ }
  }
}

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
const listFolder = (mailbox, folder, limit, cursor) => call(mailbox, 'GET', `/api/v1/messages?folder=${folder === 'sent' ? 'sent' : 'inbox'}&limit=${Math.min(50, limit || 50)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
const readMessage = (mailbox, id) => call(mailbox, 'GET', `/api/v1/messages/${encodeURIComponent(id)}`);
const markRead = (mailbox, id) => call(mailbox, 'PATCH', `/api/v1/messages/${encodeURIComponent(id)}`, { unread: false });

/** A reply in the same thread. The idempotency key makes a retry harmless (the same text is never sent twice). */
async function reply(mailbox, replyToId, text) {
  const idem = `fa-${crypto.createHash('sha256').update(`${replyToId}|${text}`).digest('hex').slice(0, 40)}`;
  return call(mailbox, 'POST', '/api/v1/messages/send', { reply_to_message_id: replyToId, text }, { 'Idempotency-Key': idem });
}

/**
 * Replies from the mailbox that received the message; if that mailbox says it does not know the message (404: the id was stored under another
 * mailbox's label, or the key was renamed), the other connected mailboxes are tried. Returns the mailbox that accepted it.
 */
async function replyAnywhere(mailbox, replyToId, text) {
  const order = [mailbox, ...mailboxes().filter((m) => m !== mailbox)].filter(Boolean);
  let last = null;
  for (const box of order) {
    try { await reply(box, replyToId, text); return box; } catch (e) {
      last = e;
      if (e.code !== 'FREDA_MAIL_404') throw e;
    }
  }
  throw last;
}

/** X-Freda-Signature = "sha256=" + HMAC-SHA256("<timestamp>.<raw body>", whsec_...). Rejects bad signatures and replays older than 5 minutes. */
function verifySignature(headers, rawBody, secretOrList) {
  // Each mailbox's webhook has its own secret: several can be given (separated by commas, spaces or new lines).
  const secrets = String(secretOrList || '').split(/[\s,;]+/).filter(Boolean);
  if (secrets.length > 1) return secrets.some((x) => verifySignature(headers, rawBody, x));
  const secret = secrets[0];
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

/**
 * The messages of a mailbox's inbox nobody answered, read or not: a thread is answered when the "sent" folder holds a message of the same thread
 * dated after it. Looks at the last `days` days (default 30, up to a year; at most 600 messages each way). Oldest first.
 */
async function unanswered(mailbox, days) {
  const since = Date.now() - Math.max(1, Math.min(365, days || 30)) * 86400000;
  const pull = async (folder) => {
    const out = []; let cursor = null;
    for (let page = 0; page < 12; page += 1) {
      const r = await listFolder(mailbox, folder, 50, cursor);
      out.push(...(r.messages || []));
      cursor = r.next_cursor;
      if (!cursor || (r.messages || []).length === 0 || new Date((r.messages[r.messages.length - 1] || {}).date || 0).getTime() < since) break;
    }
    return out.filter((m) => !m.date || new Date(m.date).getTime() >= since);
  };
  const [inbox, sent] = await Promise.all([pull('inbox'), pull('sent')]);
  const repliedAt = new Map();
  for (const m of sent) { const k = m.thread_id || m.in_reply_to; if (k) repliedAt.set(k, Math.max(repliedAt.get(k) || 0, new Date(m.date || 0).getTime())); }
  const boxes = mailboxes().map((m) => m.toLowerCase());
  return inbox
    .filter((m) => !boxes.includes(addr(m.from)) && !(m.thread_id && (repliedAt.get(m.thread_id) || 0) >= new Date(m.date || 0).getTime()))
    .sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0))
    .map((m) => ({ mailbox, id: m.id, thread_id: m.thread_id || null, from: addr(m.from), from_name: (m.from && m.from.name) || '', subject: m.subject || '(sans objet)', date: m.date, unread: !!m.unread }));
}

/** What the agent did with each message (for the admin and for the admin agent, who must report facts, not guesses). */
async function agentStateOf(fmId) {
  const row = await supabase.selectOne('admin_inbox', { message_id: `fm:${fmId}` });
  if (!row) return { state: 'pas encore importé' };
  const draft = await supabase.selectOne('agent_drafts', { inbox_id: row.id }).catch(() => null);
  const state = row.replied_at ? (draft && draft.sensitive ? `répondu (sujet sensible : ${draft.sensitive_reason || 'à suivre'} ; l'équipe a été prévenue pour la suite)` : 'répondu') : draft && draft.status === 'draft' ? (draft.sensitive ? `brouillon à approuver par un humain (sensible : ${draft.sensitive_reason || 'à valider'})` : 'brouillon à approuver') : draft && draft.status === 'rejected' ? 'brouillon rejeté par un admin' : row.agent_status === 'skipped' ? 'ignoré (message automatique ou robot)' : row.agent_status === 'error' ? `erreur de l'agent : ${row.agent_error || 'inconnue'}` : row.agent_status === 'processing' ? "en cours de traitement" : row.agent_status === 'done' ? 'traité' : "en attente de l'agent";
  return { state, inbox_id: row.id, agent_status: row.agent_status || null, category: row.agent_category || null, summary: row.agent_summary || null, draft_id: draft ? draft.id : null };
}

/**
 * Brings the unanswered messages into the admin inbox and runs the agent on each (it answers by itself when not sensitive, otherwise drafts), waiting
 * up to ~40 s so the answer says what really happened to EACH message: replied, draft to approve (and why), ignored (automatic mail), error (and the reason).
 */
async function answerPending({ mailbox, days, limit, wait } = {}) {
  await nameKeys();
  const boxes = mailbox ? [mailbox] : mailboxes();
  const result = { mailboxes: [], found: 0, started: 0, retried: 0, already_handled: 0, remaining: 0, details: [], errors: [] };
  const jobs = [];
  const emailAgent = require('./agent/emailAgent');
  for (const box of boxes) {
    try {
      const list = await unanswered(box, days || 30);
      result.found += list.length;
      let started = 0;
      for (const m of list) {
        if (jobs.length >= Math.min(30, limit || 20)) { result.remaining += 1; continue; } // the next call takes the following ones
        const known = await supabase.selectOne('admin_inbox', { message_id: `fm:${m.id}` });
        let rowId = known ? known.id : null;
        if (known) {
          // Already imported: run it again if the agent never finished it (error, never started, or stuck in "processing" for 15 minutes).
          const stuck = known.agent_status === 'processing' && Date.now() - new Date(known.received_at || 0).getTime() > 15 * 60 * 1000;
          if (!known.replied_at && (known.agent_status === 'error' || !known.agent_status || stuck)) {
            await supabase.update('admin_inbox', { id: known.id }, { agent_status: null, agent_error: null });
            result.retried += 1;
          } else { result.already_handled += 1; result.details.push({ mailbox: box, id: m.id, from: m.from, subject: m.subject, ...(await agentStateOf(m.id)) }); continue; }
        } else {
          const full = await readMessage(box, m.id);
          const row = await storeMessage(full.message || full, box);
          if (!row) continue;
          rowId = row.id;
        }
        started += 1;
        jobs.push({ box, m, rowId, promise: emailAgent.processInbox(rowId) });
      }
      result.started += started;
      result.mailboxes.push({ mailbox: box, unanswered: list.length, started });
    } catch (e) { result.errors.push(`${box} : ${e.message}`); }
  }
  const deadline = new Promise((r) => setTimeout(() => r('timeout'), wait || 40000));
  await Promise.race([Promise.allSettled(jobs.map((j) => j.promise)), deadline]);
  for (const j of jobs) result.details.push({ mailbox: j.box, id: j.m.id, from: j.m.from, subject: j.m.subject, ...(await agentStateOf(j.m.id)) });
  const count = (re) => result.details.filter((d) => re.test(d.state)).length;
  result.summary = `${result.found} email(s) sans réponse trouvé(s). Résultat : ${count(/^répondu/)} répondu(s) par l'agent, ${count(/^brouillon/)} brouillon(s) à approuver par un humain (page « Agent IA » > « Brouillons à approuver »), ${count(/^ignoré/)} ignoré(s) (messages automatiques), ${count(/^erreur/)} en erreur, ${count(/^(en cours|en attente)/)} encore en cours.${result.remaining ? ` Il en reste ${result.remaining} à traiter : relancez l'outil pour la suite.` : ''}${result.errors.length ? ` Erreurs : ${result.errors.join(' ; ')}` : ''}`;
  return result;
}

/** Safety net: the unread messages of every mailbox (last 3 days), whatever the webhook did or missed. */
async function pollUnread(limit) {
  let stored = 0; const errors = [];
  await nameKeys();
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

module.exports = { replyAnywhere, agentStateOf, unanswered, answerPending, listFolder, nameKeys, configured, mailboxes, keyFor, me, listUnread, readMessage, markRead, reply, verifySignature, storeMessage, pollUnread, fmError };
