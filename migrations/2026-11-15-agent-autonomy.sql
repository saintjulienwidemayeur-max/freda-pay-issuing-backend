-- AI agent, part 2: real Freda Mail integration, things the agent learns, KYC pre-review.

-- Inbox: the Freda Mail identifiers needed to answer inside the same thread.
alter table admin_inbox add column if not exists fm_id text;         -- Freda Mail opaque message id (reply_to_message_id)
alter table admin_inbox add column if not exists fm_mailbox text;    -- the mailbox address that received it (its API key sends the reply)
alter table admin_inbox add column if not exists fm_thread_id text;

-- Knowledge: who wrote it (the team, or the agent after watching the team answer) and from what.
alter table agent_knowledge add column if not exists source text not null default 'team';  -- team | learned
alter table agent_knowledge add column if not exists learned_from text;                    -- short note: where the agent learned it

-- One line per KYC / KYB file the agent looked at. The agent can approve a clear file when the team switched that on; it NEVER rejects: a doubt goes to a human.
create table if not exists agent_kyc_reviews (
  id text primary key,
  submission_id text not null,
  merchant_id text,
  verdict text not null,            -- clear | needs_human
  confidence numeric,
  reasons jsonb not null default '[]'::jsonb,
  summary text,
  auto_approved boolean not null default false,
  model text,
  created_at timestamptz not null default now()
);
create index if not exists idx_agent_kyc_reviews_submission on agent_kyc_reviews(submission_id);
alter table agent_kyc_reviews enable row level security;
