-- Card payments (Tranzak) + USD Gateway balance.
alter table payments add column if not exists provider text not null default 'plopplop'; -- 'plopplop' | 'tranzak'
alter table payments add column if not exists provider_transaction_id text;
alter table payments add column if not exists failure_reason text;
create index if not exists payments_provider_pending_idx on payments (provider, status, created_at);

-- Withdrawals can now be in USD (the USD Gateway balance, fed by card payments).
alter table payouts add column if not exists currency text not null default 'HTG';

-- Per-merchant overrides (admin) for card fees and the USD withdrawal fee.
alter table merchant_pricing add column if not exists gateway_card_pct numeric;
alter table merchant_pricing add column if not exists gateway_card_fixed_usd numeric;
alter table merchant_pricing add column if not exists payout_bank_fee_usd numeric;
