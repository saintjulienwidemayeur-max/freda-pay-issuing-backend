'use strict';
const supabase = require('../lib/supabase');
const config = require('../config');
const llm = require('../services/agent/llm');
const settings = require('../services/agent/settings');
const emailAgent = require('../services/agent/emailAgent');
const chatAgent = require('../services/agent/chatAgent');
const adminAgent = require('../services/agent/adminAgent');
const report = require('../services/agent/report');
const { randomHex } = require('../utils/ids');

function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}
const who = (ctx) => (ctx.admin && ctx.admin.email) || ctx.adminId || null;

async function status() {
  const cfg = await settings.get();
  const [drafts, alerts] = await Promise.all([
    supabase.select('agent_drafts', { status: 'draft' }, { select: 'id', limit: 1000 }).catch(() => []),
    supabase.select('agent_alerts', { acknowledged: false }, { select: 'id', limit: 1000 }).catch(() => []),
  ]);
  return { status: 200, body: { configured: llm.configured(), provider: config.agent.provider || null, model: cfg.model || config.agent.model, settings: cfg, pending_drafts: drafts.length, open_alerts: alerts.length, freda_mail: { keys: require('../services/fredaMail').mailboxes(), webhook_secret_set: !!config.fredaMail.webhookSecret } } };
}
async function secretsGet() { return { status: 200, body: { secrets: require('../services/agent/secrets').status() } }; }
async function secretsSave(ctx) {
  if (ctx.adminRole !== 'owner') { const e = new Error('Seul le propriétaire peut enregistrer des clés API.'); e.httpStatus = 403; e.code = 'INSUFFICIENT_ROLE'; throw e; }
  const b = ctx.body || {};
  const patch = {};
  for (const n of require('../services/agent/secrets').NAMES) if (typeof b[n] === 'string') patch[n] = b[n];
  return { status: 200, body: { secrets: await require('../services/agent/secrets').save(patch, who(ctx)) } };
}
async function saveSettings(ctx) {
  return { status: 200, body: { settings: await settings.save(ctx.body || {}, who(ctx)) } };
}

async function drafts(ctx) {
  const st = ctx.query && ctx.query.status;
  const filter = ['draft', 'sent', 'auto_sent', 'rejected'].includes(st) ? { status: st } : {};
  const rows = await supabase.select('agent_drafts', filter, { order: 'created_at.desc', limit: 100 });
  return { status: 200, body: { drafts: rows } };
}
async function approve(ctx) { return { status: 200, body: await emailAgent.approveDraft(ctx.params.id, { body: ctx.body && ctx.body.body, adminEmail: who(ctx) }) }; }
async function reject(ctx) { return { status: 200, body: await emailAgent.rejectDraft(ctx.params.id, who(ctx)) }; }

/** Run (or re-run) the agent on one inbox message. */
async function runOnMessage(ctx) {
  const row = await supabase.selectOne('admin_inbox', { id: ctx.params.id });
  if (!row) throw httpError(404, 'NOT_FOUND', 'Message introuvable.');
  await supabase.update('admin_inbox', { id: row.id }, { agent_status: null, agent_error: null });
  return { status: 200, body: await emailAgent.processInbox(row.id) };
}

async function chat(ctx) {
  if (!llm.configured()) throw httpError(424, 'AGENT_NOT_CONFIGURED', "L'agent IA n'est pas configuré : ajoutez GEMINI_API_KEY (ou ANTHROPIC_API_KEY) dans les variables d'environnement du serveur.");
  return { status: 200, body: await adminAgent.chat(ctx.body && ctx.body.messages, who(ctx)) };
}

/**
 * POST /admin/agent/ping : where the time goes. (1) can the server reach Google and which models does this key offer, (2) one tiny question to the
 * configured model, (3) if that fails or is slow, the same question to a few other fast models. Each step is timed, the model's own error is shown,
 * and a model that answers quickly can be adopted from the page. The answer is always 200 so the page can show it.
 */
