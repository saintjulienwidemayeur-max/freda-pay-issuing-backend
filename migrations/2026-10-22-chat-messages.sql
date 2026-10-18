-- Direct chat between a merchant and the Freda Pay Issuing team (dashboard <-> admin panel).
create table if not exists chat_messages (
  id text primary key,                                   -- msg_...
  merchant_id text not null references merchants(id),
  sender text not null,                                  -- merchant | admin
  author_name text,                                      -- who wrote it (merchant team member or admin)
  body text not null,
  read_by_merchant boolean not null default false,       -- set when the merchant opens the chat
  read_by_admin boolean not null default false,          -- set when an admin opens the conversation
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_merchant_idx on chat_messages (merchant_id, created_at);
alter table chat_messages enable row level security;
