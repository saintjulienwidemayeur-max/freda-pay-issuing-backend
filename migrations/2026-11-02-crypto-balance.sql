-- The crypto wallet keeps its own balance (ledger wallet 'crypto', one currency per coin: USDT, USDC), separate from the Master Wallet.
-- Sending crypto out and converting it to USD (credited to the Master Wallet) are recorded here, one row per action.
create table if not exists crypto_transactions (
  id text primary key,
  merchant_id text not null references merchants(id),
  mode text not null default 'sandbox',
  type text not null,                  -- send | convert
  coin text not null,                  -- USDT | USDC
  chain text,
  address text,                        -- send: the destination address
  amount numeric not null,             -- in the coin
  fee numeric not null default 0,      -- everything the merchant paid (in the coin)
  provider_cost numeric not null default 0,
  conversion_fee numeric,              -- convert: our conversion rate
  funding_fee numeric,                 -- convert: the plan's fee for adding money to the Master Wallet
  usd_credited numeric,                -- convert: credited to the Master Wallet
  tx_hash text,
  reference text not null,             -- the merchant's own key: the same request twice is done once
  status text not null default 'pending', -- pending | completed | failed
  failure_reason text,
  created_at timestamptz not null default now()
);
alter table crypto_transactions enable row level security;
create unique index if not exists idx_crypto_tx_ref on crypto_transactions(merchant_id, reference);
create index if not exists idx_crypto_tx_merchant on crypto_transactions(merchant_id, mode, created_at desc);
