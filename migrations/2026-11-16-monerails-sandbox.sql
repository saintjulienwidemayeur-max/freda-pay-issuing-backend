-- Monerails (second card issuer), SANDBOX ONLY: the webhook events the admin panel shows.
-- Holders and cards are read from Monerails' API; nothing here touches merchants, merchant cards or the ledger.
create table if not exists monerails_events (
  id text primary key,                 -- Monerails' event id (the same event delivered twice is stored once)
  type text not null,                  -- card.issued, card.transaction, cardholder.kyc_updated, ...
  livemode boolean not null default false,
  object_id text,                      -- the card / holder / transaction it is about
  summary text,
  payload jsonb not null,
  received_at timestamptz not null default now()
);
alter table monerails_events enable row level security;
create index if not exists idx_monerails_events_received on monerails_events(received_at desc);
create index if not exists idx_monerails_events_object on monerails_events(object_id);
