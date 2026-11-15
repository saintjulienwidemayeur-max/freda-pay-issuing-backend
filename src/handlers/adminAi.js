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
  return { status: 200, body: { configured: llm.configured(), provider: config.agent.provider || null, model: cfg.model || config.agent.model, settings: cfg, pending_drafts: drafts.length, open_alerts: alerts.length, freda_mail_webhook_ready: !!config.fredaMail.secret } };
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
 * POST /admin/agent/ping : where the time goes. One tiny question, then one with the real chat prompt (rules + knowledge, no tools): each is timed, with
 * the model, the reasoning setting used and the model's own error if it refuses. The answer is always 200 so the page can show it.
 */
async function ping() {
  if (!llm.configured()) return { status: 200, body: { ok: false, error: "Aucune clé : ajoutez GEMINI_API_KEY (ou ANTHROPIC_API_KEY) sur le serveur." } };
  const cfg = await settings.get();
  const model = cfg.model || config.agent.model;
  const out = { ok: true, provider: config.agent.provider, model, steps: [] };
  const prompts = require('../services/agent/prompts');
  const tries = [
    { name: 'Question minuscule', system: 'Tu es un test de connexion.', content: 'Réponds uniquement : OK', maxTokens: 64 },
    { name: 'Question avec le vrai prompt du chat (règles + connaissances)', system: await prompts.chatSystem({ businessName: 'Test' }), content: 'Bonjour, combien coûte la création d\'une carte ?', maxTokens: 600 },
  ];
  for (const t of tries) {
    const started = Date.now();
    try {
      const r = await llm.generate({ system: t.system, messages: [{ role: 'user', content: t.content }], model, maxTokens: t.maxTokens, timeoutMs: 40000 });
      out.steps.push({ name: t.name, ok: true, ms: Date.now() - started, reasoning: r.thinking || null, tokens_in: r.usage.input, tokens_out: r.usage.output, reply: String(r.text).slice(0, 160) });
    } catch (e) {
      out.ok = false;
      out.steps.push({ name: t.name, ok: false, ms: Date.now() - started, error: e.message });
      break;
    }
  }
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

module.exports = { ping, status, saveSettings, drafts, approve, reject, runOnMessage, chat, reportOf, alerts, ackAlert, knowledgeList, knowledgeSave, knowledgeDelete, chatStateGet, chatStateSet };
