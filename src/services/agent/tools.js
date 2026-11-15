'use strict';
const supabase = require('../../lib/supabase');
const ledger = require('../ledger');
const guarantee = require('../guarantee');
const { planKeyFor } = require('../plans');
const knowledge = require('./knowledge');
const guardrails = require('./guardrails');

/**
 * The agent's tools. ALL of them only READ. A tool for a merchant (chat, email from a known sender) is bound to that merchant's account:
 * whatever id the model passes is ignored, so it can never look at another account. The admin tools can look at any account. Every result
 * goes through the guardrails (card numbers, keys, passwords removed) and is cut to a size the model can use.
 */
const MAX_JSON = 5500;
const str = (v, n = 120) => (v == null ? null : String(v).slice(0, n));
const num = (v) => (v == null ? null : Math.round(Number(v) * 100) / 100);
const last4 = (pan) => (pan ? String(pan).replace(/\D/g, '').slice(-4) || null : null);
const clampInt = (v, d, max) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? Math.min(n, max) : d; };

const obj = (properties, required) => ({ type: 'object', properties, required: required || [] });
const S = (description) => ({ type: 'string', description });
const I = (description) => ({ type: 'integer', description });

const MERCHANT_TOOLS = [
  { name: 'search_knowledge', description: 'Cherche dans la base de connaissances de Freda Pay Issuing (tarifs, limites, procédures, API). À utiliser avant de citer un tarif ou une règle.', parameters: obj({ query: S('La question ou les mots-clés') }, ['query']) },
  { name: 'get_account_summary', description: "Résumé du compte : nom, type, statuts KYC/KYB, accès Live, plans, soldes (Master Wallet, dépôt de garantie, Gateway), nombre de cartes.", parameters: obj({}) },
  { name: 'list_cards', description: 'Les cartes du compte : référence, 4 derniers chiffres, statut, solde, type. Jamais le numéro complet ni le CVV.', parameters: obj({}) },
  { name: 'get_card_operations', description: "Les dernières opérations d'une carte (achats, refus, recharges, frais) avec date, montant et statut.", parameters: obj({ card: S("Identifiant (card_...) ou référence de la carte"), limit: I('Nombre maximum (défaut 15)') }, ['card']) },
  { name: 'list_recent_payments', description: 'Les derniers paiements reçus (MonCash, Natcash, carte) avec leur statut.', parameters: obj({ limit: I('Nombre maximum (défaut 10)') }) },
  { name: 'get_wallet_movements', description: "Les derniers mouvements d'un portefeuille avec leur cause.", parameters: obj({ wallet: S('master_wallet ou gateway'), limit: I('Nombre maximum (défaut 15)') }) },
  { name: 'get_recent_api_errors', description: "Les erreurs récentes de l'API du compte, regroupées par code, route et nombre (pour aider à déboguer une intégration).", parameters: obj({ days: I('Nombre de jours (défaut 3, maximum 14)') }) },
];

const ADMIN_TOOLS = [
  { name: 'find_merchant', description: "Retrouve des marchands par nom, email ou identifiant (mch_...).", parameters: obj({ query: S('Nom, email ou identifiant') }, ['query']) },
  { name: 'list_inbox', description: "Les derniers emails reçus (support, conformité, finance) avec leur catégorie et un résumé fait par l'agent.", parameters: obj({ limit: I('Nombre maximum (défaut 15)'), unanswered_only: { type: 'boolean', description: 'Seulement ceux sans réponse' } }) },
  { name: 'list_pending_drafts', description: "Les brouillons de réponse en attente d'approbation, avec leur raison.", parameters: obj({}) },
  { name: 'trace_card', description: "Qui a réellement fait chaque opération d'une carte : requêtes API du marchand, débits du Master Wallet et écritures de la banque partenaire.", parameters: obj({ card: S('Identifiant, référence ou identifiant partenaire') }, ['card']) },
  { name: 'explain_wallet', description: "Explique un solde : ce qui l'a fait monter et descendre, et les crédits sans source.", parameters: obj({ merchant_id: S('Identifiant du marchand'), wallet: S('master_wallet, gateway ou crypto'), mode: S('live ou sandbox') }, ['merchant_id']) },
  { name: 'platform_report', description: "Le rapport opérationnel de l'agent et de la plateforme sur une période (emails, chats, erreurs fréquentes, alertes).", parameters: obj({ days: I('Nombre de jours (défaut 7)') }) },
];

