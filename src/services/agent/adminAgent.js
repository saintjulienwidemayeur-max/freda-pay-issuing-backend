'use strict';
const llm = require('./llm');
const prompts = require('./prompts');
const guardrails = require('./guardrails');
const tools = require('./tools');
const alerts = require('./alerts');
const settings = require('./settings');

/** The admin's own chat with the agent. Stateless: the page sends the conversation so far. Read-only tools over the whole platform. */
async function chat(messages, adminEmail, admin) {
  const started = Date.now();
  const cfg = await settings.get();
  const turns = (Array.isArray(messages) ? messages : []).slice(-20).map((m) => ({ role: m && m.role === 'assistant' ? 'assistant' : 'user', content: String((m && m.content) || '').slice(0, 4000) })).filter((m) => m.content.trim());
  while (turns.length && turns[0].role !== 'user') turns.shift();
  if (!turns.length || turns[turns.length - 1].role !== 'user') { const e = new Error('Écrivez une question.'); e.httpStatus = 400; e.code = 'MISSING_FIELDS'; throw e; }
  const toolset = tools.build({ kind: 'admin', adminRole: admin && admin.role, adminEmail, adminId: admin && admin.id });
  try {
    const out = await llm.generate({ system: await prompts.adminSystem(), messages: turns, tools: toolset.definitions, runTool: toolset.run, model: cfg.model || undefined, maxTokens: 1200 });
    const red = guardrails.redact(out.text || '', { keepPartners: true }); // the team may talk about its partners
    if (red.findings.length) await alerts.raise({ kind: 'output_blocked', severity: 'high', source: 'admin', detail: `Retiré d'une réponse à ${adminEmail || 'un admin'} : ${red.findings.join(', ')}` });
    await settings.logRun({ kind: 'admin', model: out.model, input_tokens: out.usage.input, output_tokens: out.usage.output, tools_used: out.toolsUsed, outcome: 'replied', duration_ms: Date.now() - started });
    return { reply: red.text || "(Pas de réponse du modèle.)", tools_used: out.toolsUsed };
  } catch (err) {
    await settings.logRun({ kind: 'admin', outcome: 'error', error: String(err.message || err).slice(0, 300), duration_ms: Date.now() - started });
    throw err;
  }
}
module.exports = { chat };
