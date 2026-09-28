-- borrower_history (CONTRACT §6): only the matched person's loans and
-- payments, the phone app's maths (extensions, days late, statuses), never
-- client notes or company figures; audited once per person/application/day.

select tests.intake_key() as key \gset
select tests.put('today', to_char((now() at time zone 'Africa/Windhoek')::date, 'YYYY-MM-DD'));

-- Selma applies again, typing her ID with spaces.
select tests.submit_app(:'key', '{"national_id": "8903 1200 457", "phone": "+264 81 234 5678", "full_name": "Selma Nangolo"}') as s \gset
select tests.put('s', :'s');

select tests.as_user('analyst@quickserve.test');
select public.borrower_history(:'s') as h \gset
select tests.put('h', :'h');
select tests.as_postgres();

-- The person herself: one "id" match, QS-0001, five loans.
select tests.eq(jsonb_array_length(tests.v('h')::jsonb -> 'matches'), 2, 'one ID match + one possible (phone) match');
select tests.eq(tests.v('h')::jsonb -> 'matches' -> 0 ->> 'match', 'id', 'first match by ID');
select tests.eq(tests.v('h')::jsonb -> 'matches' -> 0 -> 'client',
  '{"id": "client_a", "ref": "QS-0001", "name": "Selma Nangolo", "phone": "081 234 5678", "national_id": "89031200457",
    "employer": "Rössing Uranium", "address": "Mondesa, Swakopmund", "next_of_kin": "Martha Nangolo (085 612 3390)"}'::jsonb,
  'client card without notes');
select tests.eq(tests.v('h')::jsonb -> 'matches' -> 0 -> 'summary',
  '{"loans": 5, "borrowed": 7000, "repaid": 4550, "late_loans": 3, "max_days_late": 100, "outstanding": 4820, "written_off": 680}'::jsonb,
  'summary');
select tests.eq((tests.v('h')::jsonb ->> 'qs_balance')::numeric, 4820::numeric, 'qs_balance = outstanding of the ID match, written-off excluded');

-- Per loan (keyed by id; the order is by issue date).
create table hl as
  select l ->> 'id' as id, l from jsonb_array_elements(tests.v('h')::jsonb -> 'matches' -> 0 -> 'loans') l;
select tests.eq((select string_agg(id, ',') from hl), 'loan_a5,loan_a1,loan_a2,loan_a3,loan_a4', 'only her loans, oldest first');
select tests.eq((select l - 'payments' - 'issue_date' - 'due_date' - 'paid_date' from hl where id = 'loan_a1'),
  '{"id": "loan_a1", "ref": "QSL-0001", "principal": 1000, "interest_rate": 30, "service_fee": 0, "extension_interest": 0,
    "total_due": 1300, "paid": 1300, "outstanding": 0, "status": "paid", "days_late": 0, "extensions": 0}'::jsonb, 'paid on time');
select tests.eq((select l ->> 'paid_date' from hl where id = 'loan_a1'), to_char(tests.v('today')::date - 92, 'YYYY-MM-DD'), 'paid date');
select tests.eq((select l - 'payments' - 'issue_date' - 'due_date' - 'paid_date' from hl where id = 'loan_a2'),
  '{"id": "loan_a2", "ref": "QSL-0002", "principal": 2000, "interest_rate": 30, "service_fee": 50, "extension_interest": 0,
    "total_due": 2650, "paid": 2650, "outstanding": 0, "status": "paid", "days_late": 4, "extensions": 0}'::jsonb, 'paid 4 days late');
select tests.eq((select l ->> 'paid_date' from hl where id = 'loan_a2'), to_char(tests.v('today')::date - 46, 'YYYY-MM-DD'),
  'paid date = the payment that cleared it (payments sorted by date, not array order)');
select tests.eq((select l -> 'payments' from hl where id = 'loan_a2'),
  jsonb_build_array(
    jsonb_build_object('date', to_char(tests.v('today')::date - 55, 'YYYY-MM-DD'), 'amount', 1000, 'method', 'Cash'),
    jsonb_build_object('date', to_char(tests.v('today')::date - 46, 'YYYY-MM-DD'), 'amount', 1650, 'method', 'Bank transfer')),
  'payments: date, amount, method only');
select tests.eq((select l - 'payments' - 'issue_date' - 'due_date' from hl where id = 'loan_a3'),
  '{"id": "loan_a3", "ref": "QSL-0005", "principal": 3000, "interest_rate": 30, "service_fee": 0, "extension_interest": 900,
    "total_due": 4800, "paid": 500, "outstanding": 4300, "status": "active", "paid_date": null, "days_late": 0, "extensions": 1}'::jsonb,
  'extension interest counted (app.js loanTerms)');
select tests.eq((select l - 'payments' - 'issue_date' - 'due_date' from hl where id = 'loan_a4'),
  '{"id": "loan_a4", "ref": "QSL-0006", "principal": 400, "interest_rate": 30, "service_fee": 0, "extension_interest": 0,
    "total_due": 520, "paid": 0, "outstanding": 520, "status": "overdue", "paid_date": null, "days_late": 3, "extensions": 0}'::jsonb,
  'overdue 3 days');
