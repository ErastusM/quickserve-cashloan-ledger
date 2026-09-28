-- The website's door: intake_submit / intake_import_legacy (anon, key-checked).

-- Before any key has been minted, nothing gets in.
select tests.as_anon();
select tests.expect_qs($$ select public.intake_submit('0123456789abcdef0123456789abcdef', tests.app_payload(), tests.docs_payload()) $$, 'QS_BAD_KEY');
select tests.as_postgres();

select tests.intake_key() as key \gset
select tests.put('key', :'key');

-- Only the sha256 is stored, never the key.
select tests.eq((select count(*) from private.intake_config where key_sha256 = tests.v('key')), 0::bigint, 'plaintext key not stored');
select tests.eq((select key_sha256 from private.intake_config), encode(sha256(convert_to(tests.v('key'), 'UTF8')), 'hex'), 'sha256 stored');
select tests.assert(length(tests.v('key')) >= 64, 'key is long');

select tests.as_anon();
select tests.expect_qs($$ select public.intake_submit('wrong-key-wrong-key-wrong-key-wrong-key', tests.app_payload(), tests.docs_payload()) $$, 'QS_BAD_KEY');
select tests.expect_qs($$ select public.intake_submit(null, tests.app_payload(), tests.docs_payload()) $$, 'QS_BAD_KEY');
select tests.expect_qs($$ select public.intake_submit(upper(tests.v('key')), tests.app_payload(), tests.docs_payload()) $$, 'QS_BAD_KEY');
select tests.expect_qs($$ select public.intake_import_legacy('wrong-key-wrong-key-wrong-key-wrong-key', '[]') $$, 'QS_BAD_KEY');

-- ---- a good submission ----------------------------------------------------------
select public.intake_submit(:'key', tests.app_payload('{"ip_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'), tests.docs_payload('upload-good-0001')) as res \gset
select tests.as_postgres();
select tests.put('res', :'res');
select tests.assert((tests.v('res')::jsonb ->> 'ref') ~ '^QSA-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$', 'QSA- reference from the safe alphabet');
select tests.assert((tests.v('res')::jsonb ->> 'id') ~ '^[0-9a-f-]{36}$', 'returns the id');
select tests.eq((select status from public.applications where id = (tests.v('res')::jsonb ->> 'id')::uuid), 'submitted', 'status submitted');
select tests.eq((select upload_id from public.applications where id = (tests.v('res')::jsonb ->> 'id')::uuid), 'upload-good-0001', 'upload folder recorded');
select tests.eq((select national_id_norm || '|' || phone_norm from public.applications where id = (tests.v('res')::jsonb ->> 'id')::uuid), '95043000218|815550101', 'normalised id and phone');
select tests.eq((select count(*) from public.application_documents where application_id = (tests.v('res')::jsonb ->> 'id')::uuid), 5::bigint, '5 documents');
select tests.eq((select string_agg(kind || seq, ',' order by kind, seq) from public.application_documents where application_id = (tests.v('res')::jsonb ->> 'id')::uuid), 'bank1,bank2,bank3,id1,payslip1', 'document slots');

-- Audited as the website (intake), with no user.
select tests.eq(
  (select count(*) from public.audit_log where action = 'app.submitted' and actor_role = 'intake' and actor is null
     and category = 'application' and application_id = (tests.v('res')::jsonb ->> 'id')::uuid),
  1::bigint, 'app.submitted audited as intake');

-- ---- the client can't choose status, assignment, ref or booking fields ---------------
select tests.as_anon();
select public.intake_submit(:'key', tests.app_payload(jsonb_build_object(
  'status', 'approved', 'assigned_to', tests.user_id('analyst@quickserve.test'), 'ref', 'QSA-HACKED',
  'id', '00000000-0000-0000-0000-000000000001', 'loan_ref', 'QSL-9999', 'client_id', 'client_a', 'source', 'legacy',
  'consent_version', 'v2026-10', 'legacy', '{"x": 1}', 'upload_id', 'elsewhere', 'national_id', '99010100001')),
  tests.docs_payload()) ->> 'id' as hack \gset
