-- Every card transaction notification from the card partner (purchases, declines, refunds...), one row each.
-- Without this table the card balance cannot follow purchases and neither the admin nor the merchants see any transaction.
create table if not exists card_transactions (
  id text primary key,
  merchant_id text not null references merchants(id),
  card_id text not null references cards(id),
  mode text not null default 'sandbox',
  provider_reference text not null,
  type text not null,
  status text,
  direction text,
  amount_usd numeric,
  currency text,
  description text,
  merchant_name text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table card_transactions enable row level security;
create unique index if not exists idx_card_tx_ref on card_transactions(card_id, provider_reference);
create index if not exists idx_card_tx_merchant on card_transactions(merchant_id, mode, occurred_at desc);
