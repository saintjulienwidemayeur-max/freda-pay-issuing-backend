'use strict';
const config = require('../config');
const supabase = require('../lib/supabase');
const brevo = require('./brevo');
const { buildEmail } = require('../templates/notificationEmail');

/**
 * Email alerts to the team (owners and admins; or the addresses in ADMIN_ALERT_EMAILS, comma separated). Every alert has a
 * key and is sent at most once per throttle window, so a runaway client or a chatty merchant never floods the inbox.
 * A mail problem is logged and never breaks the action that triggered the alert.
 */
const lastSent = new Map();

async function recipients() {
  const fromEnv = String(process.env.ADMIN_ALERT_EMAILS || '').split(',').map((e) => e.trim()).filter(Boolean);
  if (fromEnv.length) return fromEnv.map((email) => ({ email, name: 'Équipe Freda Pay Issuing' }));
  const rows = await supabase.select('admin_users', { role: supabase.inList(['owner', 'admin']) }, { select: 'email,name,role', limit: 50 });
  return rows.map((r) => ({ email: r.email, name: r.name }));
}

/** Sends one alert unless one with the same key went out less than `throttleMs` ago. Returns true when it was sent. */
async function alert({ key, throttleMs, subject, eyebrow, heading, paragraphs, tone }) {
  const now = Date.now();
  if (lastSent.has(key) && now - lastSent.get(key) < throttleMs) return false;
  lastSent.set(key, now);
  try {
    const to = await recipients();
    if (!to.length) return false;
    const built = buildEmail({ subject, eyebrow: eyebrow || 'Alerte', heading, paragraphs, tone: tone || 'info' });
    for (const r of to) {
      await brevo.sendEmail({ to: r.email, toName: r.name, subject: built.subject, html: built.html, text: built.text, senderEmail: config.brevo.adminSenderEmail, senderName: config.brevo.adminSenderName });
    }
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Admin alert "${key}" failed:`, err.message);
    return false;
  }
}

/** A merchant is hammering the API: many requests refused by the rate limit, or mostly failing. */
function apiAbuse({ merchantId, merchantName, limited, requests, errors, topCodes }) {
  const codes = (topCodes || []).map((c) => `${c.code} (${c.count})`).join(', ');
  return alert({
    key: `api-abuse:${merchantId}`, throttleMs: 30 * 60 * 1000, tone: 'warning',
    subject: `Alerte API : ${merchantName} dépasse la limite de requêtes`,
    eyebrow: 'Alerte API', heading: 'Un marchand sature l\'API',
    paragraphs: [
      `**${merchantName}** a envoyé **${requests}** requêtes en 5 minutes : **${limited}** ont été refusées (limite de ${require('../router').API_RATE_LIMIT} par minute), ${errors} autres ont échoué.`,
      codes ? `Erreurs principales : ${codes}.` : 'Aucune autre erreur notable.',
      'Ouvrez le panneau admin, rubrique « Trafic API », pour voir le détail, lui écrire dans le chat ou bloquer son accès API.',
    ],
  });
}

/** A MonCash / Natcash payment has been pending for a while and the partner's answer is not the normal "waiting for the customer". */
function paymentStuck({ payment, heard, ageMin, label }) {
  return alert({
    key: `payment-stuck:${payment.id}`, throttleMs: 6 * 3600 * 1000, tone: 'warning',
    subject: `Alerte paiement : ${payment.method} en attente depuis ${ageMin} min`,
    eyebrow: 'Alerte paiement', heading: 'Un paiement reste en attente',
    paragraphs: [
      `Le paiement **${payment.id}** (${payment.method}, ${payment.amount} ${payment.currency}, ${payment.mode === 'live' ? 'Live' : 'Sandbox'}) est en attente depuis **${ageMin} minutes**.`,
      `Ce que le partenaire répond : **${label}**${heard && heard.message ? ` (« ${String(heard.message).slice(0, 160)} »)` : ''}${heard && heard.trans_status ? `, statut « ${heard.trans_status} »` : ''}.`,
      'Ouvrez le panneau admin, rubrique « Erreurs cartes », bloc « Diagnostic des paiements » : vous pouvez vérifier ce paiement et relancer sa confirmation.',
    ],
  });
}

/** The card partner closed a card on its own. */
function cardClosedByPartner({ card, reason, balance }) {
  return alert({
    key: `card-closed:${card.id}`, throttleMs: 24 * 3600 * 1000, tone: 'warning',
    subject: 'Alerte carte : une carte a été fermée par le fournisseur',
    eyebrow: 'Alerte carte', heading: 'Une carte a été fermée',
    paragraphs: [
      `La carte **${card.own_reference}** (${card.kind === 'business' ? 'entreprise' : 'individuelle'}, ${card.mode === 'live' ? 'Live' : 'Sandbox'}) a été fermée par le fournisseur${reason ? ` : « ${reason} »` : ''}.`,
      `Solde affiché chez nous avant la fermeture : **${Number(balance || 0).toFixed(2)} $**. Il n'a pas été rendu automatiquement au Master Wallet : vérifiez avec le fournisseur où cet argent est allé.`,
    ],
  });
}

