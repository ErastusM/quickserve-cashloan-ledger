-- Row-level security: after 003 only an active OWNER can see or change the
-- ledger; staff read the credit tables; a login without a staff row gets
-- nothing anywhere.

select tests.intake_key() as key \gset
select tests.submit_app(:'key') as app \gset
select tests.put('app', :'app');

-- ---- anon -----------------------------------------------------------------
select tests.as_anon();
select tests.expect_error($$ select count(*) from public.ledger $$, 'permission denied');
select tests.expect_error($$ update public.ledger set rev = rev + 1 where id = 'main' $$, 'permission denied');
select tests.expect_error($$ insert into public.ledger (id, data) values ('evil', '{}') $$, 'permission denied');
select tests.expect_error($$ select count(*) from public.staff $$, 'permission denied');
select tests.expect_error($$ select count(*) from public.audit_log $$, 'permission denied');

-- ---- a stranger: a real login with no staff row ----------------------------
select tests.as_user('stranger@quickserve.test');
select tests.eq((select count(*) from public.ledger), 0::bigint, 'stranger sees no ledger rows');
with u as (update public.ledger set rev = rev + 1 where id = 'main' returning 1) select tests.eq(count(*), 0::bigint, 'stranger updates no ledger rows') from u;
with d as (delete from public.ledger returning 1) select tests.eq(count(*), 0::bigint, 'stranger deletes no ledger rows') from d;
select tests.expect_error($$ insert into public.ledger (id, data) values ('stranger', '{}') $$, 'new row violates row-level security');
select tests.eq((select count(*) from public.applications), 0::bigint, 'stranger sees no applications');
select tests.eq((select count(*) from public.application_documents), 0::bigint, 'stranger sees no documents');
select tests.eq((select count(*) from public.assessments), 0::bigint, 'stranger sees no assessments');
select tests.eq((select count(*) from public.decisions), 0::bigint, 'stranger sees no decisions');
select tests.eq((select count(*) from public.application_notes), 0::bigint, 'stranger sees no notes');
select tests.eq((select count(*) from public.credit_policy), 0::bigint, 'stranger sees no policy');
select tests.eq((select count(*) from public.staff), 0::bigint, 'stranger sees no staff');
select tests.eq((select count(*) from public.audit_log), 0::bigint, 'stranger sees no audit');
select tests.eq(public.whoami(), null::jsonb, 'stranger: whoami is null');
select tests.assert(not public.is_staff() and not public.is_owner() and public.staff_role() is null, 'stranger: no role');
select tests.expect_qs($$ select public.app_queue('open') $$, 'QS_FORBIDDEN');
select tests.expect_qs($$ select public.app_get(tests.id('app')) $$, 'QS_FORBIDDEN');
select tests.expect_qs($$ select public.app_claim(tests.id('app')) $$, 'QS_FORBIDDEN');
select tests.expect_qs($$ select public.borrower_history(tests.id('app')) $$, 'QS_FORBIDDEN');
select tests.expect_qs($$ select public.policy_get() $$, 'QS_FORBIDDEN');
select tests.expect_qs($$ select public.staff_list() $$, 'QS_FORBIDDEN');
select tests.expect_qs($$ select public.audit_list() $$, 'QS_FORBIDDEN');
select tests.expect_qs($$ select public.doc_access((select gen_random_uuid())) $$, 'QS_FORBIDDEN');

