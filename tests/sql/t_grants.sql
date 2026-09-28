-- Grants and exposure: exactly the intended functions and privileges for the
-- API roles, on top of Supabase's grant-everything defaults (see the stub).

-- anon (the publishable key, i.e. the Worker and any stranger on the internet)
-- may execute exactly the two key-checked intake RPCs in schema public.
select tests.eq(
  (select string_agg(p.proname, ',' order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')),
  'intake_import_legacy,intake_submit',
  'anon-executable functions in public');

-- authenticated: the console RPCs and the three role helpers, nothing else.
select tests.eq(
  (select string_agg(p.proname, ',' order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')),
  'app_add_note,app_claim,app_decide,app_disburse,app_disburse_preview,app_get,app_mark_notified,app_queue,'
  || 'app_recall,app_reopen,app_request_info,app_resume,app_timeline,app_update_applicant,app_withdraw,'
  || 'assessment_save,assessment_submit,audit_list,borrower_history,doc_access,is_owner,is_staff,'
  || 'policy_get,policy_update,staff_add,staff_list,staff_role,staff_set_active,whoami',
  'authenticated-executable functions in public');

-- Every SECURITY DEFINER function pins search_path to '' (no hijacking).
select tests.eq(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and p.prosecdef
     and not coalesce(p.proconfig @> array['search_path=""'], false)),
  0::bigint,
  'security definer functions without search_path = ''''');
-- … and so does every function the migrations created.
select tests.eq(
  (select string_agg(n.nspname || '.' || p.proname, ', ')
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and not coalesce(p.proconfig @> array['search_path=""'], false)),
  null::text,
  'functions without search_path = ''''');
select tests.assert(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef) >= 30,
  'the RPCs are security definer');

-- New tables: the API roles may only SELECT (filtered by RLS); anon nothing.
select tests.eq(
  (select string_agg(t || ':' || priv, ', ' order by t, priv)
   from unnest(array['public.staff', 'public.audit_log', 'public.credit_policy', 'public.applications',
                     'public.application_documents', 'public.assessments', 'public.decisions',
                     'public.application_notes']) as t,
        unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as priv
   where has_table_privilege('authenticated', t, priv)),
  null::text,
  'authenticated has no write privileges on the new tables');
select tests.eq(
  (select string_agg(t || ':' || priv, ', ' order by t, priv)
   from unnest(array['public.staff', 'public.audit_log', 'public.credit_policy', 'public.applications',
                     'public.application_documents', 'public.assessments', 'public.decisions',
                     'public.application_notes', 'public.ledger']) as t,
        unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as priv
   where has_table_privilege('anon', t, priv)),
  null::text,
  'anon has no privileges on any table, the ledger included');
-- Staff read applications and documents through RLS, column by column: the
-- intake internals the RPCs hide (IP hash, upload folder, R2 key) stay hidden.
select tests.assert(has_table_privilege('authenticated', 'public.assessments', 'SELECT'), 'staff read through RLS');
select tests.assert(not has_table_privilege('authenticated', 'public.applications', 'SELECT')
                and not has_table_privilege('authenticated', 'public.application_documents', 'SELECT'),
                'no table-wide SELECT on applications or documents');
select tests.eq(
  (select string_agg(c, ', ' order by c) from unnest(array['public.applications.ip_hash', 'public.applications.upload_id',
     'public.application_documents.r2_key']) as c
   where has_column_privilege('authenticated', split_part(c, '.', 1) || '.' || split_part(c, '.', 2), split_part(c, '.', 3), 'SELECT')),
  null::text, 'intake internals not readable');
select tests.eq(
  (select count(*) from pg_attribute a where a.attrelid = 'public.applications'::regclass and a.attnum > 0 and not a.attisdropped
     and a.attname not in ('ip_hash', 'upload_id')
     and not has_column_privilege('authenticated', 'public.applications', a.attname, 'SELECT')),
  0::bigint, 'every other application column readable');
select tests.assert(has_column_privilege('authenticated', 'public.application_documents', 'kind', 'SELECT'), 'document rows readable');
select tests.assert(not has_table_privilege('authenticated', 'public.ledger', 'TRUNCATE'), 'no TRUNCATE on the ledger (RLS does not cover it)');
select tests.assert(not has_sequence_privilege('anon', 'public.audit_log_id_seq', 'USAGE')
                and not has_sequence_privilege('authenticated', 'public.audit_log_id_seq', 'USAGE'), 'audit sequence closed');

-- RLS is on for every public table, and there are no write policies at all
-- except the ledger's owner-only ones.
select tests.eq(
  (select string_agg(tablename, ', ') from pg_tables where schemaname = 'public' and not rowsecurity),
  null::text, 'tables without RLS');
select tests.eq(
  (select string_agg(tablename || ':' || policyname, ', ') from pg_policies
   where schemaname = 'public' and cmd <> 'SELECT' and tablename <> 'ledger'),
  null::text, 'write policies on credit tables');
select tests.eq(
  (select string_agg(policyname || ':' || cmd, ', ' order by policyname) from pg_policies
   where schemaname = 'public' and tablename = 'ledger'),
  'owners insert:INSERT, owners read:SELECT, owners update:UPDATE', 'ledger policies (no delete policy)');
select tests.eq(
  (select string_agg(distinct array_to_string(roles, ','), ',') from pg_policies where schemaname = 'public'),
  'authenticated', 'every policy applies to authenticated only');

-- The private schema is invisible to the API roles.
select tests.assert(not has_schema_privilege('anon', 'private', 'USAGE'), 'anon: no usage on private');
select tests.assert(not has_schema_privilege('authenticated', 'private', 'USAGE'), 'authenticated: no usage on private');
select tests.assert(not has_schema_privilege('service_role', 'private', 'USAGE'), 'service_role: no usage on private');
select tests.eq(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private'
     and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
          or has_function_privilege('service_role', p.oid, 'execute'))),
  0::bigint, 'private functions executable by an API role');
