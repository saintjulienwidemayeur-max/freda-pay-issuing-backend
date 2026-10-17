-- Extra signers on a contract: more people on the Freda Pay side and/or the merchant (partner) side.
-- Each one gets a private link by email (only the sha256 of the token is stored) and signs without an account.
-- The contract is COMPLETED when the main recipient and every extra signer have signed.
create table if not exists contract_signers (
  id text primary key,                                   -- sgn_...
  contract_id text not null references contracts(id) on delete cascade,
  side text not null,                                    -- FREDA | CLIENT
  name text not null,
  email text not null,
  token_hash text unique not null,
  status text not null default 'PENDING',                -- PENDING | SIGNED
  signature jsonb,                                       -- same shape as contracts.admin_signature
  signed_at timestamptz,
  signed_ip text,
  signed_user_agent text,
  invited_by_admin_id text,
  created_at timestamptz not null default now()
);
create index if not exists contract_signers_contract_idx on contract_signers (contract_id, created_at);
alter table contract_signers enable row level security;