select tests.as_postgres();
select tests.eq(
  (select jsonb_build_object('status', status, 'assigned_to', assigned_to, 'ref_ok', ref ~ '^QSA-', 'loan_ref', loan_ref,
     'client_id', client_id, 'source', source, 'legacy', legacy, 'id_forced', id = '00000000-0000-0000-0000-000000000001')
   from public.applications where id = :'hack'),
  '{"status": "submitted", "assigned_to": null, "ref_ok": true, "loan_ref": null, "client_id": null, "source": "web", "legacy": null, "id_forced": false}'::jsonb,
  'non-whitelisted keys are ignored');

-- ---- validation: everything is QS_INVALID ---------------------------------------------
select tests.as_anon();
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload('{"full_name": ""}'), tests.docs_payload()) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload('{"full_name": null}'), tests.docs_payload()) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload('{"national_id": "  "}'), tests.docs_payload()) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload('{"phone": "12"}'), tests.docs_payload()) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload('{"amount_requested": 0}'), tests.docs_payload()) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload('{"amount_requested": -50}'), tests.docs_payload()) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload('{"amount_requested": 100000.01}'), tests.docs_payload()) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload('{"amount_requested": "lots"}'), tests.docs_payload()) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload('{"consent_processing": false}'), tests.docs_payload()) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload('{"consent_processing": "yes"}'), tests.docs_payload()) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload('{"consent_version": ""}'), tests.docs_payload()) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload('{"consent_version": null}'), tests.docs_payload()) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload('{"ip_hash": null}'), tests.docs_payload()) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload('{"email": "not-an-email"}'), tests.docs_payload()) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload('{"date_of_birth": "1990-02-30"}'), tests.docs_payload()) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload('{"dependants": 2.5}'), tests.docs_payload()) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload(jsonb_build_object('purpose', repeat('x', 301))), tests.docs_payload()) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), '"not an object"', tests.docs_payload()) $$, 'QS_INVALID');
-- The message names the fields, for the Worker's 400.
select tests.eq(
  tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload('{"amount_requested": 0, "phone": ""}'), tests.docs_payload()) $$, 'QS_INVALID'),
  'QS_INVALID: Check these fields: amount_requested, phone.', 'field list in the message');

-- Documents.
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload(), '[]') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload(), null) $$, 'QS_INVALID');
-- no ID
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload(),
  (select jsonb_agg(d) from jsonb_array_elements(tests.docs_payload('up-noid-0001')) d where d ->> 'kind' <> 'id')) $$, 'QS_INVALID');
-- no payslip
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload(),
  (select jsonb_agg(d) from jsonb_array_elements(tests.docs_payload('up-nopay-001')) d where d ->> 'kind' <> 'payslip')) $$, 'QS_INVALID');
-- no bank statement
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload(),
  (select jsonb_agg(d) from jsonb_array_elements(tests.docs_payload('up-nobank-01')) d where d ->> 'kind' <> 'bank')) $$, 'QS_INVALID');
-- two IDs
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload(),
  tests.docs_payload('up-twoid-001') || '[{"kind":"id","seq":2,"r2_key":"apps/up-twoid-001/id-2.jpg","mime":"image/jpeg","bytes":10}]') $$, 'QS_INVALID');
-- seven bank statements
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload(),
  tests.docs_payload('up-seven-001') || (select jsonb_agg(jsonb_build_object('kind', 'bank', 'seq', i, 'r2_key', 'apps/up-seven-001/bank-' || i || '.pdf', 'mime', 'application/pdf', 'bytes', 10)) from generate_series(4, 7) i)) $$, 'QS_INVALID');
-- an HTML "document"
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload(),
  jsonb_set(tests.docs_payload('up-html-0001'), '{0,mime}', '"text/html"')) $$, 'QS_INVALID');
-- over 10 MB
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload(),
  jsonb_set(tests.docs_payload('up-big-00001'), '{0,bytes}', '10485761')) $$, 'QS_INVALID');
-- over 40 MB in total
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload(),
  (select jsonb_agg(jsonb_set(d, '{bytes}', '10485760')) from jsonb_array_elements(tests.docs_payload('up-total-001')) d)) $$, 'QS_INVALID');
-- a key outside apps/, a path trick, another upload folder, a key that doesn't match its slot
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload(),
  jsonb_set(tests.docs_payload('up-key-00001'), '{0,r2_key}', '"applications/QS-OLD123/id-x.jpg"')) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload(),
  jsonb_set(tests.docs_payload('up-key-00002'), '{0,r2_key}', '"apps/../../etc/id-1.jpg"')) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload(),
  jsonb_set(tests.docs_payload('up-key-00003'), '{0,r2_key}', '"apps/other-folder-1/id-1.jpg"')) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload(),
  jsonb_set(tests.docs_payload('up-key-00004'), '{0,r2_key}', '"apps/up-key-00004/payslip-1.jpg"')) $$, 'QS_INVALID');
