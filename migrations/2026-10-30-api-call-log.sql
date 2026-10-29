-- One line per call of the public API (/v1/*): who, which route, the result and, for an error, its message.
-- No request or response bodies (they can hold keys, ID images and card data). Lines older than 14 days are deleted by the server.
create table if not exists api_call_log (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  merchant_id text not null,
  method text not null,
  route text not null,
  path text,
  status integer not null,
  code text,
  message text,
  ms integer,
  mode text,
  request_id text
);
create index if not exists idx_api_call_log_merchant on api_call_log (merchant_id, created_at desc);
create index if not exists idx_api_call_log_created on api_call_log (created_at);
alter table api_call_log enable row level security;
