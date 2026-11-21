'use strict';
const supabase = require('../lib/supabase');
const webhookDispatcher = require('./webhookDispatcher');

/**
 * Turns a Monerails webhook event about a MERCHANT card into what the current issuer's events already do: card activation or failure,
 * purchases / refunds / fees (stored, applied to the balance, sent to the merchant as card.transaction), declines (decline fee),
 * freezes and closures decided by the issuer, and holder verification results. Events about the admin's own test cards do nothing here.
 */
const TX_TYPE = { card_payment: 'AUTHORIZATION', card_refund: 'REFUND', card_reversal: 'REVERSAL', card_fee: 'CHARGE' };

/**
 * Tells the merchant, by webhook, whether its holder was accepted by the new card program: holder.verified or holder.rejected
 * (in-between states are not sent). The reason is the issuer's own sentence without the partner's name, links or ids.
 */
function notifyHolderResult(holder, status, reason) {
  if (!holder || !holder.merchant_id) return;
  if (status !== 'verified' && status !== 'rejected' && status !== 'failed') return;
  const ok = status === 'verified';
  const why = ok ? null : (require('./cardIssuer').publicDetail(reason) || null);
  webhookDispatcher.dispatch(holder.merchant_id, ok ? 'holder.verified' : 'holder.rejected', {
    id: holder.id, email: holder.email || null, mode: holder.mode || null, status: ok ? 'verified' : 'rejected', reason: why,
    note: ok ? 'Ce titulaire est accepté par le nouveau programme de cartes : ses prochaines cartes y sont créées.' : "Ce titulaire n'est pas accepté par le nouveau programme de cartes : ses cartes restent chez notre banque partenaire actuelle. Renvoyez sa pièce d'identité (recto et verso) pour réessayer.",
  });
}

async function handle(event, mode) {
  const env = mode === 'live' ? 'live' : 'sandbox';
  const orch = require('./cardOrchestrator');
  const obj = (event && event.data && event.data.object) || {};
  switch (event.type) {
    case 'card.issued': return orch.applyMonerailsCardResult(obj, true, null, env);
    case 'card.issue_failed': return orch.applyMonerailsCardResult(obj, false, obj.failure_reason || obj.reason ? `Création refusée par notre banque partenaire : ${obj.failure_reason || obj.reason}. Les montants débités ont été remboursés.` : null, env);
    case 'card.transaction':
    case 'card.refunded':
    case 'card.reversed': {
      const type = TX_TYPE[obj.type];
      if (!type || !obj.card) return null; // funding / withdrawal / issuance: our own operations, already booked
      const cents = Number(obj.amount || 0);
      return orch.recordCardTransaction({
        event: 'issuing.transaction', type, mode: cents < 0 ? 'DEBIT' : 'CREDIT',
        status: obj.status === 'succeeded' ? 'SUCCESS' : String(obj.status || '').toUpperCase(), amount: Math.abs(cents), currency: obj.currency || 'USD',
        card_id: obj.card, reference: obj.id, description: obj.description || (type === 'CHARGE' ? 'Frais de carte' : null),
        merchant: obj.counterparty ? { name: obj.counterparty } : undefined, created_at: obj.created_at,
      }, env);
    }
    case 'card.authorization_declined': {
      const cardId = obj.card && (obj.card.id || obj.card);
      if (!cardId) return null;
      const evt = {
        event: 'issuing.transaction', type: 'DECLINE', mode: 'DEBIT', status: 'FAILED', amount: Number(obj.amount || 0), currency: obj.currency || 'USD',
        card_id: cardId, reference: event.id, description: `Declined: ${obj.reason || 'refused'}`, reason: obj.reason, merchant: obj.merchant ? { name: obj.merchant } : undefined, created_at: event.created_at,
      };
      await orch.recordCardTransaction(evt, env);
      return orch.applyCardDeclineWebhook(evt, env);
    }
    case 'card.frozen':
    case 'card.unfrozen': {
      const card = obj.id ? await supabase.selectOne('cards', { provider_card_id: obj.id }) : null;
      if (!card || (card.mode || 'sandbox') !== env) return null;
      const frozen = event.type === 'card.frozen';
      const [changed] = await supabase.update('cards', { id: card.id, status: frozen ? 'active' : 'disabled' }, { status: frozen ? 'disabled' : 'active', updated_at: new Date().toISOString() });
      if (changed) webhookDispatcher.dispatch(card.merchant_id, frozen ? 'card.frozen' : 'card.unfrozen', { id: card.id, reference: card.own_reference, reason: 'issuer' });
      return changed || card;
    }
    case 'card.terminated': return obj.id ? orch.applyCardTerminationWebhook({ card_id: obj.id, reason: obj.reason || 'fermée par notre banque partenaire' }, env) : null;
    case 'cardholder.kyc_updated': {
      if (!obj.id) return null;
      const v = obj.verification || {};
      const before = await supabase.selectOne('maplerad_customers', { monerails_cardholder_id: obj.id }).catch(() => null);
      if (before && (before.mode || 'sandbox') !== env) return null; // environments never cross
      const rows = await supabase.update('maplerad_customers', { monerails_cardholder_id: obj.id }, { monerails_status: v.status || null, monerails_reason: v.reason || null, updated_at: new Date().toISOString() }).catch(() => []);
      // The merchant is told the result (once: only when the status really changed).
      if (rows && rows[0] && (!before || before.monerails_status !== v.status)) notifyHolderResult(rows[0], v.status, v.reason);
      return rows && rows[0];
    }
    default: return null;
  }
}

module.exports = { handle, notifyHolderResult };
