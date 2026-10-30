-- Crypto wallet: a merchant gets stablecoin deposit addresses (USDT / USDC on several chains). Every deposit is converted to USD by the
-- card partner and credited to the Master Wallet automatically.
create table if not exists crypto_addresses (
  id text primary key,
  merchant_id text not null references merchants(id),
  mode text not null default 'sandbox',
  maplerad_customer_id text not null,
  maplerad_address_id text,
  address text not null,
  chain text not null,                 -- solana | ethereum | polygon | bsc | tron
  coin text not null,                  -- USDT | USDC
  offramp boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table crypto_addresses enable row level security;
create unique index if not exists idx_crypto_addr_unique on crypto_addresses(merchant_id, mode, chain, coin);
create index if not exists idx_crypto_addr_address on crypto_addresses(address);

-- One row per deposit notification. The partner's reference is the identity: the same event delivered twice is stored (and credited) once.
create table if not exists crypto_deposits (
  id text primary key,
  merchant_id text not null references merchants(id),
  address_id text references crypto_addresses(id),
  mode text not null default 'sandbox',
  provider_reference text not null,
  chain text,
  coin text,
  tx_hash text,
  settled_usd numeric,                 -- what the partner credited to our business wallet (after its own fee)
  gross_usd numeric,                   -- what the customer sent, estimated from the partner's rate
  fee_usd numeric,                     -- everything the merchant paid (our rate)
  provider_cost_usd numeric,           -- what the partner kept
  credited_usd numeric,                -- credited to the merchant's Master Wallet
  status text not null default 'credited', -- credited | review
  note text,
  created_at timestamptz not null default now()
);
alter table crypto_deposits enable row level security;
create unique index if not exists idx_crypto_dep_ref on crypto_deposits(provider_reference);
create index if not exists idx_crypto_dep_merchant on crypto_deposits(merchant_id, mode, created_at desc);
