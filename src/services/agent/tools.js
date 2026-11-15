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
const MAX_JSON = 8000;
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
  { name: 'api_reference', description: "La documentation exacte de l'API pour une route ou un sujet (ex. « cards », « payments », « webhooks », « cards/{id}/fund ») : méthode, route, champs de la requête, exemples, erreurs. À utiliser pour toute question technique (quel endpoint, quels champs).", parameters: obj({ topic: S('Route ou sujet, ex. cards, payments, webhooks, crypto, payouts') }, ['topic']) },
  { name: 'check_webhook', description: "Vérifie le webhook du compte : URL enregistrée (sans le secret), actif ou non, livraisons réussies et échouées sur 24 h, dernière erreur, dernier test.", parameters: obj({}) },
  { name: 'check_payment', description: "Pourquoi un paiement est dans cet état (en attente, échoué...) : statut, ancienneté, dernière réponse du partenaire de paiement, ce que cela veut dire et quoi faire.", parameters: obj({ payment: S('Identifiant (pay_...) ou référence du paiement') }, ['payment']) },
  { name: 'diagnose_account', description: "Le diagnostic complet du compte (identité, vérification, clés API, webhook, accès Live, titulaires, cartes, erreurs récentes) : une liste de contrôles ok / à surveiller / en échec avec quoi faire.", parameters: obj({}) },
  { name: 'get_recent_api_errors', description: "Les erreurs récentes de l'API du compte, regroupées par code, route et nombre (pour aider à déboguer une intégration).", parameters: obj({ days: I('Nombre de jours (défaut 3, maximum 14)') }) },
];

const ADMIN_TOOLS = [
  { name: 'list_merchants', description: "La liste de TOUS les marchands, triée : par solde Master Wallet (master_wallet_usd), solde Gateway (gateway_htg), date d'inscription (created_at), nombre de cartes (cards) ou de paiements (payments). Pour savoir qui a le plus d'argent, qui est nouveau, qui n'a pas fait son KYC.", parameters: obj({ sort_by: S('master_wallet_usd, gateway_htg, created_at, cards ou payments'), order: S('desc ou asc'), limit: I('Maximum 50 (défaut 15)'), mode: S('live ou sandbox'), kyc_status: S('not_started, submitted ou verified'), search: S('Nom, email ou identifiant') }) },
  { name: 'platform_overview', description: "Vue d'ensemble de la plateforme : marchands (Live, KYC), paiements de 7 jours par statut et méthode, cartes par statut, et tout ce qui attend l'équipe (dossiers KYC, dépôts manuels, litiges, retraits bancaires).", parameters: obj({ mode: S('live ou sandbox') }) },
  { name: 'list_payments', description: 'Les paiements de TOUTE la plateforme, filtrables (statut, méthode, marchand, nombre de jours).', parameters: obj({ status: S('pending, succeeded ou failed'), method: S('moncash, natcash ou card'), merchant_id: S('Identifiant du marchand'), days: I('Défaut 3'), limit: I('Défaut 20, maximum 40') }) },
  { name: 'list_all_cards', description: 'Les cartes de TOUTE la plateforme, filtrables (statut, marchand).', parameters: obj({ status: S('pending, active, failed, disabled, terminated'), merchant_id: S('Identifiant du marchand'), limit: I('Défaut 20, maximum 40') }) },
  { name: 'diagnose_merchant', description: "Le diagnostic complet d'un marchand (même contrôles que dans le panneau admin).", parameters: obj({ merchant_id: S('Identifiant du marchand') }, ['merchant_id']) },
  { name: 'check_calculations', description: "Vérifie que les calculs de la plateforme sont justes : crédits du Master Wallet sans source ou en double, soldes sous le dépôt de garantie, soldes négatifs, frais des paiements contre revenus. Répond s'il y a une erreur ou non.", parameters: obj({ mode: S('live ou sandbox') }) },
  { name: 'list_unanswered_chats', description: "Les conversations du chat marchands dont le dernier message vient du marchand et n'a pas de réponse.", parameters: obj({}) },
  { name: 'answer_unanswered_chats', description: "ACTION : répond lui-même aux messages du chat marchands restés sans réponse (avec les mêmes règles de sécurité que le chat : les demandes sensibles sont transférées à un humain avec un résumé).", parameters: obj({ limit: I('Maximum 10 (défaut 10)') }) },
  { name: 'find_merchant', description: "Retrouve des marchands par nom, email ou identifiant (mch_...).", parameters: obj({ query: S('Nom, email ou identifiant') }, ['query']) },
  { name: 'list_inbox', description: "Les derniers emails reçus (support, conformité, finance) avec leur catégorie et un résumé fait par l'agent.", parameters: obj({ limit: I('Nombre maximum (défaut 15)'), unanswered_only: { type: 'boolean', description: 'Seulement ceux sans réponse' } }) },
  { name: 'list_pending_drafts', description: "Les brouillons de réponse en attente d'approbation, avec leur raison.", parameters: obj({}) },
  { name: 'trace_card', description: "Qui a réellement fait chaque opération d'une carte : requêtes API du marchand, débits du Master Wallet et écritures de la banque partenaire.", parameters: obj({ card: S('Identifiant, référence ou identifiant partenaire') }, ['card']) },
  { name: 'explain_wallet', description: "Explique un solde : ce qui l'a fait monter et descendre, et les crédits sans source.", parameters: obj({ merchant_id: S('Identifiant du marchand'), wallet: S('master_wallet, gateway ou crypto'), mode: S('live ou sandbox') }, ['merchant_id']) },
  { name: 'platform_report', description: "Le rapport opérationnel de l'agent et de la plateforme sur une période (emails, chats, erreurs fréquentes, alertes).", parameters: obj({ days: I('Nombre de jours (défaut 7)') }) },
];

