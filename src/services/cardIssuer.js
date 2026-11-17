'use strict';
const supabase = require('../lib/supabase');
const maplerad = require('./maplerad');
const monerails = require('./monerails');

/**
 * Which issuer a card lives at, and one way to talk to it.
 *   - Every existing card is at the current issuer (provider "maplerad", the column's default).
 *   - New INDIVIDUAL cards of SANDBOX pilot merchants (or of everyone once the admin switches "new cards" to Monerails) go to Monerails,
 *     when their holder is verified there. Monerails is wired with a TEST key only: Live cards always stay at the current issuer.
 * Settings (platform_settings "card_issuer"): { new_cards: 'maplerad' | 'monerails', pilot_merchants: [merchant ids], low_balance_usd }.
 */
const KEY = 'card_issuer';
const DEFAULTS = { new_cards: 'maplerad', pilot_merchants: [], low_balance_usd: 200, live_enabled: false, live_low_balance_usd: 500 };
let cache = null; let at = 0;

async function settings() {
  if (cache && Date.now() - at < 15000) return cache;
  let saved = {};
  try { const row = await supabase.selectOne('platform_settings', { key: KEY }); if (row) saved = JSON.parse(row.value) || {}; } catch (e) { /* defaults */ }
  cache = Object.assign({}, DEFAULTS, saved); at = Date.now();
  return cache;
}
async function saveSettings(patch, adminEmail) {
  const next = Object.assign({}, await settings());
  if (patch.new_cards !== undefined) next.new_cards = patch.new_cards === 'monerails' ? 'monerails' : 'maplerad';
  if (patch.pilot_merchants !== undefined) {
    const list = Array.isArray(patch.pilot_merchants) ? patch.pilot_merchants : String(patch.pilot_merchants || '').split(/[\s,;]+/);
    next.pilot_merchants = [...new Set(list.map((x) => String(x).trim()).filter((x) => /^mch_[A-Za-z0-9_]+$/.test(x)))].slice(0, 50);
  }
  if (patch.live_enabled !== undefined) {
    next.live_enabled = patch.live_enabled === true || patch.live_enabled === 'true';
    if (next.live_enabled && !(monerails.configured('live') && require('../config').monerails.liveWebhookSecret)) {
      const e = new Error("Ajoutez d'abord la clé Live (mr_live_...) et branchez le webhook Live avant d'activer le Live.");
      e.httpStatus = 409; e.code = 'MONERAILS_LIVE_NOT_READY';
      throw e;
    }
  }
  if (patch.live_low_balance_usd !== undefined) { const n = Number(patch.live_low_balance_usd); if (Number.isFinite(n) && n >= 0 && n <= 1000000) next.live_low_balance_usd = n; }
  if (patch.low_balance_usd !== undefined) { const n = Number(patch.low_balance_usd); if (Number.isFinite(n) && n >= 0 && n <= 1000000) next.low_balance_usd = n; }
  const row = { value: JSON.stringify(next), updated_by: adminEmail || null, updated_at: new Date().toISOString() };
  if (await supabase.selectOne('platform_settings', { key: KEY })) await supabase.update('platform_settings', { key: KEY }, row);
  else await supabase.insert('platform_settings', Object.assign({ key: KEY }, row));
  cache = next; at = Date.now();
  return next;
}

/** The issuer for a NEW card or holder of this merchant. */
async function issuerFor(merchantId, mode, kind) {
  const live = mode === 'live';
  if ((kind && kind !== 'individual') || !monerails.configured(live ? 'live' : 'sandbox')) return 'maplerad';
  const s = await settings();
  if (live && !s.live_enabled) return 'maplerad'; // the Live switch, off until the team turns it on
  if (s.new_cards === 'monerails' || (s.pilot_merchants || []).includes(merchantId)) return 'monerails';
  // Members of the new card program (they joined, and paid in Live) get their new cards from the new issuer.
  return (await require('./cardProgram').isMember(merchantId, live ? 'live' : 'sandbox')) ? 'monerails' : 'maplerad';
}

