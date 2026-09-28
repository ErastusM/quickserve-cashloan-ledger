-- The status machine (CONTRACT §3) and the decision rules (§4): every
-- transition works for the right role and state and fails for the wrong one;
-- an analyst can never decide or pay out.

select tests.intake_key() as key \gset
select tests.put('key', :'key');

-- =====================================================================
-- A. The main path, with every wrong-role / wrong-state attempt on the way
-- =====================================================================
select tests.submit_app(:'key') as a \gset
select tests.put('a', :'a');

select tests.as_user('analyst@quickserve.test');
select tests.eq(public.whoami() ->> 'role', 'analyst', 'whoami role');
select tests.eq(public.app_get(tests.id('a')) -> 'allowed_actions',
  '["claim", "withdraw", "add_note", "mark_notified", "update_applicant"]'::jsonb, 'analyst actions on a new application');
select tests.expect_qs($$ select public.app_request_info(tests.id('a'), 'Please send a clearer payslip') $$, 'QS_FORBIDDEN');
select tests.expect_qs($$ select public.assessment_save(tests.id('a'), tests.ws_clean(), tests.terms()) $$, 'QS_FORBIDDEN');
select tests.expect_qs($$ select public.app_resume(tests.id('a')) $$, 'QS_BAD_STATE');
select tests.expect_qs($$ select public.app_recall(tests.id('a')) $$, 'QS_BAD_STATE');
select tests.expect_qs($$ select public.app_decide(tests.id('a'), 0, 'declined', null, 'Analyst trying to decline this one', 'other') $$, 'QS_FORBIDDEN');
select tests.expect_qs($$ select public.app_reopen(tests.id('a'), 'Analyst trying to reopen') $$, 'QS_FORBIDDEN');
select tests.expect_qs($$ select public.app_disburse(tests.id('a'), tests.checklist(), current_date, current_date + 30, 'Cash', null) $$, 'QS_FORBIDDEN');
select tests.expect_qs($$ select public.app_claim('00000000-0000-0000-0000-000000000000') $$, 'QS_NOT_FOUND');

select tests.as_user('owner@quickserve.test');
select tests.eq(public.app_get(tests.id('a')) -> 'allowed_actions',
  '["claim", "decide", "withdraw", "add_note", "mark_notified", "update_applicant"]'::jsonb, 'owner actions on a new application');

-- submitted → in_review (claim): the claimer becomes the assignee.
select tests.as_user('analyst@quickserve.test');
select tests.eq(public.app_claim(tests.id('a')) ->> 'status', 'in_review', 'claimed');
select tests.eq((select assigned_to from public.applications where id = tests.id('a')), tests.user_id('analyst@quickserve.test'), 'assigned to the analyst');
select tests.eq(public.app_get(tests.id('a')) -> 'notes' -> 0 ->> 'body', 'Picked up by Tuyeni Analyst.', 'system note');
select tests.as_user('analyst2@quickserve.test');
select tests.expect_qs($$ select public.app_claim(tests.id('a')) $$, 'QS_BAD_STATE');
select tests.expect_qs($$ select public.app_request_info(tests.id('a'), 'Please send a clearer payslip') $$, 'QS_FORBIDDEN');
select tests.expect_qs($$ select public.assessment_save(tests.id('a'), tests.ws_clean(), tests.terms()) $$, 'QS_FORBIDDEN');

-- in_review → info_requested (assignee or owner)
select tests.as_user('analyst@quickserve.test');
select tests.expect_qs($$ select public.app_request_info(tests.id('a'), 'short') $$, 'QS_INVALID');
select tests.eq(public.app_request_info(tests.id('a'), 'Please send a clearer copy of your August payslip.') ->> 'status', 'info_requested', 'info requested');
select tests.eq((select kind from public.application_notes where application_id = tests.id('a') order by created_at desc limit 1), 'info_request', 'info request note');
select tests.expect_qs($$ select public.app_request_info(tests.id('a'), 'Please send a clearer payslip') $$, 'QS_BAD_STATE');
select tests.expect_qs($$ select public.assessment_save(tests.id('a'), tests.ws_clean(), tests.terms()) $$, 'QS_BAD_STATE');

-- info_requested → in_review (any staff)
select tests.as_user('analyst2@quickserve.test');
select tests.eq(public.app_resume(tests.id('a'), 'Payslip received on WhatsApp') ->> 'status', 'in_review', 'resumed by another analyst');
select tests.expect_qs($$ select public.app_resume(tests.id('a')) $$, 'QS_BAD_STATE');

