-- Hosted checkout page for card payments created through the API (plugins, custom sites).
alter table payments add column if not exists checkout_token text;
alter table payments add column if not exists card_client_secret text;
alter table payments add column if not exists card_publishable_key text;
alter table payments add column if not exists return_url text;