-- ---- the credit analyst ------------------------------------------------------
select tests.as_user('analyst@quickserve.test');
select tests.eq((select count(*) from public.ledger), 0::bigint, 'analyst sees no ledger rows');
with u as (update public.ledger set data = '{}', rev = rev + 1 where id = 'main' returning 1) select tests.eq(count(*), 0::bigint, 'analyst updates no ledger rows') from u;
select tests.expect_error($$ insert into public.ledger (id, data) values ('analyst', '{}') $$, 'new row violates row-level security');
select tests.eq((select count(*) from public.applications), 1::bigint, 'analyst sees applications');
select tests.eq((select count(*) from public.application_documents), 5::bigint, 'analyst sees document rows');
-- …but not the intake internals the RPCs hide (as PostgREST would ask for them).
select tests.eq((select full_name from public.applications), 'Test Applicant', 'analyst reads applicant columns');
select tests.expect_error($$ select ip_hash from public.applications $$, 'permission denied');
select tests.expect_error($$ select upload_id from public.applications $$, 'permission denied');
select tests.expect_error($$ select * from public.applications $$, 'permission denied');
select tests.expect_error($$ select r2_key from public.application_documents $$, 'permission denied');
select tests.eq((select count(*) from public.application_documents where kind = 'bank'), 3::bigint, 'analyst reads document columns');
select tests.eq((select count(*) from public.credit_policy), 1::bigint, 'analyst sees the policy');
select tests.eq((select count(*) from public.staff), 1::bigint, 'analyst sees only their own staff row');
select tests.eq((select email from public.staff), 'analyst@quickserve.test', 'own row');
select tests.eq((select count(*) from public.audit_log), 0::bigint, 'analyst cannot read the audit trail');
select tests.assert(public.is_staff() and not public.is_owner() and public.staff_role() = 'analyst', 'analyst role helpers');
select tests.expect_qs($$ select public.staff_list() $$, 'QS_FORBIDDEN');
select tests.expect_qs($$ select public.audit_list() $$, 'QS_FORBIDDEN');

-- ---- the owner ---------------------------------------------------------------
select tests.as_user('owner@quickserve.test');
select tests.eq((select count(*) from public.ledger), 1::bigint, 'owner sees the ledger');
select tests.eq((select count(*) from public.staff), 3::bigint, 'owner sees the whole team');
select tests.assert((select count(*) from public.audit_log) > 0, 'owner reads the audit trail');

-- The phone app's exact sync write (cloud.js pushUpdate):
--   PATCH /rest/v1/ledger?id=eq.main&rev=eq.N  {data, rev: N+1, updated_at, updated_by}
--   Prefer: return=representation
with u as (
  update public.ledger
     set data = data || '{"updatedAt": "2026-09-28T10:00:00.000Z"}', rev = 8,
         updated_at = now(), updated_by = 'owner@quickserve.test'
   where id = 'main' and rev = 7
  returning rev)
select tests.eq(count(*), 1::bigint, 'owner: phone-style guarded update succeeds') from u;
-- The same write again with the now-stale rev changes nothing (the phone then syncs first).
with u as (update public.ledger set data = '{}', rev = 8 where id = 'main' and rev = 7 returning rev)
select tests.eq(count(*), 0::bigint, 'owner: stale rev affects 0 rows') from u;
select tests.eq((select rev from public.ledger where id = 'main'), 8::bigint, 'rev is 8');
-- Insert (pushNew on an empty project) is allowed for the owner; delete never is.
with i as (insert into public.ledger (id, data) values ('owner-test', '{}') returning 1) select tests.eq(count(*), 1::bigint, 'owner may insert') from i;
with d as (delete from public.ledger returning 1) select tests.eq(count(*), 0::bigint, 'nobody deletes the ledger through the API') from d;

-- The same phone write by the analyst and the stranger: 0 rows.
select tests.as_user('analyst@quickserve.test');
with u as (update public.ledger set rev = 9 where id = 'main' and rev = 8 returning 1) select tests.eq(count(*), 0::bigint, 'analyst: phone-style update affects 0 rows') from u;
select tests.as_user('stranger@quickserve.test');
with u as (update public.ledger set rev = 9 where id = 'main' and rev = 8 returning 1) select tests.eq(count(*), 0::bigint, 'stranger: phone-style update affects 0 rows') from u;

-- ---- deactivation takes effect immediately -----------------------------------
select tests.as_user('owner@quickserve.test');
select public.staff_set_active(tests.user_id('analyst@quickserve.test'), false);
select tests.as_user('analyst@quickserve.test');
select tests.eq((select count(*) from public.applications), 0::bigint, 'deactivated analyst sees no applications');
select tests.eq((public.whoami() ->> 'active')::boolean, false, 'whoami reports inactive');
select tests.expect_qs($$ select public.app_queue('open') $$, 'QS_FORBIDDEN');
-- A deactivated OWNER loses the ledger too.
select tests.as_postgres();
select private.seed_owner('owner2@quickserve.test', 'Second Owner');
select tests.as_user('owner@quickserve.test');
select public.staff_set_active(tests.user_id('owner2@quickserve.test'), false);
select tests.as_user('owner2@quickserve.test');
select tests.eq((select count(*) from public.ledger), 0::bigint, 'deactivated owner sees no ledger');
select tests.as_postgres();