-- The worksheet: validation, versions.
select tests.as_user('analyst@quickserve.test');
select tests.expect_qs($$ select public.assessment_submit(tests.id('a'), 'approve', repeat('x', 60), null, tests.declaration()) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.assessment_save(tests.id('a'), jsonb_set(tests.ws_clean(), '{income,a1}', '"24500"'), tests.terms()) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.assessment_save(tests.id('a'), jsonb_set(tests.ws_clean(), '{living,c3}', '-1'), tests.terms()) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.assessment_save(tests.id('a'), '[]', tests.terms()) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.assessment_save(tests.id('a'), tests.ws_clean(), tests.terms() || '{"fee": 5}') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.assessment_save(tests.id('a'), tests.ws_clean(), tests.terms() || '{"issue_date": "28/09/2026"}') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.assessment_save(tests.id('a'), tests.ws_clean(), tests.terms() || '{"principal": "4000"}') $$, 'QS_INVALID');
select tests.eq(public.assessment_save(tests.id('a'), tests.ws_clean(), tests.terms(4000)) ->> 'version', '1', 'first save is version 1');
select tests.eq(public.assessment_save(tests.id('a'), tests.ws_clean(), tests.terms(4000)) ->> 'version', '1', 'saving again keeps version 1');
select tests.eq((public.assessment_save(tests.id('a'), tests.ws_clean(), tests.terms(4000)) -> 'computed' ->> 'd6')::numeric, 5334::numeric, 'D6 = 5,334 on the example worksheet');

-- in_review → awaiting_approval (assessment_submit)
select tests.expect_qs($$ select public.assessment_submit(tests.id('a'), 'approve', 'Too short to be a reason.', null, tests.declaration()) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.assessment_submit(tests.id('a'), 'approve', repeat('Reasons. ', 10), null, tests.declaration() - 'd12_7') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.assessment_submit(tests.id('a'), 'approve', repeat('Reasons. ', 10), null, jsonb_set(tests.declaration(), '{d12_3}', 'false')) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.assessment_submit(tests.id('a'), 'approve', repeat('Reasons. ', 10), null, null) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.assessment_submit(tests.id('a'), 'yes please', repeat('Reasons. ', 10), null, tests.declaration()) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.assessment_submit(tests.id('a'), 'approve_above_limit', repeat('Reasons. ', 10), repeat('Motivation ', 10), tests.declaration()) $$, 'QS_INVALID');
select tests.eq(public.assessment_submit(tests.id('a'), 'approve', repeat('Reasons. ', 10), null, tests.declaration()) ->> 'version', '1', 'submitted version 1');
select tests.eq((select status from public.applications where id = tests.id('a')), 'awaiting_approval', 'awaiting approval');

-- The analyst can never decide or pay out, and can't touch it while it's with the owner.
select tests.expect_qs($$ select public.app_decide(tests.id('a'), 1, 'approved') $$, 'QS_FORBIDDEN');
select tests.expect_qs($$ select public.app_decide(tests.id('a'), 1, 'returned', null, 'Return it to myself please') $$, 'QS_FORBIDDEN');
select tests.expect_qs($$ select public.app_disburse(tests.id('a'), tests.checklist(), current_date, current_date + 30, 'Cash', null) $$, 'QS_FORBIDDEN');
select tests.expect_qs($$ select public.app_disburse_preview(tests.id('a'), current_date, current_date + 30) $$, 'QS_FORBIDDEN');
select tests.expect_qs($$ select public.assessment_save(tests.id('a'), tests.ws_clean(), tests.terms()) $$, 'QS_BAD_STATE');
select tests.expect_qs($$ select public.app_update_applicant(tests.id('a'), '{"employer": "Other"}') $$, 'QS_BAD_STATE');
select tests.eq(public.app_get(tests.id('a')) -> 'allowed_actions', '["recall", "withdraw", "add_note", "mark_notified"]'::jsonb, 'submitter actions while awaiting');
select tests.as_user('analyst2@quickserve.test');
select tests.expect_qs($$ select public.app_recall(tests.id('a')) $$, 'QS_FORBIDDEN');
select tests.as_user('owner@quickserve.test');
select tests.expect_qs($$ select public.app_recall(tests.id('a')) $$, 'QS_FORBIDDEN');
select tests.eq(public.app_get(tests.id('a')) -> 'allowed_actions', '["decide", "withdraw", "add_note", "mark_notified", "update_applicant"]'::jsonb, 'owner actions while awaiting');

-- awaiting_approval → in_review (recall by the submitter); resubmitting makes version 2.
select tests.as_user('analyst@quickserve.test');
select tests.eq(public.app_recall(tests.id('a')) ->> 'status', 'in_review', 'recalled');
select tests.eq(public.assessment_submit(tests.id('a'), 'approve', repeat('Reasons. ', 10), null, tests.declaration()) ->> 'version', '2', 'resubmitted as version 2');

