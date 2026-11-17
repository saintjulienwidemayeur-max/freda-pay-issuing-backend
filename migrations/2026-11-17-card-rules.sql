-- Spending rules a merchant sets on a card: spending_limit (daily / per purchase) and single-use cards.
-- One row per card that has rules; cards without rules are not in this table (card creation never depends on it).
create table if not exists card_rules (
  card_id text primary key references cards(id),
  merchant_id text not null references merchants(id),
  mode text not null default 'sandbox',
  limit_amount numeric,                  -- USD, null = no limit
  limit_interval text,                   -- 'daily' | 'per_transaction'
  single_use boolean not null default false,
  single_use_consumed_at timestamptz,    -- the one purchase of a single-use card
  limit_frozen_until timestamptz,        -- frozen by the daily limit until this time (next UTC midnight)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table card_rules enable row level security;
create index if not exists idx_card_rules_frozen on card_rules(limit_frozen_until) where limit_frozen_until is not null;
create index if not exists idx_card_rules_single on card_rules(single_use, single_use_consumed_at) where single_use;
