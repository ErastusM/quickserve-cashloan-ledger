-- Paying out and booking into the ledger (CONTRACT §7): app_disburse_preview
-- and app_disburse write records in exactly the phone app's shape, atomically,
-- and a phone holding the old version can no longer overwrite them.

select tests.intake_key() as key \gset
select tests.put('key', :'key');
create table snap as select data, rev from public.ledger where id = 'main';

-- ---- a brand-new client ----------------------------------------------------
select tests.approved_app(:'key', '{"national_id": "95043000218", "town": "Swakopmund"}', 1500) as n \gset
select tests.put('n', :'n');

select tests.as_user('analyst@quickserve.test');
select tests.expect_qs($$ select public.app_disburse_preview(tests.id('n'), current_date, current_date + 30) $$, 'QS_FORBIDDEN');
select tests.expect_qs($$ select public.app_disburse(tests.id('n'), tests.checklist(), current_date, current_date + 30, 'Cash', null) $$, 'QS_FORBIDDEN');

select tests.as_user('owner@quickserve.test');
select tests.put('today', to_char((now() at time zone 'Africa/Windhoek')::date, 'YYYY-MM-DD'));
select tests.eq(
  public.app_disburse_preview(:'n', tests.v('today')::date, tests.v('today')::date + 30),
  '{"client_match": {"mode": "new", "candidates": []}, "next_client_ref": "QS-0011", "next_loan_ref": "QSL-0010",
    "terms": {"principal": 1500, "interest_rate": 30, "service_fee": 0, "total_repayable": 1950},
    "checks": {"G1": true, "G2": true, "G3": true, "issue_not_future": true}}'::jsonb,
  'preview for a new client (refs are max + 1 across gaps; ref-less records ignored)');
select tests.eq(public.app_disburse_preview(:'n', tests.v('today')::date + 1, tests.v('today')::date + 30) -> 'checks' -> 'issue_not_future', 'false'::jsonb, 'preview flags a future issue date');
select tests.eq(public.app_disburse_preview(:'n', tests.v('today')::date, tests.v('today')::date + 200) -> 'checks' -> 'G3', 'false'::jsonb, 'preview flags a term over 5 months');

-- Everything is re-validated.
select tests.expect_qs($$ select public.app_disburse(tests.id('n'), tests.checklist() - '13.10', tests.v('today')::date, tests.v('today')::date + 30, 'Cash', null) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.app_disburse(tests.id('n'), jsonb_set(tests.checklist(), '{13.5}', 'false'), tests.v('today')::date, tests.v('today')::date + 30, 'Cash', null) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.app_disburse(tests.id('n'), jsonb_set(tests.checklist(), '{13.1}', '"yes"'), tests.v('today')::date, tests.v('today')::date + 30, 'Cash', null) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.app_disburse(tests.id('n'), null, tests.v('today')::date, tests.v('today')::date + 30, 'Cash', null) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.app_disburse(tests.id('n'), tests.checklist(), tests.v('today')::date, tests.v('today')::date + 30, 'Bitcoin', null) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.app_disburse(tests.id('n'), tests.checklist(), tests.v('today')::date, tests.v('today')::date + 30, 'Bank transfer', null) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.app_disburse(tests.id('n'), tests.checklist(), tests.v('today')::date, tests.v('today')::date + 30, 'Bank transfer', 'ab') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.app_disburse(tests.id('n'), tests.checklist(), tests.v('today')::date + 1, tests.v('today')::date + 30, 'Cash', null) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.app_disburse(tests.id('n'), tests.checklist(), null, tests.v('today')::date + 30, 'Cash', null) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.app_disburse(tests.id('n'), tests.checklist(), tests.v('today')::date, tests.v('today')::date + 200, 'Cash', null) $$, 'QS_HARD_FAIL');
select tests.expect_qs($$ select public.app_disburse(tests.id('n'), tests.checklist(), tests.v('today')::date, tests.v('today')::date, 'Cash', null) $$, 'QS_HARD_FAIL');
select tests.as_postgres();
select tests.eq((select rev from public.ledger), 7::bigint, 'nothing written by the refused attempts');

select tests.as_user('owner@quickserve.test');
select public.app_disburse(:'n', tests.checklist(), tests.v('today')::date - 1, tests.v('today')::date + 29, 'Bank transfer', 'FNB-123456') as res \gset
select tests.as_postgres();
select tests.put('res', :'res');
select tests.eq(tests.v('res')::jsonb - 'loan_id' - 'client_id',
  '{"loan_ref": "QSL-0010", "client_ref": "QS-0011", "ledger_rev": 8}'::jsonb, 'result');

