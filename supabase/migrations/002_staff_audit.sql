-- QuickServe Credit Desk — migration 002: staff, roles and the audit trail
--
-- Run ONCE in the Supabase SQL editor (Dashboard → SQL Editor → New query →
-- paste all of this → Run), after supabase/schema.sql (migration 001).
-- Step-by-step: docs/credit-desk/RUNBOOK.md.
--
-- Nothing here changes who can use the ledger yet (that is 003). It adds:
--   * schema "private"           internals the API never exposes
--   * private.schema_migrations  which migrations ran, so they can't run twice
--                                or out of order
--   * public.staff               who may use the credit desk, and as what
--   * is_staff() / is_owner() / staff_role()   role helpers used by RLS
--   * public.audit_log           append-only: nobody can edit or delete a row,
--                                not the owner, not postgres
--   * a trigger that records every ledger save (who, version, counts)
--   * private.seed_owner()       run by hand to make the first owner
--
-- The whole file runs in one transaction: if any step fails, nothing changes.

begin;

create schema if not exists private;
revoke all on schema private from public;
do $$
begin
  -- Supabase's API roles never get into "private". (They don't exist on a
  -- plain Postgres, where there's nothing to revoke.)
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema private from anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on schema private from service_role';
  end if;
end $$;

create table if not exists private.schema_migrations (
  version    text primary key,
  applied_at timestamptz not null default now()
);

-- Order guard: 001 (the ledger) must exist, and 002 must not have run.
do $$
begin
  if to_regclass('public.ledger') is null then
    raise exception 'Run supabase/schema.sql (migration 001) first: public.ledger does not exist.';
  end if;
  if exists (select 1 from private.schema_migrations where version = '002') then
    raise exception 'Migration 002 has already been applied. Nothing was changed.';
  end if;
end $$;

insert into private.schema_migrations (version) values ('001') on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Staff
-- ---------------------------------------------------------------------------
-- One row per Supabase login that may use the credit desk. A login without an
-- active row here can do nothing at all (after 003, not even the ledger).

create table public.staff (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  full_name  text not null,
  role       text not null constraint staff_role_check check (role in ('owner', 'analyst')),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now()
);
create unique index staff_email_key on public.staff (lower(email));

create function public.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff s
    where s.user_id = (select auth.uid()) and s.active
  );
$$;

create function public.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff s
    where s.user_id = (select auth.uid()) and s.active and s.role = 'owner'
  );
$$;

-- 'owner' | 'analyst' for an active staff member, otherwise null.
create function public.staff_role() returns text
language sql stable security definer set search_path = '' as $$
  select s.role from public.staff s
  where s.user_id = (select auth.uid()) and s.active;
$$;

-- ---------------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------------
-- Written only by private.audit() (from the RPCs and the ledger trigger). The
-- actor always comes from the login (auth.uid() / JWT), never from anything the
-- client sends.

create table public.audit_log (
  id             bigint generated always as identity primary key,
  -- The moment the entry was written (clock_timestamp(), not the transaction
  -- start that now() gives), so entries written together never share a time
  -- and the owner's "Load older" paging (audit_list p_before) skips nothing.
  at             timestamptz not null default clock_timestamp(),
  actor          uuid,
  actor_email    text,
  actor_role     text not null
    constraint audit_log_actor_role_check check (actor_role in ('owner', 'analyst', 'intake', 'system')),
  action         text not null,
  category       text not null
    constraint audit_log_category_check check (category in ('application', 'decision', 'ledger', 'document', 'access')),
  application_id uuid,
  entity         text,
  entity_id      text,
  detail         jsonb not null default '{}'::jsonb
);
create index audit_log_at_idx on public.audit_log (at desc);
create index audit_log_category_at_idx on public.audit_log (category, at desc);
create index audit_log_application_idx on public.audit_log (application_id, at desc) where application_id is not null;
create index audit_log_actor_action_idx on public.audit_log (actor, action, at desc);

-- Append-only, for everyone (the table owner and postgres included).
create function private.audit_log_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception using
    errcode = 'P0001',
    message = 'QS_FORBIDDEN: The audit trail is append-only. Entries can''t be changed or deleted.';
end;
$$;

create trigger audit_log_no_update_delete
  before update or delete on public.audit_log
  for each row execute function private.audit_log_immutable();
create trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function private.audit_log_immutable();

-- The one writer. The actor is whoever is signed in (auth.uid()); their role
-- comes from public.staff. p_actor_role is only for callers with no staff
-- login: 'intake' (the website) or 'system'.
create function private.audit(
  p_action         text,
  p_category       text,
  p_application_id uuid default null,
  p_entity         text default null,
  p_entity_id      text default null,
  p_detail         jsonb default '{}'::jsonb,
  p_actor_role     text default null
) returns bigint
language plpgsql set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_staff public.staff;
  v_email text;
  v_role  text;
  v_id    bigint;
  v_at    timestamptz := clock_timestamp();
  v_last  text := current_setting('qs.audit_last_at', true);