-- the same R2 key twice (a unique violation must still come back as QS_INVALID)
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload(), tests.docs_payload('upload-good-0001')) $$, 'QS_INVALID');
-- missing seq/bytes
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload(),
  tests.docs_payload('up-seq-00001') #- '{0,seq}') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload(),
  tests.docs_payload('up-seq-00002') #- '{0,bytes}') $$, 'QS_INVALID');
select tests.as_postgres();
-- None of the refused submissions left anything behind.
select tests.eq((select count(*) from public.applications), 2::bigint, 'only the two accepted applications exist');

-- ---- the old form (still cached on some phones) -------------------------------------------
-- What Worker v2 builds from an old apply.html post (CONTRACT §8 legacy
-- compatibility): no amount, the 'legacy-v0' consent label, only the old
-- fields. Accepted; the worksheet's G6 flags the missing amount for staff.
select tests.as_anon();
select public.intake_submit(:'key', tests.app_payload('{"amount_requested": null, "consent_version": "legacy-v0",
  "date_of_birth": null, "email": null, "town": null, "dependants": null, "job_title": null, "employment_type": null,
  "pay_day": null, "bank_name": null, "bank_account_holder": null, "bank_account_no": null, "salary_into_account": null,
  "kin_relationship": null, "declared_deductions": null, "declared_expenses": null, "other_lender_loans": null,
  "other_lender_count": null, "consent_bureau": false}'), tests.docs_payload('up-oldform-01')) ->> 'id' as oldform \gset
-- The key left out altogether is the same.
select tests.assert((public.intake_submit(:'key', tests.app_payload() - 'amount_requested', tests.docs_payload()) ->> 'ref') ~ '^QSA-',
  'no amount_requested key at all');
-- A present amount is still checked.
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload('{"amount_requested": 100000.01, "consent_version": "legacy-v0"}'), tests.docs_payload()) $$, 'QS_INVALID');
select tests.as_postgres();
select tests.eq((select jsonb_build_object('amount', amount_requested, 'consent_version', consent_version, 'consent', consent_processing)
                 from public.applications where id = :'oldform'),
  '{"amount": null, "consent_version": "legacy-v0", "consent": true}'::jsonb, 'old form stored');
select tests.eq(
  (select r ->> 'result' from jsonb_array_elements(private.assessment_compute(tests.ws_clean(), tests.terms(),
     private.app_bits(a), private.policy_json()) -> 'rules') r where r ->> 'code' = 'G6'),
  'fail', 'G6 flags the missing amount')
from public.applications a where a.id = :'oldform';

-- ---- a retry of the same submission (the Worker's one retry after an unclear failure) --
select tests.as_anon();
select public.intake_submit(:'key', tests.app_payload('{"ip_hash": "dddddddddddddddddddddddddddddddd"}'), tests.docs_payload('up-retry-0001')) as first \gset
select public.intake_submit(:'key', tests.app_payload('{"ip_hash": "dddddddddddddddddddddddddddddddd"}'), tests.docs_payload('up-retry-0001')) as again \gset
select tests.eq(:'again'::jsonb, :'first'::jsonb, 'a retry answers with the stored application');
-- The same folder from another sender is refused.
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload('{"ip_hash": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}'), tests.docs_payload('up-retry-0001')) $$, 'QS_INVALID');
-- A retry is not a new application, so it never trips the rate limit.
select public.intake_submit(:'key', tests.app_payload('{"ip_hash": "dddddddddddddddddddddddddddddddd"}'), tests.docs_payload());
select public.intake_submit(:'key', tests.app_payload('{"ip_hash": "dddddddddddddddddddddddddddddddd"}'), tests.docs_payload());
select tests.eq(public.intake_submit(:'key', tests.app_payload('{"ip_hash": "dddddddddddddddddddddddddddddddd"}'), tests.docs_payload('up-retry-0001')),
  :'first'::jsonb, 'the retry still answers after three submissions');
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload('{"ip_hash": "dddddddddddddddddddddddddddddddd"}'), tests.docs_payload()) $$, 'QS_RATE_LIMIT');
select tests.as_postgres();
select tests.eq((select count(*) from public.applications where upload_id = 'up-retry-0001'), 1::bigint, 'one row for the folder');
select tests.eq((select count(*) from public.application_documents d join public.applications a on a.id = d.application_id
                 where a.upload_id = 'up-retry-0001'), 5::bigint, 'its documents once');
