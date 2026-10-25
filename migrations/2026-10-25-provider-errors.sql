-- What the card provider answered when an operation failed (raw message, admin-only): the merchant only sees a short French sentence.
create table if not exists provider_errors (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  mode text,                                              -- sandbox | live
  merchant_id text,
  route text,                                             -- our route, e.g. POST /v1/cards/business
  method text,
  path text,                                              -- the provider path, e.g. /issuing/business
  http_status integer,
  message text,                                           -- raw provider message
  request_keys text,                                      -- names of the fields we sent (never their values)
  shown_to_merchant text
);
create index if not exists provider_errors_created_idx on provider_errors (created_at desc);
alter table provider_errors enable row level security;