-- The owner decides against version 1 → stale.
select tests.as_user('owner@quickserve.test');
select tests.expect_qs($$ select public.app_decide(tests.id('a'), 1, 'approved') $$, 'QS_STALE');
select tests.expect_qs($$ select public.app_decide(tests.id('a'), 2, 'maybe') $$, 'QS_INVALID');
select public.app_decide(:'a', 2, 'approved') as dec \gset
select tests.put('dec', :'dec');
select tests.eq(tests.v('dec')::jsonb ->> 'outcome', 'approved', 'approved');
select tests.eq((tests.v('dec')::jsonb ->> 'self_assessed')::boolean, false, 'not self-assessed');
select tests.eq(tests.v('dec')::jsonb -> 'overridden_codes', '[]'::jsonb, 'nothing overridden');
select tests.eq((tests.v('dec')::jsonb -> 'terms' ->> 'principal')::numeric, 4000::numeric, 'approved on the assessed terms');
select tests.eq((select status from public.applications where id = tests.id('a')), 'approved', 'status approved');
select tests.expect_qs($$ select public.app_decide(tests.id('a'), 2, 'approved') $$, 'QS_BAD_STATE');
select tests.expect_qs($$ select public.app_update_applicant(tests.id('a'), '{"employer": "Other"}') $$, 'QS_BAD_STATE');
select tests.eq(public.app_get(tests.id('a')) -> 'allowed_actions', '["withdraw", "disburse", "add_note", "mark_notified"]'::jsonb, 'owner actions when approved');

-- approved → withdrawn: owner only.
select tests.as_user('analyst@quickserve.test');
select tests.eq(public.app_get(tests.id('a')) -> 'allowed_actions', '["add_note", "mark_notified"]'::jsonb, 'analyst actions when approved');
select tests.expect_qs($$ select public.app_withdraw(tests.id('a'), 'Applicant no longer needs the loan') $$, 'QS_FORBIDDEN');
select tests.as_user('owner@quickserve.test');
select tests.expect_qs($$ select public.app_withdraw(tests.id('a'), 'short') $$, 'QS_INVALID');
select tests.eq(public.app_withdraw(tests.id('a'), 'Applicant no longer needs the loan') ->> 'status', 'withdrawn', 'owner withdrew an approved application');

-- withdrawn → in_review: owner only.
select tests.as_user('analyst@quickserve.test');
select tests.expect_qs($$ select public.app_reopen(tests.id('a'), 'Applicant called back, wants it') $$, 'QS_FORBIDDEN');
select tests.as_user('owner@quickserve.test');
select tests.eq(public.app_reopen(tests.id('a'), 'Applicant called back, wants it after all') ->> 'status', 'in_review', 'reopened');
select tests.expect_qs($$ select public.app_reopen(tests.id('a'), 'Again, but it is open now') $$, 'QS_BAD_STATE');

-- A save after the reopen starts version 3; a decline must name that version.
select tests.as_user('analyst@quickserve.test');
select tests.eq(public.assessment_save(tests.id('a'), tests.ws_clean(), tests.terms(3000)) ->> 'version', '3', 'version 3 after reopening');
select tests.as_user('owner@quickserve.test');
select tests.expect_qs($$ select public.app_decide(tests.id('a'), 3, 'declined', null, 'Circumstances changed after the reopen') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.app_decide(tests.id('a'), 3, 'declined', null, 'Too short', 'afford') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.app_decide(tests.id('a'), 3, 'declined', null, 'Circumstances changed after the reopen', 'because') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.app_decide(tests.id('a'), 2, 'declined', null, 'Circumstances changed after the reopen', 'afford') $$, 'QS_STALE');
select tests.expect_qs($$ select public.app_decide(tests.id('a'), 3, 'approved') $$, 'QS_BAD_STATE');
select tests.eq(public.app_decide(tests.id('a'), 3, 'declined', null, 'Circumstances changed after the reopen', 'afford') ->> 'reason_to_applicant', 'afford', 'declined from in review');
select tests.eq((select status from public.applications where id = tests.id('a')), 'declined', 'status declined');
-- declined → in_review (owner)
select tests.eq(public.app_reopen(tests.id('a'), 'Applicant sent a new payslip with a raise') ->> 'status', 'in_review', 'declined → reopened');

-- =====================================================================
-- B. Owner returns a file to the analyst
-- =====================================================================
select tests.submit_app(:'key') as b \gset
select tests.put('b', :'b');
select tests.to_awaiting(:'b', tests.terms(4000));
select tests.as_user('owner@quickserve.test');
select tests.expect_qs($$ select public.app_decide(tests.id('b'), 1, 'returned', null, 'Check') $$, 'QS_INVALID');
select tests.eq(public.app_decide(:'b', 1, 'returned', null, 'Please re-check the bank average for July.') ->> 'outcome', 'returned', 'returned');
select tests.eq((select status from public.applications where id = tests.id('b')), 'in_review', 'back in review');
select tests.assert((select body from public.application_notes where application_id = tests.id('b') and kind = 'note' order by created_at desc limit 1)
  like 'Returned for another look: Please re-check%', 'return note for the analyst');
select tests.as_user('analyst@quickserve.test');
select tests.eq(public.assessment_save(tests.id('b'), tests.ws_clean(), tests.terms(4000)) ->> 'version', '2', 'rework after a return is version 2');

