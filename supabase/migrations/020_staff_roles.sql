-- QuickServe — staff roles (owner, credit analyst)
--
-- Run this ONCE in Supabase: Dashboard → SQL Editor → New query → paste all of
-- this → Run. It is safe to run again.
--
-- What it does
--   * Adds a `staff` list. Everyone who can sign in today becomes an OWNER, so
--     nobody loses access when this runs.
--   * Only owners can read or change the loan book (ledger) and its history.
--     A CREDIT ANALYST signs in to the same admin portal but sees only
--     Applications; the database itself refuses them the loan book.
--   * New logins have no access until an owner adds them on the portal's
--     Settings → Staff & roles card.
--   * Gives analysts a safe "is this a returning client?" lookup that returns
--     only the client's reference, name and loan count, not the whole book.

-- ------------------------------------------------------------------ staff ---
create table if not exists public.staff (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  email           text not null,
  role            text not null check (role in ('owner', 'analyst')),
  approval_limit  numeric(12,2),          -- N$; analysts only. null = cannot approve
  added_at        timestamptz not null default now(),
  added_by        text
);
alter table public.staff enable row level security;
-- Rows are added only through staff_add() below; the policies decide the rest.
revoke all on public.staff from anon, authenticated;
grant select, update, delete on public.staff to authenticated;

-- Nobody loses access: on the FIRST run only, everyone who can sign in today
-- becomes an owner. Running this file again never adds anyone.
insert into public.staff (user_id, email, role, added_by)
select id, coalesce(email, id::text), 'owner', 'roles installed' from auth.users
where not exists (select 1 from public.staff)
on conflict (user_id) do nothing;

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff where user_id = auth.uid() and role = 'owner');
$$;
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff where user_id = auth.uid());
$$;

drop policy if exists "staff read own or owner reads all" on public.staff;
create policy "staff read own or owner reads all" on public.staff
  for select to authenticated using (user_id = auth.uid() or public.is_owner());
drop policy if exists "owners change staff" on public.staff;
create policy "owners change staff" on public.staff
  for update to authenticated using (public.is_owner()) with check (public.is_owner());
drop policy if exists "owners remove staff" on public.staff;
create policy "owners remove staff" on public.staff
  for delete to authenticated using (public.is_owner() and user_id <> auth.uid());

-- Owners add someone by the email they sign in with (their Supabase login must
-- exist first: Authentication → Users → Add user).
create or replace function public.staff_add(p_email text, p_role text, p_limit numeric default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_email text;
begin
  if not public.is_owner() then raise exception 'Only an owner can add staff.'; end if;
  if p_role not in ('owner', 'analyst') then raise exception 'Unknown role.'; end if;
  select id, email into v_id, v_email from auth.users where lower(email) = lower(trim(p_email));
  if v_id is null then raise exception 'No login with that email. Create it in Supabase first (Authentication → Users → Add user).'; end if;
  insert into public.staff (user_id, email, role, approval_limit, added_by)
  values (v_id, v_email, p_role, case when p_role = 'analyst' then p_limit end, (select email from auth.users where id = auth.uid()))
  on conflict (user_id) do update set role = excluded.role, approval_limit = excluded.approval_limit;
  return jsonb_build_object('user_id', v_id, 'email', v_email, 'role', p_role);
end $$;
revoke all on function public.staff_add(text, text, numeric) from public;
grant execute on function public.staff_add(text, text, numeric) to authenticated;

-- ------------------------------------------------- loan book: owners only ---
drop policy if exists "members read"   on public.ledger;
drop policy if exists "members insert" on public.ledger;
drop policy if exists "members update" on public.ledger;
drop policy if exists "owners read"    on public.ledger;
drop policy if exists "owners insert"  on public.ledger;
drop policy if exists "owners update"  on public.ledger;
create policy "owners read"   on public.ledger for select using (public.is_owner());
create policy "owners insert" on public.ledger for insert with check (public.is_owner());
create policy "owners update" on public.ledger for update using (public.is_owner()) with check (public.is_owner());

-- History & backups (only if migration 010 was installed).
do $$ begin
  if to_regclass('public.ledger_versions') is not null then
    execute 'drop policy if exists "members read versions" on public.ledger_versions';
    execute 'drop policy if exists "owners read versions" on public.ledger_versions';
    execute 'create policy "owners read versions" on public.ledger_versions for select to authenticated using (public.is_owner())';
  end if;
  if to_regclass('public.ledger_changes') is not null then
    execute 'drop policy if exists "members read changes" on public.ledger_changes';
    execute 'drop policy if exists "owners read changes" on public.ledger_changes';
    execute 'create policy "owners read changes" on public.ledger_changes for select to authenticated using (public.is_owner())';
  end if;
end $$;

-- -------------------------------------------- returning-client lookup ---
-- Any staff member may ask "do we know this person?" by ID/passport or
-- cellphone. Only the client's reference, name and loan history summary come
-- back; the rest of the book stays owner-only.
create or replace function public.match_client(p_national_id text, p_phone text)
returns jsonb language sql stable security definer set search_path = public as $$
  with book as (select data from public.ledger where id = 'main'),
  wanted as (
    select nullif(regexp_replace(upper(coalesce(p_national_id, '')), '[^A-Z0-9]', '', 'g'), '') as nid,
           case when length(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')) >= 9
                then right(regexp_replace(p_phone, '\D', '', 'g'), 9) end as tel
  ),
  hits as (
    select c from book, jsonb_array_elements(coalesce(book.data -> 'clients', '[]'::jsonb)) c, wanted w
    where public.is_staff() and (
      (w.nid is not null and w.nid = regexp_replace(upper(coalesce(c ->> 'nationalId', '')), '[^A-Z0-9]', '', 'g'))
      or (w.tel is not null and length(regexp_replace(coalesce(c ->> 'phone', ''), '\D', '', 'g')) >= 9
          and w.tel = right(regexp_replace(c ->> 'phone', '\D', '', 'g'), 9))
    )
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', h.c ->> 'id',
    'ref', h.c ->> 'ref',
    'name', h.c ->> 'name',
    'loans', (select count(*) from book, jsonb_array_elements(coalesce(book.data -> 'loans', '[]'::jsonb)) l where l ->> 'clientId' = h.c ->> 'id'),
    'borrowed', (select coalesce(sum((l ->> 'principal')::numeric), 0) from book, jsonb_array_elements(coalesce(book.data -> 'loans', '[]'::jsonb)) l where l ->> 'clientId' = h.c ->> 'id'),
    'lastIssue', (select max(l ->> 'issueDate') from book, jsonb_array_elements(coalesce(book.data -> 'loans', '[]'::jsonb)) l where l ->> 'clientId' = h.c ->> 'id')
  )), '[]'::jsonb) from hits h;
$$;
revoke all on function public.match_client(text, text) from public;
grant execute on function public.match_client(text, text) to authenticated;
