'use strict';
/**
 * One-off announcement to every merchant: the new card program and its price grid, by email AND as a message in the dashboard chat.
 *
 * Safe by design:
 *  - It sends nothing until an owner ARMS it in the admin panel (one click, after seeing the recipient count).
 *  - Once armed it survives restarts: every merchant's delivery is a row (campaign + merchant), claimed before sending, so a restart,
 *    a crash or two server instances never send the same email twice, and an interrupted run resumes where it stopped.
 *  - A failed delivery is retried a few times, then left for the admin to see.
 */
const supabase = require('../lib/supabase');
const KEY = 'announcement:new-card-program';
const CAMPAIGN = 'new-card-program-2026-11';
const MAX_ATTEMPTS = 3;
const STALE_MS = 10 * 60 * 1000;
const SUBJECT = 'Nouveau programme de cartes Freda Pay Issuing : Apple Pay, Google Pay et nouvelle grille tarifaire';

function message({ liveOpen }) {
  const live = liveOpen
    ? "- L'entrée est ouverte aussi en Live : 20 $, une seule fois, prélevés sur votre Master Wallet Live."
    : "- L'entrée en Live ouvrira prochainement, nous vous préviendrons. En mode test (Sandbox), vous pouvez rejoindre le programme dès maintenant, gratuitement.";
  return `Nous lançons un nouveau programme de cartes virtuelles Visa et Mastercard sur Freda Pay Issuing, avec une nouvelle grille tarifaire.

CE QUI CHANGE
- Cartes tokenisées, compatibles Apple Pay et Google Pay : vos titulaires paient sans contact et en ligne depuis leur téléphone.
- Plafonds de dépense appliqués au moment du paiement (par jour ou par achat), que vous fixez vous-même à la création de la carte.
- Cartes à usage unique, pour un seul achat.
- La même API et les mêmes webhooks qu'aujourd'hui.

CE QUI NE CHANGE PAS
- Vos cartes déjà créées restent à leurs prix actuels (recharge, retrait, etc.).
- Vos prix actuels restent valables tant que vous ne rejoignez pas le nouveau programme.
- Vos cartes entreprise ne changent pas.
- Vous gardez votre plan actuel (Startup, Pro ou Premium) et son abonnement.

LA NOUVELLE GRILLE (cartes du nouveau programme)

| | Startup | Pro | Premium |
|---|---|---|---|
| Abonnement mensuel | 0,00 $ | 150,00 $ / mois | 500,00 $ / mois |
| Création d'une carte | 3,00 $ | 2,00 $ | 50 cartes gratuites par mois, puis 2,50 $ |
| Recharge d'une carte | 1,00 $ | 0,50 $ | 1,10 $ |
| Dépôt de fonds sur le MasterWallet | 4,0 % | 2,7 % | 2,5 % |
| Retrait de fonds depuis une carte | 3,0 % | 2,0 % | 1,5 % |
| Commission sur achats réussis (prélevée sur le MasterWallet) | 1,0 % | Gratuit | Gratuit |
| Transactions internationales (prélevées sur la carte) | 2,30 % + 0,50 $ | 2,30 % + 0,50 $ | 2,30 % + 0,50 $ |
| Maintenance mensuelle par carte active (prélevée sur la carte) | 0,50 $ | 0,50 $ | Gratuit |
| Autorisation refusée ou non réglée (prélevée sur la carte) | 0,50 $ | 0,50 $ | 0,50 $ |

COMMENT REJOINDRE
- Depuis votre tableau de bord : cliquez sur le bandeau « Nouveau programme de cartes », puis « Rejoindre ».
${live}
- Une fois dans le programme, chaque recharge de votre Master Wallet doit être d'au moins 200 $.
- Vos nouvelles cartes individuelles sont alors émises dans le programme, aux prix de votre plan.

POUR VOTRE INTÉGRATION
- Titulaires : 18 ans ou plus, recto et verso de la pièce d'identité (sauf passeport).
- Nouvelles options à la création : spending_limit et single_use.
- Détails : https://issuing.fredapay.com/docs/nouveau-programme-cartes
- Tarifs complets : https://issuing.fredapay.com/tarifs

Une question ? Répondez à cet email ou écrivez-nous à issuing@fredapay.com.

Cordialement,

Saint-Julien Widemayeur
Fondateur et CEO, Freda Pay LLC
Freda Pay Issuing`;
}