-- The row: rev + 1, updated_by = the owner's login, updatedAt = the loan's createdAt.
select tests.eq((select rev from public.ledger), 8::bigint, 'rev bumped');
select tests.eq((select updated_by from public.ledger), 'owner@quickserve.test', 'updated_by is the caller');
select tests.assert((select updated_at > now() - interval '1 minute' from public.ledger), 'updated_at now');
select tests.eq((select data ->> 'updatedAt' from public.ledger), (select data -> 'loans' -> -1 ->> 'createdAt' from public.ledger), 'data.updatedAt = createdAt');

-- Everything else in the document is untouched: unknown keys, other lists,
-- existing clients and loans (including the ones without refs).
select tests.eq((select data - 'clients' - 'loans' - 'updatedAt' from public.ledger), (select data - 'clients' - 'loans' - 'updatedAt' from snap), 'other top-level keys preserved');
select tests.eq((select data -> 'customTopLevelKey' from public.ledger), '{"keep": "me", "n": 1}'::jsonb, 'unknown key kept');
select tests.eq((select (data -> 'clients') - 6 from public.ledger), (select data -> 'clients' from snap), 'existing clients unchanged');
select tests.eq((select (data -> 'loans') - 8 from public.ledger), (select data -> 'loans' from snap), 'existing loans unchanged');
select tests.eq((select c ? 'ref' from public.ledger, jsonb_array_elements(data -> 'clients') c where c ->> 'id' = 'client_c'), false, 'ref-less client left alone');
select tests.eq((select l ? 'ref' from public.ledger, jsonb_array_elements(data -> 'loans') l where l ->> 'id' = 'loan_c1'), false, 'ref-less loan left alone');

-- The new client, in app.js shape.
select tests.put('client', (select (data -> 'clients' -> -1)::text from public.ledger));
select tests.eq((select string_agg(k, ',' order by k) from jsonb_object_keys(tests.v('client')::jsonb) k),
  'address,createdAt,employer,id,name,nationalId,nextOfKin,notes,phone,ref', 'client keys');
select tests.eq(tests.v('client')::jsonb - 'id' - 'createdAt' - 'notes',
  '{"ref": "QS-0011", "name": "Test Applicant", "phone": "081 555 0101", "nationalId": "95043000218", "employer": "Namdeb",
    "address": "12 Sam Nujoma Ave, Swakopmund", "nextOfKin": "Martha Kin (085 612 3390)"}'::jsonb, 'client fields');
