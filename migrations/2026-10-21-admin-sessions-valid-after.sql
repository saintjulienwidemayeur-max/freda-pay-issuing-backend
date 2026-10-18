-- A password change (own or admin) ends every session opened before it. Merchants and team members already had this column.
alter table admin_users add column if not exists sessions_valid_after timestamptz;