/** The same news, short and in plain text (the dashboard chat shows text only, 2000 characters at most). */
function chatText(name, { liveOpen }) {
  return `Bonjour${name ? ' ' + name : ''},

Nouveau programme de cartes Freda Pay Issuing : cartes compatibles Apple Pay et Google Pay, plafonds de dépense (spending_limit), cartes à usage unique (single_use), même API et mêmes webhooks.

Vos cartes actuelles et vos prix actuels ne changent pas. Pour rejoindre le programme : bandeau « Nouveau programme de cartes » de votre tableau de bord. ${liveOpen ? "Entrée : 20 $ une seule fois (Master Wallet Live), gratuit en Sandbox." : "L'entrée en Live ouvrira prochainement ; elle est gratuite dès maintenant en Sandbox."} Vous gardez votre plan (Startup, Pro ou Premium) ; chaque recharge du Master Wallet est d'au moins 200 $.

Création de carte : 3 $ (Startup) · 2 $ (Pro) · 50 gratuites/mois puis 2,50 $ (Premium)
Recharge de carte : 1 $ · 0,50 $ · 1,10 $
Dépôt sur le MasterWallet : 4 % · 2,7 % · 2,5 %
Retrait depuis une carte : 3 % · 2 % · 1,5 %
Achats réussis : 1 % (Startup, sur le MasterWallet) · gratuit · gratuit

La grille complète vous a été envoyée par email. Détails : https://issuing.fredapay.com/docs/nouveau-programme-cartes`;
}

async function state() {
  const row = await supabase.selectOne('platform_settings', { key: KEY }).catch(() => null);
  try { return row ? JSON.parse(row.value) || {} : {}; } catch (e) { return {}; }
}
async function saveState(patch) {
  const next = Object.assign(await state(), patch);
  const row = { value: JSON.stringify(next), updated_at: new Date().toISOString() };
  if (await supabase.selectOne('platform_settings', { key: KEY })) await supabase.update('platform_settings', { key: KEY }, row);
  else await supabase.insert('platform_settings', Object.assign({ key: KEY }, row));
  return next;
}

const recipients = () => require('../handlers/adminMessages').recipientsFor('all');
const liveOpen = () => require('./cardProgram').openFor('live').catch(() => false);

async function deliveries() {
  try { return await supabase.select('announcement_deliveries', { campaign: CAMPAIGN }, { limit: 20000 }); } catch (e) { return null; } // null: table missing (migration not run)
}

async function status() {
  const [st, list, rows] = await Promise.all([state(), recipients(), deliveries()]);
  const byMerchant = new Map((rows || []).map((r) => [r.merchant_id, r]));
  const done = list.filter((m) => { const r = byMerchant.get(m.id); return r && r.email_sent_at && r.chat_sent_at; }).length;
  const failed = list.filter((m) => { const r = byMerchant.get(m.id); return r && Number(r.attempts || 0) >= MAX_ATTEMPTS && !(r.email_sent_at && r.chat_sent_at); });
  return {
    campaign: CAMPAIGN, subject: SUBJECT, armed: !!st.armed, armed_at: st.armed_at || null, armed_by: st.armed_by || null, finished_at: st.finished_at || null,
    recipients: list.length, delivered: done, failed: failed.length, failed_list: failed.slice(0, 20).map((m) => ({ id: m.id, email: m.email, error: (byMerchant.get(m.id) || {}).error || null })),
    table_ready: rows !== null, live_open: await liveOpen(),
  };
}

/** Arms the campaign: from now on the server sends it (and resumes after any restart) until everybody has it. */
async function arm(adminEmail, expectedCount) {
  const rows = await deliveries();
  if (rows === null) throw Object.assign(new Error("La table announcement_deliveries n'existe pas : exécutez d'abord la migration 2026-11-18-announcement."), { httpStatus: 409, code: 'MIGRATION_REQUIRED' });
  const list = await recipients();
  if (expectedCount !== undefined && Number(expectedCount) !== list.length) throw Object.assign(new Error(`Le nombre de destinataires a changé (${list.length} au lieu de ${Number(expectedCount)}). Rien n'est programmé : vérifiez et recommencez.`), { httpStatus: 409, code: 'RECIPIENTS_CHANGED' });
  await saveState({ armed: true, armed_at: new Date().toISOString(), armed_by: adminEmail || null, finished_at: null });
  setTimeout(() => run().catch((e) => console.error('Announcement:', e.message)), 500).unref(); // eslint-disable-line no-console
  return status();
}
async function disarm() { await saveState({ armed: false }); return status(); }