function build(scope) {
  const admin = scope.kind === 'admin';
  const isPublic = scope.kind === 'public'; // a sender we cannot tie to an account: knowledge only
  const definitions = admin ? [...MERCHANT_TOOLS, ...ADMIN_TOOLS] : isPublic ? [MERCHANT_TOOLS[0]] : MERCHANT_TOOLS;
  const idOf = (input) => {
    if (!admin) return scope.merchantId;
    const id = str(input && input.merchant_id, 60);
    if (!id) throw new Error('merchant_id est requis pour cet outil (utilisez find_merchant pour le trouver).');
    return id;
  };

  const handlers = {
    async search_knowledge(input) {
      const found = await knowledge.search(input.query, 3);
      return found.map((d) => ({ title: d.title, content: d.content.slice(0, 1800) }));
    },
    async get_account_summary(input) {
      const id = idOf(input);
      const m = await supabase.selectOne('merchants', { id });
      if (!m) return { error: 'Marchand introuvable.' };
      const [mwLive, mwSandbox, gwLive, floor, cards, topups] = await Promise.all([
        ledger.getBalance(id, 'master_wallet', 'USD', 'live'), ledger.getBalance(id, 'master_wallet', 'USD', 'sandbox'),
        ledger.getBalance(id, 'gateway', 'HTG', 'live'), guarantee.get(id),
        supabase.select('cards', { merchant_id: id }, { select: 'id,status,mode', limit: 500 }),
        supabase.select('wallet_topups', { merchant_id: id, status: supabase.inList(['pending', 'awaiting_review']) }, { select: 'id,method,status,amount_usd,amount_htg', limit: 20 }),
      ]);
      return {
        ...(admin ? { id: m.id } : {}),
        business_name: m.business_name, email: m.email, account_type: m.account_type, created_at: m.created_at, deactivated: !!m.deleted_at,
        kyc_status: m.kyc_status, kyb_status: m.kyb_status, gateway_live_enabled: !!m.gateway_live_enabled, issuing_live_enabled: !!m.issuing_live_enabled,
        plans: { gateway_live: planKeyFor(m, 'gateway', 'live'), issuing_live: planKeyFor(m, 'issuing', 'live') },
        master_wallet_usd: { live: num(mwLive), sandbox: num(mwSandbox), guarantee_deposit: num(floor) }, gateway_live_htg: num(gwLive),
        cards: { total: cards.length, active: cards.filter((c) => c.status === 'active').length, pending: cards.filter((c) => c.status === 'pending').length, failed: cards.filter((c) => c.status === 'failed').length },
        pending_deposits: topups.map((t) => ({ method: t.method, status: t.status, amount: t.amount_usd || t.amount_htg })),
      };
    },
    async list_cards(input) {
      const id = idOf(input);
      const rows = await supabase.select('cards', { merchant_id: id }, { order: 'created_at.desc', limit: 30 });
      return rows.map((c) => ({ id: c.id, reference: c.own_reference, last4: last4(c.masked_pan), kind: c.kind, brand: c.brand, status: c.status, mode: c.mode, balance_usd: num(c.balance), created_at: c.created_at, failure_reason: str(c.failure_reason, 200) }));
    },
    async get_card_operations(input) {
      const id = idOf(input);
      const key = str(input.card, 80);
      const card = (await supabase.selectOne('cards', { merchant_id: id, id: key })) || (await supabase.selectOne('cards', { merchant_id: id, own_reference: key }));
      if (!card) return { error: 'Carte introuvable sur ce compte.' };
      const rows = await supabase.select('card_transactions', { card_id: card.id }, { order: 'occurred_at.desc', limit: clampInt(input.limit, 15, 30) });
      return { card: { id: card.id, reference: card.own_reference, last4: last4(card.masked_pan), status: card.status, balance_usd: num(card.balance) },
        operations: rows.map((t) => ({ at: t.occurred_at, type: t.type, direction: t.direction, status: t.status, amount_usd: num(t.amount_usd), description: str(t.description, 100), merchant: str(t.merchant_name, 60) })) };
    },
    async list_recent_payments(input) {
      const id = idOf(input);
      const rows = await supabase.select('payments', { merchant_id: id }, { order: 'created_at.desc', limit: clampInt(input.limit, 10, 25) });
      return rows.map((p) => ({ id: p.id, at: p.created_at, method: p.method, status: p.status, amount: num(p.amount), currency: p.currency, fee: num(p.fee), mode: p.mode, reference: str(p.own_reference, 60) }));
    },
    async get_wallet_movements(input) {
      const id = idOf(input);
      const wallet = input.wallet === 'gateway' ? 'gateway' : 'master_wallet';
      const audit = require('../walletAudit');
      const d = await audit.ledgerFor(id, { wallet, mode: 'live', limit: clampInt(input.limit, 15, 30) });
      return { wallet, currency: d.currency, balance: d.balance, entries: d.entries.map((e) => ({ at: e.at, amount: e.amount, cause: e.label, balance_after: e.balance_after })) };
    },
    async get_recent_api_errors(input) {
      const id = idOf(input);
      const since = new Date(Date.now() - clampInt(input.days, 3, 14) * 86400000).toISOString();
      const rows = await supabase.select('api_call_log', { merchant_id: id, created_at: supabase.gt(since) }, { order: 'created_at.desc', limit: 1000 }).catch(() => []);
      const bad = rows.filter((r) => r.status >= 400);
      const groups = new Map();
      for (const r of bad) { const k = `${r.method} ${r.route} ${r.status} ${r.code || ''}`; const g = groups.get(k) || { method: r.method, route: r.route, status: r.status, code: r.code, count: 0, last_at: r.created_at, message: str(r.message, 160) }; g.count += 1; groups.set(k, g); }
      return { calls_checked: rows.length, errors: bad.length, top: [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 10) };
    },
  };

  if (admin) {
    Object.assign(handlers, {
      async find_merchant(input) {
        const q = String(input.query || '').trim().toLowerCase();
        if (q.length < 2) return { error: 'Tapez au moins 2 caractères.' };
        const rows = await supabase.select('merchants', {}, { order: 'created_at.desc', limit: 2000 });
        return rows.filter((m) => [m.id, m.email, m.business_name].some((v) => v && String(v).toLowerCase().includes(q))).slice(0, 10)
          .map((m) => ({ id: m.id, business_name: m.business_name, email: m.email, kyc_status: m.kyc_status, kyb_status: m.kyb_status, live: !!m.gateway_live_enabled, deactivated: !!m.deleted_at }));
      },
      async list_inbox(input) {
        const f = input.unanswered_only ? { replied_at: supabase.isNull() } : {};
        const rows = await supabase.select('admin_inbox', f, { order: 'received_at.desc', limit: clampInt(input.limit, 15, 30) });
        return rows.map((r) => ({ id: r.id, at: r.received_at, from: r.from_email, merchant_id: r.merchant_id, subject: str(r.subject, 120), mailbox: r.mailbox, category: r.agent_category, language: r.agent_language, summary: str(r.agent_summary, 300), answered: !!r.replied_at, agent_status: r.agent_status }));
      },
      async list_pending_drafts() {
        const rows = await supabase.select('agent_drafts', { status: 'draft' }, { order: 'created_at.desc', limit: 20 });
        return rows.map((d) => ({ id: d.id, to: d.to_email, subject: str(d.subject, 120), category: d.category, sensitive: d.sensitive, reason: d.sensitive_reason, summary: str(d.summary, 300), created_at: d.created_at }));
      },
      async trace_card(input) {
        const t = await require('../cardTrace').trace(input.card);
        if (!t) return { error: 'Carte introuvable.' };
        return { card: t.card, summary: t.summary, events: t.events.slice(-25).map((e) => ({ at: e.at, source: e.source, title: e.title, amount: e.amount, verdict: e.verdict && e.verdict.text })) };
      },
      async explain_wallet(input) {
        const wallet = ['gateway', 'crypto'].includes(input.wallet) ? input.wallet : 'master_wallet';
        const d = await require('../walletAudit').ledgerFor(idOf(input), { wallet, mode: input.mode === 'sandbox' ? 'sandbox' : 'live', limit: 10 });
        return { wallet, currency: d.currency, balance: d.balance, matches_ledger: d.matches, total_up: d.total_up, total_down: d.total_down, anomalies: d.anomalies, up: d.up.map((c) => ({ cause: c.label, count: c.count, total: c.total })), down: d.down.map((c) => ({ cause: c.label, count: c.count, total: c.total })),
          latest: d.entries.map((e) => ({ at: e.at, amount: e.amount, cause: e.label, status: e.status, note: e.note })) };
      },
      async platform_report(input) { return require('./report').build(clampInt(input.days, 7, 90)); },
    });
  }

  async function run(name, input) {
    const fn = definitions.some((d) => d.name === name) ? handlers[name] : null;
    if (!fn) return { error: `Outil inconnu : ${name}` };
    const out = guardrails.redactDeep(await fn(input || {}));
    let text = JSON.stringify(out);
    if (text.length > MAX_JSON) { const cut = Array.isArray(out) ? out.slice(0, Math.max(1, Math.floor(out.length / 2))) : out; text = JSON.stringify(cut).slice(0, MAX_JSON); return { truncated: true, data: text }; }
    return out;
  }
  return { definitions, run };
}

module.exports = { build, MERCHANT_TOOLS, ADMIN_TOOLS };
