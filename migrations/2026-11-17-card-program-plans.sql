-- Plans of the new card program (Startup / Pro / Premium): the member's plan, the paid period, and the free cards used this month.
alter table card_program_members add column if not exists plan text not null default 'startup';
alter table card_program_members add column if not exists paid_until timestamptz;
alter table card_program_members add column if not exists renewal_failed_at timestamptz;
alter table card_program_members add column if not exists free_cards_month text;     -- 'YYYY-MM' the counter below belongs to
alter table card_program_members add column if not exists free_cards_used integer not null default 0;
