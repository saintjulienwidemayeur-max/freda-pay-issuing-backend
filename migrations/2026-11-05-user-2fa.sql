-- Two-factor authentication (authenticator app, TOTP) for merchant owners and team members.
-- One row per person. The secret is stored ENCRYPTED; recovery codes are stored hashed.
-- A row with enabled_at null is either a setup in progress (secret_enc set) or just a reminder that was sent.
create table if not exists user_2fa (
  id text primary key,                 -- '<subject_type>:<subject_id>'
  subject_type text not null,          -- 'merchant' | 'member'
  subject_id text not null,
  merchant_id text not null,
  secret_enc text,
  enabled_at timestamptz,
  last_step bigint,                    -- last accepted time step: a code can't be used twice
  recovery_hashes jsonb not null default '[]'::jsonb,
  reminded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table user_2fa enable row level security;
create index if not exists idx_user_2fa_merchant on user_2fa(merchant_id);
