-- QuickServe Cashloan — ledger version history and change log.
--
-- Run once in the Supabase dashboard: SQL Editor → New query → paste this
-- whole file → Run. It is safe to run again (it only adds what is missing).
-- It does not change any loan-book data.
--
-- What it adds:
--   * public.ledger_versions — a full copy of the loan book as it was before
--     every save, so a bad edit or delete can be undone from the console
--     (History → Restore). The newest 300 versions are kept.
--   * public.ledger_changes  — a permanent, append-only log of every save:
--     who saved (from their login, not from what the page claims), when, and
--     exactly which records were added, removed or changed — including the
--     full details of anything deleted. Nobody can edit or delete it.
--
-- Both are readable by signed-in users only (the same people who can read the
-- ledger today) and are written only by the database itself.
--
-- Independent of the credit-desk migrations (002–004). When those run, the
-- ledger lockdown (003) should also make these two tables owner-only.

begin;

create schema if not exists qs_history;
revoke all on schema qs_history from public;

-- ---------------------------------------------------------------- tables ---

create table if not exists public.ledger_versions (
  id          bigint generated always as identity primary key,
  ledger_id   text        not null,
  rev         bigint      not null,
  data        jsonb       not null,
  saved_at    timestamptz,              -- when this version was saved
  saved_by    text,                     -- who saved it (as recorded then)
  replaced_at timestamptz not null default now(),
  replaced_by text,                     -- login that replaced it
  counts      jsonb       not null default '{}'::jsonb
);
create index if not exists ledger_versions_ledger_id_idx on public.ledger_versions (ledger_id, id desc);

create table if not exists public.ledger_changes (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  ledger_id   text        not null,
  action      text        not null check (action in ('insert','update','delete','baseline')),
  rev_from    bigint,
  rev_to      bigint,
  actor_id    uuid,                     -- from the login token
  actor_email text,                     -- from the login token
  claimed_by  text,                     -- updated_by sent by the page
  summary     jsonb       not null default '{}'::jsonb,  -- counts per collection
  detail      jsonb       not null default '{}'::jsonb   -- the records themselves
);
create index if not exists ledger_changes_at_idx on public.ledger_changes (ledger_id, id desc);

-- ------------------------------------------------------------- functions ---

