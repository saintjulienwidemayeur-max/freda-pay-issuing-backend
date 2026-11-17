-- Who saw / opened the new card program (dashboard banner and window), for the admin "Programme de cartes" page.
create table if not exists card_program_views (
  merchant_id text primary key references merchants(id),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  seen_count integer not null default 1,
  opened_at timestamptz,
  last_opened_at timestamptz,
  open_count integer not null default 0
);
alter table card_program_views enable row level security;