/** The part of openapi.yaml for a route or a topic, cut to a size the model can read. */
let openapiText = null;
function apiSnippet(topic) {
  if (openapiText === null) { try { openapiText = require('fs').readFileSync(require('path').join(__dirname, '..', '..', '..', 'openapi.yaml'), 'utf8'); } catch (e) { openapiText = ''; } }
  const t = String(topic || '').toLowerCase().replace(/^\/?v1/, '').replace(/^\//, '').trim();
  if (!t) return null;
  const lines = openapiText.split('\n');
  const out = []; let on = false;
  for (const l of lines) {
    const r = l.match(/^  (\/[^\s:]+):\s*$/);
    if (r) on = r[1].toLowerCase().replace(/^\//, '').startsWith(t) || r[1].toLowerCase().includes(t);
    else if (/^[a-z]/.test(l)) on = false;
    if (on) out.push(l);
  }
  return out.length ? out.join('\n').slice(0, 4500) : null;
}

/** Chat conversations whose last message is the merchant's and has no answer. */
async function unansweredChats() {
  const rows = await supabase.select('chat_messages', {}, { order: 'created_at.desc', limit: 2000 });
  const last = new Map();
  for (const m of rows) if (!last.has(m.merchant_id)) last.set(m.merchant_id, m);
  const waiting = [...last.values()].filter((m) => m.sender === 'merchant');
  const out = [];
  for (const m of waiting.slice(0, 30)) {
    const merchant = await supabase.selectOne('merchants', { id: m.merchant_id }).catch(() => null);
    const st = await require('./chatAgent').stateOf(m.merchant_id).catch(() => ({ mode: 'agent' }));
    out.push({ merchant_id: m.merchant_id, business_name: merchant ? merchant.business_name : m.merchant_id, at: m.created_at, body: m.body, mode: st.mode });
  }
  return out;
}

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
    async api_reference(input) {
      const snippet = apiSnippet(input.topic);
      return snippet ? { topic: input.topic, openapi: snippet } : { error: `Aucune route ne correspond à « ${str(input.topic, 40)} ». Sujets : payments, payouts, balance, crypto, cards, holders, webhooks.` };
    },
    async check_webhook(input) {
      const id = idOf(input);
      const hook = await supabase.selectOne('webhook_endpoints', { merchant_id: id }).catch(() => null);
      const health = require('../webhookHealth');
      if (!hook) return { registered: false, advice: "Aucun webhook enregistré : POST /v1/webhooks avec l'URL https de votre serveur, ou depuis le tableau de bord (Webhooks)." };
      let host = null; try { host = new URL(hook.url).host; } catch (e) { host = null; }
      const h = health.get(id);
      const probe = health.getProbe(id);
      const advice = !hook.active ? 'Le webhook est désactivé : réactivez-le.' : h.failed_24h && !h.delivered_24h ? `Toutes les livraisons échouent (${h.last_error || 'erreur inconnue'}) : vérifiez que l'URL est publique, en https, répond 2xx en moins de 10 s et vérifie la signature avec le secret.` : h.failed_24h ? `Certaines livraisons échouent (${h.last_error || ''}).` : h.delivered_24h ? 'Le webhook fonctionne.' : "Aucune livraison sur 24 h : normal s'il n'y a pas eu d'évènement.";
      return { registered: true, active: !!hook.active, url_host: host, url: str(hook.url, 200), deliveries_24h: h, last_test: probe, advice };
    },
    async check_payment(input) {
      const key = str(input.payment, 80);
      const f = admin ? {} : { merchant_id: scope.merchantId };
      const p = (await supabase.selectOne('payments', Object.assign({ id: key }, f))) || (await supabase.selectOne('payments', Object.assign({ own_reference: key }, f)));
      if (!p) return { error: 'Paiement introuvable.' };
      const health = require('../paymentHealth');
      const answer = health.lastAnswer(p.id);
      const ageMin = Math.round((Date.now() - new Date(p.created_at).getTime()) / 60000);
      const meaning = p.status === 'succeeded' ? 'Le paiement est confirmé et crédité.' : p.status === 'failed' ? 'Le paiement a échoué ou a été refusé.' : ageMin < 15 ? "Le client est probablement encore en train de payer : le statut se règle dès que le partenaire confirme." : answer && answer.kind === 'confirmed' ? 'Le partenaire dit que c\'est payé : le crédit est en cours (relecture automatique).' : answer && answer.kind === 'waiting' ? "Le partenaire indique que le client n'a pas terminé le paiement (en attente côté client)." : answer && answer.kind === 'not_found' ? "Le partenaire ne retrouve pas ce paiement : le client n'a sans doute jamais payé." : "En attente depuis plus de 15 minutes : le système relit le partenaire toutes les quelques minutes ; si le client a payé, l'équipe peut revérifier.";
      return { id: p.id, reference: p.own_reference, method: p.method, status: p.status, amount: num(p.amount), currency: p.currency, mode: p.mode, created_at: p.created_at, age_min: ageMin, partner_last_answer: answer ? { kind: answer.kind, label: health.LABEL[answer.kind], at: new Date(answer.at).toISOString(), message: str(answer.message, 160) } : null, meaning };
    },
    async diagnose_account(input) {
      const d = await require('../merchantDiagnostic').diagnose(idOf(input));
      if (!d) return { error: 'Marchand introuvable.' };
      const checks = (d.checks || []);
      return { summary: d.summary || null, problems: checks.filter((c) => c.status !== 'ok').map((c) => Object.assign({ area: c.area, check: c.label, status: c.status, detail: str(c.detail, 220) }, admin ? { fix: str(c.fix, 220) } : {})), ok_count: checks.filter((c) => c.status === 'ok').length };
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
      async list_merchants(input) { return require('./platformData').listMerchants({ sortBy: input.sort_by, order: input.order, limit: clampInt(input.limit, 15, 50), mode: input.mode === 'sandbox' ? 'sandbox' : 'live', kycStatus: input.kyc_status, search: input.search }); },
      async platform_overview(input) { return require('./platformData').overview(input.mode === 'sandbox' ? 'sandbox' : 'live'); },
      async list_payments(input) {
        const f = {};
        if (['pending', 'succeeded', 'failed'].includes(input.status)) f.status = input.status;
        if (input.method) f.method = str(input.method, 20);
        if (input.merchant_id) f.merchant_id = str(input.merchant_id, 60);
        f.created_at = supabase.gt(new Date(Date.now() - clampInt(input.days, 3, 60) * 86400000).toISOString());
        const rows = await supabase.select('payments', f, { order: 'created_at.desc', limit: clampInt(input.limit, 20, 40) });
        return rows.map((p) => ({ id: p.id, merchant_id: p.merchant_id, at: p.created_at, method: p.method, status: p.status, amount: num(p.amount), currency: p.currency, mode: p.mode }));
      },
      async list_all_cards(input) {
        const f = {};
        if (input.status) f.status = str(input.status, 20);
        if (input.merchant_id) f.merchant_id = str(input.merchant_id, 60);
        const rows = await supabase.select('cards', f, { order: 'created_at.desc', limit: clampInt(input.limit, 20, 40) });
        return rows.map((c) => ({ id: c.id, merchant_id: c.merchant_id, reference: c.own_reference, last4: last4(c.masked_pan), status: c.status, mode: c.mode, balance_usd: num(c.balance), created_at: c.created_at, failure_reason: str(c.failure_reason, 160) }));
      },
      async diagnose_merchant(input) { return handlers.diagnose_account(input); },
      async check_calculations(input) { return require('./platformData').checkCalculations(input.mode); },
      async list_unanswered_chats() { return (await unansweredChats()).map((c) => ({ merchant_id: c.merchant_id, business_name: c.business_name, waiting_since: c.at, message: str(c.body, 200), mode: c.mode })); },
      async answer_unanswered_chats(input) {
        const list = (await unansweredChats()).slice(0, clampInt(input.limit, 10, 10));
        const chatAgent = require('./chatAgent');
        const results = [];
        for (const c of list) results.push({ business_name: c.business_name, merchant_id: c.merchant_id, outcome: (await chatAgent.handleMerchantMessage(c.merchant_id, { force: true })).outcome });
        return { answered: results.filter((r) => r.outcome === 'replied').length, handed_to_humans: results.filter((r) => r.outcome === 'handed_off').length, results };
      },
      async platform_report(input) { return require('./report').build(clampInt(input.days, 7, 90)); },
    });
  }

  async function run(name, input) {
    const fn = definitions.some((d) => d.name === name) ? handlers[name] : null;
    if (!fn) return { error: `Outil inconnu : ${name}` };
    const out = guardrails.redactDeep(await fn(input || {}));
    let text = JSON.stringify(out);
    if (text.length > MAX_JSON) {
      // Too long for the model: the lists inside are cut (the top of a sorted list is what matters), and it is said.
      let cut = out;
      for (let i = 0; i < 8 && JSON.stringify(cut).length > MAX_JSON; i += 1) {
        if (Array.isArray(cut)) cut = cut.slice(0, Math.max(1, Math.floor(cut.length / 2)));
        else { cut = Object.assign({}, cut); for (const k of Object.keys(cut)) if (Array.isArray(cut[k]) && cut[k].length > 3) cut[k] = cut[k].slice(0, Math.max(3, Math.floor(cut[k].length / 2))); }
      }
      return Array.isArray(cut) ? { truncated: true, items: cut } : Object.assign({ truncated: true }, cut);
    }
    return out;
  }
  return { definitions, run };
}

/**
 * The account summary and the card list are put in the prompt up front (read-only, bound to the merchant), so that most answers need ONE model
 * call instead of a tool round trip first. The tools stay available for anything deeper.
 */
async function accountContext(merchantId) {
  const t = build({ kind: 'merchant', merchantId });
  const [summary, cards] = await Promise.all([t.run('get_account_summary', {}), t.run('list_cards', {})]);
  const shortCards = Array.isArray(cards) ? cards.slice(0, 8).map((c) => ({ ref: c.reference, last4: c.last4, status: c.status, balance_usd: c.balance_usd, mode: c.mode, failure: c.failure_reason })) : cards;
  return `Contexte du compte (lecture seule, déjà vérifié par le système) :\n${JSON.stringify({ account: summary, cards: shortCards, cards_listed: Array.isArray(cards) ? Math.min(cards.length, 8) : 0 }).slice(0, 2500)}`;
}

module.exports = { accountContext, build, MERCHANT_TOOLS, ADMIN_TOOLS };