/** A card has been "pending" for over 30 minutes and the partner cannot be asked about it, or does not know it. */
function cardCreationStuck({ card, why }) {
  return alert({
    key: `card-stuck:${card.id}`, throttleMs: 6 * 3600 * 1000, tone: 'warning',
    subject: 'Alerte carte : une création de carte reste en attente',
    eyebrow: 'Alerte carte', heading: 'Une carte reste en attente',
    paragraphs: [
      `La carte **${card.own_reference}** (${card.mode === 'live' ? 'Live' : 'Sandbox'}) est en attente depuis plus de 30 minutes : le fournisseur n'a pas confirmé sa création.`,
      `Réponse du fournisseur quand nous l'interrogeons : « ${String(why || '').slice(0, 200)} ». Ouvrez « Erreurs cartes » dans le panneau admin, puis vérifiez ce que le marchand a été débité.`,
    ],
  });
}

/** A merchant wrote in the chat. One alert per merchant per 10 minutes, with the message. */
function chatMessage({ merchantId, merchantName, body, hasPhoto }) {
  const excerpt = String(body || '').slice(0, 300);
  return alert({
    key: `chat:${merchantId}`, throttleMs: 10 * 60 * 1000,
    subject: `Nouveau message de ${merchantName}`,
    eyebrow: 'Chat marchands', heading: `${merchantName} vous a écrit`,
    paragraphs: [excerpt ? `« ${excerpt} »` : 'Le marchand a envoyé une photo.', hasPhoto && excerpt ? 'Le message contient aussi une photo.' : '', 'Répondez dans le panneau admin, rubrique « Chat marchands ».'].filter(Boolean),
  });
}

/**
 * Looks at the last five minutes of API traffic of every merchant and raises the abuse alert for the ones that are
 * refused by the rate limit (20 or more 429s) or that fail most of the time (half of 30+ requests).
 */
async function watchApi() {
  const apiTraffic = require('./apiTraffic');
  for (const id of apiTraffic.merchantIds()) {
    const r = apiTraffic.recent(id);
    const abusive = r.limited >= 20 || (r.requests >= 30 && (r.limited + r.errors) / r.requests >= 0.5);
    if (!abusive) continue;
    let name = id;
    try { const m = await supabase.selectOne('merchants', { id }); if (m) name = m.business_name || m.email || id; } catch (e) { /* keep the id */ }
    await apiAbuse({ merchantId: id, merchantName: name, limited: r.limited, requests: r.requests, errors: r.errors, topCodes: r.top_codes });
  }
}

function start() {
  const t = setInterval(() => { watchApi().catch(() => {}); }, 60 * 1000);
  if (t.unref) t.unref();
}

function reset() { lastSent.clear(); }

module.exports = { alert, apiAbuse, chatMessage, watchApi, start, reset, paymentStuck, cardClosedByPartner, cardCreationStuck };
