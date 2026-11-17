-- The new card program (tokenized cards, Apple Pay / Google Pay, issued by the new issuer). A merchant joins it once per environment:
-- 20 $ taken from the Live Master Wallet (free in Sandbox). Members' new individual cards go to the new issuer at the program's prices;
-- their cards created before stay where they are, at their old prices.
create table if not exists card_program_members (
  merchant_id text not null references merchants(id),
  mode text not null default 'live',
  joined_at timestamptz not null default now(),
  fee_usd numeric not null default 0,
  ledger_reference text,
  primary key (merchant_id, mode)
);
alter table card_program_members enable row level security;
