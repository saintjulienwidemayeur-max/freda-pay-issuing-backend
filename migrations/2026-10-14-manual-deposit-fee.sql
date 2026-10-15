-- Frais de financement retenus sur les dépôts Zelle / virement (USD). Idempotent.
alter table wallet_topups add column if not exists fee_usd numeric;
