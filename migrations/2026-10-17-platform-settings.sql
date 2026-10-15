-- Platform settings editable from the admin panel (exchange rate HTG per USD).
create table if not exists platform_settings (
  key text primary key,
  value text not null,
  updated_by text,
  updated_at timestamptz not null default now()
);
alter table platform_settings enable row level security;