const isMonerails = (card) => !!card && card.provider === 'monerails';
/** The card's id at its issuer. */
const providerCardId = (card) => (isMonerails(card) ? card.provider_card_id : card && card.maplerad_card_id);

/** A card from an issuer event (Maplerad card id or Monerails card id). */
async function findByProviderId(id) {
  if (!id) return null;
  return (await supabase.selectOne('cards', { maplerad_card_id: id })) || (await supabase.selectOne('cards', { provider_card_id: id }).catch(() => null));
}

/** The same operations, whichever issuer holds the card. Amounts in US cents. */
function ops(card) {
  if (isMonerails(card)) {
    const m = monerails.forMode(card.mode); // a Live card uses the live key, a Sandbox card the test key: never crossed
    const id = card.provider_card_id;
    return {
      fund: (cents, key) => m.fund(id, cents, key),
      withdraw: (cents, key) => m.withdraw(id, cents, key),
      freeze: () => m.freeze(id),
      unfreeze: () => m.unfreeze(id),
      terminate: () => m.terminate(id),
      /** Raw details in the field names the reveal code understands. */
      details: async () => { const d = (await m.details(id)).data || {}; return { card_number: d.number, cvv: d.cvc, expiry_month: d.exp_month, expiry_year: d.exp_year }; },
      balanceCents: async () => { const c = (await m.getCard(id)).data || {}; return c.balance == null ? null : Number(c.balance); },
    };
  }
  const p = maplerad.forMode(card.mode);
  const id = card.maplerad_card_id;
  return {
    fund: (cents) => p.fundCard(id, cents),
    withdraw: (cents) => p.withdrawFromCard(id, cents),
    freeze: () => p.freezeCard(id),
    unfreeze: () => p.unfreezeCard(id),
    terminate: () => p.terminateCard(id),
    details: async () => { const res = await p.getCard(id); return (res && (res.data || res)) || {}; },
    balanceCents: async () => { const res = await p.getCard(id); const d = (res && (res.data || res)) || {}; return d.balance == null ? null : Number(d.balance); },
  };
}

/** Monerails answers with { error: { code } } turned into MONERAILS_<CODE>: the merchant gets our own codes and a short French message. */
function translateError(err) {
  const code = String((err && err.code) || '');
  const map = {
    MONERAILS_CARD_MINIMUM_BALANCE: [400, 'CARD_MINIMUM_BALANCE', 'Au moins 1 $ doit rester sur la carte.'],
    MONERAILS_CARD_OPERATION_IN_PROGRESS: [409, 'CARD_OPERATION_IN_PROGRESS', 'Une autre opération est en cours sur cette carte. Réessayez dans un instant.'],
    MONERAILS_CARD_SINGLE_USE: [400, 'CARD_SINGLE_USE', 'Carte à usage unique : elle ne peut être ni rechargée ni vidée.'],
    MONERAILS_CARD_ALREADY_FROZEN: [409, 'CARD_FROZEN', 'Cette carte est déjà gelée.'],
    MONERAILS_CARD_NOT_FROZEN: [409, 'CARD_NOT_FROZEN', "Cette carte n'est pas gelée."],
    MONERAILS_CARD_TERMINATED: [409, 'CARD_TERMINATED', 'Cette carte est fermée.'],
    MONERAILS_CARD_NOT_READY: [409, 'CARD_NOT_READY', "Cette carte n'est pas encore active (création en cours)."],
    MONERAILS_RATE_LIMITED: [429, 'CARD_REVEAL_LIMIT', 'Trop de demandes pour cette carte. Réessayez plus tard.'],
    MONERAILS_BALANCE_INSUFFICIENT: [503, 'CARD_SERVICE_ERROR', 'Le service de cartes est momentanément indisponible. Réessayez plus tard.'],
  };
  if (/Cards Created Today Cannot be Terminated/i.test(String(err && err.message))) return Object.assign(new Error('Une carte ne peut pas être fermée le jour de sa création. Gelez-la maintenant, puis fermez-la demain.'), { code: 'CARD_TERMINATE_SAME_DAY', httpStatus: 400 });
  const m = map[code];
  if (m) return Object.assign(new Error(m[2]), { code: m[1], httpStatus: m[0] });
  if (/^MONERAILS_/.test(code)) return Object.assign(new Error('Le service de cartes a refusé la demande. Réessayez ou contactez le support.'), { code: 'CARD_SERVICE_ERROR', httpStatus: 502, providerInfo: { provider: 'monerails', code, message: String(err.message).slice(0, 300) } });
  return err;
}
/**
 * Runs an issuer call and returns our own error on failure. For the new issuer, a call whose outcome is unknown (timeout, network, server
 * error) is repeated with the SAME idempotency key (the issuer replays the first answer instead of doing it twice); if it is still unknown,
 * the error is CARD_RESULT_UNKNOWN (502) and the callers keep the money where it is for the team to check, never refunding blindly.
 */
