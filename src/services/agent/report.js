'use strict';
const supabase = require('../../lib/supabase');
const llm = require('./llm');
const config = require('../../config');

/**
 * The operational report of the agent and of the platform for the last `days` days: emails handled, chats answered, hand-offs, the most
 * frequent technical and payment problems, and the security alerts. Everything is counted from the tables themselves.
 */
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const countBy = (rows, key) => { const m = {}; for (const r of rows) { const k = (typeof key === 'function' ? key(r) : r[key]) || '—'; m[k] = (m[k] || 0) + 1; } return m; };
const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));

async function safe(promise, fallback) { try { return await promise; } catch (e) { return fallback; } }

async function build(days) {
  const d = Math.max(1, Math.min(90, Number(days) || 7));
  const since = new Date(Date.now() - d * 86400000).toISOString();
  const gt = supabase.gt(since);
  const [runs, drafts, inbox, chatByAgent, chatStates, alerts, apiCalls, payments, failedCards] = await Promise.all([
    safe(supabase.select('agent_runs', { created_at: gt }, { limit: 20000 }), []),
    safe(supabase.select('agent_drafts', { created_at: gt }, { limit: 5000 }), []),
    safe(supabase.select('admin_inbox', { received_at: gt }, { limit: 5000 }), []),
    safe(supabase.select('chat_messages', { by_agent: true, created_at: gt }, { limit: 20000 }), []),
    safe(supabase.select('agent_chat_state', { handoff_at: gt }, { limit: 2000 }), []),
    safe(supabase.select('agent_alerts', { created_at: gt }, { order: 'created_at.desc', limit: 200 }), []),
    safe(supabase.select('api_call_log', { created_at: gt }, { limit: 20000 }), []),
    safe(supabase.select('payments', { created_at: gt }, { limit: 20000 }), []),
    safe(supabase.select('cards', { status: 'failed', created_at: gt }, { limit: 2000 }), []),
  ]);

  const emailRuns = runs.filter((r) => r.kind === 'email');
  const chatRuns = runs.filter((r) => r.kind === 'chat');
  const adminRuns = runs.filter((r) => r.kind === 'admin');
  const apiErrors = apiCalls.filter((c) => c.status >= 400);
  const failedPay = payments.filter((p) => p.status === 'failed');
  const stuck = payments.filter((p) => p.status === 'pending' && Date.now() - new Date(p.created_at).getTime() > 15 * 60 * 1000);
  const tokens = (rows) => rows.reduce((t, r) => t + (r.input_tokens || 0) + (r.output_tokens || 0), 0);

  return {
    period_days: d, since,
    agent: { configured: llm.configured(), provider: config.agent.provider || null, model: config.agent.model },
    emails: {
      received: inbox.length,
      processed: inbox.filter((m) => m.agent_status === 'done').length,
      skipped_robots: inbox.filter((m) => m.agent_status === 'skipped').length,
      waiting: inbox.filter((m) => !m.agent_status || m.agent_status === 'processing').length,
      errors: inbox.filter((m) => m.agent_status === 'error').length,
      drafts_created: drafts.length,
      drafts_pending: drafts.filter((x) => x.status === 'draft').length,
      sent_after_approval: drafts.filter((x) => x.status === 'sent').length,
      auto_sent: drafts.filter((x) => x.status === 'auto_sent').length,
      rejected: drafts.filter((x) => x.status === 'rejected').length,
      sensitive: drafts.filter((x) => x.sensitive).length,
      by_mailbox: countBy(drafts, 'mailbox'), by_category: top(countBy(drafts, 'category'), 8), by_language: countBy(drafts, 'language'),
    },
    chats: {
      answered_by_agent: chatByAgent.length,
      merchants_served: new Set(chatByAgent.map((m) => m.merchant_id)).size,
      handed_to_humans: chatStates.length,
      agent_runs: chatRuns.length,
    },
    technical: {
      api_calls: apiCalls.length, api_errors: apiErrors.length,
      top_api_errors: top(countBy(apiErrors, (c) => `${c.code || `HTTP ${c.status}`} · ${c.method} ${c.route}`), 8),
      payments: { total: payments.length, failed: failedPay.length, stuck_pending: stuck.length, by_method_failed: countBy(failedPay, 'method') },
      cards_failed: failedCards.length, top_card_failures: top(countBy(failedCards, (c) => String(c.failure_reason || 'raison inconnue').slice(0, 100)), 5),
    },
    security: {
      alerts_total: alerts.length, unacknowledged: alerts.filter((a) => !a.acknowledged).length, high: alerts.filter((a) => a.severity === 'high').length,
      by_kind: countBy(alerts, 'kind'),
      latest: alerts.slice(0, 10).map((a) => ({ id: a.id, at: a.created_at, kind: a.kind, severity: a.severity, source: a.source, merchant_id: a.merchant_id, detail: a.detail, acknowledged: a.acknowledged })),
    },
    usage: {
      runs: runs.length, errors: runs.filter((r) => r.outcome === 'error').length, admin_questions: adminRuns.length, tokens: tokens(runs), email_tokens: tokens(emailRuns),
      avg_ms: runs.length ? Math.round(runs.reduce((t, r) => t + (r.duration_ms || 0), 0) / runs.length) : 0,
      tools_used: top(countBy(runs.flatMap((r) => r.tools_used || []), (x) => x), 8),
    },
  };
}

module.exports = { build };