select tests.eq((select count(*) from public.audit_log where action = 'app.submitted' and application_id = (:'first'::jsonb ->> 'id')::uuid),
  1::bigint, 'audited once');

-- Optional proof of address and HEIC/WEBP/PNG are fine.
select tests.as_anon();
select public.intake_submit(:'key', tests.app_payload(),
  jsonb_set(jsonb_set(tests.docs_payload('up-extra-001'), '{0,mime}', '"image/heic"'), '{0,r2_key}', '"apps/up-extra-001/id-1.heic"')
  || '[{"kind":"proof_address","seq":1,"r2_key":"apps/up-extra-001/proof_address-1.webp","mime":"image/webp","bytes":1000}]') ->> 'ref' as extra \gset
select tests.as_postgres();

-- ---- rate limit: 3 per IP hash per hour -------------------------------------------------
select tests.as_anon();
select public.intake_submit(:'key', tests.app_payload('{"ip_hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'), tests.docs_payload());
select public.intake_submit(:'key', tests.app_payload('{"ip_hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'), tests.docs_payload());
select public.intake_submit(:'key', tests.app_payload('{"ip_hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'), tests.docs_payload());
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload('{"ip_hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'), tests.docs_payload()) $$, 'QS_RATE_LIMIT');
-- another connection is unaffected
select public.intake_submit(:'key', tests.app_payload('{"ip_hash": "cccccccccccccccccccccccccccccccc"}'), tests.docs_payload());
select tests.as_postgres();
-- an hour later it's allowed again
update public.applications set submitted_at = now() - interval '61 minutes' where ip_hash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
select tests.as_anon();
select public.intake_submit(:'key', tests.app_payload('{"ip_hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'), tests.docs_payload());
select tests.as_postgres();

-- A rotated key replaces the old one.
select tests.intake_key() as key2 \gset
select tests.put('key2', :'key2');
select tests.as_anon();
select tests.expect_qs($$ select public.intake_submit(tests.v('key'), tests.app_payload(), tests.docs_payload()) $$, 'QS_BAD_KEY');
select public.intake_submit(:'key2', tests.app_payload(), tests.docs_payload());
select tests.as_postgres();

-- ---- legacy import (the old D1 inbox) ---------------------------------------------------
select tests.as_anon();
select public.intake_import_legacy(:'key2', '[
  {"id": "QS-ABC123", "ref": "QS-ABC123", "created_at": "2026-08-01T10:00:00.000Z", "status": "new", "full_name": "Old New",
   "phone": "0814444444", "national_id": "88010100111", "address": "Kuisebmund", "employer": "Fishing co", "income": "12000",
   "kin_name": "Kin", "kin_phone": "0815555555", "purpose": "Rent", "repay_date": "2026-09-01", "consent": "yes",
   "decided_at": null, "decided_note": null, "consent_processing": true, "declared_income": 12000,
   "docs": [{"kind": "id", "seq": 1, "r2_key": "applications/QS-ABC123/id-front.jpg", "mime": "image/jpeg", "bytes": 1000, "original_name": "front.jpg"},
            {"kind": "bank", "seq": 1, "r2_key": "applications/QS-ABC123/bank-0-june.pdf", "mime": "application/pdf", "bytes": 2000},
            {"kind": "bank", "seq": 2, "r2_key": "applications/QS-ABC123/bank-1-evil.html", "mime": "text/html", "bytes": 10}],
   "docs_skipped": [{"kind": "payslip", "seq": 1, "reason": "unsupported_type"}]},
  {"id": "QS-DEF456", "ref": "QS-DEF456", "created_at": "2026-07-01T10:00:00.000Z", "status": "approved", "full_name": "Old Approved",
   "phone": "0816666666", "national_id": "88010100222", "income": "about 9k", "consent": "yes", "decided_at": "2026-07-02T10:00:00.000Z",
   "decided_note": "paid out by hand", "docs": []},
  {"id": "QS-GHI789", "ref": "QS-GHI789", "created_at": "2026-07-05T10:00:00.000Z", "status": "declined", "full_name": "Old Declined",
   "phone": "0817777777", "national_id": "", "consent": "yes", "docs": []},
  {"id": "QSA-NOTOLD", "ref": "QSA-NOTOLD", "status": "new", "full_name": "Not a legacy ref", "phone": "0818888888"},
  {"id": "QS-NONAME1", "ref": "QS-NONAME1", "status": "new", "full_name": "", "phone": "0818888888"},
  "not an object"
]') as imp \gset
select tests.put('imp', :'imp');
select tests.eq(tests.v('imp')::jsonb, '{"imported": 3, "skipped": 3}'::jsonb, 'first import');
-- Idempotent: the same rows again import nothing.
select tests.eq(public.intake_import_legacy(:'key2', '[{"id": "QS-ABC123", "ref": "QS-ABC123", "status": "new", "full_name": "Old New"}]'),
  '{"imported": 0, "skipped": 1}'::jsonb, 're-import skips');