-- Record counts of a ledger document, for quick display.
create or replace function qs_history.counts(d jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_object_agg(k, case when jsonb_typeof(d -> k) = 'array' then jsonb_array_length(d -> k) else 0 end)
  from unnest(array['clients','loans','payments','expenses','capital','accounts','transfers']) as k
$$;

-- What changed between two ledger documents: for every collection, the records
-- added, removed (in full) and changed (before and after), matched by id; plus
-- settings and restore markers.
create or replace function qs_history.diff(old_d jsonb, new_d jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  k text; o jsonb; n jsonb; added jsonb; removed jsonb; changed jsonb;
  result jsonb := '{}'::jsonb;
begin
  foreach k in array array['clients','loans','payments','expenses','capital','accounts','transfers'] loop
    o := case when jsonb_typeof(old_d -> k) = 'array' then old_d -> k else '[]'::jsonb end;
    n := case when jsonb_typeof(new_d -> k) = 'array' then new_d -> k else '[]'::jsonb end;
    if o = n then continue; end if;
    select coalesce(jsonb_agg(x), '[]'::jsonb) into added
      from jsonb_array_elements(n) x
     where not exists (select 1 from jsonb_array_elements(o) y where y ->> 'id' = x ->> 'id');
    select coalesce(jsonb_agg(y), '[]'::jsonb) into removed
      from jsonb_array_elements(o) y
     where not exists (select 1 from jsonb_array_elements(n) x where x ->> 'id' = y ->> 'id');
    select coalesce(jsonb_agg(jsonb_build_object('id', x ->> 'id', 'before', y, 'after', x)), '[]'::jsonb) into changed
      from jsonb_array_elements(n) x
      join jsonb_array_elements(o) y on y ->> 'id' = x ->> 'id'
     where x is distinct from y;
    if added <> '[]'::jsonb or removed <> '[]'::jsonb or changed <> '[]'::jsonb then
      result := result || jsonb_build_object(k, jsonb_build_object('added', added, 'removed', removed, 'changed', changed));
    end if;
  end loop;
  if (old_d -> 'settings') is distinct from (new_d -> 'settings') then
    result := result || jsonb_build_object('settings', jsonb_build_object('before', old_d -> 'settings', 'after', new_d -> 'settings'));
  end if;
  if (old_d -> 'lastRestore') is distinct from (new_d -> 'lastRestore') then
    result := result || jsonb_build_object('lastRestore', new_d -> 'lastRestore');
  end if;
  return result;
end $$;

create or replace function qs_history.summary(detail jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(key,
           case when jsonb_typeof(value -> 'added') = 'array'
                then jsonb_build_object('added', jsonb_array_length(value -> 'added'),
                                        'removed', jsonb_array_length(value -> 'removed'),
                                        'changed', jsonb_array_length(value -> 'changed'))
                else '{}'::jsonb end), '{}'::jsonb)
  from jsonb_each(detail)
$$;

-- Fires on every write to public.ledger.
create or replace function qs_history.capture() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  who_id uuid; who_email text; d jsonb; keep_from bigint;
begin
  begin
    who_id := auth.uid();
    who_email := coalesce(auth.jwt() ->> 'email', auth.email());
  exception when others then
    who_id := null; who_email := null;
  end;

  if tg_op = 'UPDATE' then
    if old.data is not distinct from new.data then return new; end if;
    insert into public.ledger_versions (ledger_id, rev, data, saved_at, saved_by, replaced_by, counts)
    values (old.id, old.rev, old.data, old.updated_at, old.updated_by, who_email, qs_history.counts(old.data));
    d := qs_history.diff(old.data, new.data);
    insert into public.ledger_changes (ledger_id, action, rev_from, rev_to, actor_id, actor_email, claimed_by, summary, detail)
    values (new.id, 'update', old.rev, new.rev, who_id, who_email, new.updated_by, qs_history.summary(d), d);
    -- Keep the newest 300 versions.
    select v.id into keep_from from public.ledger_versions v
     where v.ledger_id = old.id order by v.id desc offset 299 limit 1;
    if keep_from is not null then
      delete from public.ledger_versions v where v.ledger_id = old.id and v.id < keep_from;
    end if;
    return new;
  elsif tg_op = 'INSERT' then
    insert into public.ledger_changes (ledger_id, action, rev_to, actor_id, actor_email, claimed_by, summary)
    values (new.id, 'insert', new.rev, who_id, who_email, new.updated_by, jsonb_build_object('counts', qs_history.counts(new.data)));
    return new;
  else -- DELETE: keep the whole book
    insert into public.ledger_versions (ledger_id, rev, data, saved_at, saved_by, replaced_by, counts)
    values (old.id, old.rev, old.data, old.updated_at, old.updated_by, who_email, qs_history.counts(old.data));
    insert into public.ledger_changes (ledger_id, action, rev_from, actor_id, actor_email, summary)
    values (old.id, 'delete', old.rev, who_id, who_email, jsonb_build_object('counts', qs_history.counts(old.data)));
    return old;
  end if;
end $$;

-- The change log is append-only for everyone, the table owner included.
create or replace function qs_history.block() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'The change log can''t be edited or deleted.';
end $$;

revoke all on all functions in schema qs_history from public;

-- -------------------------------------------------------------- triggers ---

drop trigger if exists ledger_history_capture on public.ledger;
create trigger ledger_history_capture
  after insert or update or delete on public.ledger
  for each row execute function qs_history.capture();

drop trigger if exists ledger_changes_append_only on public.ledger_changes;
create trigger ledger_changes_append_only
  before update or delete on public.ledger_changes
  for each row execute function qs_history.block();

drop trigger if exists ledger_changes_no_truncate on public.ledger_changes;
create trigger ledger_changes_no_truncate
  before truncate on public.ledger_changes
  for each statement execute function qs_history.block();

-- ------------------------------------------------------- access (RLS) ---

alter table public.ledger_versions enable row level security;
alter table public.ledger_changes  enable row level security;

revoke all on public.ledger_versions, public.ledger_changes from anon;
revoke insert, update, delete, truncate, references, trigger on public.ledger_versions, public.ledger_changes from authenticated;
grant select on public.ledger_versions, public.ledger_changes to authenticated;

drop policy if exists "members read versions" on public.ledger_versions;
create policy "members read versions" on public.ledger_versions
  for select to authenticated using (auth.uid() is not null);

drop policy if exists "members read changes" on public.ledger_changes;
create policy "members read changes" on public.ledger_changes
  for select to authenticated using (auth.uid() is not null);

-- ------------------------------------------------------------ baseline ---
-- Keep today's book as the first version, so even the very first change after
-- installing can be undone.
insert into public.ledger_versions (ledger_id, rev, data, saved_at, saved_by, replaced_by, counts)
select l.id, l.rev, l.data, l.updated_at, l.updated_by, 'history installed', qs_history.counts(l.data)
  from public.ledger l
 where not exists (select 1 from public.ledger_versions v where v.ledger_id = l.id);

insert into public.ledger_changes (ledger_id, action, rev_to, summary)
select l.id, 'baseline', l.rev, jsonb_build_object('counts', qs_history.counts(l.data))
  from public.ledger l
 where not exists (select 1 from public.ledger_changes c where c.ledger_id = l.id);

commit;
