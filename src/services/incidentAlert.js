'use strict';
/**
 * Incident alert to the merchants that issue cards in Live: an email AND a message in their dashboard chat, sent now.
 * Used from the admin panel and by the admin assistant (when an admin asks it to). Guarded: staff only, one send per kind every 30 minutes,
 * every send is written to the messages history.
 */
const supabase = require('../lib/supabase');
const crypto = require('crypto');
const KEY = 'incident_alert_last';
const MIN_GAP_MS = 30 * 60 * 1000;

const TEMPLATES = {
  cards_outage: {
    subject: "Incident en cours sur les cartes : résolution en moins d'1 heure",
    message: `Nous rencontrons actuellement une panne qui touche l'émission de cartes.

CE QUI EST AFFECTÉ
- La création de nouvelles cartes.
- La recharge des cartes.

CE QUI FONCTIONNE NORMALEMENT
- Toutes les autres opérations de la plateforme.

NOTRE ÉQUIPE EST SUR LE PROBLÈME
Résolution attendue en moins d'une heure. Nous vous écrirons dès que tout est rétabli. Inutile de répéter vos tentatives en boucle : elles échoueront jusqu'à la résolution.

Nous sommes désolés pour la gêne.`,
    chat: "Incident en cours : la création de nouvelles cartes et la recharge des cartes sont momentanément indisponibles. Toutes les autres opérations fonctionnent normalement. Notre équipe est sur le problème, résolution attendue en moins d'une heure. Nous vous écrirons dès que tout est rétabli. Désolé pour la gêne.",
  },
  cards_resolved: {
    subject: "Rétabli : la création et la recharge de cartes fonctionnent à nouveau",
    message: `L'incident sur les cartes est résolu : la création de nouvelles cartes et la recharge des cartes fonctionnent à nouveau normalement.

Merci de votre patience. Si une opération a échoué pendant l'incident, vous pouvez la refaire maintenant. En cas de doute sur un montant, répondez à cet email.`,
    chat: "C'est rétabli : la création de nouvelles cartes et la recharge des cartes fonctionnent à nouveau. Merci de votre patience. Si une opération a échoué pendant l'incident, vous pouvez la refaire maintenant.",
  },
};

function httpError(status, code, message) { const e = new Error(message); e.httpStatus = status; e.code = code; return e; }

/** Live merchants that issue cards: verified email, not deleted. */
async function audience() {
  const rows = await supabase.select('merchants', { deleted_at: supabase.isNull(), email_verified: true, issuing_live_enabled: true }, { order: 'created_at.desc', limit: 5000 });
  return rows.filter((m) => m.email);
}

async function lastSend() {
  const row = await supabase.selectOne('platform_settings', { key: KEY }).catch(() => null);
  try { return row ? JSON.parse(row.value) || {} : {}; } catch (e) { return {}; }
}
async function markSent(kind) {
  const last = Object.assign(await lastSend(), { [kind]: new Date().toISOString() });
  const row = { value: JSON.stringify(last), updated_at: new Date().toISOString() };
  if (await supabase.selectOne('platform_settings', { key: KEY })) await supabase.update('platform_settings', { key: KEY }, row);
  else await supabase.insert('platform_settings', Object.assign({ key: KEY }, row));
}

let sending = false;
/**
 * kind: cards_outage | cards_resolved. message (optional, 600 characters at most) replaces the email text and the chat text.
 * confirm !== true: nothing is sent, the audience and the text are returned (preview).
 */
async function send({ kind, message, confirm, adminEmail, adminId }) {
  const tpl = TEMPLATES[kind];
  if (!tpl) throw httpError(400, 'INVALID_KIND', 'Type invalide : cards_outage ou cards_resolved.');
  const custom = message ? String(message).trim().slice(0, 600) : '';
  const body = custom || tpl.message;
  const chatText = custom || tpl.chat;
  const list = await audience();
  if (confirm !== true) return { sent: false, preview: true, kind, recipients: list.length, subject: tpl.subject, message: body };
  if (!list.length) throw httpError(400, 'NO_RECIPIENTS', 'Aucun marchand Live qui émet des cartes.');
  const last = (await lastSend())[kind];
  if (last && Date.now() - new Date(last).getTime() < MIN_GAP_MS) throw httpError(429, 'ALREADY_SENT_RECENTLY', `Cette alerte a déjà été envoyée il y a moins de 30 minutes (${new Date(last).toISOString()}). Rien n'a été renvoyé.`);
  if (sending) throw httpError(409, 'SEND_IN_PROGRESS', 'Un envoi est déjà en cours.');
  sending = true;
  try {
    await markSent(kind); // claimed before sending: a second call cannot double it
    const adminMessages = require('../handlers/adminMessages');
    let emailed = 0; let chatted = 0; let failed = 0;
    for (let i = 0; i < list.length; i += 5) {
      const batch = list.slice(i, i + 5);
      await Promise.all(batch.map(async (m) => {
        try { await adminMessages.sendOne(m, tpl.subject, body); emailed += 1; } catch (e) { failed += 1; }
        try {
          await supabase.insert('chat_messages', { id: `msg_${crypto.randomBytes(8).toString('hex')}`, merchant_id: m.id, sender: 'admin', author_name: 'Freda Pay Issuing', by_agent: false, body: chatText.slice(0, 2000), read_by_merchant: false, read_by_admin: true });
          chatted += 1;
        } catch (e) { /* the email is the main channel */ }
      }));
    }
    await supabase.insert('admin_messages', { id: `msg_${crypto.randomBytes(8).toString('hex')}`, sent_by: adminId || null, sent_by_email: adminEmail || null, audience: 'live', merchant_id: null, subject: tpl.subject, body, recipients: list.length, sent: emailed, failed }).catch(() => {});
    return { sent: true, kind, recipients: list.length, emailed, chat_messages: chatted, failed };
  } finally { sending = false; }
}

module.exports = { send, audience, TEMPLATES };
