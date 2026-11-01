-- Partner profit reports prepared by an admin: the profit of a period (filled from the real fees collected),
-- the expenses entered by hand (amount + reason), the partner's percentage and the resulting share.
create table if not exists partner_reports (
  id text primary key,
  title text not null,
  partner_name text not null,
  mode text not null default 'live',
  period_from date not null,
  period_to date not null,
  revenue_usd numeric not null default 0,
  partner_cost_usd numeric not null default 0,
  profit_usd numeric not null default 0,        -- the base the percentage applies to, before expenses (can be edited by hand)
  expenses jsonb not null default '[]'::jsonb,  -- [{ label, amount_usd }]
  expenses_total_usd numeric not null default 0,
  net_usd numeric not null default 0,           -- profit - expenses
  profit_pct numeric not null,                  -- the partner's percentage, e.g. 13
  partner_share_usd numeric not null default 0,
  our_share_usd numeric not null default 0,
  notes text,
  created_by text,
  last_sent_to text,
  last_sent_at timestamptz,
  created_at timestamptz not null default now()
);
alter table partner_reports enable row level security;
create index if not exists idx_partner_reports_created on partner_reports(created_at desc);