-- =====================================================================
-- C. A hard fail blocks approval — for the analyst and the owner
-- =====================================================================
select tests.submit_app(:'key') as c \gset
select tests.put('c', :'c');
select tests.as_user('analyst@quickserve.test');
select public.app_claim(:'c');
select tests.eq(public.assessment_save(tests.id('c'), jsonb_set(tests.ws_clean(), '{docs,d2_3}', 'false'), tests.terms(4000)) -> 'computed' -> 'hard_fail_codes',
  '["DOCS"]'::jsonb, 'DOCS hard fail');
select tests.expect_qs($$ select public.assessment_submit(tests.id('c'), 'approve', repeat('Reasons. ', 10), null, tests.declaration()) $$, 'QS_HARD_FAIL');
select tests.expect_qs($$ select public.assessment_submit(tests.id('c'), 'approve_reduced', repeat('Reasons. ', 10), null, tests.declaration()) $$, 'QS_HARD_FAIL');
select tests.expect_qs($$ select public.assessment_submit(tests.id('c'), 'approve_above_limit', repeat('Reasons. ', 10), repeat('Motivation ', 10), tests.declaration()) $$, 'QS_HARD_FAIL');
select public.assessment_submit(:'c', 'decline', repeat('Reasons. ', 10), null, tests.declaration());
select tests.as_user('owner@quickserve.test');
select tests.expect_qs($$ select public.app_decide(tests.id('c'), 1, 'approved', null, null, null, 'I am the owner and I say yes anyway') $$, 'QS_HARD_FAIL');
select tests.expect_qs($$ select public.app_decide(tests.id('c'), 1, 'approved', '{"principal": 500}', null, null, 'Smaller amount does not fix documents') $$, 'QS_HARD_FAIL');
-- G2 on the owner's own final terms is a hard fail too.
select tests.eq(public.app_decide(tests.id('c'), 1, 'declined', null, 'Bank statement for June missing.', 'docs') ->> 'outcome', 'declined', 'hard fail declined');

-- =====================================================================
-- D. Above the limit (owner-class F3/G8): motivation + override note
-- =====================================================================
select tests.submit_app(:'key') as d \gset
select tests.put('d', :'d');
select tests.as_user('analyst@quickserve.test');
select public.app_claim(:'d');
select tests.eq(public.assessment_save(tests.id('d'), tests.ws_clean(), tests.terms(5000)) -> 'computed' -> 'owner_fail_codes', '["F3", "G8"]'::jsonb, 'F3 and G8 fail at N$5,000');
select tests.expect_qs($$ select public.assessment_submit(tests.id('d'), 'approve', repeat('Reasons. ', 10), null, tests.declaration()) $$, 'QS_OVERRIDE_REQUIRED');
select tests.expect_qs($$ select public.assessment_submit(tests.id('d'), 'approve_reduced', repeat('Reasons. ', 10), null, tests.declaration()) $$, 'QS_OVERRIDE_REQUIRED');
select tests.expect_qs($$ select public.assessment_submit(tests.id('d'), 'approve_above_limit', repeat('Reasons. ', 10), 'Too short a motivation', tests.declaration()) $$, 'QS_INVALID');
select public.assessment_submit(:'d', 'approve_above_limit', repeat('Reasons. ', 10),
  'Permanent employee for 11 years; the other lender is settled with the October salary, after which the repayment fits.', tests.declaration());
select tests.as_user('owner@quickserve.test');
select tests.expect_qs($$ select public.app_decide(tests.id('d'), 1, 'approved') $$, 'QS_OVERRIDE_REQUIRED');
select tests.expect_qs($$ select public.app_decide(tests.id('d'), 1, 'approved', null, null, null, 'ok by me') $$, 'QS_OVERRIDE_REQUIRED');
select public.app_decide(:'d', 1, 'approved', null, null, null, 'Accept the motivation: long service, lender settles in October.') as ddec \gset
select tests.put('ddec', :'ddec');
select tests.eq(tests.v('ddec')::jsonb -> 'overridden_codes', '["F3", "G8"]'::jsonb, 'overridden codes recorded');
select tests.eq(tests.v('ddec')::jsonb ->> 'override_note', 'Accept the motivation: long service, lender settles in October.', 'override note kept');

-- Without a motivation (recommendation "refer") the owner can't approve above the limit…
select tests.submit_app(:'key') as d2 \gset
select tests.put('d2', :'d2');
select tests.to_awaiting(:'d2', tests.terms(5000), 'refer');
select tests.as_user('owner@quickserve.test');
select tests.expect_qs($$ select public.app_decide(tests.id('d2'), 1, 'approved', null, null, null, 'I would like to approve this above the limit') $$, 'QS_OVERRIDE_REQUIRED');
-- … but may approve a smaller amount that passes, without any override.
select tests.eq((public.app_decide(:'d2', 1, 'approved', '{"principal": 4000}') -> 'terms' ->> 'principal')::numeric, 4000::numeric, 'owner approved a reduced amount');
select tests.eq((select status from public.applications where id = tests.id('d2')), 'approved', 'd2 approved');