select tests.expect_qs($$ select public.intake_import_legacy(tests.v('key'), '[]') $$, 'QS_BAD_KEY');
select tests.expect_qs($$ select public.intake_import_legacy(tests.v('key2'), (select jsonb_agg('{}'::jsonb) from generate_series(1, 101))) $$, 'QS_INVALID');
select tests.as_postgres();

select tests.eq(
  (select jsonb_agg(jsonb_build_object('ref', ref, 'status', status, 'legacy_status', legacy ->> 'status', 'consent_version', consent_version,
     'source', source, 'income', declared_income, 'income_text', declared ->> 'income_text', 'consent', consent_processing) order by ref)
   from public.applications where source = 'legacy'),
  '[{"ref": "QS-ABC123", "status": "submitted", "legacy_status": "new", "consent_version": "legacy-v0", "source": "legacy", "income": 12000, "income_text": null, "consent": true},
    {"ref": "QS-DEF456", "status": "archived", "legacy_status": "approved", "consent_version": "legacy-v0", "source": "legacy", "income": null, "income_text": "about 9k", "consent": true},
    {"ref": "QS-GHI789", "status": "archived", "legacy_status": "declined", "consent_version": "legacy-v0", "source": "legacy", "income": null, "income_text": null, "consent": true}]'::jsonb,
  'legacy rows mapped');
select tests.eq((select submitted_at from public.applications where ref = 'QS-ABC123'), '2026-08-01T10:00:00Z'::timestamptz, 'original submission time kept');
select tests.eq((select string_agg(kind || seq, ',' order by kind, seq) from public.application_documents d join public.applications a on a.id = d.application_id where a.ref = 'QS-ABC123'),
  'bank1,id1', 'legacy documents imported, the HTML one refused');
select tests.eq((select legacy -> 'docs_skipped' -> 0 ->> 'reason' from public.applications where ref = 'QS-ABC123'), 'unsupported_type', 'skipped documents recorded');
select tests.eq((select count(*) from public.audit_log where action = 'app.imported' and actor_role = 'intake'), 3::bigint, 'imports audited');

-- Archived imports can never be worked or booked.
select tests.as_user('owner@quickserve.test');
select tests.put('arch', (select id::text from public.applications where ref = 'QS-DEF456'));
select tests.expect_qs($$ select public.app_claim(tests.id('arch')) $$, 'QS_BAD_STATE');
select tests.expect_qs($$ select public.app_withdraw(tests.id('arch'), 'Duplicate of a newer application') $$, 'QS_BAD_STATE');
select tests.expect_qs($$ select public.app_reopen(tests.id('arch'), 'Want to look at this again') $$, 'QS_BAD_STATE');
select tests.expect_qs($$ select public.app_decide(tests.id('arch'), 0, 'declined', null, 'Declined long ago by hand, recorded now', 'other') $$, 'QS_BAD_STATE');
select tests.eq(public.app_get(tests.id('arch')) -> 'allowed_actions', '["add_note", "mark_notified"]'::jsonb, 'archived: only notes');
-- The imported "new" one is in the queue like any other.
select tests.eq((select count(*) from jsonb_array_elements(public.app_queue('submitted') -> 'rows') r where r ->> 'ref' = 'QS-ABC123'), 1::bigint, 'legacy new in the queue');
select tests.as_postgres();