async function ping() {
  if (!llm.configured()) return { status: 200, body: { ok: false, error: "Aucune clé : ajoutez GEMINI_API_KEY (ou ANTHROPIC_API_KEY) sur le serveur." } };
  const cfg = await settings.get();
  const model = cfg.model || config.agent.model;
  const out = { ok: true, provider: config.agent.provider, model, steps: [], models: [], suggestion: null };
  const tiny = (m, timeoutMs) => llm.generate({ system: 'Tu es un test de connexion.', messages: [{ role: 'user', content: 'Réponds uniquement : OK' }], model: m, maxTokens: 64, timeoutMs, noFallback: true }); // the test shows the model as it is: no automatic switch
  const step = async (name, m, timeoutMs) => {
    const started = Date.now();
    try {
      const r = await tiny(m, timeoutMs);
      out.steps.push({ name, model: m, ok: true, ms: Date.now() - started, reasoning: r.thinking || null, reply: String(r.text).slice(0, 60) });
      return true;
    } catch (e) {
      out.steps.push({ name, model: m, ok: false, ms: Date.now() - started, error: e.message });
      return false;
    }
  };

  let available = [];
  if (config.agent.provider === 'gemini') {
    const started = Date.now();
    try {
      available = await llm.listGeminiModels(10000);
      out.steps.push({ name: 'Connexion à Google (liste des modèles)', ok: true, ms: Date.now() - started, reply: `${available.length} modèle(s) utilisables avec cette clé` });
      out.models = available.map((m) => m.name).filter((n) => /flash/i.test(n)).slice(0, 25);
    } catch (e) {
      out.ok = false;
      out.steps.push({ name: 'Connexion à Google (liste des modèles)', ok: false, ms: Date.now() - started, error: e.message });
      return { status: 200, body: out };
    }
    if (available.length && !available.some((m) => m.name === model)) out.steps.push({ name: 'Modèle configuré', model, ok: false, ms: 0, error: `« ${model} » n'est pas dans la liste des modèles de cette clé.` });
  }
  const T = config.agent.pingTimeoutMs;
  const mainOk = await step('Question minuscule', model, T);
  const slow = !mainOk || out.steps[out.steps.length - 1].ms > 8000;
  if (slow && available.length) {
    // The same tiny question to other fast models, to find one that answers.
    const candidates = llm.rankFast(available.map((m) => m.name), [model]).slice(0, 3);
    for (const c of candidates) await step('Même question, autre modèle', c, Math.min(T, 12000));
  }
  const good = out.steps.find((x) => x.ok && x.model && x.ms <= 8000); // in the order tried: the configured model first, then the lite ones
  if (good && good.model !== model) out.suggestion = good.model;
  out.ok = out.steps.every((x) => x.ok) || !!good;
  return { status: 200, body: out };
}

async function reportOf(ctx) { return { status: 200, body: await report.build(ctx.query && ctx.query.days) }; }

async function alerts(ctx) {
  const rows = await supabase.select('agent_alerts', ctx.query && ctx.query.all ? {} : { acknowledged: false }, { order: 'created_at.desc', limit: 200 });
  return { status: 200, body: { alerts: rows } };
}
async function ackAlert(ctx) {
  const done = await supabase.update('agent_alerts', { id: ctx.params.id }, { acknowledged: true });
  if (!done || !done.length) throw httpError(404, 'NOT_FOUND', 'Alerte introuvable.');
  return { status: 200, body: { id: ctx.params.id, acknowledged: true } };
}

async function knowledgeList() {
  const rows = await supabase.select('agent_knowledge', {}, { order: 'updated_at.desc', limit: 200 });
  const builtin = require('../services/agent/knowledge').builtin().map((d) => ({ id: d.id, title: d.title, builtin: true, preview: d.content.slice(0, 200) }));
  return { status: 200, body: { entries: rows, builtin } };
}
async function knowledgeSave(ctx) {
  const b = ctx.body || {};
  const title = String(b.title || '').trim().slice(0, 150);
  const content = String(b.content || '').trim().slice(0, 6000);
  if (title.length < 3 || content.length < 10) throw httpError(400, 'MISSING_FIELDS', 'Titre (3 caractères minimum) et contenu (10 caractères minimum) requis.');
  const row = { title, content, enabled: b.enabled !== false, updated_by: who(ctx), updated_at: new Date().toISOString() };
  if (ctx.params && ctx.params.id) {
    const done = await supabase.update('agent_knowledge', { id: ctx.params.id }, row);
    if (!done || !done.length) throw httpError(404, 'NOT_FOUND', 'Entrée introuvable.');
    return { status: 200, body: { entry: done[0] } };
  }
  return { status: 201, body: { entry: await supabase.insert('agent_knowledge', Object.assign({ id: `kb_${randomHex(6)}` }, row)) } };
}
async function knowledgeDelete(ctx) {
  await supabase.delete('agent_knowledge', { id: ctx.params.id });
  return { status: 200, body: { deleted: true } };
}