-- =====================================================================
-- E. A soft fail needs an override note
-- =====================================================================
select tests.submit_app(:'key') as e \gset
select tests.put('e', :'e');
select tests.to_awaiting(:'e', tests.terms(4000), 'approve', 'analyst@quickserve.test', jsonb_set(tests.ws_clean(), '{flags,f8_3}', 'true'));
select tests.as_user('owner@quickserve.test');
select tests.expect_qs($$ select public.app_decide(tests.id('e'), 1, 'approved') $$, 'QS_OVERRIDE_REQUIRED');
select tests.expect_qs($$ select public.app_decide(tests.id('e'), 1, 'approved', null, null, null, 'fine') $$, 'QS_OVERRIDE_REQUIRED');
select tests.eq(public.app_decide(:'e', 1, 'approved', null, null, null, 'Both warning signs explained by the employer.') -> 'overridden_codes',
  '["FLAGS"]'::jsonb, 'soft fail overridden');

-- =====================================================================
-- F. The owner assesses their own file (analyst away) → self_assessed
-- =====================================================================
select tests.submit_app(:'key') as f \gset
select tests.put('f', :'f');
select tests.to_awaiting(:'f', tests.terms(4000), 'approve', 'owner@quickserve.test');
select tests.as_user('owner@quickserve.test');
select tests.eq((public.app_decide(:'f', 1, 'approved') ->> 'self_assessed')::boolean, true, 'self-assessed flagged');

-- =====================================================================
-- G. approve_reduced must really be less than requested
-- =====================================================================
select tests.submit_app(:'key') as g \gset
select tests.put('g', :'g');
select tests.as_user('analyst@quickserve.test');
select public.app_claim(:'g');
select public.assessment_save(:'g', tests.ws_clean(), tests.terms(4000));
select tests.expect_qs($$ select public.assessment_submit(tests.id('g'), 'approve_reduced', repeat('Reasons. ', 10), null, tests.declaration()) $$, 'QS_INVALID');
select public.assessment_save(:'g', tests.ws_clean(), tests.terms(3000));
select tests.eq(public.assessment_submit(:'g', 'approve_reduced', repeat('Reasons. ', 10), null, tests.declaration()) ->> 'version', '1', 'reduced recommendation');

-- =====================================================================
-- H. The analyst withdraws spam before approval; only the owner reopens
-- =====================================================================
select tests.submit_app(:'key') as h \gset
select tests.put('h', :'h');
select tests.as_user('analyst@quickserve.test');
select tests.expect_qs($$ select public.app_withdraw(tests.id('h'), 'spam') $$, 'QS_INVALID');
select tests.eq(public.app_withdraw(tests.id('h'), 'Spam: duplicate of an earlier application') ->> 'status', 'withdrawn', 'analyst withdrew');
select tests.expect_qs($$ select public.app_withdraw(tests.id('h'), 'Spam: duplicate of an earlier application') $$, 'QS_BAD_STATE');
select tests.expect_qs($$ select public.app_reopen(tests.id('h'), 'Not spam after all, reopen') $$, 'QS_FORBIDDEN');
select tests.as_user('owner@quickserve.test');
select tests.eq(public.app_reopen(tests.id('h'), 'Not spam after all, reopen') ->> 'status', 'in_review', 'owner reopened');
-- Nobody ever picked it up, so it is in review with no assignee: any analyst
-- may now pick it up (the status stays in review), then work it as usual.
select tests.eq((select assigned_to from public.applications where id = tests.id('h')), null::uuid, 'reopened unassigned');
select tests.put('h_changed', (select status_changed_at::text from public.applications where id = tests.id('h')));
select tests.as_user('analyst@quickserve.test');
select tests.eq(public.app_get(tests.id('h')) -> 'allowed_actions',
  '["claim", "withdraw", "add_note", "mark_notified", "update_applicant"]'::jsonb, 'analyst may pick up the unassigned file');
select tests.expect_qs($$ select public.assessment_save(tests.id('h'), tests.ws_clean(), tests.terms()) $$, 'QS_FORBIDDEN');
select tests.eq(public.app_claim(tests.id('h')) ->> 'status', 'in_review', 'picked up, still in review');
select tests.eq((select assigned_to from public.applications where id = tests.id('h')), tests.user_id('analyst@quickserve.test'), 'now assigned');
select tests.eq((select status_changed_at::text from public.applications where id = tests.id('h')), tests.v('h_changed'), 'status time kept');
select tests.as_postgres();
select tests.eq((select (detail ->> 'from') || '→' || (detail ->> 'to') from public.audit_log
                 where action = 'app.claimed' and application_id = tests.id('h')), 'in_review→in_review', 'claim audited');
