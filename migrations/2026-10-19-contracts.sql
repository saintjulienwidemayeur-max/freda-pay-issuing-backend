-- Internal e-signature: contracts an admin sends to a merchant (or to an outside partner by a private link),
-- signed by both parties inside the platform. The PDF is generated on demand from this row (nothing binary is stored).
create table if not exists contracts (
  id text primary key,                                   -- ctr_...
  title text not null,
  body_html text not null,                               -- sanitized HTML (whitelist); blanks to fill are written [[Label]]
  merchant_id text references merchants(id),             -- null = outside partner, signs by private link
  recipient_name text not null,
  recipient_email text not null,
  token_hash text unique not null,                       -- sha256 of the private link token (external recipients)
  status text not null default 'PENDING_SIGNATURE',      -- PENDING_SIGNATURE | COMPLETED | CANCELLED
  created_by_admin_id text,
  admin_name text not null,
  admin_email text not null,
  admin_signature jsonb not null,                        -- { type: 'typed'|'drawn', name?, font?, image: { w, h, alpha(base64 8-bit mask) } }
  admin_signed_at timestamptz not null default now(),
  admin_signed_ip text,
  fields jsonb not null default '{}'::jsonb,             -- values entered by the signer, by label
  signer_name text,
  signer_email text,
  signer_signature jsonb,
  signed_at timestamptz,
  signed_ip text,
  signed_user_agent text,
  content_hash text,                                     -- sha256 fingerprint of the signed content, set when completed
  viewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists contracts_merchant_idx on contracts (merchant_id, created_at desc);
create index if not exists contracts_status_idx on contracts (status, created_at desc);
alter table contracts enable row level security;
