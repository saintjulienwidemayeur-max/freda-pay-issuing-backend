-- Freda Pay Issuing : Supabase (Postgres) schema
-- Run this ONCE in the Supabase SQL Editor (Project → SQL Editor → New query).
-- Safe to re-run: every statement uses IF NOT EXISTS / OR REPLACE.

create extension if not exists pgcrypto;

create table if not exists merchants (
  id text primary key,
  business_name text not null,
  entity_type text,
  account_type text not null default 'individual', -- 'business' | 'individual'
  email text unique not null,
  phone text,
  password_hash text not null,
  kyc_status text not null default 'not_started',   -- not_started | submitted | verified
  kyb_status text not null default 'not_started',
  live_enabled boolean not null default false, -- deprecated, kept for old rows; use the two below
  gateway_live_enabled boolean not null default false, -- Gateway: self-serve once KYC/KYB is verified
  issuing_live_enabled boolean not null default false,  -- Issuing: ALWAYS requires a separate admin-approved request, even after KYC/KYB
  active_mode text not null default 'sandbox', -- 'sandbox' | 'live' - which the dashboard currently shows/writes; toggled by the merchant, only settable to 'live' once gateway_live_enabled is true
  deleted_at timestamptz,
  gateway_plan text not null default 'standard', -- 'standard' | 'pro' | 'business'
  issuing_plan text not null default 'startup',  -- 'startup' | 'pro' | 'premium'
  email_verified boolean not null default false,
  created_at timestamptz not null default now()
);
-- Safe to run even on a merchants table created before these columns existed:
alter table merchants add column if not exists gateway_plan text not null default 'standard';
alter table merchants add column if not exists issuing_plan text not null default 'startup';
alter table merchants add column if not exists email_verified boolean not null default false;
alter table merchants add column if not exists onboarding jsonb; -- answers from the signup wizard (product, business description, expected volume, ...)
alter table merchants add column if not exists deleted_at timestamptz; -- set by an admin to deactivate an account without losing its history
-- The old single `plan` column (free/pro/enterprise) is superseded by the two
-- columns above. Drop it if it exists from an earlier version of this schema:
alter table merchants drop column if exists plan;

