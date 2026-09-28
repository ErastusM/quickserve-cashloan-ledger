-- QuickServe Credit Desk — migration 003: only owners may use the ledger
--
-- Before this, ANY Supabase login of the project could read and write the
-- whole loan book (supabase/schema.sql: "auth.uid() is not null"). After it,
-- only a login that is an active OWNER in public.staff can. The phone app and
-- the console keep working unchanged for the owner; a credit analyst, a
-- deactivated person or a stranger who signed up sees nothing.
--
-- Run it in the SQL editor AFTER 002 and AFTER
--   select private.seed_owner('<the phone app login>', '<name>');
-- It refuses (and changes nothing) until that is done.
-- Rollback: 003_ledger_lockdown.down.sql.

begin;

do $$
declare
  v_stranger text;
begin
  if to_regclass('private.schema_migrations') is null
     or not exists (select 1 from private.schema_migrations where version = '002') then
    raise exception 'Run migration 002 first. Nothing was changed.';
  end if;
  if exists (select 1 from private.schema_migrations where version = '003') then
    raise exception 'Migration 003 has already been applied. Nothing was changed.';
  end if;

  if not exists (select 1 from public.staff where role = 'owner' and active) then
    raise exception 'No active owner yet. Run select private.seed_owner(''<login email>'', ''<full name>''); for the login the phone app syncs with, then run this again. Nothing was changed.';
  end if;

  -- The login that last saved the ledger (normally the phone app's) must be an
  -- owner, or that phone would stop syncing the moment this runs.
  select l.updated_by into v_stranger
  from public.ledger l
  where nullif(btrim(l.updated_by), '') is not null
    and not exists (
      select 1 from public.staff s
      where s.role = 'owner' and s.active and lower(s.email) = lower(btrim(l.updated_by))
    )
  limit 1;
  if v_stranger is not null then
    raise exception 'The ledger was last saved by % who is not an active owner. Seed that login with select private.seed_owner(''%'', ''<full name>''); (or sync once from an owner''s phone), then run this again. Nothing was changed.', v_stranger, v_stranger;
  end if;
end $$;

drop policy if exists "members read"   on public.ledger;
drop policy if exists "members insert" on public.ledger;
drop policy if exists "members update" on public.ledger;

-- Still no delete policy: the row can never be deleted through the API.
create policy "owners read" on public.ledger
  for select to authenticated
  using ((select public.is_owner()));

create policy "owners insert" on public.ledger
  for insert to authenticated
  with check ((select public.is_owner()));

create policy "owners update" on public.ledger
  for update to authenticated
  using ((select public.is_owner()))
  with check ((select public.is_owner()));

-- Belt and braces: the anonymous API role never needs the ledger, and TRUNCATE
-- is not covered by row-level security, so nobody on the API gets it.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.ledger from anon';
    execute 'revoke truncate, references, trigger on public.ledger from authenticated';
  end if;
end $$;

insert into private.schema_migrations (version) values ('003');

commit;
