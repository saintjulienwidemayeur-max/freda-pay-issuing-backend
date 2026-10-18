-- Chat photos, and the error codes an API client provokes (admin "Santé des intégrations").
alter table chat_messages add column if not exists attachment_path text;
alter table chat_messages add column if not exists attachment_name text;
alter table chat_messages add column if not exists attachment_type text;
alter table api_usage_daily add column if not exists codes jsonb not null default '{}'::jsonb;
