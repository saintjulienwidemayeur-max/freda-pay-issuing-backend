-- Old blog addresses keep working: when a published article's slug changes, the old slug is saved here and redirects (301) to the article.
create table if not exists blog_slug_redirects (
  old_slug text primary key,
  post_id text not null,
  created_at timestamptz not null default now()
);
alter table blog_slug_redirects enable row level security;