select tests.eq(
  (select count(*) from pg_tables t where t.schemaname = 'private'
     and (has_table_privilege('anon', t.schemaname || '.' || t.tablename, 'SELECT')
          or has_table_privilege('authenticated', t.schemaname || '.' || t.tablename, 'SELECT'))),
  0::bigint, 'private tables readable by an API role');

-- And for real: an authenticated owner can't write any credit table directly,
-- nor reach private.* (e.g. to mint an intake key or seed an owner).
select tests.as_user('owner@quickserve.test');
select tests.expect_error($$ insert into public.applications (ref, full_name, consent_version) values ('QSA-HACK01', 'X', 'v') $$, 'permission denied');
select tests.expect_error($$ update public.applications set status = 'approved' $$, 'permission denied');
select tests.expect_error($$ delete from public.applications $$, 'permission denied');
select tests.expect_error($$ update public.credit_policy set max_principal = 1 $$, 'permission denied');
select tests.expect_error($$ insert into public.staff (user_id, email, full_name, role) values (gen_random_uuid(), 'x@y.z', 'X', 'owner') $$, 'permission denied');
select tests.expect_error($$ update public.staff set role = 'owner' $$, 'permission denied');
select tests.expect_error($$ insert into public.decisions (application_id, outcome, decided_by) values (gen_random_uuid(), 'approved', gen_random_uuid()) $$, 'permission denied');
select tests.expect_error($$ insert into public.audit_log (actor_role, action, category) values ('owner', 'fake', 'access') $$, 'permission denied');
select tests.expect_error($$ select private.intake_rotate_key() $$, 'permission denied');
select tests.expect_error($$ select private.seed_owner('stranger@quickserve.test', 'Stranger') $$, 'permission denied');
select tests.expect_error($$ select private.assessment_compute('{}', '{}', '{}', '{}') $$, 'permission denied');
select tests.expect_error($$ select * from private.intake_config $$, 'permission denied');

select tests.as_user('analyst@quickserve.test');
select tests.expect_error($$ update public.applications set assigned_to = null $$, 'permission denied');
select tests.expect_error($$ insert into public.application_notes (application_id, body) values (gen_random_uuid(), 'x') $$, 'permission denied');

select tests.as_anon();
select tests.expect_error($$ select public.whoami() $$, 'permission denied');
select tests.expect_error($$ select public.app_queue('open') $$, 'permission denied');
select tests.expect_error($$ select public.is_owner() $$, 'permission denied');
select tests.expect_error($$ select * from public.applications $$, 'permission denied');
select tests.expect_error($$ select private.intake_rotate_key() $$, 'permission denied');
select tests.as_postgres();

-- Contract errors carry errcode P0001 and the "QS_<CODE>: " prefix.
select tests.as_user('stranger@quickserve.test');
select tests.expect_qs($$ select public.app_queue('open') $$, 'QS_FORBIDDEN');
select tests.as_postgres();

-- The migrations recorded themselves, in order.
select tests.eq((select string_agg(version, ',' order by version) from private.schema_migrations), '001,002,003,004', 'schema_migrations');
