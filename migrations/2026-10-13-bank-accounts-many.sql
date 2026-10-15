-- Plusieurs comptes bancaires par marchand (avant : un seul) + comptes Zelle. Idempotent.
alter table bank_accounts drop constraint if exists bank_accounts_merchant_id_key;
create index if not exists bank_accounts_merchant_idx on bank_accounts (merchant_id);
-- Type de compte : 'bank' (virement) ou 'zelle' (email ou numéro de téléphone américain).
alter table bank_accounts add column if not exists kind text not null default 'bank';
alter table bank_accounts add column if not exists zelle_contact text;