select tests.as_user('analyst@quickserve.test');
select tests.eq(public.assessment_save(tests.id('h'), tests.ws_clean(), tests.terms()) ->> 'version', '1', 'the analyst works it');
-- Someone active has it now: nobody else can take it over.
select tests.as_user('analyst2@quickserve.test');
select tests.expect_qs($$ select public.app_claim(tests.id('h')) $$, 'QS_BAD_STATE');
-- If its analyst is deactivated, another may pick it up.
select tests.as_user('owner@quickserve.test');
select public.staff_set_active(tests.user_id('analyst@quickserve.test'), false);
select tests.as_user('analyst2@quickserve.test');
select tests.eq(public.app_claim(tests.id('h')) ->> 'assigned_to', tests.user_id('analyst2@quickserve.test')::text, 'taken over from a deactivated analyst');
select tests.as_user('owner@quickserve.test');
select public.staff_set_active(tests.user_id('analyst@quickserve.test'), true);
select tests.as_user('analyst@quickserve.test');
select tests.expect_qs($$ select public.app_claim(tests.id('h')) $$, 'QS_BAD_STATE');
select tests.expect_qs($$ select public.app_claim(tests.id('a')) $$, 'QS_BAD_STATE');

-- =====================================================================
-- I. The owner declines straight from "submitted" (no worksheet: version 0)
-- =====================================================================
select tests.submit_app(:'key') as i \gset
select tests.put('i', :'i');
select tests.as_user('owner@quickserve.test');
select tests.expect_qs($$ select public.app_decide(tests.id('i'), 1, 'declined', null, 'Documents are not legible at all', 'docs') $$, 'QS_STALE');
select tests.eq(public.app_decide(:'i', 0, 'declined', null, 'Documents are not legible at all', 'docs') ->> 'outcome', 'declined', 'declined from submitted');
select tests.expect_qs($$ select public.app_claim(tests.id('i')) $$, 'QS_BAD_STATE');

-- =====================================================================
-- J. Correcting applicant details
-- =====================================================================
select tests.as_user('analyst@quickserve.test');
select tests.eq(public.app_update_applicant(:'b', '{"employer": "Namdeb Diamond Corp", "pay_day": "Last day"}') ->> 'employer', 'Namdeb Diamond Corp', 'employer corrected');
-- The ID and phone decide whose history is shown: an analyst can't change them
-- (sending them unchanged is fine), an owner can.
select tests.expect_qs($$ select public.app_update_applicant(tests.id('b'), '{"national_id": "89031200457"}') $$, 'QS_FORBIDDEN');
select tests.expect_qs($$ select public.app_update_applicant(tests.id('b'), '{"phone": "081 234 5678"}') $$, 'QS_FORBIDDEN');
select tests.eq(public.app_update_applicant(:'b', (select jsonb_build_object('national_id', national_id, 'phone', phone, 'town', 'Arandis') from public.applications where id = :'b')) ->> 'town',
  'Arandis', 'unchanged ID/phone may be sent back');
select tests.as_user('owner@quickserve.test');
select tests.eq(public.app_update_applicant(:'b', '{"phone": "081 999 0000"}') ->> 'phone', '081 999 0000', 'owner corrects the phone');
select tests.eq((select phone_norm from public.applications where id = tests.id('b')), '819990000', 'phone_norm follows');
select tests.as_user('analyst@quickserve.test');
select tests.expect_qs($$ select public.app_update_applicant(tests.id('b'), '{"status": "approved"}') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.app_update_applicant(tests.id('b'), '{"assigned_to": null}') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.app_update_applicant(tests.id('b'), '{"consent_bureau": true}') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.app_update_applicant(tests.id('b'), '{"full_name": ""}') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.app_update_applicant(tests.id('b'), '{"amount_requested": 250000}') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.app_update_applicant(tests.id('b'), '{}') $$, 'QS_INVALID');
-- While it's with the owner only the owner may correct; after approval nobody.
select tests.expect_qs($$ select public.app_update_applicant(tests.id('g'), '{"employer": "X"}') $$, 'QS_BAD_STATE');
select tests.as_user('owner@quickserve.test');
select tests.eq(public.app_update_applicant(:'g', '{"bank_account_no": "62009999999"}') ->> 'bank_account_no', '62009999999', 'owner corrects while awaiting');
select tests.expect_qs($$ select public.app_update_applicant(tests.id('d2'), '{"employer": "X"}') $$, 'QS_BAD_STATE');
select tests.as_postgres();
select tests.eq((select detail -> 'changes' -> 'bank_account_no' ->> 'to' from public.audit_log where action = 'app.updated' and application_id = tests.id('g')),
  '62009999999', 'correction audited with before/after');

-- =====================================================================
-- K. Team and policy (owner only)
-- =====================================================================
select tests.as_user('analyst@quickserve.test');
select tests.expect_qs($$ select public.staff_add('stranger@quickserve.test', 'Stranger', 'analyst') $$, 'QS_FORBIDDEN');
select tests.expect_qs($$ select public.staff_set_active(tests.user_id('analyst2@quickserve.test'), false) $$, 'QS_FORBIDDEN');
select tests.expect_qs($$ select public.policy_update('{"max_share_disposable_pct": 90}') $$, 'QS_FORBIDDEN');
select tests.eq((public.policy_get() ->> 'max_share_disposable_pct')::numeric, 70::numeric, 'analyst reads the policy');

