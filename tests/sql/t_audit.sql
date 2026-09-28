-- The audit trail: every state-changing RPC (and every document/history view)
-- writes an entry; entries can't be changed or deleted by anyone; the actor
-- comes from the login; only owners can read it.

select tests.intake_key() as key \gset
select tests.put('key', :'key');
create table seen (action text primary key);
create function pg_temp.mark() returns void language sql as $$
  insert into seen select distinct action from public.audit_log on conflict do nothing;
$$;

-- Drive every RPC once.
select tests.submit_app(:'key') as a \gset
select tests.put('a', :'a');
select tests.as_user('analyst@quickserve.test');
select public.whoami();
select public.app_claim(:'a');
select public.app_request_info(:'a', 'Please send the July bank statement.');
select public.app_resume(:'a', 'Statement received');
select public.app_update_applicant(:'a', '{"employer": "Namdeb Diamond Corporation"}');
select public.app_add_note(:'a', 'Employer confirmed by phone.');
select public.doc_access((select id from public.application_documents where application_id = :'a' and kind = 'payslip'));
select public.borrower_history(:'a');
select public.assessment_save(:'a', tests.ws_clean(), tests.terms(4000));
select public.assessment_submit(:'a', 'approve', repeat('Reasons. ', 10), null, tests.declaration());
select public.app_recall(:'a');
select public.assessment_submit(:'a', 'approve', repeat('Reasons. ', 10), null, tests.declaration());
select tests.as_user('owner@quickserve.test');
select public.app_decide(:'a', 2, 'returned', null, 'Please double-check the July average.');
select tests.as_user('analyst@quickserve.test');
select public.assessment_submit(:'a', 'approve', repeat('Reasons. ', 10), null, tests.declaration());
select tests.as_user('owner@quickserve.test');
select public.app_decide(:'a', 3, 'approved');
select public.app_mark_notified(:'a', 'whatsapp');
select public.app_disburse(:'a', tests.checklist(), (now() at time zone 'Africa/Windhoek')::date, (now() at time zone 'Africa/Windhoek')::date + 30, 'Cash', null);
select tests.as_postgres();

select tests.submit_app(:'key') as b \gset
select tests.as_user('owner@quickserve.test');
select public.app_decide(:'b', 0, 'declined', null, 'Payslip is from a different employer.', 'docs');
select public.app_reopen(:'b', 'Applicant explained the employer change.');
select public.app_withdraw(:'b', 'Applicant withdrew by WhatsApp.');
select public.staff_set_active(tests.user_id('analyst2@quickserve.test'), false);
select public.staff_set_active(tests.user_id('analyst2@quickserve.test'), true);
select public.staff_add('stranger@quickserve.test', 'Former Stranger', 'analyst');
select public.policy_update('{"sla_pickup_hours": 12}');
select tests.as_user('owner2@quickserve.test');
select public.whoami();
select tests.as_anon();
select public.intake_import_legacy(:'key', '[{"id": "QS-LEG001", "status": "new", "full_name": "Old Applicant", "phone": "0811212121"}]');
select tests.as_postgres();
select pg_temp.mark();

select tests.eq(
  (select string_agg(x, ', ') from unnest(array[
     'access.refused', 'access.signed_in', 'app.claimed', 'app.imported', 'app.info_requested', 'app.notified', 'app.recalled',
     'app.reopened', 'app.resumed', 'app.submitted', 'app.updated', 'app.withdrawn', 'assessment.saved', 'assessment.submitted',
     'decision.approved', 'decision.declined', 'decision.returned', 'doc.viewed', 'history.viewed', 'intake.key_rotated',
     'ledger.booked', 'ledger.created', 'ledger.updated', 'note.added', 'policy.updated', 'staff.added', 'staff.deactivated',
     'staff.reactivated', 'staff.seeded']) as x
   where x not in (select action from seen)),
  null::text, 'every action was audited');

-- Categories and actors.
select tests.eq((select string_agg(distinct category, ',' order by category) from public.audit_log),
  'access,application,decision,document,ledger', 'all five categories used');