select tests.eq((select l - 'payments' - 'issue_date' - 'due_date' from hl where id = 'loan_a5'),
  '{"id": "loan_a5", "ref": "QSL-0004", "principal": 600, "interest_rate": 30, "service_fee": 0, "extension_interest": 0,
    "total_due": 780, "paid": 100, "outstanding": 680, "status": "written-off", "paid_date": null, "days_late": 100, "extensions": 0}'::jsonb,
  'written off');

-- The possible match shares the phone number but is someone else: no history, no ID, no employer.
select tests.eq(tests.v('h')::jsonb -> 'matches' -> 1,
  '{"match": "phone", "restricted": true,
    "client": {"id": "client_b", "ref": "QS-0003", "name": "Aina Nangolo", "phone": "+264 81 234 5678", "national_id": null,
               "employer": null, "address": null, "next_of_kin": null},
    "summary": {"loans": null, "borrowed": null, "repaid": null, "late_loans": null, "max_days_late": null, "outstanding": null},
    "loans": []}'::jsonb, 'phone match is restricted');

-- Nothing private leaks: no notes, no other people, no company figures.
select tests.assert(position('SECRET' in tests.v('h')) = 0, 'no client/payment/extension notes');
select tests.assert(position('"notes"' in tests.v('h')) = 0, 'no notes key at all');
select tests.assert(position('Aina private' in tests.v('h')) = 0, 'not the phone match''s loans');
select tests.assert(position('Twin' in tests.v('h')) = 0 and position('Legacy Person' in tests.v('h')) = 0, 'no other clients');
select tests.assert(position('capital' in tests.v('h')) = 0 and position('expense' in tests.v('h')) = 0 and position('Opening float' in tests.v('h')) = 0, 'no company figures');

-- app_get's KYC and the queue say the same, again without notes.
select tests.as_user('analyst@quickserve.test');
select tests.eq(public.app_get(:'s') -> 'kyc' -> 'ledger_match',
  '{"client_id": "client_a", "client_ref": "QS-0001", "name": "Selma Nangolo", "loans": 5, "matches": 1}'::jsonb, 'kyc ledger match');
select tests.eq(public.app_get(:'s') -> 'kyc' -> 'phone_matches', '[{"client_ref": "QS-0003", "name": "Aina Nangolo"}]'::jsonb, 'kyc phone matches');
select tests.eq((public.app_get(:'s') -> 'kyc') - 'dup_open' - 'ledger_match' - 'phone_matches',
  jsonb_build_object('id_is_namibian', true, 'id_valid', true, 'dob', '1989-03-12',
    'age', date_part('year', age(tests.v('today')::date, date '1989-03-12'))::int, 'age_ok', true), 'kyc from the ID number');
select tests.assert(position('SECRET' in public.app_get(:'s')::text) = 0, 'app_get has no notes from the ledger');
select tests.eq(
  (select r - 'id' - 'ref' - 'submitted_at' - 'status_changed_at' - 'age_hours' - 'national_id' - 'phone' - 'employer' - 'declared_income' - 'amount_requested'
   from jsonb_array_elements(public.app_queue('open') -> 'rows') r where r ->> 'id' = tests.v('s')),
  '{"status": "submitted", "full_name": "Selma Nangolo", "assigned_to": null, "assigned_name": null, "returning": true,
    "client_ref": "QS-0001", "late_loans": 3, "dup_open": 0, "recommendation": null, "hard_fail": false, "above_limit": false}'::jsonb,
  'queue row: returning borrower with 3 late loans');

-- Audited once per person, application and day.
select public.borrower_history(:'s');
select tests.as_user('owner@quickserve.test');
select public.borrower_history(:'s');
select tests.as_postgres();
select tests.eq((select count(*) from public.audit_log where action = 'history.viewed' and application_id = tests.id('s')), 2::bigint, 'one entry per viewer per day');
select tests.eq((select detail -> 'client_refs' from public.audit_log where action = 'history.viewed' and application_id = tests.id('s') limit 1),
  '["QS-0001"]'::jsonb, 'which client was looked at');

-- B8 is always the ledger balance, whatever the worksheet says.
select tests.as_user('analyst@quickserve.test');
select public.app_claim(:'s');
select tests.eq((public.assessment_save(:'s', jsonb_set(tests.ws_clean(), '{commitments,b8}', '0'), tests.terms(1500)) -> 'computed' ->> 'b12')::numeric,
  6300::numeric, 'B12 includes B8 = 4,820');
select tests.as_postgres();
select tests.eq((select (worksheet -> 'commitments' ->> 'b8')::numeric from public.assessments where application_id = tests.id('s')), 4820::numeric, 'b8 stored as the ledger balance');