begin
  if v_uid is not null then
    select * into v_staff from public.staff where user_id = v_uid;
  end if;
  v_email := coalesce(v_staff.email, nullif(auth.jwt() ->> 'email', ''));
  v_role := coalesce(p_actor_role, case when v_staff.active then v_staff.role end, 'system');

  -- Each entry gets its own time, strictly after the previous one written in
  -- this transaction (a disbursement writes two, a legacy import up to 25), so
  -- paging by time never splits a tie.
  if coalesce(v_last, '') <> '' and v_at <= v_last::timestamptz then
    v_at := v_last::timestamptz + interval '1 microsecond';
  end if;
  perform set_config('qs.audit_last_at', to_char(v_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), true);

  insert into public.audit_log (at, actor, actor_email, actor_role, action, category, application_id, entity, entity_id, detail)
  values (v_at, v_uid, v_email, v_role, p_action, p_category, p_application_id, p_entity, p_entity_id, coalesce(p_detail, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Ledger saves are recorded: version from → to, who (from the login, not the
-- client-supplied updated_by) and how many records changed. Never the
-- document itself.
-- ---------------------------------------------------------------------------

create function private.ledger_count(p_data jsonb, p_key text) returns integer
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p_data -> p_key) = 'array' then jsonb_array_length(p_data -> p_key) else 0 end;
$$;

create function private.ledger_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_counts jsonb := '{}'::jsonb;
  v_key    text;
  v_delta  integer;
begin
  foreach v_key in array array['clients', 'loans', 'payments', 'expenses', 'capital'] loop
    v_delta := case when tg_op = 'DELETE' then 0 else private.ledger_count(new.data, v_key) end
             - case when tg_op = 'INSERT' then 0 else private.ledger_count(old.data, v_key) end;
    v_counts := v_counts || jsonb_build_object(v_key, v_delta);
  end loop;

  if tg_op = 'INSERT' then
    perform private.audit('ledger.created', 'ledger', null, 'ledger', new.id,
      jsonb_build_object('rev_to', new.rev, 'counts', v_counts));
    return new;
  elsif tg_op = 'UPDATE' then
    perform private.audit('ledger.updated', 'ledger', null, 'ledger', new.id,
      jsonb_build_object('rev_from', old.rev, 'rev_to', new.rev, 'counts', v_counts));
    return new;
  else
    perform private.audit('ledger.deleted', 'ledger', null, 'ledger', old.id,
      jsonb_build_object('rev_from', old.rev, 'counts', v_counts));
    return old;
  end if;
end;
$$;

create trigger ledger_audit
  after insert or update or delete on public.ledger
  for each row execute function private.ledger_audit();

-- ---------------------------------------------------------------------------
-- Seeding the first owner (run by hand in the SQL editor, as postgres):
--   select private.seed_owner('you@example.com', 'Your Name');
-- The login must already exist under Authentication → Users.
-- ---------------------------------------------------------------------------

create function private.seed_owner(p_email text, p_full_name text) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_name  text := btrim(coalesce(p_full_name, ''));
  v_user  uuid;
  v_row   public.staff;
begin
  if current_user <> 'postgres' then
    raise exception using errcode = 'P0001',
      message = 'QS_FORBIDDEN: Only the postgres role (the Supabase SQL editor) can seed an owner.';
  end if;
  if v_email = '' or length(v_name) < 2 then
    raise exception using errcode = 'P0001',
      message = 'QS_INVALID: Give the login email and the owner''s full name, e.g. select private.seed_owner(''you@example.com'', ''Your Name'').';
  end if;

  select u.id into v_user from auth.users u where lower(u.email) = v_email;
  if v_user is null then
    raise exception using errcode = 'P0001',
      message = format('QS_NOT_FOUND: No Supabase login exists for %s. Create it under Authentication → Users first, then run this again.', v_email);
  end if;

  insert into public.staff (user_id, email, full_name, role, active)
  values (v_user, v_email, v_name, 'owner', true)
  on conflict (user_id) do update
    set email = excluded.email, full_name = excluded.full_name, role = 'owner', active = true, updated_at = now()
  returning * into v_row;

  perform private.audit('staff.seeded', 'access', null, 'staff', v_user::text,
    jsonb_build_object('email', v_email, 'full_name', v_name, 'role', 'owner'), 'system');

  return jsonb_build_object('user_id', v_row.user_id, 'email', v_row.email, 'full_name', v_row.full_name,
    'role', v_row.role, 'active', v_row.active);
end;
$$;

-- ---------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------
-- No insert/update/delete policies anywhere: the only writers are the
-- functions above (and, from 004, the credit-desk RPCs).

alter table public.staff enable row level security;
alter table public.audit_log enable row level security;

create policy "staff: self or owner" on public.staff
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_owner()));

create policy "audit: owners read" on public.audit_log
  for select to authenticated
  using ((select public.is_owner()));

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    -- Supabase grants everything on new public tables to anon/authenticated by
    -- default; take that back and hand out only SELECT (filtered by RLS).
    execute 'revoke all on public.staff, public.audit_log from anon, authenticated';
    execute 'revoke all on sequence public.audit_log_id_seq from anon, authenticated';
    execute 'grant select on public.staff, public.audit_log to authenticated';
    execute 'revoke all on function public.is_staff(), public.is_owner(), public.staff_role() from public, anon, authenticated';
    -- The RLS policies call these as the signed-in user.
    execute 'grant execute on function public.is_staff(), public.is_owner(), public.staff_role() to authenticated';
  end if;
end $$;

-- Internals: only the owner of the functions (postgres) may run them.
revoke all on all functions in schema private from public;
revoke all on all tables in schema private from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all functions in schema private from anon, authenticated';
    execute 'revoke all on all tables in schema private from anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on all functions in schema private from service_role';
    execute 'revoke all on all tables in schema private from service_role';
  end if;
end $$;

insert into private.schema_migrations (version) values ('002');

commit;