select tests.eq((select actor_email || '/' || actor_role from public.audit_log where action = 'app.claimed' and application_id = :'a'),
  'analyst@quickserve.test/analyst', 'actor from the login');
select tests.eq((select actor_role from public.audit_log where action = 'decision.approved' and application_id = :'a'), 'owner', 'owner decisions');
select tests.eq((select detail ->> 'kind' from public.audit_log where action = 'doc.viewed' and application_id = :'a'), 'payslip', 'which document');
select tests.eq((select count(*) from public.audit_log where action = 'access.refused'), 1::bigint, 'a login without a staff row is recorded as refused');

-- The ledger trigger: the actor comes from the JWT, never from updated_by.
select tests.as_user('owner@quickserve.test');
update public.ledger
   set data = jsonb_set(data, '{payments}', (data -> 'payments') || '[{"id": "payment_new", "loanId": "loan_a4", "amount": 520, "date": "2026-09-28", "method": "Cash"}]'),
       rev = rev + 1, updated_by = 'someone-else@evil.test'
 where id = 'main';
select tests.as_postgres();
select tests.eq(
  (select jsonb_build_object('actor_email', actor_email, 'actor_role', actor_role, 'is_owner', actor = tests.user_id('owner@quickserve.test'),
     'keys', (select jsonb_agg(k order by k) from jsonb_object_keys(detail) k), 'counts', detail -> 'counts')
   from public.audit_log where action = 'ledger.updated' order by id desc limit 1),
  '{"actor_email": "owner@quickserve.test", "actor_role": "owner", "is_owner": true, "keys": ["counts", "rev_from", "rev_to"],
    "counts": {"clients": 0, "loans": 0, "payments": 1, "expenses": 0, "capital": 0}}'::jsonb,
  'ledger save: real actor, versions and count deltas only (never the document)');
select tests.eq((select (detail ->> 'rev_to')::int - (detail ->> 'rev_from')::int from public.audit_log where action = 'ledger.updated' order by id desc limit 1), 1, 'rev from → to');

-- Append-only, for everyone.
select tests.as_user('owner@quickserve.test');
select tests.expect_error($$ update public.audit_log set action = 'nothing' $$, 'permission denied');
select tests.expect_error($$ delete from public.audit_log $$, 'permission denied');
select tests.expect_error($$ truncate public.audit_log $$, 'permission denied');
select tests.as_postgres();
select tests.expect_qs($$ update public.audit_log set action = 'nothing' where id = 1 $$, 'QS_FORBIDDEN');
select tests.expect_qs($$ delete from public.audit_log where id = 1 $$, 'QS_FORBIDDEN');
select tests.expect_qs($$ truncate public.audit_log $$, 'QS_FORBIDDEN');
select tests.expect_qs($$ delete from public.audit_log $$, 'QS_FORBIDDEN');
select tests.assert((select count(*) from public.audit_log) > 30, 'entries survived');

-- Reading: owners only (RLS + RPC); the analyst gets the curated timeline.
select tests.as_user('analyst@quickserve.test');
select tests.eq((select count(*) from public.audit_log), 0::bigint, 'analyst reads no audit rows');
select tests.expect_qs($$ select public.audit_list() $$, 'QS_FORBIDDEN');
select tests.eq((select jsonb_agg(e ->> 'action') from jsonb_array_elements(public.app_timeline(:'a')) e) -> 0, '"ledger.booked"'::jsonb, 'timeline newest first');
select tests.assert((select bool_and(e ? 'at' and e ? 'actor_name' and e ? 'action' and e ? 'text') from jsonb_array_elements(public.app_timeline(:'a')) e), 'timeline shape');
select tests.eq((select e ->> 'actor_name' from jsonb_array_elements(public.app_timeline(:'a')) e where e ->> 'action' = 'app.submitted'), 'Website', 'intake shown as the website');
select tests.eq((select e ->> 'text' from jsonb_array_elements(public.app_timeline(:'a')) e where e ->> 'action' = 'doc.viewed'), 'Viewed the payslip', 'plain-English line');
select tests.assert(public.app_get(:'a') -> 'documents' -> 1 ->> 'viewed_by_me_at' is not null, 'viewed_by_me_at from the audit trail');

