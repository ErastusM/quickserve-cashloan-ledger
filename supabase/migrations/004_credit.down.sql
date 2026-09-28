-- QuickServe Credit Desk — rollback of migration 004
--
-- Removes everything 004 created: the credit tables (applications, their
-- documents, worksheets, decisions, notes, the credit policy), the intake key
-- and every credit-desk function. The ledger, staff and the audit trail (002)
-- are untouched; audit entries about applications stay.
--
-- THIS DELETES APPLICATIONS. It refuses while any application exists unless
-- you first export them (Table editor → applications → Export) and then
-- confirm by adding this line above "begin;" and running again:
--
--   set qs.confirm = 'drop-credit-data';
--
-- The documents themselves stay in Cloudflare R2.

begin;

do $$
declare
  v_count bigint;
begin
  if to_regclass('private.schema_migrations') is null
     or not exists (select 1 from private.schema_migrations where version = '004') then
    raise exception 'Migration 004 is not applied, so there is nothing to roll back. Nothing was changed.';
  end if;
  select count(*) into v_count from public.applications;
  if v_count > 0 and coalesce(current_setting('qs.confirm', true), '') <> 'drop-credit-data' then
    raise exception '% application(s) would be deleted. Export them first, then add  set qs.confirm = ''drop-credit-data'';  above "begin;" and run again. Nothing was changed.', v_count;
  end if;
end $$;

-- Every function 004 created, whatever its arguments.
do $$
declare
  v_fn regprocedure;
begin
  for v_fn in
    select p.oid::regprocedure
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'public' and p.proname in (
             'whoami', 'staff_list', 'staff_add', 'staff_set_active', 'policy_get', 'policy_update',
             'app_queue', 'app_get', 'app_update_applicant', 'app_claim', 'app_request_info', 'app_resume',
             'app_recall', 'app_withdraw', 'app_reopen', 'assessment_save', 'assessment_submit', 'app_decide',
             'app_mark_notified', 'app_add_note', 'app_timeline', 'borrower_history', 'doc_access',
             'app_disburse_preview', 'app_disburse', 'audit_list', 'intake_submit', 'intake_import_legacy'))
       or (n.nspname = 'private' and p.proname in (
             'fail', 'r2', 'round_money_f', 'round_money', 'jnum', 'jnum_loose', 'jarr', 'jpresent', 'try_date',
             'try_timestamptz', 'norm_id', 'norm_phone', 'today_na', 'base36', 'rand_chars', 'ref_number', 'next_ref', 'money_text',
             'assessment_compute', 'require_staff', 'require_owner', 'staff_name', 'get_app', 'current_assessment',
             'status_label', 'check_action', 'allowed_actions', 'transition', 'app_clean', 'app_bits', 'app_json',
             'policy_json', 'clean_terms', 'check_bookable_terms', 'check_worksheet', 'ledger_data', 'ledger_loans',
             'names_match', 'client_public',
             'history_json', 'qs_balance', 'ws_with_b8', 'ledger_id_matches', 'client_loan_count', 'staff_json',
             'id_dob', 'kyc_json', 'assessment_json', 'decision_json', 'note_json', 'add_note', 'require_text',
             'timeline_text', 'approved_terms', 'disburse_checks', 'new_ledger_id', 'intake_rotate_key',
             'check_intake_key', 'new_app_ref'))
    order by n.nspname, p.proname
  loop
    execute format('drop function %s', v_fn);
  end loop;
end $$;

drop table public.application_notes;
drop table public.decisions;
drop table public.assessments;
drop table public.application_documents;
drop table public.applications;
drop table public.credit_policy;
drop table private.intake_config;

delete from private.schema_migrations where version = '004';

commit;
