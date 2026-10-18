-- Public API usage per merchant and per day (month / week / day views in the admin panel) and API access blocks.
create table if not exists api_usage_daily (
  merchant_id text not null references merchants(id),
  day date not null,                                     -- UTC day
  requests integer not null default 0,
  limited integer not null default 0,                    -- answered 429 (over the rate limit)
  errors integer not null default 0,                     -- other 4xx / 5xx
  live integer not null default 0,
  sandbox integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (merchant_id, day)
);
create index if not exists api_usage_daily_day_idx on api_usage_daily (day);
alter table api_usage_daily enable row level security;

-- A blocked merchant gets 403 API_BLOCKED on every /v1 call, all keys, until `until` (null = until an admin lifts it).
create table if not exists api_blocks (
  merchant_id text primary key references merchants(id),
  reason text,
  blocked_by text,
  blocked_at timestamptz not null default now(),
  until timestamptz
);
alter table api_blocks enable row level security;
