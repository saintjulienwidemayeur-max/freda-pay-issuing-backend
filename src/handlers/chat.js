'use strict';
const crypto = require('crypto');
const supabase = require('../lib/supabase');

/**
 * Direct chat between a merchant (dashboard) and the team (admin panel). One conversation per merchant; every member of
 * the merchant account sees it. Messages are plain text (the pages render them with textContent).
 */
const MAX_BODY = 2000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const BUCKET = 'chat-attachments';
const PAGE = 200;

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}
const cleanBody = (b, hasAttachment) => {
  const body = String(b == null ? '' : b).replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim();
  if (!body && !hasAttachment) throw httpError(400, 'EMPTY_MESSAGE', 'Écrivez un message ou ajoutez une photo.');
  if (body.length > MAX_BODY) throw httpError(400, 'MESSAGE_TOO_LONG', `Message trop long (${MAX_BODY} caractères maximum).`);
  return body;
};
const view = (m, url) => ({ id: m.id, sender: m.sender, author_name: m.author_name || null, body: m.body, created_at: m.created_at, read: m.sender === 'merchant' ? !!m.read_by_admin : !!m.read_by_merchant,
  attachment: m.attachment_path ? { name: m.attachment_name || 'photo', type: m.attachment_type || 'image/jpeg', url: url || null } : null });

/** A photo sent with a message: a real PNG / JPEG / GIF / WebP (checked by its first bytes, not by what the client claims), 5 MB at most. */
function readImage(att) {
  if (att == null) return null;
  if (typeof att !== 'object' || typeof att.data !== 'string') throw httpError(400, 'INVALID_ATTACHMENT', 'Photo invalide.');
  const buf = Buffer.from(att.data.replace(/^data:[^,]*,/, ''), 'base64');
  if (!buf.length) throw httpError(400, 'INVALID_ATTACHMENT', 'Photo vide.');
  if (buf.length > MAX_IMAGE_BYTES) throw httpError(413, 'ATTACHMENT_TOO_LARGE', 'La photo est trop lourde (5 Mo maximum).');
  let type = null;
  if (buf[0] === 0x89 && buf.slice(1, 4).toString() === 'PNG') type = 'image/png';
  else if (buf[0] === 0xff && buf[1] === 0xd8) type = 'image/jpeg';
  else if (buf.slice(0, 3).toString() === 'GIF') type = 'image/gif';
  else if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') type = 'image/webp';
  if (!type) throw httpError(400, 'INVALID_ATTACHMENT', 'Seules les photos PNG, JPEG, GIF ou WebP sont acceptées.');
  const name = String(att.name || 'photo').replace(/[^\w.\- ]/g, '_').slice(0, 80);
  return { buf, type, name };
}
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
async function storeImage(merchantId, msgId, img) {
  const path = `${merchantId}/${msgId}.${EXT[img.type]}`;
  await supabase.uploadFile(BUCKET, path, img.buf, img.type);
  return path;
}
/** Messages as the pages see them, with a short-lived link for each photo (the 40 newest). */
async function withUrls(messages) {
  const withPhoto = messages.filter((m) => m.attachment_path).slice(-40);
  const urls = new Map();
  await Promise.all(withPhoto.map(async (m) => { try { urls.set(m.id, await supabase.signedUrl(BUCKET, m.attachment_path, 600)); } catch (e) { /* the message still shows, without the picture */ } }));
  return messages.map((m) => view(m, urls.get(m.id)));
}

async function thread(merchantId) {
  const rows = await supabase.select('chat_messages', { merchant_id: merchantId }, { order: 'created_at.desc', limit: PAGE });
  return rows.reverse();
}
async function unreadForMerchant(merchantId) {
  const rows = await supabase.select('chat_messages', { merchant_id: merchantId, sender: 'admin', read_by_merchant: false }, { select: 'id', limit: 500 });
  return rows.length;
}

// ------------------------------------------------------------ merchant (dashboard)
async function merchantList(ctx) {
  const messages = await thread(ctx.merchantId);
  return { status: 200, body: { messages: await withUrls(messages), unread: messages.filter((m) => m.sender === 'admin' && !m.read_by_merchant).length } };
}
async function merchantUnread(ctx) {
  return { status: 200, body: { unread: await unreadForMerchant(ctx.merchantId) } };
}
async function merchantRead(ctx) {
  await supabase.update('chat_messages', { merchant_id: ctx.merchantId, sender: 'admin', read_by_merchant: false }, { read_by_merchant: true });
  return { status: 200, body: { unread: 0 } };
}
async function merchantSend(ctx) {
  const img = readImage(ctx.body && ctx.body.attachment);
  const body = cleanBody(ctx.body && ctx.body.body, !!img);
  const member = ctx.userId ? await supabase.selectOne('team_members', { id: ctx.userId }).catch(() => null) : null;
  const merchant = await supabase.selectOne('merchants', { id: ctx.merchantId });
  const author = (member && (member.name || member.email)) || (merchant && (merchant.business_name || merchant.email)) || 'Marchand';
  const id = `msg_${crypto.randomBytes(8).toString('hex')}`;
  const att = img ? { attachment_path: await storeImage(ctx.merchantId, id, img), attachment_name: img.name, attachment_type: img.type } : {};
  const row = await supabase.insert('chat_messages', Object.assign({
    id, merchant_id: ctx.merchantId, sender: 'merchant', author_name: String(author).slice(0, 120),
    body, read_by_merchant: true, read_by_admin: false,
  }, att));
  require('../services/adminAlerts').chatMessage({ merchantId: ctx.merchantId, merchantName: author, body, hasPhoto: !!img });
  return { status: 201, body: { message: (await withUrls([row]))[0] } };
}