select tests.as_user('owner@quickserve.test');
select tests.expect_qs($$ select public.staff_add('nobody@quickserve.test', 'Nobody Here', 'analyst') $$, 'QS_NOT_FOUND');
select tests.expect_qs($$ select public.staff_add('analyst@quickserve.test', 'Tuyeni Again', 'analyst') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.staff_add('stranger@quickserve.test', 'Stranger', 'admin') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.staff_add('not an email', 'Stranger', 'analyst') $$, 'QS_INVALID');
select tests.eq(public.staff_add(' Owner2@QuickServe.test ', 'Second Owner', 'owner') ->> 'role', 'owner', 'second owner added');
select tests.expect_qs($$ select public.staff_set_active(tests.user_id('owner@quickserve.test'), false) $$, 'QS_INVALID');
select tests.expect_qs($$ select public.staff_set_active('00000000-0000-0000-0000-000000000000', false) $$, 'QS_NOT_FOUND');
select tests.eq((public.staff_set_active(tests.user_id('analyst2@quickserve.test'), false) ->> 'active')::boolean, false, 'deactivated');
select tests.eq((public.staff_set_active(tests.user_id('analyst2@quickserve.test'), true) ->> 'active')::boolean, true, 'reactivated');
select tests.eq(jsonb_array_length(public.staff_list()), 4, 'staff list');
select tests.assert(public.staff_list() -> 0 ? 'last_sign_in_at', 'staff list has last sign-in');
select tests.eq(public.staff_list() -> 0 ->> 'role', 'owner', 'owners listed first');

select tests.expect_qs($$ select public.policy_update('{"max_principal": 200000}') $$, 'QS_INVALID');
select tests.eq(tests.expect_qs($$ select public.policy_update('{"max_principal": 100001}') $$, 'QS_INVALID'),
  'QS_INVALID: The largest loan must be above N$0 and at most N$100,000.', 'legal cap message');
select tests.expect_qs($$ select public.policy_update('{"cost_cap_pct": 35}') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.policy_update('{"max_term_months": 6}') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.policy_update('{"default_interest_rate": 31}') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.policy_update('{"min_age": 70, "max_age": 18}') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.policy_update('{"max_share_disposable_pct": "80"}') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.policy_update('{"max_share_disposable_pct": null}') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.policy_update('{"id": 2}') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.policy_update('{"sneaky": 1}') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.policy_update('{}') $$, 'QS_INVALID');
select tests.eq((public.policy_update('{"max_share_disposable_pct": 80, "bureau_required": false}') ->> 'max_share_disposable_pct')::numeric, 80::numeric, 'D5 changed');
select tests.eq((public.policy_get() ->> 'max_share_disposable_pct')::numeric, 80::numeric, 'D5 stored');
select tests.as_postgres();
select tests.eq((select detail -> 'changes' from public.audit_log where action = 'policy.updated' order by id desc limit 1),
  '{"max_share_disposable_pct": {"from": 70.00, "to": 80.00}}'::jsonb, 'policy change audited before/after (unchanged keys omitted)');
-- New worksheets use the new D5.
select tests.submit_app(:'key') as i2 \gset
select tests.as_user('analyst@quickserve.test');
select public.app_claim(:'i2');
select tests.eq((public.assessment_save(:'i2', tests.ws_clean(), tests.terms(4000)) -> 'computed' ->> 'd6')::numeric, 6096::numeric, 'D6 at 80% = 6,096');
select tests.as_user('owner@quickserve.test');
select public.policy_update('{"max_share_disposable_pct": 70}');

-- =====================================================================
-- L. Notes, notifications, queue
-- =====================================================================
select tests.as_user('analyst@quickserve.test');
select tests.expect_qs($$ select public.app_add_note(tests.id('b'), '   ') $$, 'QS_INVALID');
select tests.eq(public.app_add_note(:'b', 'Employer confirmed by phone.') ->> 'author_name', 'Tuyeni Analyst', 'note by the analyst');
select tests.expect_qs($$ select public.app_mark_notified(tests.id('b'), 'sms') $$, 'QS_INVALID');
select tests.eq(public.app_mark_notified(:'b', 'whatsapp') ->> 'notified_via', 'whatsapp', 'notified');
select tests.expect_qs($$ select public.app_queue('everything') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.app_queue(null) $$, 'QS_INVALID');
select tests.eq(
  (select string_agg(k || '=' || v, ',' order by k) from jsonb_each_text(public.app_queue('open') -> 'counts') as x(k, v)),
  (select string_agg(k || '=' || v, ',' order by k) from (
     select 'open' as k, count(*) filter (where status in ('submitted','in_review','info_requested','awaiting_approval','approved'))::text as v from public.applications
     union all select 'submitted', count(*) filter (where status = 'submitted')::text from public.applications
     union all select 'in_review', count(*) filter (where status = 'in_review')::text from public.applications
     union all select 'info_requested', count(*) filter (where status = 'info_requested')::text from public.applications
     union all select 'awaiting_approval', count(*) filter (where status = 'awaiting_approval')::text from public.applications
     union all select 'approved', count(*) filter (where status = 'approved')::text from public.applications
     union all select 'closed', count(*) filter (where status in ('disbursed','declined','withdrawn','archived'))::text from public.applications) c),
  'queue counts');