async function call(card, fn, { retries } = {}) {
  if (!isMonerails(card)) return fn(ops(card));
  const attempts = 1 + (retries == null ? 0 : retries);
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try { return await fn(ops(card)); } catch (err) {
      last = err;
      if (!err.unknownOutcome || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  if (last && last.unknownOutcome && attempts > 1) {
    const e = Object.assign(new Error("Le résultat de l'opération n'a pas pu être confirmé par le service de cartes. Ne la répétez pas : l'équipe vérifie et corrige si besoin."), { code: 'CARD_RESULT_UNKNOWN', httpStatus: 502, unknownOutcome: true });
    require('./adminAlerts').alert({ key: `card-unknown-${card.id}`, throttleMs: 30 * 60 * 1000, subject: 'Résultat inconnu chez Monerails : à vérifier', eyebrow: 'Cartes', heading: 'Opération de carte à vérifier', tone: 'warning', paragraphs: [`Carte ${card.id} (${card.own_reference}) : le service de cartes n'a pas confirmé une opération (délai ou erreur serveur).`, "L'argent n'a pas été remboursé automatiquement pour éviter un double paiement. Comparez le solde de la carte chez Monerails et chez nous, puis corrigez."] }).catch(() => {});
    throw e;
  }
  throw translateError(last);
}

/**
 * Monerails' card balance can only be topped up in crypto from its dashboard: when it falls under the threshold, the team is warned
 * (at most every 6 hours) before card creations and recharges start failing. Only checked while Monerails issues merchant cards.
 */
async function checkMonerailsBalance() {
  const s = await settings();
  const inUse = s.new_cards === 'monerails' || (s.pilot_merchants || []).length > 0;
  const out = { checked: false };
  const envs = [['sandbox', s.low_balance_usd]];
  if (s.live_enabled) envs.push(['live', s.live_low_balance_usd]);
  for (const [mode, threshold] of envs) {
    if (!inUse || !monerails.configured(mode)) continue;
    const b = (await monerails.forMode(mode).balance()).data || {};
    const usd = b.cards && b.cards.amount != null ? Number(b.cards.amount) / 100 : null;
    const low = usd != null && usd < Number(threshold || 0);
    const label = mode === 'live' ? 'Live' : 'Sandbox';
    if (low) {
      await require('./adminAlerts').alert({
        key: `monerails-low-balance-${mode}`, throttleMs: 6 * 3600 * 1000, subject: `Solde cartes Monerails ${label} bas : ${usd.toFixed(2)} $`, eyebrow: 'Cartes', heading: `Rechargez le solde cartes Monerails (${label})`, tone: 'warning',
        paragraphs: [`Le solde cartes Monerails ${label} est de ${usd.toFixed(2)} $, sous le seuil de ${Number(threshold).toFixed(2)} $.`, 'Sans solde, les créations et recharges des cartes émises chez Monerails échouent.', 'Rechargez-le en crypto (USDT / USDC) depuis le dashboard Monerails, puis vérifiez le solde dans Admin > Monerails.'],
      }).catch(() => {});
    }
    Object.assign(out, { checked: true, [mode]: { balance_usd: usd, low } });
    if (mode === 'sandbox') Object.assign(out, { balance_usd: usd, low });
  }
  return out;
}

module.exports = { checkMonerailsBalance, settings, saveSettings, issuerFor, isMonerails, providerCardId, findByProviderId, ops, call, translateError };
