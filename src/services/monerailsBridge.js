'use strict';
const supabase = require('../lib/supabase');
const webhookDispatcher = require('./webhookDispatcher');

/**
 * Turns a Monerails webhook event about a MERCHANT card into what the current issuer's events already do: card activation or failure,
 * purchases / refunds / fees (stored, applied to the balance, sent to the merchant as card.transaction), declines (decline fee),
 * freezes and closures decided by the issuer, and holder verification results. Events about the admin's own test cards do nothing here.
 */
const TX_TYPE = { card_payment: 'AUTHORIZATION', card_refund: 'REFUND', card_reversal: 'REVERSAL', card_fee: 'CHARGE' };

async function handle(event) {
  const orch = require('./cardOrchestrator');
  const obj = (event && event.data && event.data.object) || {};
  switch (event.type) {
    case 'card.issued': return orch.applyMonerailsCardResult(obj, true);
    case 'card.issue_failed': return orch.applyMonerailsCardResult(obj, false, obj.failure_reason || obj.reason ? `Création refusée par le service de cartes : ${obj.failure_reason || obj.reason}. Les montants débités ont été remboursés.` : null);
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
      }, 'sandbox');
    }
    case 'card.authorization_declined': {
      const cardId = obj.card && (obj.card.id || obj.card);
      if (!cardId) return null;
      const evt = {
        event: 'issuing.transaction', type: 'DECLINE', mode: 'DEBIT', status: 'FAILED', amount: Number(obj.amount || 0), currency: obj.currency || 'USD',
        card_id: cardId, reference: event.id, description: `Declined: ${obj.reason || 'refused'}`, reason: obj.reason, merchant: obj.merchant ? { name: obj.merchant } : undefined, created_at: event.created_at,
      };
      await orch.recordCardTransaction(evt, 'sandbox');
      return orch.applyCardDeclineWebhook(evt, 'sandbox');
    }
    case 'card.frozen':
    case 'card.unfrozen': {
      const card = obj.id ? await supabase.selectOne('cards', { provider_card_id: obj.id }) : null;
      if (!card) return null;
      const frozen = event.type === 'card.frozen';
      const [changed] = await supabase.update('cards', { id: card.id, status: frozen ? 'active' : 'disabled' }, { status: frozen ? 'disabled' : 'active', updated_at: new Date().toISOString() });
      if (changed) webhookDispatcher.dispatch(card.merchant_id, frozen ? 'card.frozen' : 'card.unfrozen', { id: card.id, reference: card.own_reference, reason: 'issuer' });
      return changed || card;
    }
    case 'card.terminated': return obj.id ? orch.applyCardTerminationWebhook({ card_id: obj.id, reason: obj.reason || 'fermée par le service de cartes' }, 'sandbox') : null;
    case 'cardholder.kyc_updated': {
      if (!obj.id) return null;
      const v = obj.verification || {};
      const rows = await supabase.update('maplerad_customers', { monerails_cardholder_id: obj.id }, { monerails_status: v.status || null, monerails_reason: v.reason || null, updated_at: new Date().toISOString() }).catch(() => []);
      return rows && rows[0];
    }
    default: return null;
  }
}

module.exports = { handle };
