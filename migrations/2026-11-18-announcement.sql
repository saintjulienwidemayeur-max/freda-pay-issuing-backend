-- One row per (campaign, merchant): claimed before sending so a restart or two servers never send the same announcement twice.
create table if not exists announcement_deliveries (
  campaign text not null,
  merchant_id text not null,
  attempts integer not null default 0,
  email_sent_at timestamptz,
  chat_sent_at timestamptz,
  error text,
  updated_at timestamptz not null default now(),
  primary key (campaign, merchant_id)
);
alter table announcement_deliveries enable row level security;