select tests.assert((tests.v('client')::jsonb ->> 'id') ~ '^client_[0-9a-z]{8,9}_[0-9a-z]{6}$', 'client id: client_<base36 ms>_<6>');
select tests.eq(tests.v('client')::jsonb ->> 'id', tests.v('res')::jsonb ->> 'client_id', 'returned client id');
select tests.assert((tests.v('client')::jsonb ->> 'createdAt') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$', 'createdAt ISO with ms, UTC');
select tests.eq(tests.v('client')::jsonb ->> 'notes',
  'From application ' || (select ref from public.applications where id = tests.id('n')) || ' (' || tests.v('today') || ')', 'client notes');

-- The new loan, in app.js shape.
select tests.put('loan', (select (data -> 'loans' -> -1)::text from public.ledger));
select tests.eq((select string_agg(k, ',' order by k) from jsonb_object_keys(tests.v('loan')::jsonb) k),
  'applicationId,applicationRef,clientId,createdAt,dueDate,id,interestRate,issueDate,payoutMethod,payoutReference,principal,purpose,ref,serviceFee,status',
  'loan keys');
select tests.eq(tests.v('loan')::jsonb - 'id' - 'createdAt' - 'clientId' - 'applicationId' - 'applicationRef' - 'issueDate' - 'dueDate',
  '{"ref": "QSL-0010", "status": "active", "principal": 1500, "interestRate": 30, "serviceFee": 0, "purpose": "School fees",
    "payoutMethod": "Bank transfer", "payoutReference": "FNB-123456"}'::jsonb, 'loan fields');
select tests.eq((select string_agg(jsonb_typeof(tests.v('loan')::jsonb -> k), ',') from unnest(array['principal', 'interestRate', 'serviceFee']) k),
  'number,number,number', 'money as JSON numbers');
select tests.eq(tests.v('loan')::jsonb ->> 'clientId', tests.v('client')::jsonb ->> 'id', 'loan belongs to the new client');
select tests.eq(tests.v('loan')::jsonb ->> 'applicationId', tests.v('n'), 'applicationId');
select tests.eq(tests.v('loan')::jsonb ->> 'issueDate', to_char(tests.v('today')::date - 1, 'YYYY-MM-DD'), 'issueDate YYYY-MM-DD');
select tests.eq(tests.v('loan')::jsonb ->> 'dueDate', to_char(tests.v('today')::date + 29, 'YYYY-MM-DD'), 'dueDate YYYY-MM-DD');
select tests.assert((tests.v('loan')::jsonb ->> 'id') ~ '^loan_[0-9a-z]{8,9}_[0-9a-z]{6}$', 'loan id: loan_<base36 ms>_<6>');
select tests.eq(tests.v('loan')::jsonb ->> 'createdAt', tests.v('client')::jsonb ->> 'createdAt', 'one createdAt for both');

-- The application is closed and linked.
select tests.eq(
  (select jsonb_build_object('status', status, 'client_ref', client_ref, 'loan_ref', loan_ref, 'payout_method', payout_method,
     'payout_reference', payout_reference, 'by_owner', disbursed_by = tests.user_id('owner@quickserve.test'), 'checklist', checklist = tests.checklist())
   from public.applications where id = tests.id('n')),
  '{"status": "disbursed", "client_ref": "QS-0011", "loan_ref": "QSL-0010", "payout_method": "Bank transfer",
    "payout_reference": "FNB-123456", "by_owner": true, "checklist": true}'::jsonb, 'application disbursed and linked');
select tests.eq((select detail ->> 'loan_ref' from public.audit_log where action = 'ledger.booked' and application_id = tests.id('n')), 'QSL-0010', 'ledger.booked audited');
select tests.eq((select detail -> 'counts' from public.audit_log where action = 'ledger.updated' order by id desc limit 1),
  '{"clients": 1, "loans": 1, "payments": 0, "expenses": 0, "capital": 0}'::jsonb, 'ledger.updated counts');

-- Paying out twice is impossible.
select tests.as_user('owner@quickserve.test');
select tests.expect_qs($$ select public.app_disburse(tests.id('n'), tests.checklist(), tests.v('today')::date, tests.v('today')::date + 30, 'Cash', null) $$, 'QS_BAD_STATE');
select tests.expect_qs($$ select public.app_disburse_preview(tests.id('n'), tests.v('today')::date, tests.v('today')::date + 30) $$, 'QS_BAD_STATE');

-- A phone still holding version 7 can't overwrite the booking (0 rows; it syncs first).
with u as (update public.ledger set data = (select data from snap), rev = 8, updated_by = 'owner@quickserve.test' where id = 'main' and rev = 7 returning 1)
select tests.eq(count(*), 0::bigint, 'stale phone PATCH affects 0 rows') from u;
select tests.as_postgres();
select tests.eq((select jsonb_array_length(data -> 'loans') from public.ledger), 9, 'booking still there');

-- ---- an existing client, matched despite spacing/case, gaps filled only if empty --------
select tests.approved_app(:'key', '{"national_id": "p 1234567", "phone": "081 999 8888", "employer": "Walvis Port",
  "address": "1 Harbour Rd", "town": "Walvis Bay", "kin_name": "Kin P", "kin_phone": "081 000 0000", "full_name": "P. Person"}', 1500) as p \gset
select tests.put('p', :'p');
select tests.as_user('owner@quickserve.test');
select tests.eq(public.app_disburse_preview(:'p', tests.v('today')::date, tests.v('today')::date + 30) -> 'client_match',
  '{"mode": "existing", "candidates": [{"id": "client_f", "ref": "QS-0010", "name": "Passport Person", "national_id": "p-1234567", "loans": 0}]}'::jsonb,
  'matched on the normalised ID');
select tests.eq(public.app_disburse(:'p', tests.checklist(), tests.v('today')::date, tests.v('today')::date + 30, 'Cash', null) - 'loan_id',
  '{"client_id": "client_f", "client_ref": "QS-0010", "loan_ref": "QSL-0011", "ledger_rev": 9}'::jsonb, 'booked to the existing client');
select tests.as_postgres();
select tests.eq((select c from public.ledger, jsonb_array_elements(data -> 'clients') c where c ->> 'id' = 'client_f'),
  '{"id": "client_f", "ref": "QS-0010", "createdAt": "2026-03-01T08:00:00.000Z", "name": "Passport Person", "phone": "081 999 8888",
    "nationalId": "p-1234567", "employer": "Walvis Port", "address": "1 Harbour Rd, Walvis Bay", "nextOfKin": "Kin P (081 000 0000)",
    "notes": "keep this note"}'::jsonb, 'only the empty fields were filled; name, ID and notes kept');
select tests.eq((select jsonb_array_length(data -> 'clients') from public.ledger), 7, 'no new client');

-- Selma: matched with dashes in the ID; her record has every field, so nothing changes.
select tests.approved_app(:'key', '{"national_id": "890312-00457", "phone": "0810000000", "employer": "Somewhere Else"}', 1500) as s \gset
select tests.as_user('owner@quickserve.test');
select tests.eq(public.app_disburse(:'s', tests.checklist(), tests.v('today')::date, tests.v('today')::date + 30, 'E-wallet', 'EW-99') ->> 'client_ref', 'QS-0001', 'Selma matched');
select tests.as_postgres();
select tests.eq((select c from public.ledger, jsonb_array_elements(data -> 'clients') c where c ->> 'id' = 'client_a'),
  (select c from snap, jsonb_array_elements(data -> 'clients') c where c ->> 'id' = 'client_a'), 'a complete client record is not touched');

-- ---- ambiguous: two clients share the ID -------------------------------------------------
select tests.approved_app(:'key', '{"national_id": "770101 00123"}', 1500) as t \gset
select tests.put('t', :'t');
select tests.as_user('owner@quickserve.test');
select tests.eq(public.app_disburse_preview(:'t', tests.v('today')::date, tests.v('today')::date + 30) -> 'client_match' ->> 'mode', 'ambiguous', 'ambiguous');
select tests.eq((select string_agg(c ->> 'ref', ',') from jsonb_array_elements(public.app_disburse_preview(:'t', tests.v('today')::date, tests.v('today')::date + 30) -> 'client_match' -> 'candidates') c),
  'QS-0007,QS-0008', 'both candidates offered');
select tests.expect_qs($$ select public.app_disburse(tests.id('t'), tests.checklist(), tests.v('today')::date, tests.v('today')::date + 30, 'Cash', null) $$, 'QS_AMBIGUOUS_CLIENT');
select tests.expect_qs($$ select public.app_disburse(tests.id('t'), tests.checklist(), tests.v('today')::date, tests.v('today')::date + 30, 'Cash', null, 'client_a') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.app_disburse(tests.id('t'), tests.checklist(), tests.v('today')::date, tests.v('today')::date + 30, 'Cash', null, 'client_zzz') $$, 'QS_NOT_FOUND');
select tests.eq(public.app_disburse(:'t', tests.checklist(), tests.v('today')::date, tests.v('today')::date + 30, 'Cash', null, 'client_e') ->> 'client_ref', 'QS-0008', 'owner picked the second twin');

-- p_new_client forces a new client even when the ID matches.
select tests.as_postgres();
select tests.approved_app(:'key', '{"national_id": "77010100123", "full_name": "Twin Three"}', 1500) as t2 \gset
select tests.as_user('owner@quickserve.test');
select tests.eq(public.app_disburse(:'t2', tests.checklist(), tests.v('today')::date, tests.v('today')::date + 30, 'Other', 'Voucher 1', null, true) ->> 'client_ref', 'QS-0012', 'forced new client');

-- A legacy client with no ID on file can be linked by id.
select tests.as_postgres();
select tests.approved_app(:'key', '{"national_id": "66010100111", "full_name": "Legacy Person"}', 1500) as l \gset
select tests.as_user('owner@quickserve.test');
select tests.eq(public.app_disburse(:'l', tests.checklist(), tests.v('today')::date, tests.v('today')::date + 30, 'Cash', null, 'client_c') ->> 'client_id', 'client_c', 'linked to the ID-less client');
select tests.as_postgres();
select tests.eq((select c ->> 'employer' from public.ledger, jsonb_array_elements(data -> 'clients') c where c ->> 'id' = 'client_c'), 'Namdeb', 'its empty employer filled');

-- ---- refs beyond 4 digits are not truncated -----------------------------------------------
update public.ledger set data = jsonb_set(data, '{loans,0,ref}', '"QSL-12345"') where id = 'main';
select tests.approved_app(:'key', '{"national_id": "55010100999"}', 1500) as big \gset
select tests.as_user('owner@quickserve.test');
select tests.eq(public.app_disburse(:'big', tests.checklist(), tests.v('today')::date, tests.v('today')::date + 30, 'Cash', null) ->> 'loan_ref', 'QSL-12346', 'max + 1 past 9999');
select tests.as_postgres();

-- ---- no ledger row → QS_LEDGER_MISSING, nothing changes -----------------------------------
select tests.approved_app(:'key', '{"national_id": "44010100888"}', 1500) as m \gset
select tests.put('m', :'m');
delete from public.ledger where id = 'main';
select tests.as_user('owner@quickserve.test');
select tests.expect_qs($$ select public.app_disburse(tests.id('m'), tests.checklist(), tests.v('today')::date, tests.v('today')::date + 30, 'Cash', null) $$, 'QS_LEDGER_MISSING');
select tests.as_postgres();
select tests.eq((select status from public.applications where id = tests.id('m')), 'approved', 'still approved');