-- Someone with no history.
select tests.submit_app(:'key', '{"national_id": "01010100001", "phone": "0819990001"}') as nobody \gset
select tests.as_user('analyst@quickserve.test');
select tests.eq(public.borrower_history(:'nobody'), '{"matches": [], "qs_balance": 0}'::jsonb, 'new borrower: empty history');
select tests.eq(public.app_get(:'nobody') -> 'kyc' -> 'ledger_match', 'null'::jsonb, 'no ledger match');

-- Not for strangers or the anonymous key.
select tests.as_user('stranger@quickserve.test');
select tests.expect_qs($$ select public.borrower_history((select tests.v('s'))::uuid) $$, 'QS_FORBIDDEN');
select tests.as_anon();
select tests.expect_error($$ select public.borrower_history((select tests.v('s'))::uuid) $$, 'permission denied');
select tests.as_postgres();

-- ---- the phone app's cent (CONTRACT §6: the per-loan maths ARE app.js) --------
-- app.js roundMoney works in binary doubles: N$500.05 at 30 % is 150.015
-- exactly, but the phone computes 150.01499999999998… and collects 150.01.
-- The SQL must land on the phone's cent, not the exact one (expected values
-- computed with app.js roundMoney).
select tests.eq(
  (select jsonb_agg(jsonb_build_object('interest', trim_scale(l.interest), 'total_due', trim_scale(l.total_due),
                                       'outstanding', trim_scale(l.outstanding)) order by l.ord)
   from private.ledger_loans(jsonb_build_object('loans', jsonb_build_array(
          jsonb_build_object('id', 'e1', 'principal', 500.05, 'interestRate', 30),
          jsonb_build_object('id', 'e2', 'principal', 117, 'interestRate', 27.5),
          jsonb_build_object('id', 'e3', 'principal', 1234.55, 'interestRate', 30),
          jsonb_build_object('id', 'e4', 'principal', 2000.1, 'interestRate', 30),
          jsonb_build_object('id', 'e5', 'principal', '333.33', 'interestRate', '12.5', 'serviceFee', 10.005),
          jsonb_build_object('id', 'e6', 'principal', 1000, 'interestRate', 30,
                             'extensions', jsonb_build_array(jsonb_build_object('addedInterest', 0.1), jsonb_build_object('addedInterest', 0.2))))),
        tests.v('today')::date) l),
  '[{"interest": 150.01, "total_due": 650.06, "outstanding": 650.06},
    {"interest": 32.17, "total_due": 149.17, "outstanding": 149.17},
    {"interest": 370.37, "total_due": 1604.92, "outstanding": 1604.92},
    {"interest": 600.03, "total_due": 2600.13, "outstanding": 2600.13},
    {"interest": 41.67, "total_due": 385.01, "outstanding": 385.01},
    {"interest": 300, "total_due": 1300.3, "outstanding": 1300.3}]'::jsonb,
  'ledger maths round like app.js roundMoney (floats), not exact decimals');
select tests.eq(private.round_money(1.005), 1.01, 'roundMoney(1.005) = 1.01 (the EPSILON nudge)');
select tests.eq(private.round_money(-2.5), -2.5, 'negative, already cents');
select tests.eq(private.round_money_f(-0.125::float8), -0.12, 'Math.round rounds a tie towards +infinity');

-- ---- an ID that belongs to someone else in the ledger -----------------------
-- The website needs no login, so someone could apply with another person's ID
-- number and look them up. The view is flagged for the owner when the
-- ledger's name for that ID is a different name.
select tests.submit_app(:'key', '{"national_id": "89031200457", "phone": "0819990002", "full_name": "Johannes Imposter"}') as imp \gset
select tests.submit_app(:'key', '{"national_id": "89031200457", "phone": "0819990003", "full_name": "SELMA N. NANGOLO"}') as same \gset
select tests.as_user('analyst@quickserve.test');
select public.borrower_history(:'imp');
select public.borrower_history(:'same');
select tests.as_postgres();
select tests.eq((select detail -> 'name_differs' from public.audit_log where action = 'history.viewed' and application_id = :'imp'),
  'true'::jsonb, 'different name flagged');
select tests.eq((select detail -> 'name_differs' from public.audit_log where action = 'history.viewed' and application_id = :'same'),
  'false'::jsonb, 'same person, other spelling: not flagged');
select tests.eq((select detail -> 'name_differs' from public.audit_log where action = 'history.viewed' and application_id = tests.id('s') limit 1),
  'false'::jsonb, 'Selma herself: not flagged');
select tests.as_user('owner@quickserve.test');
select tests.eq((select e ->> 'text' from jsonb_array_elements(public.app_timeline(:'imp')) e where e ->> 'action' = 'history.viewed'),
  'Viewed the borrower history (the ledger has a different name for this ID number)', 'shown on the timeline');
select tests.as_postgres();
select tests.assert(private.names_match('Selma Nangolo', 'selma  nangolo-shikongo') and private.names_match('Nangolo', 'Selma Nangolo')
  and not private.names_match('Selma Nangolo', 'Aina Nangolo') and not private.names_match('', 'Selma Nangolo'), 'name matching');