select tests.eq(jsonb_array_length(public.app_queue('awaiting_approval') -> 'rows'), 1, 'one awaiting approval (g)');
select tests.eq(public.app_queue('awaiting_approval') -> 'rows' -> 0 ->> 'recommendation', 'approve_reduced', 'recommendation in the queue');
select tests.eq(jsonb_array_length(public.app_queue('approved') -> 'rows'), 4, 'four ready to disburse (d, d2, e, f)');
select tests.eq((select count(*) from jsonb_array_elements(public.app_queue('closed') -> 'rows') r where r ->> 'id' = tests.v('c')), 1::bigint, 'declined is closed');
select tests.eq(jsonb_array_length(public.app_queue('open', (select ref from public.applications where id = tests.id('b'))) -> 'rows'), 1, 'search by ref');
select tests.eq(jsonb_array_length(public.app_queue('open', 'nobody by this name') -> 'rows'), 0, 'search miss');
select tests.eq((public.app_queue('open', '9504 3000 218') -> 'rows' -> 0 ->> 'dup_open')::int >= 1, true, 'duplicate ID flagged');
select tests.as_postgres();

-- =====================================================================
-- M. Money to the cent: only terms the ledger and the phone app keep exactly
-- =====================================================================
select tests.submit_app(:'key') as m \gset
select tests.put('m', :'m');
select tests.as_user('analyst@quickserve.test');
select public.app_claim(:'m');
-- Sub-cent money and a rate with more than 2 decimals are refused.
select tests.expect_qs($$ select public.assessment_save(tests.id('m'), tests.ws_clean(), tests.terms() || '{"principal": 1000.005}') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.assessment_save(tests.id('m'), tests.ws_clean(), tests.terms() || '{"service_fee": 10.001}') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.assessment_save(tests.id('m'), tests.ws_clean(), tests.terms() || '{"interest_rate": 27.555}') $$, 'QS_INVALID');
select tests.eq(public.assessment_save(:'m', tests.ws_clean(), tests.terms() || '{"principal": 1000.05, "service_fee": 10.5, "interest_rate": 27.5}') ->> 'version',
  '1', 'cents and a 2-decimal rate are fine');
-- A half-cent interest (N$117 at 27.5 % = 32.175) saves, but can't be
-- recommended for approval: the desk shows 149.18, the phone would collect 149.17.
select public.assessment_save(:'m', tests.ws_clean(), tests.terms(117) || '{"interest_rate": 27.5}');
select tests.eq(
  tests.expect_qs($$ select public.assessment_submit(tests.id('m'), 'approve', repeat('Reasons. ', 10), null, tests.declaration()) $$, 'QS_INVALID'),
  'QS_INVALID: At 27.5% the interest on N$117 comes to N$32.175, which is not a whole number of cents, so the desk and the phone app could round it to different cents. Change the amount or the rate slightly.',
  'half-cent interest refused, in plain words');
select tests.expect_qs($$ select public.assessment_submit(tests.id('m'), 'approve_reduced', repeat('Reasons. ', 10), null, tests.declaration()) $$, 'QS_INVALID');
select public.assessment_save(:'m', tests.ws_clean(), tests.terms(118) || '{"interest_rate": 27.5}');
select tests.eq(public.assessment_submit(:'m', 'approve', repeat('Reasons. ', 10), null, tests.declaration()) ->> 'version', '1', 'N$118 at 27.5 % (32.45) is fine');
-- The owner can't approve half-cent final terms either.
select tests.as_user('owner@quickserve.test');
select tests.expect_qs($$ select public.app_decide(tests.id('m'), 1, 'approved', '{"principal": 117}') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.app_decide(tests.id('m'), 1, 'approved', '{"principal": 500.05, "interest_rate": 30}') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.app_decide(tests.id('m'), 1, 'approved', '{"principal": 1000.005}') $$, 'QS_INVALID');
select tests.expect_qs($$ select public.app_decide(tests.id('m'), 1, 'approved', '{"interest_rate": 27.555}') $$, 'QS_INVALID');
select tests.eq(public.app_decide(:'m', 1, 'approved') -> 'terms' ->> 'principal', '118', 'approved as assessed');
-- And paying out re-checks the approved terms (defence in depth).
select tests.as_postgres();
update public.decisions set terms = terms || '{"principal": 117}' where application_id = :'m';
select tests.as_user('owner@quickserve.test');
select tests.expect_qs($$ select public.app_disburse(tests.id('m'), tests.checklist(), (now() at time zone 'Africa/Windhoek')::date,
  (now() at time zone 'Africa/Windhoek')::date + 30, 'Cash', null) $$, 'QS_INVALID');
select tests.eq((select status from public.applications where id = tests.id('m')), 'approved', 'nothing booked');
select tests.as_postgres();
