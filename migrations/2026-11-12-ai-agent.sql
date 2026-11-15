-- Central AI agent: email drafts, chat hand-offs, run log, security alerts, admin-editable knowledge.
-- The agent is read-only on the platform's data. Anything sensitive is saved as a DRAFT and waits for an admin.

-- One line per agent run (email, chat, admin chat): what it did, how long, how many tokens, which read-only tools it used.
create table if not exists agent_runs (
  id text primary key,
  kind text not null,               -- email | chat | admin
  ref_id text,                      -- admin_inbox id, chat message id...
  merchant_id text,
  model text,
  input_tokens integer,
  output_tokens integer,
  tools_used jsonb not null default '[]'::jsonb,
  outcome text,                     -- drafted | auto_sent | replied | handed_off | skipped | error
  error text,
  duration_ms integer,
  created_at timestamptz not null default now()
);
create index if not exists idx_agent_runs_created on agent_runs(created_at desc);
alter table agent_runs enable row level security;

-- Replies written by the agent for an email. Nothing leaves while status = 'draft'.
create table if not exists agent_drafts (
  id text primary key,
  source text not null,             -- email
  inbox_id text,
  merchant_id text,
  to_email text,
  to_name text,
  subject text,
  body text not null,
  original_excerpt text,
  language text,                    -- fr | ht | en | es
  category text,
  mailbox text,                     -- support | compliance | finance | other
  sensitive boolean not null default false,
  sensitive_reason text,
  summary text,
  status text not null default 'draft', -- draft | sent | auto_sent | rejected
  edited boolean not null default false,
  reviewed_by text,
  reviewed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_agent_drafts_status on agent_drafts(status, created_at desc);
alter table agent_drafts enable row level security;

-- Who answers a merchant's chat: the agent, or a human after a hand-off (with the conversation summary).
create table if not exists agent_chat_state (
  merchant_id text primary key,
  mode text not null default 'agent', -- agent | human
  human_until timestamptz,
  handoff_reason text,
  handoff_summary text,
  handoff_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table agent_chat_state enable row level security;

-- Knowledge added by the team (the price list, limits and procedures are read from the platform itself).
create table if not exists agent_knowledge (
  id text primary key,
  title text not null,
  content text not null,
  enabled boolean not null default true,
  updated_by text,
  updated_at timestamptz not null default now()
);
alter table agent_knowledge enable row level security;

-- Security alerts raised by the guardrails (secret requested, prompt injection, output blocked...).
create table if not exists agent_alerts (
  id text primary key,
  kind text not null,               -- secret_request | prompt_injection | output_blocked | rate_limited
  severity text not null default 'warning', -- info | warning | high
  merchant_id text,
  source text,                      -- email | chat | admin
  detail text,
  acknowledged boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_agent_alerts_created on agent_alerts(created_at desc);
alter table agent_alerts enable row level security;

-- Inbox: where the message came from and what the agent made of it.
alter table admin_inbox add column if not exists source text not null default 'brevo'; -- brevo | freda_mail
alter table admin_inbox add column if not exists mailbox text;                         -- support | compliance | finance | other
alter table admin_inbox add column if not exists agent_status text;                    -- null (waiting) | processing | done | skipped | error
alter table admin_inbox add column if not exists agent_category text;
alter table admin_inbox add column if not exists agent_summary text;
alter table admin_inbox add column if not exists agent_language text;
alter table admin_inbox add column if not exists agent_error text;
-- Chat: messages written by the agent are marked.
alter table chat_messages add column if not exists by_agent boolean not null default false;