-- Outbound webhooks: a merchant's own server URL that Freda Pay notifies on
-- events (payment.succeeded, payout.succeeded, card.created, etc.) instead
-- of the merchant having to poll. One merchant can register at most one
-- endpoint for now (kept simple - extend to multiple if ever needed).
create table if not exists webhook_endpoints (
  id text primary key,
  merchant_id text unique not null references merchants(id),
  url text not null,
  secret text not null,          -- shown once at creation; used to HMAC-sign every delivery
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table webhook_endpoints enable row level security;

-- Team members invited by the account owner. They sign in with their own
-- email + password and see the owner's account with a limited role.
-- role: 'admin' (everything except managing the team) | 'viewer' (read only)
create table if not exists team_members (
  id text primary key,
  merchant_id text not null references merchants(id),
  email text unique not null,
  role text not null default 'viewer',
  status text not null default 'invited', -- invited | active
  password_hash text,
  invite_token_hash text,
  invite_expires_at timestamptz,
  created_at timestamptz not null default now()
);
alter table team_members enable row level security;

-- One-time codes emailed to verify an account's email address at signup.
create table if not exists email_otps (
  id text primary key,
  merchant_id text not null references merchants(id),
  code_hash text not null,
  purpose text not null default 'signup',
  expires_at timestamptz not null,
  attempts int not null default 0,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table email_otps enable row level security;

create table if not exists api_keys (
  id text primary key,
  merchant_id text not null references merchants(id),
  key_id text unique not null,
  secret_hash text not null,
  mode text not null, -- 'test' | 'live'
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists idx_api_keys_secret_hash on api_keys(secret_hash);

create table if not exists ledger_entries (
  id bigint generated always as identity primary key,
  merchant_id text not null references merchants(id),
  wallet text not null,   -- 'gateway' | 'master_wallet'
  type text not null,     -- 'payment_credit' | 'payout_debit' | 'wallet_topup' | 'wallet_debit' | 'manual_adjustment'
  amount numeric not null, -- positive = credit, negative = debit
  currency text not null default 'HTG',
  reference text,
  related_id text,
  created_at timestamptz not null default now()
);
create index if not exists idx_ledger_merchant on ledger_entries(merchant_id, wallet, currency);

create table if not exists payments (
  id text primary key,
  merchant_id text not null references merchants(id),
  own_reference text not null,
  plopplop_reference text unique not null,
  plopplop_transaction_id text,
  amount numeric not null,
  currency text not null default 'HTG',
  method text not null,
  status text not null default 'pending', -- pending | succeeded | failed
  fee numeric,
  net_amount numeric,
  checkout_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(merchant_id, own_reference)
);

create table if not exists payouts (
  id text primary key,
  merchant_id text not null references merchants(id),
  own_reference text not null,
  plopplop_reference text unique not null,
  amount numeric not null,
  method text not null,
  recipient text not null,
  status text not null default 'pending', -- pending | success | failed
  fee numeric,
  api_reference text,
  plopplop_transaction_id text,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(merchant_id, own_reference)
);

create table if not exists wallet_topups (
  id text primary key,
  merchant_id text not null references merchants(id),
  method text not null, -- 'moncash' | 'natcash' | 'zelle' | 'bank_transfer'
  status text not null default 'pending', -- pending | succeeded | failed | awaiting_review
  amount_htg numeric,        -- moncash/natcash: gross HTG the merchant paid
  amount_usd numeric,        -- zelle/bank_transfer: USD amount the merchant claims to have sent
  fee_htg numeric,           -- moncash/natcash: processing fee withheld (4% + 5 HTG)
  exchange_rate numeric,     -- HTG per 1 USD used for the conversion (133)
  credited_usd numeric,      -- actual USD credited to the Master Wallet once confirmed
  own_reference text not null,
  plopplop_reference text,        -- moncash/natcash only
  plopplop_transaction_id text,
  receipt_path text,               -- zelle/bank_transfer: path in Supabase Storage
  receipt_filename text,
  checkout_url text,                -- moncash/natcash: URL the customer completes payment on
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(merchant_id, own_reference)
);
alter table wallet_topups add column if not exists checkout_url text;

-- Storage buckets. The backend also creates them automatically on first
-- upload, but you can create them now (safe to re-run):
--   receipts, verification-documents -> private (viewed by admin via signed URL)
--   blog-images                      -> public (blog covers)
insert into storage.buckets (id, name, public) values
  ('receipts', 'receipts', false),
  ('verification-documents', 'verification-documents', false),
  ('blog-images', 'blog-images', true)
on conflict (id) do nothing;

-- Payment Links: a merchant-created shareable checkout page. Anyone with the
-- link can pay (MonCash, Natcash, or card) without needing a Freda Pay account.
-- `id` doubles as the unguessable public slug in the checkout URL.
create table if not exists payment_links (
  id text primary key,
  merchant_id text not null references merchants(id),
  amount numeric,             -- null = customer enters their own amount
  currency text not null default 'HTG',
  description text,
  status text not null default 'active', -- active | disabled
  mode text not null default 'sandbox', -- the merchant's mode when the link was created - payments made through it inherit this
  created_at timestamptz not null default now()
);
alter table payment_links enable row level security;
alter table payment_links add column if not exists mode text not null default 'sandbox';

-- Card issuing (Maplerad). One Maplerad customer per Freda Pay merchant,
-- created once via /customers/enroll, then reused for every card that
-- merchant issues.
-- A merchant may enroll several card holders (e.g. different employees) and
-- pick which one an individual card is issued for at creation time.
create table if not exists maplerad_customers (
  id text primary key,
  merchant_id text not null references merchants(id),
  maplerad_customer_id text unique,   -- null until enrollment succeeds
  status text not null default 'pending', -- pending | enrolled | failed
  -- Holder profile submitted for enrollment (kept for our own records/support).
  first_name text,
  last_name text,
  email text,
  country text,
  dob text,
  identification_number text,
  phone_number text,
  phone_short_code text,
  address jsonb,
  photo_url text,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Safe to run even on a table created before multi-holder support existed:
-- drop the old one-holder-per-merchant constraint if present, and add the
-- new photo column.
alter table maplerad_customers drop constraint if exists maplerad_customers_merchant_id_key;
alter table maplerad_customers add column if not exists photo_url text;

-- Card creation on Maplerad is ASYNCHRONOUS: the initial POST only confirms
-- the request was accepted, and Maplerad notifies the final result (success/
-- failure, real card id, masked PAN) via webhook - see webhook_events below.
create table if not exists cards (
  id text primary key,
  merchant_id text not null references merchants(id),
  own_reference text not null,        -- our own idempotency key
  maplerad_reference text unique,     -- Maplerad's OWN reference, returned at creation and echoed back in the webhook - this is what correlates the async result, not own_reference
  maplerad_card_id text unique,       -- filled in once the webhook confirms creation
  kind text not null default 'individual', -- individual | business
  brand text not null,                -- VISA | MASTERCARD
  currency text not null default 'USD',
  status text not null default 'pending', -- pending | active | disabled | terminated | failed
  masked_pan text,
  holder_name text,
  holder_id text references maplerad_customers(id), -- which holder this individual card was issued for (null for business cards)
  initial_amount numeric,             -- cents requested at creation
  creation_fee numeric not null default 0, -- USD flat fee charged at creation (per Issuing plan)
  balance numeric not null default 0, -- USD, tracked internally (funded via Master Wallet)
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(merchant_id, own_reference)
);
alter table cards add column if not exists creation_fee numeric not null default 0;
alter table cards add column if not exists holder_id text references maplerad_customers(id);

-- Raw webhook deliveries, kept for debugging/replay and to make each event
-- idempotent (Maplerad may resend the same event after a delivery failure).
create table if not exists webhook_events (
  id text primary key,          -- the provider's own event/message id (e.g. svix-id)
  provider text not null,       -- 'maplerad' | 'plopplop' (future)
  event_type text,
  payload jsonb,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

-- Balance is always DERIVED by summing ledger_entries (never a stored running total),
-- so it can never drift out of sync. Exposed as an RPC so the backend can fetch it
-- in one round trip via PostgREST: POST /rest/v1/rpc/get_balance
create or replace function get_balance(p_merchant_id text, p_wallet text, p_currency text)
returns numeric
language sql
stable
as $$
  select coalesce(sum(amount), 0)
  from ledger_entries
  where merchant_id = p_merchant_id and wallet = p_wallet and currency = p_currency;
$$;

-- Row Level Security: the backend talks to Supabase with the service_role key,
-- which bypasses RLS entirely, so these tables can stay locked down to that one
-- trusted server context (defense in depth in case the anon/publishable key is
-- ever used against this project directly).
alter table merchants enable row level security;
alter table api_keys enable row level security;
alter table ledger_entries enable row level security;
alter table payments enable row level security;
alter table payouts enable row level security;
alter table wallet_topups enable row level security;
alter table payment_links enable row level security;
alter table maplerad_customers enable row level security;
alter table cards enable row level security;
alter table webhook_events enable row level security;
-- No policies are created for the anon/authenticated roles on purpose: only
-- service_role (used exclusively by the Freda Pay backend) can read/write here.

-- Freda Pay's own staff (not merchants) who can review KYC/KYB and publish
-- the blog. Separate from `merchants` - a completely different login.
create table if not exists admin_users (
  id text primary key,
  email text unique not null,
  password_hash text not null,
  name text not null,
  role text not null default 'editor', -- 'owner' | 'admin' | 'editor' (editor: blog only, no compliance review)
  created_at timestamptz not null default now()
);
alter table admin_users enable row level security;

-- KYC/KYB documents a merchant submitted, and the admin review outcome.
create table if not exists verification_submissions (
  id text primary key,
  merchant_id text not null references merchants(id),
  kind text not null, -- 'kyc' | 'kyb'
  documents jsonb not null, -- [{ label, url }]
  status text not null default 'submitted', -- submitted | approved | rejected
  reviewed_by text references admin_users(id),
  reviewed_at timestamptz,
  rejection_reason text,
  created_at timestamptz not null default now()
);
alter table verification_submissions enable row level security;

-- Blog posts, written by admin staff, public once status = 'published'.
create table if not exists blog_posts (
  id text primary key,
  slug text unique not null,
  title text not null,
  excerpt text,
  cover_image_url text,
  content_markdown text not null,
  tags text[] default '{}',
  status text not null default 'draft', -- draft | published
  author_id text references admin_users(id),
  author_name text,
  meta_description text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table blog_posts enable row level security;
create index if not exists idx_blog_posts_status_published on blog_posts(status, published_at desc);

-- Per-merchant fee overrides, set by an admin. Any null field falls back to
-- the merchant's plan-based pricing (config.js). This is how a merchant can
-- get custom pricing instead of their plan's standard rates.
create table if not exists merchant_pricing (
  merchant_id text primary key references merchants(id),
  card_creation_usd numeric,
  card_recharge_usd numeric,
  card_withdrawal_usd numeric,
  card_decline_usd numeric,
  wallet_funding_pct numeric,
  gateway_pct numeric,
  gateway_fixed_htg numeric,
  payout_fee_htg numeric,
  updated_at timestamptz not null default now()
);
alter table merchant_pricing enable row level security;

-- Admin-initiated manual credits to a merchant's Master Wallet or Gateway
-- balance (e.g. confirming a bank transfer, a goodwill adjustment).
create table if not exists admin_wallet_credits (
  id text primary key,
  merchant_id text not null references merchants(id),
  admin_id text not null references admin_users(id),
  wallet text not null, -- 'master_wallet' | 'gateway'
  amount numeric not null,
  currency text not null,
  note text,
  created_at timestamptz not null default now()
);
alter table admin_wallet_credits enable row level security;

-- A merchant disputing one of their own payments (chargeback-style flow).
create table if not exists disputes (
  id text primary key,
  merchant_id text not null references merchants(id),
  payment_id text not null references payments(id),
  reason text not null,
  details text,
  status text not null default 'open', -- open | resolved | rejected
  admin_note text,
  resolved_by text references admin_users(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
alter table disputes enable row level security;

-- Invitations for new Freda Pay admin staff (owner/admin role only - mirrors
-- the merchant team_members invite flow, but for the admin_users table).
alter table admin_users add column if not exists status text not null default 'active'; -- invited | active
alter table admin_users add column if not exists invite_token_hash text;
alter table admin_users add column if not exists invite_expires_at timestamptz;
alter table admin_users alter column password_hash drop not null; -- an invited-but-not-yet-accepted admin has no password yet

-- Every fee Freda Pay has ever charged, one row per event, so admin can see
-- real revenue (and, for Issuing kinds, real profit against provider cost)
-- per merchant and per day/week - not reverse-engineered from debit totals
-- that bundle the fee together with the principal amount.
create table if not exists fee_revenue (
  id text primary key,
  merchant_id text not null references merchants(id),
  kind text not null, -- gateway_payment | card_creation | card_recharge | card_withdrawal | wallet_funding | payout
  amount numeric not null,
  currency text not null,
  related_id text,
  created_at timestamptz not null default now()
);
alter table fee_revenue enable row level security;
create index if not exists idx_fee_revenue_merchant on fee_revenue(merchant_id, created_at desc);

alter table merchants add column if not exists gateway_live_enabled boolean not null default false;
alter table merchants add column if not exists issuing_live_enabled boolean not null default false;
alter table merchants add column if not exists active_mode text not null default 'sandbox';
-- One-time backfill: merchants already marked live under the old single flag keep Gateway live
-- (Issuing stays false - it now always needs its own explicit request, per the new policy).
update merchants set gateway_live_enabled = true where live_enabled = true and gateway_live_enabled = false;

alter table payments add column if not exists mode text not null default 'sandbox';
alter table payouts add column if not exists mode text not null default 'sandbox';
alter table wallet_topups add column if not exists mode text not null default 'sandbox';
alter table cards add column if not exists mode text not null default 'sandbox';

-- A merchant's request for Issuing to go live - always reviewed by an admin,
-- never auto-approved just because KYC/KYB passed.
create table if not exists issuing_access_requests (
  id text primary key,
  merchant_id text not null references merchants(id),
  status text not null default 'pending', -- pending | approved | rejected
  note text,
  reviewed_by text references admin_users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table issuing_access_requests enable row level security;

-- ===== Live Maplerad: every record that touches the provider now knows its environment =====
-- Sandbox and live are separate worlds. A holder created on the sandbox provider account does
-- not exist on the live one, fees/credits must not mix play money with real money, etc.
-- (Ledger balances are separated by wallet name instead: 'live:master_wallet' / 'live:gateway' -
--  no column or function change needed, and every existing row stays a valid sandbox row.)
alter table maplerad_customers add column if not exists mode text not null default 'sandbox';
alter table fee_revenue add column if not exists mode text not null default 'sandbox';
alter table admin_wallet_credits add column if not exists mode text not null default 'sandbox';
alter table wallet_topups add column if not exists mode text not null default 'sandbox';

-- ===== Plans are chosen per environment: a Sandbox plan never carries over to Live =====
-- (gateway_plan / issuing_plan stay the SANDBOX plans; these two are the LIVE plans.)
alter table merchants add column if not exists live_gateway_plan text not null default 'standard';
alter table merchants add column if not exists live_issuing_plan text not null default 'startup';

-- ===== Email code (OTP) at EVERY login: merchant owners, team members and admin staff =====
-- One short-lived challenge per login attempt. No foreign key on purpose: the subject can be a
-- merchant, a team member or an admin. The code itself is never stored, only its hash.
create table if not exists login_challenges (
  id text primary key,
  subject_type text not null, -- 'merchant' | 'member' | 'admin'
  subject_id text not null,
  merchant_id text,           -- owning merchant for 'merchant' / 'member'
  role text,                  -- team role for 'member'
  email text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table login_challenges enable row level security;
create index if not exists idx_login_challenges_subject on login_challenges(subject_type, subject_id, created_at desc);

-- ===== Manual deposits (Zelle / bank transfer): reviewed by an admin who sees the receipt =====
alter table wallet_topups add column if not exists admin_note text;
alter table wallet_topups add column if not exists reviewed_by text references admin_users(id);
alter table wallet_topups add column if not exists reviewed_at timestamptz;

-- ===== Fix: suspending a merchant used to switch the legacy live flag off, and reactivating never switched it back =====
-- gateway_live_enabled is the real flag; make the legacy mirror agree for every row (suspended ones included).
update merchants set live_enabled = gateway_live_enabled where live_enabled is distinct from gateway_live_enabled;

-- ===== Forgotten password: single-use, one-hour reset links sent by email =====
-- Only the hash of the link's token is stored (like invitation tokens), never the token itself.
create table if not exists password_resets (
  id text primary key,
  subject_type text not null, -- 'merchant' | 'member'
  subject_id text not null,
  email text not null,
  token_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
alter table password_resets enable row level security;
create index if not exists idx_password_resets_token on password_resets(token_hash);
-- A password reset ends every session opened before it (a session token older than this moment is refused).
alter table merchants add column if not exists sessions_valid_after timestamptz;
alter table team_members add column if not exists sessions_valid_after timestamptz;

-- ===== Real numbers for the admin: what the partners cost us, and what the cards really spend =====
-- The cost the PARTNER charged us on each fee event (USD). Null on older rows (the admin then falls back to the known price list).
alter table fee_revenue add column if not exists partner_cost_usd numeric;

-- Every card transaction notification from the card partner (purchases, declines, refunds...), one row each.
create table if not exists card_transactions (
  id text primary key,
  merchant_id text not null references merchants(id),
  card_id text not null references cards(id),
  mode text not null default 'sandbox',
  provider_reference text not null,   -- the partner's own reference: the same event delivered twice is stored once
  type text not null,                 -- AUTHORIZATION | AUTHORIZATION-SETTLEMENT | DECLINE | REVERSAL | REFUND | CROSS-BORDER ...
  status text,
  direction text,                     -- DEBIT | CREDIT
  amount_usd numeric,
  currency text,
  description text,
  merchant_name text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table card_transactions enable row level security;
create unique index if not exists idx_card_tx_ref on card_transactions(card_id, provider_reference);
create index if not exists idx_card_tx_merchant on card_transactions(merchant_id, mode, occurred_at desc);

-- Clean-up of figures that were wrong BEFORE this fix: a card creation that failed (and was refunded) must not count as income.
delete from fee_revenue
where kind = 'card_creation'
  and related_id in (select id from cards where status in ('failed', 'pending'));

-- ===== Withdrawals: bank transfer (done by hand by the team) + fees on MonCash/Natcash =====
-- The merchant's bank account, kept for bank-transfer withdrawals (one per merchant).
create table if not exists bank_accounts (
  id text primary key,
  merchant_id text not null unique references merchants(id),
  holder_name text not null,
  bank_name text not null,
  country text not null,               -- ISO 3166 alpha-2
  currency text not null default 'HTG',-- the currency of the destination account
  account_number text,
  iban text,
  swift text,
  routing_number text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table bank_accounts enable row level security;

-- A bank withdrawal keeps a COPY of the bank details as they were when it was requested.
alter table payouts add column if not exists bank_details jsonb;
alter table payouts add column if not exists bank_reference text;      -- transfer reference entered by the team when it is sent
alter table payouts add column if not exists partner_fee_htg numeric;  -- what the payment partner charged us to send a MonCash/Natcash withdrawal
alter table payouts add column if not exists admin_note text;
alter table payouts add column if not exists reviewed_by text references admin_users(id);
alter table payouts add column if not exists reviewed_at timestamptz;
-- Per-merchant custom withdrawal fees (null = the standard ones)
alter table merchant_pricing add column if not exists payout_mobile_pct numeric;
alter table merchant_pricing add column if not exists payout_bank_fee_htg numeric;

-- ===== Cards: a deleted card disappears from the merchant's lists (the row is kept for the ledger and for audit) =====
alter table cards add column if not exists deleted_at timestamptz;

-- ===== Monthly plan renewal (real-money plans only: the LIVE ones) =====
-- When the next monthly charge is due (null = a free plan, nothing to renew), and since when a renewal could not be paid.
alter table merchants add column if not exists live_gateway_renews_at timestamptz;
alter table merchants add column if not exists live_issuing_renews_at timestamptz;
alter table merchants add column if not exists live_gateway_unpaid_since timestamptz;
alter table merchants add column if not exists live_issuing_unpaid_since timestamptz;


-- Messages sent by the admin team to merchants (one, all, live, sandbox) from administration@fredapay.com.
create table if not exists admin_messages (
  id text primary key,
  sent_by text,
  sent_by_email text,
  audience text not null,
  merchant_id text,
  subject text not null,
  body text not null,
  recipients integer not null default 0,
  sent integer not null default 0,
  failed integer not null default 0,
  created_at timestamptz not null default now()
);

-- Inbox: emails received at the admin address (Brevo Inbound Parsing -> POST /webhooks/inbound-email).
create table if not exists admin_inbox (
  id text primary key,
  message_id text unique,
  from_email text not null,
  from_name text,
  subject text,
  body text,
  merchant_id text,
  is_read boolean not null default false,
  replied_at timestamptz,
  last_reply text,
  received_at timestamptz not null default now()
);
alter table admin_inbox enable row level security;

alter table admin_inbox add column if not exists ack_sent_at timestamptz; -- automatic acknowledgement of receipt

-- Audit trail of sensitive actions taken by the admin team (card deletion, webhook re-sends...).
create table if not exists admin_audit_log (
  id text primary key,
  admin_id text,
  admin_email text,
  action text not null,
  target_type text,
  target_id text,
  merchant_id text,
  details jsonb,
  created_at timestamptz not null default now()
);
alter table admin_audit_log enable row level security;