let running = false;
/** One pass: every merchant that does not have it yet gets the email and the chat message. Safe to call at any time, from any instance. */
async function run() {
  if (running) return { skipped: 'busy' };
  running = true;
  try {
    const st = await state();
    if (!st.armed || st.finished_at) return { skipped: 'not-armed' };
    const rows = await deliveries();
    if (rows === null) return { skipped: 'no-table' };
    const open = await liveOpen();
    const byMerchant = new Map(rows.map((r) => [r.merchant_id, r]));
    const list = await recipients();
    const adminMessages = require('../handlers/adminMessages');
    let sent = 0; let pending = 0;
    for (const m of list) {
      let row = byMerchant.get(m.id);
      const complete = row && row.email_sent_at && row.chat_sent_at;
      if (complete) continue;
      if (row && Number(row.attempts || 0) >= MAX_ATTEMPTS) continue;
      if (row && Date.now() - new Date(row.updated_at || 0).getTime() < STALE_MS && !row.error) { pending += 1; continue; } // another instance is on it
      const now = new Date().toISOString();
      if (!row) {
        try { row = await supabase.insert('announcement_deliveries', { campaign: CAMPAIGN, merchant_id: m.id, attempts: 1, updated_at: now }); } catch (e) { pending += 1; continue; } // someone else claimed it
      } else {
        const claimed = await supabase.update('announcement_deliveries', { campaign: CAMPAIGN, merchant_id: m.id, updated_at: row.updated_at }, { attempts: Number(row.attempts || 0) + 1, error: null, updated_at: now }).catch(() => []);
        if (!claimed || !claimed.length) { pending += 1; continue; }
        row = claimed[0];
      }
      const patch = {};
      try {
        if (!row.email_sent_at) { await adminMessages.sendOne(m, SUBJECT, message({ liveOpen: open })); patch.email_sent_at = new Date().toISOString(); }
        if (!row.chat_sent_at) {
          await supabase.insert('chat_messages', { id: `msg_${require('crypto').randomBytes(8).toString('hex')}`, merchant_id: m.id, sender: 'admin', author_name: 'Freda Pay Issuing', by_agent: true, body: chatText(m.business_name, { liveOpen: open }).slice(0, 2000), read_by_merchant: false, read_by_admin: true });
          patch.chat_sent_at = new Date().toISOString();
        }
        sent += 1;
      } catch (err) { patch.error = String(err.message || err).slice(0, 300); }
      patch.updated_at = new Date().toISOString();
      await supabase.update('announcement_deliveries', { campaign: CAMPAIGN, merchant_id: m.id }, patch).catch(() => {});
    }
    const left = list.filter((m) => { const r = byMerchant.get(m.id); return !(r && r.email_sent_at && r.chat_sent_at); }).length;
    if (!pending && sent >= 0) {
      const after = await deliveries();
      const map = new Map((after || []).map((r) => [r.merchant_id, r]));
      const unfinished = list.filter((m) => { const r = map.get(m.id); return !(r && r.email_sent_at && r.chat_sent_at) && !(r && Number(r.attempts || 0) >= MAX_ATTEMPTS); });
      if (!unfinished.length) await saveState({ finished_at: new Date().toISOString() });
    }
    return { sent, left };
  } finally { running = false; }
}

/** Called once the server is up and then every few minutes: resumes an armed campaign after a restart. */
function start() {
  const tick = () => run().catch((e) => console.error('Announcement:', e.message)); // eslint-disable-line no-console
  setTimeout(tick, 30 * 1000).unref();
  setInterval(tick, 5 * 60 * 1000).unref();
}

/** A copy to the admin who asks, to proof-read. Nothing else is sent. */
async function sendTest(email) {
  if (!email) throw Object.assign(new Error("Votre compte admin n'a pas d'adresse email."), { httpStatus: 400, code: 'NO_EMAIL' });
  const res = await require('../handlers/adminMessages').sendOne({ email, business_name: 'Test' }, SUBJECT, message({ liveOpen: await liveOpen() }));
  const brevo = require('./brevo');
  return { sent: 1, to: email, from: (res && res._from) || require('../config').brevo.adminSenderEmail, fallback: !!(res && res._fallback), delivery: await brevo.deliveryStatus(res && res.messageId, { waitMs: 8000 }) };
}

module.exports = { status, arm, disarm, run, start, sendTest, message, chatText, SUBJECT, CAMPAIGN };
