-- QuickServe Cashloan — cloud sync schema
--
-- Run this ONCE in your Supabase project:
--   Dashboard → SQL Editor → New query → paste all of this → Run.
--
-- It creates a single shared "ledger" document that the app reads and writes,
-- locked by row-level security so only people you give a login can touch it.

create table if not exists public.ledger (
  id          text primary key default 'main',
  data        jsonb       not null,
  rev         bigint      not null default 1,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

alter table public.ledger enable row level security;

-- Any signed-in user of THIS project may read and write the ledger.
-- You decide who that is under Authentication → Users. There is no delete
-- policy, so the row can never be deleted through the app.
drop policy if exists "members read"   on public.ledger;
drop policy if exists "members insert" on public.ledger;
drop policy if exists "members update" on public.ledger;

create policy "members read"   on public.ledger
  for select using (auth.uid() is not null);

create policy "members insert" on public.ledger
  for insert with check (auth.uid() is not null);

create policy "members update" on public.ledger
  for update using (auth.uid() is not null) with check (auth.uid() is not null);
