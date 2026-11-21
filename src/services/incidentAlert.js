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
  webhooks_news: {
    audience: 'webhooks',
    subject: 'Nouveaux événements webhook pour les cartes : holder.verified et holder.rejected',
    message: `Deux nouveaux événements webhook sont disponibles pour vos titulaires de cartes. Vous n'avez rien à modifier : votre intégration continue de fonctionner comme avant.

CE QUI EST NOUVEAU
- holder.verified : un titulaire est accepté par le nouveau programme de cartes ; ses prochaines cartes y sont créées.
- holder.rejected : un titulaire n'est pas accepté. data.reason donne la raison quand elle est connue ; ses cartes restent chez notre banque partenaire actuelle. Renvoyez sa pièce d'identité (recto et verso) pour réessayer.

CE QUE VOUS DEVEZ FAIRE
- Rien d'obligatoire.
- Si votre endpoint webhook renvoie une erreur quand il reçoit un événement qu'il ne connaît pas, faites-le plutôt ignorer cet événement et répondre 200.

Détails : https://issuing.fredapay.com/docs/webhooks`,
    chat: "Nouveau côté webhooks : deux événements pour vos titulaires de cartes, holder.verified (titulaire accepté par le nouveau programme de cartes) et holder.rejected (refusé, avec la raison dans data.reason ; ses cartes restent chez notre banque partenaire actuelle, renvoyez sa pièce d'identité recto et verso pour réessayer). Rien à modifier chez vous. Si votre endpoint renvoie une erreur sur un événement inconnu, faites-le répondre 200 et l'ignorer. Détails : https://issuing.fredapay.com/docs/webhooks",
  },
  cards_resolved: {
    subject: "Rétabli : la création et la recharge de cartes fonctionnent à nouveau",
    message: `L'incident sur les cartes est résolu : la création de nouvelles cartes et la recharge des cartes fonctionnent à nouveau normalement.

Merci de votre patience. Si une opération a échoué pendant l'incident, vous pouvez la refaire maintenant. En cas de doute sur un montant, répondez à cet email.`,
    chat: "C'est rétabli : la création de nouvelles cartes et la recharge des cartes fonctionnent à nouveau. Merci de votre patience. Si une opération a échoué pendant l'incident, vous pouvez la refaire maintenant.",
  },
};

/** The dashboard banner that goes with the alert (what every merchant sees at the top of its dashboard). */
const BANNERS = {
  cards_outage: { tone: 'warning', message: "Incident en cours : la création de nouvelles cartes et la recharge des cartes sont momentanément indisponibles. Toutes les autres opérations fonctionnent normalement. Nous travaillons à le résoudre en moins d'une heure." },
  cards_resolved: { restore: true },
};

function httpError(status, code, message) { const e = new Error(message); e.httpStatus = status; e.code = code; return e; }

/** Live merchants that issue cards: verified email, not deleted. kind 'webhooks': only those that registered an active webhook. */
async function audience(kind) {
  const rows = await supabase.select('merchants', { deleted_at: supabase.isNull(), email_verified: true, issuing_live_enabled: true }, { order: 'created_at.desc', limit: 5000 });
  const list = rows.filter((m) => m.email);
  if (!TEMPLATES[kind] || TEMPLATES[kind].audience !== 'webhooks') return list;
  const hooks = await supabase.select('webhook_endpoints', { active: true }, { limit: 20000 }).catch(() => []);
  const withHook = new Set(hooks.map((h) => h.merchant_id));
  return list.filter((m) => withHook.has(m.id));
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
async function send({ kind, message, confirm, banner, adminEmail, adminId }) {
  const tpl = TEMPLATES[kind];
  if (!tpl) throw httpError(400, 'INVALID_KIND', 'Type invalide : cards_outage, cards_resolved ou webhooks_news.');
  const custom = message ? String(message).trim().slice(0, 600) : '';
  const body = custom || tpl.message;
  const chatText = custom || tpl.chat;
  const list = await audience(kind);
  if (confirm !== true) return { sent: false, preview: true, kind, recipients: list.length, subject: tpl.subject, message: body };
  if (!list.length) throw httpError(400, 'NO_RECIPIENTS', 'Aucun marchand Live concerné.');
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
    // The dashboard banner (outage: shown; resolved: back to the usual one). banner: false to leave the banner alone.
    let bannerSet = false;
    if (banner !== false && BANNERS[kind]) {
      const notice = require('./notice');
      try {
        if (BANNERS[kind].restore) await notice.save({ enabled: true, tone: notice.DEFAULT.tone, message: notice.DEFAULT.message }, adminEmail);
        else await notice.save({ enabled: true, tone: BANNERS[kind].tone, message: custom ? custom.slice(0, 400) : BANNERS[kind].message }, adminEmail);
        bannerSet = true;
      } catch (e) { /* the emails and chat messages went out; the banner can be set from Paramètres */ }
    }
    await supabase.insert('admin_messages', { id: `msg_${crypto.randomBytes(8).toString('hex')}`, sent_by: adminId || null, sent_by_email: adminEmail || null, audience: 'live', merchant_id: null, subject: tpl.subject, body, recipients: list.length, sent: emailed, failed }).catch(() => {});
    return { sent: true, kind, recipients: list.length, emailed, chat_messages: chatted, failed, banner: bannerSet };
  } finally { sending = false; }
}

module.exports = { send, audience, TEMPLATES };
