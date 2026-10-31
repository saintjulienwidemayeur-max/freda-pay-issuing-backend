-- When the card partner refuses a card for an identity-check reason, it can give a link the cardholder uses to do the check again
-- (facial verification, new document). It is kept on the card so the merchant can read it from the API and the dashboard, not only
-- from the one-time webhook. Never shown after it expires.
alter table cards add column if not exists verification_link text;
alter table cards add column if not exists verification_link_expires_at timestamptz;
