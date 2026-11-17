-- Each new identity check sent for a cardholder (restart_verification): at most 5 per 24 h (HOLDER_VERIFICATION_LIMIT).
create table if not exists holder_verification_attempts (
  id text primary key,
  holder_id text not null,
  created_at timestamptz not null default now()
);
alter table holder_verification_attempts enable row level security;
create index if not exists idx_holder_attempts on holder_verification_attempts(holder_id, created_at desc);