/** Chat hand-off state of one merchant, and the way to give the chat back to the agent (or keep it for humans). */
async function chatStateGet(ctx) {
  return { status: 200, body: { state: await chatAgent.stateOf(ctx.params.merchantId) } };
}
async function chatStateSet(ctx) {
  const mode = ctx.body && ctx.body.mode === 'human' ? 'human' : 'agent';
  await chatAgent.setState(ctx.params.merchantId, mode === 'human' ? { mode, human_until: new Date(Date.now() + 24 * 3600 * 1000).toISOString() } : { mode, human_until: null, handoff_reason: null });
  return { status: 200, body: { state: await chatAgent.stateOf(ctx.params.merchantId) } };
}

/** KYC / KYB files waiting for the team with what the agent made of each (it never rejects; it approves only when the team switched that on). */
async function kycList() {
  const [subs, reviews] = await Promise.all([
    supabase.select('verification_submissions', { status: 'submitted' }, { order: 'created_at.asc', limit: 100 }),
    supabase.select('agent_kyc_reviews', {}, { order: 'created_at.desc', limit: 200 }).catch(() => []),
  ]);
  const byId = new Map(reviews.map((r) => [r.submission_id, r]));
  const out = [];
  for (const s of subs) {
    const m = await supabase.selectOne('merchants', { id: s.merchant_id }).catch(() => null);
    out.push({ submission_id: s.id, kind: s.kind, created_at: s.created_at, merchant_id: s.merchant_id, business_name: m && m.business_name, email: m && m.email, review: byId.get(s.id) || null });
  }
  return { status: 200, body: { pending: out, recent_reviews: reviews.slice(0, 20) } };
}
async function kycReview(ctx) {
  if (!llm.configured()) throw httpError(424, 'AGENT_NOT_CONFIGURED', "L'agent IA n'est pas configuré.");
  const existing = await supabase.selectOne('agent_kyc_reviews', { submission_id: ctx.params.id });
  if (existing && ctx.body && ctx.body.again) await supabase.delete('agent_kyc_reviews', { id: existing.id });
  return { status: 200, body: await require('../services/agent/kycAgent').review(ctx.params.id) };
}
async function learnNow() {
  if (!llm.configured()) throw httpError(424, 'AGENT_NOT_CONFIGURED', "L'agent IA n'est pas configuré.");
  return { status: 200, body: await require('../services/agent/learning').learn({ force: true }) };
}
async function fredaMailStatus() {
  const fm = require('../services/fredaMail');
  await fm.nameKeys();
  const boxes = [];
  for (const m of fm.mailboxes()) {
    try { const me = await fm.me(m); boxes.push({ mailbox: m, ok: true, scope: (me.key && me.key.scope) || me.scope || null, name: me.name || null, address: me.mailbox || null }); } catch (e) { boxes.push({ mailbox: m, ok: false, error: e.message }); }
  }
  return { status: 200, body: { configured: fm.configured(), webhook_secret_set: !!config.fredaMail.webhookSecret, webhook_url_hint: '/webhooks/freda-mail', mailboxes: boxes, problems: config.fredaMail.keyProblems || [], env_names_found: config.fredaMail.envNamesFound || [] } };
}
async function knowledgeToggle(ctx) {
  const done = await supabase.update('agent_knowledge', { id: ctx.params.id }, { enabled: !!(ctx.body && ctx.body.enabled), updated_by: who(ctx), updated_at: new Date().toISOString() });
  if (!done || !done.length) throw httpError(404, 'NOT_FOUND', 'Entrée introuvable.');
  return { status: 200, body: { entry: done[0] } };
}

module.exports = { secretsGet, secretsSave, kycList, kycReview, learnNow, fredaMailStatus, knowledgeToggle, ping, status, saveSettings, drafts, approve, reject, runOnMessage, chat, reportOf, alerts, ackAlert, knowledgeList, knowledgeSave, knowledgeDelete, chatStateGet, chatStateSet };
