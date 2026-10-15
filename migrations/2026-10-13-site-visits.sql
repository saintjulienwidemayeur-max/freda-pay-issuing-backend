-- Visites du site public (mesure d'audience sans cookie, sans adresse IP stockée).
-- À exécuter une fois dans Supabase : SQL Editor > New query > Run.
create table if not exists site_visits (
  id bigint generated always as identity primary key,
  day date not null,                 -- jour UTC de la visite
  visitor_hash text not null,        -- HMAC(secret, ip + navigateur) : jamais l'IP elle-même
  path text not null,                -- page publique visitée, ex. /docs
  referrer_host text,                -- site d'origine (ex. google.com), sans chemin
  device text,                       -- mobile | desktop
  created_at timestamptz not null default now()
);
create index if not exists site_visits_day_idx on site_visits (day);
alter table site_visits enable row level security; -- accessible seulement via la clé service du backend
