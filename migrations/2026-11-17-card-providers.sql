-- Second card issuer (Monerails) for merchants, card by card. Existing cards stay on the current issuer (provider = 'maplerad').
alter table cards add column if not exists provider text not null default 'maplerad';
alter table cards add column if not exists provider_card_id text;           -- the card's id at Monerails (null for the current issuer)
create unique index if not exists idx_cards_provider_card on cards(provider_card_id) where provider_card_id is not null;

-- A holder can also be enrolled at Monerails (pilot merchants, sandbox).
alter table maplerad_customers add column if not exists monerails_cardholder_id text;
alter table maplerad_customers add column if not exists monerails_status text;      -- pending | in_review | verified | rejected | failed
alter table maplerad_customers add column if not exists monerails_reason text;

-- A spending rule passed to the issuer itself (Monerails applies it at payment time) instead of being applied after each purchase.
alter table card_rules add column if not exists native boolean not null default false;

-- One operation at a time per card, shared by every server instance.
create table if not exists card_locks (
  card_id text primary key,
  locked_until timestamptz not null
);
alter table card_locks enable row level security;

-- Each display of a card's full number / CVV (30 per hour per card).
create table if not exists card_reveals (
  id text primary key,
  card_id text not null,
  created_at timestamptz not null default now()
);
alter table card_reveals enable row level security;
create index if not exists idx_card_reveals on card_reveals(card_id, created_at desc);
