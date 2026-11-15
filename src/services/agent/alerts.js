'use strict';
const supabase = require('../../lib/supabase');
const adminAlerts = require('../adminAlerts');
const { randomHex } = require('../../utils/ids');

/** Security alerts raised by the guardrails: stored (admin "Agent IA" page) and, for the serious ones, emailed to the team (throttled). */
const LABEL = {
  secret_request: 'Demande d\'une information secrète (numéro de carte, CVV, clé API, mot de passe ou code)',
  prompt_injection: "Tentative de donner des instructions à l'agent",
  output_blocked: "Une donnée sensible a été retirée d'une réponse de l'agent",
  rate_limited: 'Trop de messages vers l\'agent',
};

async function raise({ kind, severity = 'warning', merchantId, source, detail }) {
  try {
    await supabase.insert('agent_alerts', { id: `aal_${randomHex(8)}`, kind, severity, merchant_id: merchantId || null, source: source || null, detail: String(detail || '').slice(0, 500), acknowledged: false });
  } catch (e) { /* never break the work */ }
  if (severity === 'high') {
    adminAlerts.alert({
      key: `agent-alert:${kind}:${merchantId || 'x'}`, throttleMs: 30 * 60 * 1000,
      subject: `Alerte sécurité de l'agent IA : ${LABEL[kind] || kind}`, eyebrow: 'Agent IA', heading: LABEL[kind] || kind, tone: 'warning',
      paragraphs: [String(detail || '').slice(0, 400), `Source : ${source || '-'}${merchantId ? `, marchand ${merchantId}` : ''}. Voir « Agent IA » dans le panneau admin.`],
    }).catch(() => {});
  }
}

module.exports = { raise, LABEL };
