-- QuickServe Credit Desk — rollback of migration 003
--
-- Puts the ledger back to the original rule from supabase/schema.sql: ANY
-- signed-in login of this project may read and write it. Use it only if the
-- phone app can't sync after 003 and seeding its login as an owner didn't help.
--
-- Because that rule lets every login in, this refuses while a credit-analyst
-- login exists (they would see the whole loan book). Delete the analyst's login
-- under Authentication → Users first; you can add them again later.
-- (The anon role's ledger grants removed by 003 are not given back: under the
-- original rule anon could never pass "auth.uid() is not null" anyway.)

begin;

do $$
declare
  v_analyst text;
begin
  if to_regclass('private.schema_migrations') is null
     or not exists (select 1 from private.schema_migrations where version = '003') then
    raise exception 'Migration 003 is not applied, so there is nothing to roll back. Nothing was changed.';
  end if;

  select s.email into v_analyst from public.staff s where s.role = 'analyst' limit 1;
  if v_analyst is not null then
    raise exception 'The analyst login % exists and would be able to read the whole ledger after this rollback. Delete that login under Authentication → Users first, then run this again. Nothing was changed.', v_analyst;
  end if;
end $$;

drop policy if exists "owners read"   on public.ledger;
drop policy if exists "owners insert" on public.ledger;
drop policy if exists "owners update" on public.ledger;

-- Exactly as in supabase/schema.sql.
create policy "members read"   on public.ledger
  for select using (auth.uid() is not null);

create policy "members insert" on public.ledger
  for insert with check (auth.uid() is not null);

create policy "members update" on public.ledger
  for update using (auth.uid() is not null) with check (auth.uid() is not null);

delete from private.schema_migrations where version = '003';

commit;
