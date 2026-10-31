-- The identity details of the person behind a merchant account, asked ONCE (for the crypto wallet: the partner needs them to make its
-- customer Tier 1) and kept so nobody is asked twice. Never returned by the API.
create table if not exists merchant_identity (
  merchant_id text primary key references merchants(id),
  date_of_birth text,                  -- YYYY-MM-DD
  identification_number text,
  phone text,                          -- with the country code
  address jsonb,                       -- { street, city, state, postal_code, country }
  source text,                         -- merchant | holder (taken from a card holder already enrolled)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table merchant_identity enable row level security;
