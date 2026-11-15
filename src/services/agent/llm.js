'use strict';
const config = require('../../config');

/**
 * One interface for the model behind the agent: Google Gemini (GEMINI_API_KEY) or Anthropic Claude (ANTHROPIC_API_KEY).
 * generate() runs the conversation, lets the model call the READ-ONLY tools it is given (up to maxIterations rounds) and returns its final text.
 *   messages: [{ role: 'user' | 'assistant', content: string }]
 *   tools:    [{ name, description, parameters: { type: 'object', properties, required } }]
 *   runTool:  async (name, args) => any JSON-able value (already redacted by the caller)
 */
// 424 (Failed Dependency), never 502/503/504: the hosting proxy replaces those by its own error page (no CORS headers), and the admin page then
// only says "cannot reach the server" instead of showing the real reason.
function agentError(code, message) {
  const err = new Error(message);
  err.code = code;
  err.httpStatus = 424;
  return err;
}

const configured = () => !!(config.agent.provider && config.agent.apiKey);

async function post(url, headers, body) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), config.agent.timeoutMs);
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: JSON.stringify(body), signal: ctl.signal });
    } catch (e) {
      throw agentError('AGENT_UNREACHABLE', e.name === 'AbortError' ? "Le modèle n'a pas répondu à temps." : `Le modèle est injoignable : ${e.message}`);
    } finally { clearTimeout(timer); }
    if ((res.status === 429 || res.status === 503 || res.status === 529) && attempt === 0) { await new Promise((r) => setTimeout(r, 1500)); continue; }
    let data = null;
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok) {
      const msg = (data && (data.error && (data.error.message || data.error))) || `HTTP ${res.status}`;
      console.error(`Agent model error: HTTP ${res.status} ${String(msg).slice(0, 300)}`); // eslint-disable-line no-console
      const failure = agentError('AGENT_PROVIDER_ERROR', `Le modèle a refusé la requête (HTTP ${res.status}) : ${String(msg).slice(0, 200)}`);
      failure.providerStatus = res.status;
      throw failure;
    }
    return data || {};
  }
  throw agentError('AGENT_PROVIDER_ERROR', 'Le modèle est surchargé, réessayez.');
}

/**
 * Gemini rejects an object schema with no properties (and an empty "required" list): a tool without arguments is declared without "parameters".
 */
function geminiDeclaration(t) {
  const decl = { name: t.name, description: t.description };
  const props = t.parameters && t.parameters.properties;
  if (props && Object.keys(props).length) {
    decl.parameters = { type: 'object', properties: props };
    if (t.parameters.required && t.parameters.required.length) decl.parameters.required = t.parameters.required;
  }
  return decl;
}

// Gemini "flash" models reason before answering, which can take many seconds. For support answers a short reasoning is enough: the budget is
// set by AGENT_THINKING_BUDGET (default 0 = none, "" = leave the model's own default). A model that does not accept the setting is asked again without it.
let thinkingUnsupported = false;
const thinkingBudget = () => { const v = process.env.AGENT_THINKING_BUDGET; if (v === '') return null; const n = v === undefined ? 0 : Number(v); return Number.isFinite(n) ? n : 0; };