select tests.as_user('owner@quickserve.test');
select tests.assert(jsonb_array_length(public.audit_list()) > 30, 'owner lists the trail');
select tests.eq((select string_agg(distinct e ->> 'category', ',') from jsonb_array_elements(public.audit_list('decision')) e), 'decision', 'category filter');
select tests.eq(jsonb_array_length(public.audit_list(null, null, 3)), 3, 'limit');
select tests.eq(jsonb_array_length(public.audit_list(null, '2000-01-01', 10)), 0, 'before');
select tests.expect_qs($$ select public.audit_list('everything') $$, 'QS_INVALID');
select tests.eq(
  (select e - 'id' - 'at' - 'detail' from jsonb_array_elements(public.audit_list('application')) e where e ->> 'action' = 'app.claimed'),
  jsonb_build_object('actor_name', 'Tuyeni Analyst', 'actor_email', 'analyst@quickserve.test', 'actor_role', 'analyst',
    'action', 'app.claimed', 'category', 'application', 'application_ref', (select ref from public.applications where id = :'a')),
  'audit_list row shape');
select tests.as_postgres();

-- ---- "Load older" never skips an entry ---------------------------------------
-- Entries written in one transaction (a booking writes ledger.updated then
-- ledger.booked; a legacy import one app.imported per row) each get their own
-- time, so paging with p_before = the last row's `at` (what the console does)
-- walks the whole trail with no gaps and no repeats, at any page size.
select tests.eq((select count(*) - count(distinct at) from public.audit_log), 0::bigint, 'no two entries share a time');
select tests.as_anon();
select public.intake_import_legacy(:'key', '[{"id": "QS-TIE001", "status": "new", "full_name": "Tie One"},
  {"id": "QS-TIE002", "status": "new", "full_name": "Tie Two"}, {"id": "QS-TIE003", "status": "new", "full_name": "Tie Three"}]');
select tests.as_postgres();
select tests.eq((select count(distinct at) from public.audit_log where action = 'app.imported' and detail ->> 'ref' like 'QS-TIE%'),
  3::bigint, 'one import batch, three distinct times');
select tests.eq((select count(*) from public.audit_log u, public.audit_log b
                 where u.action = 'ledger.updated' and b.action = 'ledger.booked' and b.application_id = :'a'
                   and (u.detail ->> 'rev_to') = (b.detail ->> 'rev_to') and b.at > u.at),
  1::bigint, 'booking pair: the ledger save, then the booking, at distinct times');

create function pg_temp.walk(p_category text, p_page int) returns bigint[]
language plpgsql as $$
declare
  v_out    bigint[] := '{}';
  v_page   jsonb;
  v_before timestamptz;
begin
  perform tests.as_user('owner@quickserve.test');
  loop
    v_page := public.audit_list(p_category, v_before, p_page);
    exit when jsonb_array_length(v_page) = 0;
    v_out := v_out || array(select (e ->> 'id')::bigint from jsonb_array_elements(v_page) e);
    v_before := (v_page -> -1 ->> 'at')::timestamptz;
  end loop;
  perform tests.as_postgres();
  return v_out;
end;
$$;
select tests.eq(pg_temp.walk(null, 1), (select array_agg(id order by at desc, id desc) from public.audit_log), 'page size 1: every entry once');
select tests.eq(pg_temp.walk(null, 7), (select array_agg(id order by at desc, id desc) from public.audit_log), 'page size 7: every entry once');
select tests.eq(pg_temp.walk('ledger', 1), (select array_agg(id order by at desc, id desc) from public.audit_log where category = 'ledger'),
  'ledger category, page size 1');
select tests.eq(pg_temp.walk('application', 2), (select array_agg(id order by at desc, id desc) from public.audit_log where category = 'application'),
  'application category, page size 2');

-- Direct inserts (none in practice) get the same per-row clock by default.
select tests.eq((select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
                 where d.adrelid = 'public.audit_log'::regclass and a.attname = 'at'), 'clock_timestamp()', 'column default');
