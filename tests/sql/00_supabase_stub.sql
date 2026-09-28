-- A minimal stand-in for what Supabase provides, so the migrations can be
-- tested on a plain throwaway Postgres. NEVER run this against a real project.
--
-- It reproduces the parts that matter for security:
--   * the API roles anon / authenticated (no login) and service_role (bypassrls)
--   * auth.users, and auth.uid() / auth.jwt() / auth.email() / auth.role()
--     read from the request.jwt.claim(s) settings exactly like Supabase
--   * Supabase's DEFAULT PRIVILEGES: every new table, sequence and function in
--     schema public is granted to anon, authenticated and service_role. So a
--     missing RLS policy, grant or revoke shows up in the tests as a real leak.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

create schema auth;

create table auth.users (
  id              uuid primary key default gen_random_uuid(),
  email           text,
  created_at      timestamptz not null default now(),
  last_sign_in_at timestamptz
);
create unique index users_email_key on auth.users (lower(email));

-- Same definitions as Supabase (supabase/postgres migrations).
create function auth.uid() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create function auth.role() returns text
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create function auth.email() returns text
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$;

create function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