async function runGemini({ system, messages, tools, runTool, maxIterations, maxTokens, model }) {
  const contents = messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content) }] }));
  const usage = { input: 0, output: 0 };
  const toolsUsed = [];
  for (let i = 0; i < maxIterations; i += 1) {
    const body = { systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 } };
    if (tools.length) body.tools = [{ functionDeclarations: tools.map((t) => geminiDeclaration(t)) }];
    const budget = thinkingBudget();
    if (budget !== null && !thinkingUnsupported) body.generationConfig.thinkingConfig = { thinkingBudget: budget };
    const url = `${config.agent.baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    let data;
    try {
      data = await post(url, { 'x-goog-api-key': config.agent.apiKey }, body);
    } catch (e) {
      if (!(e.providerStatus === 400 && /thinking/i.test(e.message) && body.generationConfig.thinkingConfig)) throw e;
      thinkingUnsupported = true; // this model does not take the setting: same request without it, and not tried again
      delete body.generationConfig.thinkingConfig;
      data = await post(url, { 'x-goog-api-key': config.agent.apiKey }, body);
    }
    usage.input += Number(data.usageMetadata && data.usageMetadata.promptTokenCount) || 0;
    usage.output += Number(data.usageMetadata && data.usageMetadata.candidatesTokenCount) || 0;
    const cand = data.candidates && data.candidates[0];
    if (!cand || !cand.content) throw agentError('AGENT_NO_ANSWER', `Le modèle n'a pas donné de réponse${data.promptFeedback && data.promptFeedback.blockReason ? ` (${data.promptFeedback.blockReason})` : ''}.`);
    const parts = cand.content.parts || [];
    const calls = parts.filter((p) => p.functionCall);
    if (!calls.length) return { text: parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('').trim(), usage, toolsUsed };
    contents.push(cand.content); // returned unchanged (the model's own parts, thought signatures included)
    // Several tool calls asked at once are run at the same time (each one is only a read).
    const responses = await Promise.all(calls.map(async (c) => {
      toolsUsed.push(c.functionCall.name);
      let result;
      try { result = await runTool(c.functionCall.name, c.functionCall.args || {}); } catch (e) { result = { error: String(e.message || e).slice(0, 200) }; }
      return { functionResponse: { name: c.functionCall.name, response: { result } } };
    }));
    contents.push({ role: 'user', parts: responses });
  }
  throw agentError('AGENT_TOO_MANY_STEPS', 'Le modèle a demandé trop de consultations.');
}

async function runAnthropic({ system, messages, tools, runTool, maxIterations, maxTokens, model }) {
  const convo = messages.map((m) => ({ role: m.role, content: String(m.content) }));
  const usage = { input: 0, output: 0 };
  const toolsUsed = [];
  for (let i = 0; i < maxIterations; i += 1) {
    const body = { model, max_tokens: maxTokens, system, messages: convo };
    if (tools.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    const data = await post(`${config.agent.baseUrl}/v1/messages`, { 'x-api-key': config.agent.apiKey, 'anthropic-version': '2023-06-01' }, body);
    usage.input += Number(data.usage && data.usage.input_tokens) || 0;
    usage.output += Number(data.usage && data.usage.output_tokens) || 0;
    const blocks = data.content || [];
    const calls = blocks.filter((b) => b.type === 'tool_use');
    if (data.stop_reason !== 'tool_use' || !calls.length) return { text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim(), usage, toolsUsed };
    convo.push({ role: 'assistant', content: blocks });
    const results = await Promise.all(calls.map(async (c) => {
      toolsUsed.push(c.name);
      let result;
      try { result = await runTool(c.name, c.input || {}); } catch (e) { result = { error: String(e.message || e).slice(0, 200) }; }
      return { type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(result) };
    }));
    convo.push({ role: 'user', content: results });
  }
  throw agentError('AGENT_TOO_MANY_STEPS', 'Le modèle a demandé trop de consultations.');
}

async function generate({ system, messages, tools = [], runTool = async () => ({}), maxIterations = 6, maxTokens, model }) {
  if (!configured()) throw agentError('AGENT_NOT_CONFIGURED', "L'agent IA n'est pas configuré (GEMINI_API_KEY ou ANTHROPIC_API_KEY manquante sur le serveur).");
  const opts = { system, messages, tools, runTool, maxIterations, maxTokens: maxTokens || config.agent.maxTokens, model: model || config.agent.model };
  const out = config.agent.provider === 'gemini' ? await runGemini(opts) : await runAnthropic(opts);
  return Object.assign(out, { provider: config.agent.provider, model: opts.model });
}

/** The first JSON object found in a model answer (models sometimes wrap it in a code fence or add a sentence). null when there is none. */
function extractJson(text) {
  const t = String(text || '');
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
}

module.exports = { generate, extractJson, configured, agentError };