// ------------------------------------------------------------ admin
async function adminConversations() {
  const recent = await supabase.select('chat_messages', {}, { order: 'created_at.desc', limit: 1000 });
  const unreadRows = await supabase.select('chat_messages', { sender: 'merchant', read_by_admin: false }, { select: 'merchant_id', limit: 2000 });
  const unread = {};
  for (const r of unreadRows) unread[r.merchant_id] = (unread[r.merchant_id] || 0) + 1;
  const byMerchant = new Map();
  for (const m of recent) if (!byMerchant.has(m.merchant_id)) byMerchant.set(m.merchant_id, m);
  const ids = [...byMerchant.keys()];
  const names = {};
  if (ids.length) {
    const ms = await supabase.select('merchants', { id: supabase.inList(ids) }, { select: 'id,business_name,email', limit: 500 });
    for (const m of ms) names[m.id] = m;
  }
  const conversations = ids.map((id) => {
    const last = byMerchant.get(id);
    return { merchant_id: id, business_name: (names[id] && names[id].business_name) || null, email: (names[id] && names[id].email) || null, unread: unread[id] || 0, last_message: { sender: last.sender, body: String(last.body || (last.attachment_path ? 'Photo' : '')).slice(0, 140), created_at: last.created_at } };
  }).sort((a, b) => (b.unread > 0) - (a.unread > 0) || String(b.last_message.created_at).localeCompare(String(a.last_message.created_at)));
  return { status: 200, body: { conversations, unread_total: Object.values(unread).reduce((a, b) => a + b, 0) } };
}
async function adminUnread() {
  const rows = await supabase.select('chat_messages', { sender: 'merchant', read_by_admin: false }, { select: 'id', limit: 2000 });
  return { status: 200, body: { unread: rows.length } };
}
async function merchantOf(id) {
  const m = await supabase.selectOne('merchants', { id: String(id) });
  if (!m) throw httpError(404, 'MERCHANT_NOT_FOUND', 'Marchand introuvable.');
  return m;
}
async function adminThread(ctx) {
  const m = await merchantOf(ctx.params.merchantId);
  const messages = await thread(m.id);
  await supabase.update('chat_messages', { merchant_id: m.id, sender: 'merchant', read_by_admin: false }, { read_by_admin: true });
  return { status: 200, body: { merchant: { id: m.id, business_name: m.business_name, email: m.email }, messages: (await withUrls(messages)).map((x) => Object.assign(x, { read: x.sender === 'merchant' ? true : x.read })) } };
}
async function adminSend(ctx) {
  const m = await merchantOf(ctx.params.merchantId);
  const img = readImage(ctx.body && ctx.body.attachment);
  const body = cleanBody(ctx.body && ctx.body.body, !!img);
  const id = `msg_${crypto.randomBytes(8).toString('hex')}`;
  const att = img ? { attachment_path: await storeImage(m.id, id, img), attachment_name: img.name, attachment_type: img.type } : {};
  const row = await supabase.insert('chat_messages', Object.assign({
    id, merchant_id: m.id, sender: 'admin', author_name: String((ctx.admin && ctx.admin.name) || 'Support Freda Pay Issuing').slice(0, 120),
    body, read_by_merchant: false, read_by_admin: true,
  }, att));
  return { status: 201, body: { message: (await withUrls([row]))[0] } };
}

/** Used by the integration health view: the team writes to a merchant from outside the chat page. */
async function postAdminMessage({ merchantId, body, adminName }) {
  const id = `msg_${crypto.randomBytes(8).toString('hex')}`;
  const row = await supabase.insert('chat_messages', {
    id, merchant_id: merchantId, sender: 'admin', author_name: String(adminName || 'Support Freda Pay Issuing').slice(0, 120),
    body: cleanBody(body, false), read_by_merchant: false, read_by_admin: true,
  });
  return view(row);
}

module.exports = { postAdminMessage, merchantList, merchantUnread, merchantRead, merchantSend, adminConversations, adminUnread, adminThread, adminSend };
