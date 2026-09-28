-- QuickServe Credit Desk — migration 004: applications, assessment, approval
-- and booking
--
-- Run ONCE in the Supabase SQL editor after 002 and 003.
-- Step-by-step: docs/credit-desk/RUNBOOK.md. The rules it enforces are in
-- docs/credit-desk/CONTRACT.md (the frozen build contract).
--
-- Design in one paragraph: the tables are readable by active staff (RLS) but
-- have NO write policies. Every change goes through a SECURITY DEFINER RPC
-- below, which checks who is calling (public.staff), checks the application's
-- state, writes the audit trail and returns jsonb. Errors look like
-- 'QS_<CODE>: <plain English>' (errcode P0001); the console shows the part
-- after ": ". The website's Worker can only call intake_submit and
-- intake_import_legacy, and only with the intake key (stored here as a
-- sha256 hash; the key itself lives in the Worker as a secret).
--
-- The whole file runs in one transaction: if any step fails, nothing changes.
-- Rollback: 004_credit.down.sql.

begin;

do $$
begin
  if to_regclass('private.schema_migrations') is null
     or not exists (select 1 from private.schema_migrations where version = '002') then
    raise exception 'Run migration 002 first. Nothing was changed.';
  end if;
  if not exists (select 1 from private.schema_migrations where version = '003') then
    raise exception 'Run migration 003 (ledger lockdown) first, so an analyst can never see the ledger. Nothing was changed.';
  end if;
  if exists (select 1 from private.schema_migrations where version = '004') then
    raise exception 'Migration 004 has already been applied. Nothing was changed.';
  end if;
end $$;

-- ===========================================================================
-- 1. Small helpers
-- ===========================================================================

-- Raise a contract error: 'QS_<CODE>: <message>' with errcode P0001.
create function private.fail(p_code text, p_message text) returns void
language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = p_code || ': ' || p_message;
end;
$$;

-- Round half away from zero to 2 decimals (numeric round() does exactly that).
create function private.r2(p numeric) returns numeric
language sql immutable set search_path = '' as $$
  select round(p, 2);
$$;

-- The phone app's roundMoney(), for the ledger maths (CONTRACT §6: the
-- per-loan maths ARE app.js loanTerms/analyzeLoan):
--   Math.round((Number(x) + Number.EPSILON) * 100) / 100
-- done in IEEE doubles exactly as the phone does it. It is not the same as
-- r2 on a few half cents: N$500.05 at 30 % is 150.015 exactly, but the
-- phone's double for it is a hair below (150.014999999999986…), so the phone
-- collects 150.01. x − floor(x) is exact in a double, so the tie test is exact too
-- (Math.round rounds a tie towards +∞).
create function private.round_money_f(p float8) returns numeric
language sql immutable set search_path = '' as $$
  select round((case when x - floor(x) >= 0.5 then floor(x) + 1 else floor(x) end)::numeric / 100, 2)
  from (select (coalesce(p, 0) + 2.220446049250313e-16::float8) * 100 as x) v;
$$;

create function private.round_money(p numeric) returns numeric
language sql immutable set search_path = '' as $$
  select private.round_money_f(coalesce(p, 0)::float8);
$$;

-- A JSON number, or 0 for anything else (missing, null, string, boolean).
-- Worksheet numbers are JSON numbers by contract; strings are not parsed.
create function private.jnum(p jsonb) returns numeric
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p) = 'number' then (p #>> '{}')::numeric else 0 end;
$$;

-- Ledger values: like the phone app's Number(x || 0) — numbers, or strings
-- that look like numbers; anything else is 0.
create function private.jnum_loose(p jsonb) returns numeric
language sql immutable set search_path = '' as $$
  select case
    when jsonb_typeof(p) = 'number' then (p #>> '{}')::numeric
    when jsonb_typeof(p) = 'string' and btrim(p #>> '{}') ~ '^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$'
      then btrim(p #>> '{}')::numeric
    else 0
  end;
$$;

create function private.jarr(p jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end;
$$;

-- "Present" for the G6 completeness rule: a non-blank string, a non-zero
-- number or true.
create function private.jpresent(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(case jsonb_typeof(p)
    when 'string'  then btrim(p #>> '{}') <> ''
    when 'number'  then (p #>> '{}')::numeric <> 0
    when 'boolean' then p = 'true'::jsonb
    else false
  end, false);
$$;

-- 'YYYY-MM-DD' → date, or null if missing or not a real date.
create function private.try_date(p text) returns date
language plpgsql immutable set search_path = '' as $$
begin
  if p is null or p !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    return null;
  end if;
  return make_date(substr(p, 1, 4)::int, substr(p, 6, 2)::int, substr(p, 9, 2)::int);
exception when others then
  return null;
end;
$$;

create function private.try_timestamptz(p text) returns timestamptz
language plpgsql stable set search_path = '' as $$
begin
  if p is null or btrim(p) = '' then
    return null;
  end if;
  return p::timestamptz;
exception when others then
  return null;
end;
$$;

-- National ID normalisation: upper-case, keep only A–Z and 0–9.
create function private.norm_id(p text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(upper(coalesce(p, '')), '[^A-Z0-9]', '', 'g');
$$;

-- Phone normalisation: digits only, last 9.
create function private.norm_phone(p text) returns text
language sql immutable set search_path = '' as $$
  select right(regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g'), 9);
$$;

-- "Today" for the business: Africa/Windhoek (UTC+2, no DST).
create function private.today_na() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'Africa/Windhoek')::date;
$$;

create function private.base36(p_n bigint) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v_digits constant text := '0123456789abcdefghijklmnopqrstuvwxyz';
  v_n   bigint := p_n;
  v_out text := '';
begin
  if v_n <= 0 then
    return '0';
  end if;
  while v_n > 0 loop
    v_out := substr(v_digits, (v_n % 36)::int + 1, 1) || v_out;
    v_n := v_n / 36;
  end loop;
  return v_out;
end;
$$;

-- p_len (≤ 12) random characters from p_alphabet, from gen_random_uuid()'s
-- random bytes (the version/variant bytes are skipped).
create function private.rand_chars(p_alphabet text, p_len int) returns text
language plpgsql volatile set search_path = '' as $$
declare
  v_bytes bytea := uuid_send(gen_random_uuid());
  v_pos   constant int[] := array[0, 1, 2, 3, 4, 5, 10, 11, 12, 13, 14, 15];
  v_out   text := '';
begin
  for i in 1 .. least(p_len, 12) loop
    v_out := v_out || substr(p_alphabet, (get_byte(v_bytes, v_pos[i]) % length(p_alphabet)) + 1, 1);
  end loop;
  return v_out;
end;
$$;

-- Numeric part of a ref, exactly like app.js clientRefNumber(): the first run
-- of digits, or 0.
create function private.ref_number(p_ref text) returns numeric
language sql immutable set search_path = '' as $$
  select coalesce(substring(coalesce(p_ref, '') from '([0-9]+)')::numeric, 0);
$$;

-- Next ref after the highest one in a ledger array (app.js highestClientRef /
-- highestLoanRef + 1), padded to at least 4 digits like padStart(4, "0").
create function private.next_ref(p_items jsonb, p_prefix text) returns text
language sql immutable set search_path = '' as $$
  select p_prefix || case when length(n) >= 4 then n else lpad(n, 4, '0') end
  from (
    select (coalesce(max(private.ref_number(e ->> 'ref')), 0) + 1)::text as n
    from jsonb_array_elements(private.jarr(p_items)) as e
    where jsonb_typeof(e) = 'object'
  ) x;
$$;

-- 'N$4,000' / 'N$4,000.50' for human-readable timeline text.
create function private.money_text(p numeric) returns text
language sql immutable set search_path = '' as $$
  select case when p is null then 'N$0'
    else (case when p < 0 then '−' else '' end) || 'N$'
      || regexp_replace(to_char(abs(round(p, 2)), 'FM999,999,999,990.00'), '\.00$', '')
  end;
$$;

-- ===========================================================================
-- 2. Tables
-- ===========================================================================

-- One row: the rules every worksheet is checked against. Owner-editable
-- through policy_update(); the legal caps are enforced here too.
create table public.credit_policy (
  id                       integer primary key default 1
    constraint credit_policy_single_row check (id = 1),
  max_share_disposable_pct numeric(5,2) not null default 70
    constraint credit_policy_d5_check check (max_share_disposable_pct > 0 and max_share_disposable_pct <= 100),
  default_interest_rate    numeric(5,2) not null default 30
    constraint credit_policy_rate_check check (default_interest_rate >= 0),
  default_service_fee      numeric(12,2) not null default 0
    constraint credit_policy_fee_check check (default_service_fee >= 0),
  cost_cap_pct             numeric(5,2) not null default 30
    constraint credit_policy_cost_cap_check check (cost_cap_pct > 0 and cost_cap_pct <= 30),
  max_principal            numeric(12,2) not null default 100000
    constraint credit_policy_max_principal_check check (max_principal > 0 and max_principal <= 100000),
  max_term_months          integer not null default 5
    constraint credit_policy_max_term_check check (max_term_months between 1 and 5),
  bureau_required          boolean not null default false,
  red_flag_threshold       integer not null default 2
    constraint credit_policy_red_flag_check check (red_flag_threshold between 1 and 7),
  principal_round_step     numeric(12,2) not null default 50
    constraint credit_policy_round_step_check check (principal_round_step > 0 and principal_round_step <= 10000),
  min_age                  integer not null default 18,
  max_age                  integer not null default 70,
  sla_pickup_hours         integer not null default 24
    constraint credit_policy_sla_pickup_check check (sla_pickup_hours between 1 and 720),
  sla_approval_hours       integer not null default 24
    constraint credit_policy_sla_approval_check check (sla_approval_hours between 1 and 720),
  idle_minutes             integer not null default 20
    constraint credit_policy_idle_check check (idle_minutes between 5 and 240),
  updated_at               timestamptz not null default now(),
  updated_by               uuid,
  constraint credit_policy_age_check check (min_age >= 16 and max_age <= 100 and min_age < max_age),
  constraint credit_policy_rate_within_cap check (default_interest_rate <= cost_cap_pct)
);
insert into public.credit_policy (id) values (1);

-- The Worker's intake key, as a sha256 hex digest only.
create table private.intake_config (
  id          boolean primary key default true constraint intake_config_single_row check (id),
  key_sha256  text,
  rotated_at  timestamptz
);
insert into private.intake_config (id) values (true);

create table public.applications (
  id                  uuid primary key default gen_random_uuid(),
  ref                 text not null constraint applications_ref_key unique,
  source              text not null default 'web'
    constraint applications_source_check check (source in ('web', 'legacy')),
  status              text not null default 'submitted'
    constraint applications_status_check check (status in (
      'submitted', 'in_review', 'info_requested', 'awaiting_approval', 'approved',
      'disbursed', 'declined', 'withdrawn', 'archived')),
  submitted_at        timestamptz not null default now(),
  status_changed_at   timestamptz not null default now(),
  assigned_to         uuid references public.staff (user_id) on delete set null,
  assigned_at         timestamptz,

  -- The applicant, as submitted (staff may correct via app_update_applicant).
  full_name           text not null,
  national_id         text not null default '',
  national_id_norm    text generated always as (regexp_replace(upper(national_id), '[^A-Z0-9]', '', 'g')) stored,
  date_of_birth       date,
  phone               text not null default '',
  phone_norm          text generated always as (right(regexp_replace(phone, '[^0-9]', '', 'g'), 9)) stored,
  email               text,
  address             text,
  town                text,
  dependants          integer constraint applications_dependants_check check (dependants between 0 and 50),
  employer            text,
  job_title           text,
  employment_type     text,
  pay_day             text,
  bank_name           text,
  bank_account_holder text,
  bank_account_no     text,
  salary_into_account boolean,
  kin_name            text,
  kin_relationship    text,
  kin_phone           text,
  amount_requested    numeric(12,2) constraint applications_amount_check check (amount_requested > 0),
  repay_date          date,
  purpose             text,
  declared_income     numeric(12,2) constraint applications_declared_income_check check (declared_income >= 0),
  declared_deductions numeric(12,2) constraint applications_declared_deductions_check check (declared_deductions >= 0),
  declared_expenses   numeric(12,2) constraint applications_declared_expenses_check check (declared_expenses >= 0),
  declared            jsonb not null default '{}'::jsonb,  -- e.g. {"income_text": "..."} from the old form
  other_lender_loans  boolean,
  other_lender_count  integer constraint applications_other_lender_count_check check (other_lender_count between 0 and 50),
  consent_processing  boolean not null default false,
  consent_bureau      boolean not null default false,
  consent_version     text not null,

  -- Intake bookkeeping.
  ip_hash             text,       -- HMAC of the submitter's IP (rate limit only)
  upload_id           text,       -- R2 folder apps/<upload_id>/

  -- Telling the applicant.
  notified_at         timestamptz,
  notified_via        text constraint applications_notified_via_check check (notified_via in ('whatsapp', 'phone', 'in_person')),
  notified_by         uuid,

  -- Booking (app_disburse).
  client_id           text,
  client_ref          text,
  loan_id             text,
  loan_ref            text,
  payout_method       text,
  payout_reference    text,
  checklist           jsonb,
  disbursed_at        timestamptz,
  disbursed_by        uuid,

  legacy              jsonb,      -- the original D1 row for imported applications
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index applications_status_idx on public.applications (status, submitted_at desc);
create index applications_submitted_idx on public.applications (submitted_at desc);
create index applications_national_id_idx on public.applications (national_id_norm);
create index applications_phone_idx on public.applications (phone_norm);
create index applications_ip_idx on public.applications (ip_hash, submitted_at) where ip_hash is not null;
-- One application per upload folder: lets intake_submit answer a retry of the
-- same submission with what it already stored.
create unique index applications_upload_key on public.applications (upload_id) where upload_id is not null;
create index applications_assigned_idx on public.applications (assigned_to);

create table public.application_documents (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications (id),
  kind           text not null
    constraint application_documents_kind_check check (kind in ('id', 'payslip', 'bank', 'proof_address', 'other')),
  seq            integer not null default 1 constraint application_documents_seq_check check (seq between 1 and 50),
  r2_key         text not null constraint application_documents_r2_key_key unique,
  mime           text not null
    constraint application_documents_mime_check check (mime in (
      'image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'image/heic', 'image/heif')),
  bytes          bigint constraint application_documents_bytes_check check (bytes >= 0),
  original_name  text,
  uploaded_at    timestamptz not null default now(),
  constraint application_documents_slot_key unique (application_id, kind, seq)
);

-- Affordability worksheets. One row per version: a version is edited in
-- place until it is submitted; working on it again after a recall/return
-- starts the next version, so an owner's decision is always tied to exactly
-- what was submitted (optimistic lock in app_decide).
create table public.assessments (
  id                     uuid primary key default gen_random_uuid(),
  application_id         uuid not null references public.applications (id),
  version                integer not null constraint assessments_version_check check (version >= 1),
  worksheet              jsonb not null default '{}'::jsonb,
  terms                  jsonb not null default '{}'::jsonb,
  computed               jsonb not null default '{}'::jsonb,
  -- Promoted from computed, for lists and reports.
  disposable_income      numeric(14,2),   -- D4
  max_repayment          numeric(14,2),   -- D6
  total_repayable        numeric(14,2),   -- E7
  affordable             boolean,         -- F3
  max_principal_passing  numeric(14,2),   -- F5
  hard_fail_codes        text[] not null default '{}',
  owner_fail_codes       text[] not null default '{}',
  soft_fail_codes        text[] not null default '{}',
  recommendation         text constraint assessments_recommendation_check check (recommendation in (
    'approve', 'approve_above_limit', 'approve_reduced', 'decline', 'refer')),
  reasons                text,
  motivation             text,
  declaration            jsonb,
  created_at             timestamptz not null default now(),
  created_by             uuid,
  updated_at             timestamptz not null default now(),
  updated_by             uuid,
  submitted_at           timestamptz,
  submitted_by           uuid,
  constraint assessments_version_key unique (application_id, version)
);

create table public.decisions (
  id                  uuid primary key default gen_random_uuid(),
  application_id      uuid not null references public.applications (id),
  assessment_id       uuid references public.assessments (id),
  assessment_version  integer,
  outcome             text not null constraint decisions_outcome_check check (outcome in ('approved', 'declined', 'returned')),
  terms               jsonb,
  computed            jsonb,
  reasons             text,
  reason_to_applicant text constraint decisions_reason_check check (reason_to_applicant in ('afford', 'docs', 'history', 'other')),
  override_note       text,
  overridden_codes    text[] not null default '{}',
  self_assessed       boolean not null default false,
  decided_by          uuid not null,
  decided_at          timestamptz not null default now(),
  snapshot            jsonb
);
create index decisions_application_idx on public.decisions (application_id, decided_at desc);

create table public.application_notes (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications (id),
  kind           text not null default 'note'
    constraint application_notes_kind_check check (kind in ('note', 'info_request', 'system')),
  body           text not null constraint application_notes_body_check check (length(body) between 1 and 4000),
  author         uuid,
  author_name    text,
  created_at     timestamptz not null default now()
);
create index application_notes_application_idx on public.application_notes (application_id, created_at desc);

-- ===========================================================================
-- 3. Worksheet maths — CONTRACT §4. Mirrored to the cent by JS QSCredit.compute;
--    tests/fixtures/credit-cases.json holds the shared cases.
-- ===========================================================================

create function private.assessment_compute(p_worksheet jsonb, p_terms jsonb, p_app jsonb, p_policy jsonb)
returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  ws    jsonb := case when jsonb_typeof(p_worksheet) = 'object' then p_worksheet else '{}'::jsonb end;
  t     jsonb := case when jsonb_typeof(p_terms) = 'object' then p_terms else '{}'::jsonb end;
  app   jsonb := case when jsonb_typeof(p_app) = 'object' then p_app else '{}'::jsonb end;
  pol   jsonb := case when jsonb_typeof(p_policy) = 'object' then p_policy else '{}'::jsonb end;
  inc   jsonb := ws -> 'income';
  com   jsonb := ws -> 'commitments';
  liv   jsonb := ws -> 'living';
  docs  jsonb := ws -> 'docs';
  ver   jsonb := ws -> 'verify';
  bur   jsonb := ws -> 'bureau';
  flg   jsonb := ws -> 'flags';
  con   jsonb := ws -> 'conduct';
  yes   constant jsonb := 'true'::jsonb;
  a4 numeric; a6 numeric; a8 numeric; b12 numeric; c10 numeric;
  d4 numeric; d5 numeric; d6 numeric;
  e1 numeric; rate numeric; e2 numeric; e3 numeric; e4 numeric; e7 numeric; e10 integer;
  v_issue date; v_due date;
  f3 boolean; f4 numeric; f5 numeric; g7 boolean := false; flag_count integer := 0;
  v_step numeric; v_max numeric; v_cap numeric; v_months integer; v_threshold numeric;
  v_g4 text;
  rules jsonb := '[]'::jsonb;
  hard text[]; own text[]; soft text[];
begin
  -- A: income
  a4 := private.r2(private.jnum(inc -> 'a1') - private.jnum(inc -> 'a2') - private.jnum(inc -> 'a3'));
  a6 := case when coalesce(inc -> 'irregular' = yes, false)
          then private.jnum(inc -> 'a11')
          else least(a4, private.jnum(inc -> 'a5')) end;
  a8 := private.r2(a6 + private.jnum(inc -> 'a7'));
  -- B: commitments (b8 is our own balance, filled in server-side)
  b12 := private.r2(
      private.jnum(com -> 'b1') + private.jnum(com -> 'b2') + private.jnum(com -> 'b3') + private.jnum(com -> 'b4')
    + private.jnum(com -> 'b5') + private.jnum(com -> 'b6') + private.jnum(com -> 'b7') + private.jnum(com -> 'b8')
    + private.jnum(com -> 'b9') + private.jnum(com -> 'b10') + private.jnum(com -> 'b11'));
  -- C: living costs
  c10 := private.r2(
      private.jnum(liv -> 'c1') + private.jnum(liv -> 'c2') + private.jnum(liv -> 'c3') + private.jnum(liv -> 'c4')
    + private.jnum(liv -> 'c5') + private.jnum(liv -> 'c6') + private.jnum(liv -> 'c7') + private.jnum(liv -> 'c8')
    + private.jnum(liv -> 'c9'));
  -- D: disposable income and the most one repayment may take
  d4 := private.r2(a8 - b12 - c10);
  d5 := private.jnum(pol -> 'max_share_disposable_pct');
  d6 := private.r2(greatest(0, d4 * d5 / 100));
  -- E: the loan
  e1 := private.jnum(t -> 'principal');
  rate := private.jnum(t -> 'interest_rate');
  e2 := private.r2(e1 * rate / 100);
  e3 := private.jnum(t -> 'service_fee');
  e4 := private.r2(e2 + e3);
  e7 := private.r2(e1 + e4);
  v_issue := private.try_date(t ->> 'issue_date');
  v_due := private.try_date(t ->> 'due_date');
  e10 := v_due - v_issue;
  -- F: affordability
  f3 := e7 > 0 and e7 <= d6;
  f4 := private.r2(d4 - e7);
  v_step := private.jnum(pol -> 'principal_round_step');
  v_max := private.jnum(pol -> 'max_principal');
  -- floor(((D6 − E3) / (1 + rate/100)) / step) × step, done as one exact
  -- integer division so no rounding can push it over a step boundary.
  if d6 > e3 and v_step > 0 and 100 + rate > 0 then
    f5 := div((d6 - e3) * 100, (100 + rate) * v_step) * v_step;
  else
    f5 := 0;
  end if;
  f5 := least(f5, v_max);
  -- G7: other lenders (b8 excluded)
  g7 := private.jnum(com -> 'b1') > 0 or private.jnum(com -> 'b2') > 0 or private.jnum(com -> 'b3') > 0
     or private.jnum(com -> 'b4') > 0 or private.jnum(com -> 'b5') > 0 or private.jnum(com -> 'b6') > 0
     or private.jnum(com -> 'b7') > 0 or private.jnum(com -> 'b9') > 0 or private.jnum(com -> 'b10') > 0
     or private.jnum(com -> 'b11') > 0;
  for i in 1 .. 7 loop
    if coalesce(flg -> ('f8_' || i) = yes, false) then
      flag_count := flag_count + 1;
    end if;
  end loop;

  v_cap := private.jnum(pol -> 'cost_cap_pct');
  v_months := floor(private.jnum(pol -> 'max_term_months'))::int;
  v_threshold := private.jnum(pol -> 'red_flag_threshold');

  if coalesce(pol -> 'bureau_required' = yes, false) then
    v_g4 := case when coalesce(bur -> 'used' = yes, false)
                   and private.jpresent(bur -> 'date')
                   and private.jpresent(bur -> 'ref')
              then 'pass' else 'fail' end;
  else
    v_g4 := 'na';
  end if;

  -- Rules, in the contract's table order.
  rules := jsonb_build_array(
    jsonb_build_object('code', 'D4', 'class', 'hard', 'result', case when d4 > 0 then 'pass' else 'fail' end),
    jsonb_build_object('code', 'DOCS', 'class', 'hard', 'result', case when
        coalesce(docs -> 'd2_1' = yes, false) and coalesce(docs -> 'd2_2' = yes, false)
        and coalesce(docs -> 'd2_3' = yes, false) and coalesce(docs -> 'd2_4' = yes, false)
        and coalesce(docs -> 'd2_5' = yes, false) then 'pass' else 'fail' end),
    jsonb_build_object('code', 'G1', 'class', 'hard', 'result', case when
        e1 > 0 and e4 <= e1 * v_cap / 100 + 0.005 then 'pass' else 'fail' end),
    jsonb_build_object('code', 'G2', 'class', 'hard', 'result', case when
        e1 > 0 and e1 <= v_max then 'pass' else 'fail' end),
    jsonb_build_object('code', 'G3', 'class', 'hard', 'result', case when
        v_issue is not null and v_due is not null and v_issue < v_due
        and v_due <= (v_issue + make_interval(months => v_months))::date then 'pass' else 'fail' end),
    jsonb_build_object('code', 'G4', 'class', 'hard', 'result', v_g4),
    jsonb_build_object('code', 'G10', 'class', 'hard', 'result', case when coalesce(con -> 'g10' = yes, false) then 'pass' else 'fail' end),
    jsonb_build_object('code', 'G11', 'class', 'hard', 'result', case when coalesce(con -> 'g11' = yes, false) then 'pass' else 'fail' end),
    jsonb_build_object('code', 'F3', 'class', 'owner', 'result', case when f3 then 'pass' else 'fail' end),
    jsonb_build_object('code', 'G8', 'class', 'owner', 'result', case when (not g7) or f3 then 'pass' else 'fail' end),
    jsonb_build_object('code', 'G5', 'class', 'soft', 'result', case when coalesce(app -> 'consent_bureau' = yes, false) then 'pass' else 'fail' end),
    jsonb_build_object('code', 'G6', 'class', 'soft', 'result', case when
        private.jpresent(app -> 'amount_requested') and private.jpresent(app -> 'bank_account_no')
        and private.jpresent(app -> 'pay_day') and private.jpresent(app -> 'employer')
        and private.jpresent(app -> 'kin_name') and private.jpresent(app -> 'kin_phone') then 'pass' else 'fail' end),
    jsonb_build_object('code', 'G9', 'class', 'soft', 'result', case when
        jsonb_typeof(con -> 'g9') = 'string' and (con ->> 'g9') in ('na', 'yes') then 'pass' else 'fail' end),
    jsonb_build_object('code', 'FLAGS', 'class', 'soft', 'result', case when flag_count < v_threshold then 'pass' else 'fail' end),
    jsonb_build_object('code', 'VERIFY', 'class', 'soft', 'result', case when
        coalesce(ver -> 'v2_8' = yes, false) and coalesce(ver -> 'v2_9' = yes, false)
        and coalesce(ver -> 'v2_10' = yes, false) then 'pass' else 'fail' end),
    jsonb_build_object('code', 'G7', 'class', 'info', 'result', case when g7 then 'yes' else 'no' end)
  );

  select coalesce(array_agg(r ->> 'code' order by n) filter (where r ->> 'class' = 'hard' and r ->> 'result' = 'fail'), '{}'),
         coalesce(array_agg(r ->> 'code' order by n) filter (where r ->> 'class' = 'owner' and r ->> 'result' = 'fail'), '{}'),
         coalesce(array_agg(r ->> 'code' order by n) filter (where r ->> 'class' = 'soft' and r ->> 'result' = 'fail'), '{}')
    into hard, own, soft
  from jsonb_array_elements(rules) with ordinality as x(r, n);

  return jsonb_build_object(
    'a4', trim_scale(a4), 'a6', trim_scale(a6), 'a8', trim_scale(a8),
    'b12', trim_scale(b12), 'c10', trim_scale(c10),
    'd1', trim_scale(a8), 'd2', trim_scale(b12), 'd3', trim_scale(c10),
    'd4', trim_scale(d4), 'd5', trim_scale(d5), 'd6', trim_scale(d6),
    'e1', trim_scale(e1), 'e2', trim_scale(e2), 'e3', trim_scale(e3), 'e4', trim_scale(e4),
    'e5', trim_scale(e7), 'e7', trim_scale(e7), 'e10', e10,
    'f3', f3, 'f4', trim_scale(f4), 'f5', trim_scale(f5),
    'g7', g7, 'flag_count', flag_count,
    'rules', rules,
    'hard_fail_codes', to_jsonb(hard),
    'owner_fail_codes', to_jsonb(own),
    'soft_fail_codes', to_jsonb(soft)
  );
end;
$$;

-- ===========================================================================
-- 4. Who is calling, and what they may do
-- ===========================================================================

create function private.require_staff() returns public.staff
language plpgsql stable set search_path = '' as $$
declare
  v public.staff;
begin
  select * into v from public.staff where user_id = auth.uid();
  if v.user_id is null or not v.active then
    perform private.fail('QS_FORBIDDEN', 'Your login isn''t enabled for the credit desk — ask the owner.');
  end if;
  return v;
end;
$$;

create function private.require_owner() returns public.staff
language plpgsql stable set search_path = '' as $$
declare
  v public.staff := private.require_staff();
begin
  if v.role <> 'owner' then
    perform private.fail('QS_FORBIDDEN', 'Only an owner can do this.');
  end if;
  return v;
end;
$$;

create function private.staff_name(p_user uuid) returns text
language sql stable set search_path = '' as $$
  select s.full_name from public.staff s where s.user_id = p_user;
$$;

create function private.get_app(p_app_id uuid, p_lock boolean default false) returns public.applications
language plpgsql set search_path = '' as $$
declare
  v public.applications;
begin
  if p_app_id is null then
    perform private.fail('QS_INVALID', 'Say which application.');
  end if;
  if p_lock then
    select * into v from public.applications where id = p_app_id for update;
  else
    select * into v from public.applications where id = p_app_id;
  end if;
  if v.id is null then
    perform private.fail('QS_NOT_FOUND', 'That application doesn''t exist.');
  end if;
  return v;
end;
$$;

-- The current (highest) worksheet version, or a null row.
create function private.current_assessment(p_app_id uuid) returns public.assessments
language sql stable set search_path = '' as $$
  select a.* from public.assessments a
  where a.application_id = p_app_id
  order by a.version desc
  limit 1;
$$;

create function private.status_label(p_status text) returns text
language sql immutable set search_path = '' as $$
  select case p_status
    when 'submitted' then 'new'
    when 'in_review' then 'in review'
    when 'info_requested' then 'waiting on the applicant'
    when 'awaiting_approval' then 'awaiting approval'
    when 'approved' then 'approved and waiting to be paid out'
    else coalesce(p_status, 'unknown')
  end;
$$;

-- The state machine (CONTRACT §3) in one place. Returns null when p_me may do
-- p_action to p_app now, otherwise the full 'QS_<CODE>: …' message.
create function private.check_action(p_app public.applications, p_me public.staff, p_action text, p_asm public.assessments)
returns text
language plpgsql stable set search_path = '' as $$
declare
  v_owner    boolean := p_me.role = 'owner' and p_me.active;
  v_assignee boolean := p_app.assigned_to is not null and p_app.assigned_to = p_me.user_id;
  v_pre      boolean := p_app.status in ('submitted', 'in_review', 'info_requested', 'awaiting_approval');
  v_state    text := 'QS_BAD_STATE: This application is ' || private.status_label(p_app.status) || ', so that can''t be done now.';
begin
  if p_me.user_id is null or not p_me.active then
    return 'QS_FORBIDDEN: Your login isn''t enabled for the credit desk — ask the owner.';
  end if;

  case p_action
    when 'claim' then
      -- A new file; or one in review that nobody active is working on (a
      -- declined/withdrawn file reopened before anyone picked it up, or its
      -- analyst was deactivated) — otherwise only an owner could move it.
      if not (p_app.status = 'submitted'
              or (p_app.status = 'in_review'
                  and not exists (select 1 from public.staff s
                                  where s.user_id = p_app.assigned_to and s.active))) then
        return v_state;
      end if;
    when 'request_info' then
      if not (v_owner or v_assignee) then
        return 'QS_FORBIDDEN: Only the analyst who picked this up, or an owner, can ask the applicant for more.';
      end if;
      if p_app.status <> 'in_review' then return v_state; end if;
    when 'resume' then
      if p_app.status <> 'info_requested' then return v_state; end if;
    when 'save_assessment', 'submit_assessment' then
      if not (v_owner or v_assignee) then
        return 'QS_FORBIDDEN: Only the analyst who picked this up, or an owner, can work on the worksheet.';
      end if;
      if p_app.status <> 'in_review' then return v_state; end if;
    when 'recall' then
      if p_app.status <> 'awaiting_approval' then return v_state; end if;
      if p_asm.submitted_by is distinct from p_me.user_id then
        return 'QS_FORBIDDEN: Only the person who sent it for approval can recall it.';
      end if;
    when 'return', 'approve' then
      if not v_owner then return 'QS_FORBIDDEN: Only an owner can decide.'; end if;
      if p_app.status <> 'awaiting_approval' then return v_state; end if;
    when 'decline', 'decide' then
      if not v_owner then return 'QS_FORBIDDEN: Only an owner can decide.'; end if;
      if not v_pre then return v_state; end if;
    when 'disburse' then
      if not v_owner then return 'QS_FORBIDDEN: Only an owner can pay out and book a loan.'; end if;
      if p_app.status <> 'approved' then return v_state; end if;
    when 'withdraw' then
      if p_app.status = 'approved' then
        if not v_owner then return 'QS_FORBIDDEN: Only an owner can withdraw an approved application.'; end if;
      elsif not v_pre then
        return v_state;
      end if;
    when 'reopen' then
      if not v_owner then return 'QS_FORBIDDEN: Only an owner can reopen an application.'; end if;
      if p_app.status not in ('declined', 'withdrawn') then return v_state; end if;
    when 'update_applicant' then
      if p_app.status = 'awaiting_approval' then
        if not v_owner then
          return 'QS_BAD_STATE: It''s with the owner for approval — recall it before changing the applicant''s details.';
        end if;
      elsif p_app.status not in ('submitted', 'in_review', 'info_requested') then
        return v_state;
      end if;
    when 'add_note', 'mark_notified' then
      null;
    else
      return 'QS_INVALID: Unknown action ' || coalesce(p_action, '(none)') || '.';
  end case;
  return null;
end;
$$;

create function private.allowed_actions(p_app public.applications, p_me public.staff, p_asm public.assessments)
returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(a order by n), '[]'::jsonb)
  from unnest(array['claim', 'request_info', 'resume', 'save_assessment', 'submit_assessment', 'recall',
                    'decide', 'withdraw', 'reopen', 'disburse', 'add_note', 'mark_notified', 'update_applicant'])
       with ordinality as x(a, n)
  where private.check_action(p_app, p_me, a, p_asm) is null;
$$;

-- Every status change goes through here: lock, check role + state, move,
-- write the audit entry.
create function private.transition(p_app_id uuid, p_action text, p_detail jsonb default '{}'::jsonb)
returns public.applications
language plpgsql set search_path = '' as $$
declare
  v_me    public.staff := private.require_staff();
  v_app   public.applications := private.get_app(p_app_id, true);
  v_from  text := v_app.status;
  v_err   text;
  v_to    text;
  v_audit text;
  v_cat   text;
begin
  v_err := private.check_action(v_app, v_me, p_action, private.current_assessment(p_app_id));
  if v_err is not null then
    raise exception using errcode = 'P0001', message = v_err;
  end if;

  select x.to_status, x.audit_action, x.category into v_to, v_audit, v_cat
  from (values
    ('claim',             'in_review',         'app.claimed',          'application'),
    ('request_info',      'info_requested',    'app.info_requested',   'application'),
    ('resume',            'in_review',         'app.resumed',          'application'),
    ('submit_assessment', 'awaiting_approval', 'assessment.submitted', 'application'),
    ('recall',            'in_review',         'app.recalled',         'application'),
    ('return',            'in_review',         'decision.returned',    'decision'),
    ('approve',           'approved',          'decision.approved',    'decision'),
    ('decline',           'declined',          'decision.declined',    'decision'),
    ('disburse',          'disbursed',         'ledger.booked',        'ledger'),
    ('withdraw',          'withdrawn',         'app.withdrawn',        'application'),
    ('reopen',            'in_review',         'app.reopened',         'application')
  ) as x(action, to_status, audit_action, category)
  where x.action = p_action;
  if v_to is null then
    perform private.fail('QS_INVALID', 'Unknown transition ' || coalesce(p_action, '(none)') || '.');
  end if;

  update public.applications a
     set status = v_to,
         -- (claiming an unassigned file already in review keeps its status)
         status_changed_at = case when v_to <> v_from then now() else a.status_changed_at end,
         updated_at = now(),
         assigned_to = case when p_action = 'claim' then v_me.user_id else a.assigned_to end,
         assigned_at = case when p_action = 'claim' then now() else a.assigned_at end
   where a.id = v_app.id
  returning a.* into v_app;

  perform private.audit(v_audit, v_cat, v_app.id, 'application', v_app.id::text,
    coalesce(p_detail, '{}'::jsonb) || jsonb_build_object('ref', v_app.ref, 'from', v_from, 'to', v_to));
  return v_app;
end;
$$;

-- ===========================================================================
-- 5. Applicant fields: one whitelist + validator for the website and for
--    staff corrections.
-- ===========================================================================

create function private.app_clean(p_app jsonb, p_mode text, p_max_principal numeric)
returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_in     jsonb := case when jsonb_typeof(p_app) = 'object' then p_app else '{}'::jsonb end;
  v_out    jsonb := '{}'::jsonb;
  v_bad    text[] := '{}';
  v_key    text;
  v_type   text;
  v_max    integer;
  v_val    jsonb;
  v_text   text;
  v_num    numeric;
  v_date   date;
  v_modes  text[];
begin
  if p_mode = 'staff' then
    -- Staff may correct applicant details, never consent or intake fields.
    for v_key in select jsonb_object_keys(v_in) loop
      if v_key not in ('full_name', 'national_id', 'date_of_birth', 'phone', 'email', 'address', 'town',
                       'dependants', 'employer', 'job_title', 'employment_type', 'pay_day', 'bank_name',
                       'bank_account_holder', 'bank_account_no', 'salary_into_account', 'kin_name',
                       'kin_relationship', 'kin_phone', 'amount_requested', 'repay_date', 'purpose',
                       'declared_income', 'declared_deductions', 'declared_expenses', 'other_lender_loans',
                       'other_lender_count') then
        perform private.fail('QS_INVALID', format('%s can''t be changed here.', left(v_key, 40)));
      end if;
    end loop;
  end if;

  for v_key, v_type, v_max, v_modes in
    select * from (values
      ('full_name',           'text',  120, array['intake', 'staff']),
      ('national_id',         'text',   30, array['intake', 'staff']),
      ('date_of_birth',       'date',  null, array['intake', 'staff']),
      ('phone',               'text',   30, array['intake', 'staff']),
      ('email',               'text',  120, array['intake', 'staff']),
      ('address',             'text',  300, array['intake', 'staff']),
      ('town',                'text',   80, array['intake', 'staff']),
      ('dependants',          'int',    50, array['intake', 'staff']),
      ('employer',            'text',  120, array['intake', 'staff']),
      ('job_title',           'text',   80, array['intake', 'staff']),
      ('employment_type',     'text',   40, array['intake', 'staff']),
      ('pay_day',             'text',   40, array['intake', 'staff']),
      ('bank_name',           'text',   80, array['intake', 'staff']),
      ('bank_account_holder', 'text',  120, array['intake', 'staff']),
      ('bank_account_no',     'text',   30, array['intake', 'staff']),
      ('salary_into_account', 'bool',  null, array['intake', 'staff']),
      ('kin_name',            'text',  120, array['intake', 'staff']),
      ('kin_relationship',    'text',   60, array['intake', 'staff']),
      ('kin_phone',           'text',   30, array['intake', 'staff']),
      ('amount_requested',    'money', null, array['intake', 'staff']),
      ('repay_date',          'date',  null, array['intake', 'staff']),
      ('purpose',             'text',  300, array['intake', 'staff']),
      ('declared_income',     'money', null, array['intake', 'staff']),
      ('declared_deductions', 'money', null, array['intake', 'staff']),
      ('declared_expenses',   'money', null, array['intake', 'staff']),
      ('other_lender_loans',  'bool',  null, array['intake', 'staff']),
      ('other_lender_count',  'int',    50, array['intake', 'staff']),
      ('consent_processing',  'bool',  null, array['intake']),
      ('consent_bureau',      'bool',  null, array['intake']),
      ('consent_version',     'text',   40, array['intake']),
      ('ip_hash',             'hash',  null, array['intake']),
      ('declared',            'declared', null, array['intake'])
    ) as f(key, type, max, modes)
  loop
    continue when not (p_mode = any (v_modes));
    -- Staff patches touch only the keys they send; intake always gets every key.
    continue when p_mode = 'staff' and not (v_in ? v_key);
    v_val := v_in -> v_key;
    if v_val is null or jsonb_typeof(v_val) = 'null' then
      v_out := v_out || jsonb_build_object(v_key, null);
      continue;
    end if;

    case v_type
      when 'text' then
        if jsonb_typeof(v_val) not in ('string', 'number') then
          v_bad := v_bad || v_key;
        else
          v_text := btrim(v_val #>> '{}');
          if length(v_text) > v_max then
            v_bad := v_bad || v_key;
          else
            v_out := v_out || jsonb_build_object(v_key, nullif(v_text, ''));
          end if;
        end if;
      when 'date' then
        v_date := case when jsonb_typeof(v_val) = 'string' then private.try_date(btrim(v_val #>> '{}')) end;
        if v_date is null and not (jsonb_typeof(v_val) = 'string' and btrim(v_val #>> '{}') = '') then
          v_bad := v_bad || v_key;
        else
          v_out := v_out || jsonb_build_object(v_key, v_date);
        end if;
      when 'int' then
        if jsonb_typeof(v_val) <> 'number' or (v_val #>> '{}')::numeric <> trunc((v_val #>> '{}')::numeric)
           or (v_val #>> '{}')::numeric < 0 or (v_val #>> '{}')::numeric > v_max then
          v_bad := v_bad || v_key;
        else
          v_out := v_out || jsonb_build_object(v_key, (v_val #>> '{}')::numeric::int);
        end if;
      when 'money' then
        v_num := case
          when jsonb_typeof(v_val) = 'number' then (v_val #>> '{}')::numeric
          when jsonb_typeof(v_val) = 'string' and btrim(v_val #>> '{}') ~ '^[0-9]+(\.[0-9]{1,2})?$' then btrim(v_val #>> '{}')::numeric
        end;
        if v_num is null or v_num < 0 or v_num > 10000000 or v_num <> round(v_num, 2) then
          v_bad := v_bad || v_key;
        else
          v_out := v_out || jsonb_build_object(v_key, v_num);
        end if;
      when 'bool' then
        if jsonb_typeof(v_val) <> 'boolean' then
          v_bad := v_bad || v_key;
        else
          v_out := v_out || jsonb_build_object(v_key, v_val);
        end if;
      when 'hash' then
        if jsonb_typeof(v_val) <> 'string' or (v_val #>> '{}') !~ '^[0-9a-f]{16,128}$' then
          v_bad := v_bad || v_key;
        else
          v_out := v_out || jsonb_build_object(v_key, v_val);
        end if;
      when 'declared' then
        if jsonb_typeof(v_val) <> 'object' then
          v_bad := v_bad || v_key;
        elsif jsonb_typeof(v_val -> 'income_text') = 'string' then
          v_out := v_out || jsonb_build_object(v_key, jsonb_build_object('income_text', left(btrim(v_val ->> 'income_text'), 120)));
        else
          v_out := v_out || jsonb_build_object(v_key, '{}'::jsonb);
        end if;
    end case;
  end loop;

  -- Field-level rules.
  if v_out ? 'full_name' and length(coalesce(v_out ->> 'full_name', '')) < 2 then
    v_bad := v_bad || 'full_name'::text;
  end if;
  if v_out ? 'national_id' and length(private.norm_id(v_out ->> 'national_id')) < 4 then
    v_bad := v_bad || 'national_id'::text;
  end if;
  if v_out ? 'phone' and length(regexp_replace(coalesce(v_out ->> 'phone', ''), '[^0-9]', '', 'g')) < 7 then
    v_bad := v_bad || 'phone'::text;
  end if;
  if v_out ? 'kin_phone' and v_out ->> 'kin_phone' is not null
     and length(regexp_replace(v_out ->> 'kin_phone', '[^0-9]', '', 'g')) < 7 then
    v_bad := v_bad || 'kin_phone'::text;
  end if;
  if v_out ->> 'email' is not null and (v_out ->> 'email') !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    v_bad := v_bad || 'email'::text;
  end if;
  if v_out ->> 'date_of_birth' is not null
     and ((v_out ->> 'date_of_birth')::date < date '1900-01-01' or (v_out ->> 'date_of_birth')::date > private.today_na()) then
    v_bad := v_bad || 'date_of_birth'::text;
  end if;
  if v_out ? 'amount_requested' and v_out ->> 'amount_requested' is not null
     and ((v_out ->> 'amount_requested')::numeric <= 0 or (v_out ->> 'amount_requested')::numeric > p_max_principal) then
    v_bad := v_bad || 'amount_requested'::text;
  end if;

  if p_mode = 'intake' then
    -- amount_requested may be missing: the old form (still cached on some
    -- phones) never asked for it, and CONTRACT §8 keeps that form working.
    -- The worksheet's G6 flags it and staff fill it in (app_update_applicant).
    if coalesce(v_out -> 'consent_processing' <> 'true'::jsonb, true) then v_bad := v_bad || 'consent_processing'::text; end if;
    if v_out ->> 'consent_version' is null then v_bad := v_bad || 'consent_version'::text; end if;
    if v_out ->> 'ip_hash' is null then v_bad := v_bad || 'ip_hash'::text; end if;
  end if;
  -- Identity fields can be corrected but never blanked.
  if v_out ? 'full_name' and v_out ->> 'full_name' is null then v_bad := v_bad || 'full_name'::text; end if;
  if v_out ? 'national_id' and v_out ->> 'national_id' is null then v_bad := v_bad || 'national_id'::text; end if;
  if v_out ? 'phone' and v_out ->> 'phone' is null then v_bad := v_bad || 'phone'::text; end if;

  if cardinality(v_bad) > 0 then
    perform private.fail('QS_INVALID', 'Check these fields: '
      || (select string_agg(distinct b, ', ') from unnest(v_bad) as b) || '.');
  end if;
  return v_out;
end;
$$;

create function private.app_bits(p_app public.applications) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'consent_bureau', p_app.consent_bureau,
    'amount_requested', p_app.amount_requested,
    'bank_account_no', p_app.bank_account_no,
    'pay_day', p_app.pay_day,
    'employer', p_app.employer,
    'kin_name', p_app.kin_name,
    'kin_phone', p_app.kin_phone);
$$;

-- What staff see of an application (the IP hash and upload folder stay inside).
create function private.app_json(p_app public.applications) returns jsonb
language sql stable set search_path = '' as $$
  select (to_jsonb(p_app) - 'ip_hash' - 'upload_id')
      || jsonb_build_object('assigned_name', private.staff_name(p_app.assigned_to));
$$;

create function private.policy_json() returns jsonb
language sql stable set search_path = '' as $$
  select to_jsonb(p) from public.credit_policy p where p.id = 1;
$$;

-- Terms: only the five contract keys, validated. Missing numbers stay null
-- (the maths treats them as 0). p_partial: return only the keys given.
create function private.clean_terms(p_terms jsonb, p_partial boolean default false) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_in  jsonb := coalesce(p_terms, '{}'::jsonb);
  v_key text;
  v_out jsonb := '{}'::jsonb;
  v_val jsonb;
  v_num numeric;
begin
  if jsonb_typeof(v_in) <> 'object' then
    perform private.fail('QS_INVALID', 'The loan terms must be an object.');
  end if;
  for v_key in select jsonb_object_keys(v_in) loop
    if v_key not in ('principal', 'interest_rate', 'service_fee', 'issue_date', 'due_date') then
      perform private.fail('QS_INVALID', format('Unknown loan term %s.', left(v_key, 40)));
    end if;
  end loop;
  foreach v_key in array array['principal', 'interest_rate', 'service_fee'] loop
    continue when p_partial and not (v_in ? v_key);
    v_val := v_in -> v_key;
    if v_val is null or jsonb_typeof(v_val) = 'null' then
      v_out := v_out || jsonb_build_object(v_key, null);
      continue;
    end if;
    if jsonb_typeof(v_val) <> 'number' then
      perform private.fail('QS_INVALID', format('The %s must be a number.', replace(v_key, '_', ' ')));
    end if;
    v_num := (v_val #>> '{}')::numeric;
    if v_num < 0 or v_num > (case v_key when 'interest_rate' then 100 else 10000000 end) then
      perform private.fail('QS_INVALID', format('The %s is out of range.', replace(v_key, '_', ' ')));
    end if;
    -- Money to the cent and the rate to 2 decimals, as the ledger keeps them
    -- (the phone app would otherwise round a stored N$1,000.005 on its own).
    if v_num <> round(v_num, 2) then
      perform private.fail('QS_INVALID', format('The %s can have at most 2 decimals.', replace(v_key, '_', ' ')));
    end if;
    v_out := v_out || jsonb_build_object(v_key, v_val);
  end loop;
  foreach v_key in array array['issue_date', 'due_date'] loop
    continue when p_partial and not (v_in ? v_key);
    v_val := v_in -> v_key;
    if v_val is null or jsonb_typeof(v_val) = 'null' or (jsonb_typeof(v_val) = 'string' and v_val #>> '{}' = '') then
      v_out := v_out || jsonb_build_object(v_key, null);
      continue;
    end if;
    if jsonb_typeof(v_val) <> 'string' or private.try_date(v_val #>> '{}') is null then
      perform private.fail('QS_INVALID', format('The %s must be a date (YYYY-MM-DD).', replace(v_key, '_', ' ')));
    end if;
    v_out := v_out || jsonb_build_object(v_key, v_val);
  end loop;
  return v_out;
end;
$$;

-- Terms that can be booked: the interest (principal × rate / 100) must be a
-- whole number of cents. The desk rounds exactly (CONTRACT §4 r2) but the
-- phone app, which collects the loan, rounds in binary floats (§6), and on a
-- half cent they part by N$0.01 (N$500.05 at 30 %: E7 650.07, phone 650.06).
-- Refusing those terms keeps "total repayable", the WhatsApp message and the
-- loan book on the same cent. Checked when recommending approval, approving
-- and paying out — not on autosave.
create function private.check_bookable_terms(p_terms jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  v_principal numeric := private.jnum(p_terms -> 'principal');
  v_rate      numeric := private.jnum(p_terms -> 'interest_rate');
  v_interest  numeric := v_principal * v_rate / 100;
begin
  if v_interest <> round(v_interest, 2) then
    perform private.fail('QS_INVALID', format(
      'At %s%% the interest on %s comes to %s, which is not a whole number of cents, so the desk and the '
      || 'phone app could round it to different cents. Change the amount or the rate slightly.',
      trim_scale(v_rate), private.money_text(v_principal), 'N$' || trim_scale(v_interest)));
  end if;
end;
$$;

create function private.check_worksheet(p_ws jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  v_sec text;
  v_key text;
  v_val jsonb;
begin
  if p_ws is null or jsonb_typeof(p_ws) <> 'object' then
    perform private.fail('QS_INVALID', 'The worksheet must be an object.');
  end if;
  if length(p_ws::text) > 65536 then
    perform private.fail('QS_INVALID', 'The worksheet is too large.');
  end if;
  foreach v_sec in array array['docs', 'verify', 'bureau', 'income', 'commitments', 'living', 'flags', 'conduct'] loop
    if jsonb_typeof(p_ws -> v_sec) not in ('object', 'null') then
      perform private.fail('QS_INVALID', format('Worksheet section %s must be an object.', v_sec));
    end if;
  end loop;
  for v_sec, v_key in
    select * from (values
      ('income', 'a1'), ('income', 'a2'), ('income', 'a3'), ('income', 'a5'), ('income', 'a7'), ('income', 'a11'),
      ('commitments', 'b1'), ('commitments', 'b2'), ('commitments', 'b3'), ('commitments', 'b4'),
      ('commitments', 'b5'), ('commitments', 'b6'), ('commitments', 'b7'), ('commitments', 'b9'),
      ('commitments', 'b10'), ('commitments', 'b11'),
      ('living', 'c1'), ('living', 'c2'), ('living', 'c3'), ('living', 'c4'), ('living', 'c5'),
      ('living', 'c6'), ('living', 'c7'), ('living', 'c8'), ('living', 'c9'), ('living', 'dependants'),
      ('bureau', 'open_accounts'), ('bureau', 'monthly_commitments'), ('bureau', 'enquiries_3m')
    ) as f(sec, key)
  loop
    v_val := p_ws -> v_sec -> v_key;
    continue when v_val is null or jsonb_typeof(v_val) = 'null';
    if jsonb_typeof(v_val) <> 'number' or (v_val #>> '{}')::numeric < 0 or (v_val #>> '{}')::numeric > 100000000 then
      perform private.fail('QS_INVALID', format('Worksheet %s must be a number between 0 and 100,000,000.', upper(v_key)));
    end if;
  end loop;
end;
$$;

-- ===========================================================================
-- 6. The ledger, read the way the phone app reads it
-- ===========================================================================

create function private.ledger_data() returns jsonb
language sql stable set search_path = '' as $$
  select l.data from public.ledger l where l.id = 'main';
$$;

-- Every loan in a ledger document, analysed exactly like app.js
-- loanTerms()/analyzeLoan(): interest = roundMoney(principal × rate / 100)
-- computed in doubles like the phone, extension interest =
-- Σ extensions[].addedInterest, payments in date then createdAt order, status
-- paid / written-off / overdue / active. Every rounding is the phone's
-- roundMoney (private.round_money), so borrower history, B8 and qs_balance
-- land on the phone app's cent.
create function private.ledger_loans(p_data jsonb, p_today date)
returns table (
  loan_id text, ref text, client_id text, application_id text, issue_date text, due_date text,
  principal numeric, interest_rate numeric, interest numeric, fees numeric, extension_interest numeric,
  total_due numeric, paid numeric, outstanding numeric, status text, paid_date text, days_late integer,
  extensions integer, payments jsonb, ord bigint
)
language sql stable set search_path = '' as $$
  with l as (
    select x.loan, x.ord,
           x.loan ->> 'id' as id,
           private.round_money(private.jnum_loose(x.loan -> 'principal')) as principal,
           private.jnum_loose(x.loan -> 'interestRate') as rate,
           private.round_money(private.jnum_loose(x.loan -> 'serviceFee')) as fees,
           private.round_money((select coalesce(sum(private.jnum_loose(e -> 'addedInterest')), 0)
                       from jsonb_array_elements(private.jarr(x.loan -> 'extensions')) as e
                       where jsonb_typeof(e) = 'object')) as ext,
           jsonb_array_length(private.jarr(x.loan -> 'extensions')) as ext_count
    from jsonb_array_elements(private.jarr(p_data -> 'loans')) with ordinality as x(loan, ord)
    where jsonb_typeof(x.loan) = 'object'
  ),
  t as (
    -- (principal * rate) / 100 in doubles, the phone's order of operations.
    select l.*, private.round_money_f(l.principal::float8 * l.rate::float8 / 100) as interest
    from l
  ),
  t2 as (
    select t.*, private.round_money(t.principal + private.round_money(t.interest + t.fees + t.ext)) as total_due
    from t
  ),
  p as (
    select y.pay ->> 'loanId' as loan_id,
           private.jnum_loose(y.pay -> 'amount') as amount,
           coalesce(y.pay ->> 'date', '') as pdate,
           coalesce(y.pay ->> 'createdAt', '') as created_at,
           y.pay ->> 'method' as method,
           y.ord
    from jsonb_array_elements(private.jarr(p_data -> 'payments')) with ordinality as y(pay, ord)
    where jsonb_typeof(y.pay) = 'object'
  ),
  run as (
    select p.*, t2.total_due,
           sum(private.round_money(p.amount)) over (
             partition by p.loan_id
             order by p.pdate collate "C", p.created_at collate "C", p.ord
             rows between unbounded preceding and current row) as running
    from p join t2 on t2.id = p.loan_id
  ),
  agg as (
    select run.loan_id,
           private.round_money(sum(run.amount)) as paid,
           (array_agg(run.pdate order by run.pdate collate "C", run.created_at collate "C", run.ord)
              filter (where run.total_due - run.running <= 0))[1] as paid_date,
           jsonb_agg(jsonb_build_object('date', nullif(run.pdate, ''), 'amount', trim_scale(private.round_money(run.amount)), 'method', run.method)
                     order by run.pdate collate "C", run.created_at collate "C", run.ord) as payments
    from run
    group by run.loan_id
  ),
  res as (
    select t2.*, coalesce(agg.paid, 0) as paid,
           private.round_money(greatest(0, t2.total_due - coalesce(agg.paid, 0))) as outstanding,
           agg.paid_date, coalesce(agg.payments, '[]'::jsonb) as payments,
           private.try_date(t2.loan ->> 'dueDate') as due
    from t2 left join agg on agg.loan_id = t2.id
  )
  select res.id, res.loan ->> 'ref', res.loan ->> 'clientId', res.loan ->> 'applicationId',
         res.loan ->> 'issueDate', res.loan ->> 'dueDate',
         res.principal, res.rate, res.interest, res.fees, res.ext, res.total_due, res.paid, res.outstanding,
         case when res.outstanding <= 0 then 'paid'
              when res.loan ->> 'status' = 'written-off' then 'written-off'
              when res.due < p_today then 'overdue'
              else 'active' end,
         case when res.outstanding <= 0 then nullif(res.paid_date, '') end,
         case when res.outstanding <= 0
              then greatest(0, coalesce(private.try_date(res.paid_date) - res.due, 0))
              else greatest(0, coalesce(p_today - res.due, 0)) end,
         res.ext_count, res.payments, res.ord
  from res;
$$;

-- Could these be two spellings of one person's name? At least two words in
-- common, or every word of a one-word name (letters only, any case), so
-- "Selma N. Nangolo" and "SELMA NANGOLO" agree and a stranger's name doesn't.
create function private.names_match(p_a text, p_b text) returns boolean
language sql immutable set search_path = '' as $$
  with a as (select distinct w from regexp_split_to_table(lower(coalesce(p_a, '')), '[^[:alpha:]]+') as w where length(w) >= 2),
       b as (select distinct w from regexp_split_to_table(lower(coalesce(p_b, '')), '[^[:alpha:]]+') as w where length(w) >= 2)
  select (select count(*) from a) > 0 and (select count(*) from b) > 0
     and (select count(*) from a join b using (w)) >= least(2, (select count(*) from a), (select count(*) from b));
$$;

-- A client as staff may see it: no notes, ever.
create function private.client_public(p_client jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', p_client ->> 'id', 'ref', p_client ->> 'ref', 'name', p_client ->> 'name',
    'phone', p_client ->> 'phone', 'national_id', p_client ->> 'nationalId',
    'employer', p_client ->> 'employer', 'address', p_client ->> 'address',
    'next_of_kin', p_client ->> 'nextOfKin');
$$;

-- CONTRACT §6. Loans and payments of the person whose national ID matches;
-- a client who only shares the phone number is listed as a possible match
-- without their history (it may be someone else).
create function private.history_json(p_app public.applications) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_data    jsonb := coalesce(private.ledger_data(), '{}'::jsonb);
  v_today   date := private.today_na();
  v_matches jsonb := '[]'::jsonb;
  v_balance numeric := 0;
  v_client  jsonb;
  v_loans   jsonb;
  v_sum     jsonb;
begin
  -- Same person: normalised national ID.
  for v_client in
    select c from jsonb_array_elements(private.jarr(v_data -> 'clients')) with ordinality as x(c, ord)
    where jsonb_typeof(c) = 'object' and p_app.national_id_norm <> ''
      and private.norm_id(c ->> 'nationalId') = p_app.national_id_norm
    order by private.ref_number(c ->> 'ref'), ord
  loop
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', l.loan_id, 'ref', l.ref, 'issue_date', l.issue_date, 'due_date', l.due_date,
             'principal', trim_scale(l.principal), 'interest_rate', trim_scale(l.interest_rate),
             'service_fee', trim_scale(l.fees), 'extension_interest', trim_scale(l.extension_interest),
             'total_due', trim_scale(l.total_due), 'paid', trim_scale(l.paid), 'outstanding', trim_scale(l.outstanding),
             'status', l.status, 'paid_date', l.paid_date, 'days_late', l.days_late,
             'extensions', l.extensions, 'payments', l.payments)
             order by l.issue_date collate "C", l.ord), '[]'::jsonb),
           jsonb_build_object(
             'loans', count(*),
             'borrowed', trim_scale(coalesce(sum(l.principal), 0)),
             'repaid', trim_scale(coalesce(sum(l.paid), 0)),
             'late_loans', count(*) filter (where l.days_late > 0),
             'max_days_late', coalesce(max(l.days_late), 0),
             'outstanding', trim_scale(coalesce(sum(l.outstanding) filter (where l.status <> 'written-off'), 0)),
             'written_off', trim_scale(coalesce(sum(l.outstanding) filter (where l.status = 'written-off'), 0)))
      into v_loans, v_sum
    from private.ledger_loans(v_data, v_today) l
    where l.client_id = v_client ->> 'id';

    v_balance := v_balance + (v_sum ->> 'outstanding')::numeric;
    v_matches := v_matches || jsonb_build_array(jsonb_build_object(
      'match', 'id', 'client', private.client_public(v_client), 'summary', v_sum, 'loans', v_loans));
  end loop;

  -- Possible match: same phone number, different (or no) ID.
  for v_client in
    select c from jsonb_array_elements(private.jarr(v_data -> 'clients')) with ordinality as x(c, ord)
    where jsonb_typeof(c) = 'object' and length(p_app.phone_norm) >= 7
      and private.norm_phone(c ->> 'phone') = p_app.phone_norm
      and not (p_app.national_id_norm <> '' and private.norm_id(c ->> 'nationalId') = p_app.national_id_norm)
    order by private.ref_number(c ->> 'ref'), ord
  loop
    v_matches := v_matches || jsonb_build_array(jsonb_build_object(
      'match', 'phone',
      'restricted', true,
      'client', jsonb_build_object('id', v_client ->> 'id', 'ref', v_client ->> 'ref', 'name', v_client ->> 'name',
        'phone', v_client ->> 'phone', 'national_id', null, 'employer', null, 'address', null, 'next_of_kin', null),
      'summary', jsonb_build_object('loans', null, 'borrowed', null, 'repaid', null, 'late_loans', null,
        'max_days_late', null, 'outstanding', null),
      'loans', '[]'::jsonb));
  end loop;

  return jsonb_build_object('matches', v_matches, 'qs_balance', trim_scale(private.r2(v_balance)));
end;
$$;

create function private.qs_balance(p_app public.applications) returns numeric
language sql stable set search_path = '' as $$
  select (private.history_json(p_app) ->> 'qs_balance')::numeric;
$$;

-- B8 = the applicant's current QuickServe balance, always from the ledger.
create function private.ws_with_b8(p_ws jsonb, p_balance numeric) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(p_ws, '{}'::jsonb) || jsonb_build_object('commitments',
    (case when jsonb_typeof(p_ws -> 'commitments') = 'object' then p_ws -> 'commitments' else '{}'::jsonb end)
    || jsonb_build_object('b8', trim_scale(coalesce(p_balance, 0))));
$$;

-- Ledger clients whose normalised national ID equals p_norm.
create function private.ledger_id_matches(p_data jsonb, p_norm text) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(c order by private.ref_number(c ->> 'ref'), ord), '[]'::jsonb)
  from jsonb_array_elements(private.jarr(p_data -> 'clients')) with ordinality as x(c, ord)
  where jsonb_typeof(c) = 'object' and coalesce(p_norm, '') <> ''
    and private.norm_id(c ->> 'nationalId') = p_norm;
$$;

create function private.client_loan_count(p_data jsonb, p_client_id text) returns integer
language sql immutable set search_path = '' as $$
  select count(*)::int
  from jsonb_array_elements(private.jarr(p_data -> 'loans')) as l
  where jsonb_typeof(l) = 'object' and l ->> 'clientId' = p_client_id;
$$;

-- ===========================================================================
-- 7. RPCs — identity, team, policy
-- ===========================================================================

create function public.whoami() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid    uuid := auth.uid();
  v        public.staff;
  v_action text;
begin
  if v_uid is null then
    return null;
  end if;
  select * into v from public.staff where user_id = v_uid;
  -- One "signed in" (or "refused") entry per person per 20 minutes.
  v_action := case when v.user_id is not null and v.active then 'access.signed_in' else 'access.refused' end;
  if not exists (
    select 1 from public.audit_log a
    where a.actor = v_uid and a.action = v_action and a.at > now() - interval '20 minutes'
  ) then
    perform private.audit(v_action, 'access', null, 'staff', v_uid::text,
      jsonb_build_object('email', coalesce(v.email, auth.jwt() ->> 'email')));
  end if;
  if v.user_id is null then
    return null;
  end if;
  return jsonb_build_object('user_id', v.user_id, 'email', v.email, 'full_name', v.full_name,
    'role', v.role, 'active', v.active);
end;
$$;

create function private.staff_json(p_user uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('user_id', s.user_id, 'email', s.email, 'full_name', s.full_name, 'role', s.role,
    'active', s.active, 'created_at', s.created_at, 'last_sign_in_at', u.last_sign_in_at)
  from public.staff s left join auth.users u on u.id = s.user_id
  where s.user_id = p_user;
$$;

create function public.staff_list() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_owner();
  return (
    select coalesce(jsonb_agg(private.staff_json(s.user_id)
             order by s.active desc, (s.role = 'owner') desc, lower(s.full_name)), '[]'::jsonb)
    from public.staff s
  );
end;
$$;

create function public.staff_add(p_email text, p_full_name text, p_role text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me    public.staff := private.require_owner();
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_name  text := btrim(coalesce(p_full_name, ''));
  v_role  text := lower(btrim(coalesce(p_role, '')));
  v_user  uuid;
begin
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    perform private.fail('QS_INVALID', 'Enter the email address of their Supabase login.');
  end if;
  if length(v_name) < 2 or length(v_name) > 120 then
    perform private.fail('QS_INVALID', 'Enter their full name.');
  end if;
  if v_role not in ('owner', 'analyst') then
    perform private.fail('QS_INVALID', 'The role must be owner or analyst.');
  end if;
  select u.id into v_user from auth.users u where lower(u.email) = v_email;
  if v_user is null then
    perform private.fail('QS_NOT_FOUND', format(
      'No Supabase login exists for %s. Create it under Authentication → Users first, then add them here.', v_email));
  end if;
  if exists (select 1 from public.staff s where s.user_id = v_user) then
    perform private.fail('QS_INVALID', format('%s is already on the team. Reactivate them instead.', v_email));
  end if;

  insert into public.staff (user_id, email, full_name, role, active, created_by)
  values (v_user, v_email, v_name, v_role, true, v_me.user_id);

  perform private.audit('staff.added', 'access', null, 'staff', v_user::text,
    jsonb_build_object('email', v_email, 'full_name', v_name, 'role', v_role));
  return private.staff_json(v_user);
end;
$$;

create function public.staff_set_active(p_user_id uuid, p_active boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me     public.staff := private.require_owner();
  v_target public.staff;
begin
  if p_user_id is null or p_active is null then
    perform private.fail('QS_INVALID', 'Say who, and whether to activate or deactivate them.');
  end if;
  if p_user_id = v_me.user_id then
    perform private.fail('QS_INVALID', 'You can''t deactivate or reactivate yourself.');
  end if;
  select * into v_target from public.staff where user_id = p_user_id for update;
  if v_target.user_id is null then
    perform private.fail('QS_NOT_FOUND', 'That person isn''t on the team.');
  end if;
  if not p_active and v_target.role = 'owner' and v_target.active
     and (select count(*) from public.staff where role = 'owner' and active) <= 1 then
    perform private.fail('QS_INVALID', 'You can''t deactivate the last active owner.');
  end if;

  update public.staff set active = p_active, updated_at = now() where user_id = p_user_id;
  perform private.audit(case when p_active then 'staff.reactivated' else 'staff.deactivated' end, 'access',
    null, 'staff', p_user_id::text,
    jsonb_build_object('email', v_target.email, 'full_name', v_target.full_name, 'role', v_target.role,
      'was_active', v_target.active));
  return private.staff_json(p_user_id);
end;
$$;

create function public.policy_get() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_staff();
  return private.policy_json();
end;
$$;

create function public.policy_update(p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me         public.staff := private.require_owner();
  v_old        public.credit_policy;
  v_new        public.credit_policy;
  v_key        text;
  v_changes    jsonb := '{}'::jsonb;
  v_constraint text;
  v_before     jsonb;
  v_after      jsonb;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    perform private.fail('QS_INVALID', 'Nothing to change.');
  end if;
  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key not in ('max_share_disposable_pct', 'default_interest_rate', 'default_service_fee', 'cost_cap_pct',
                     'max_principal', 'max_term_months', 'bureau_required', 'red_flag_threshold',
                     'principal_round_step', 'min_age', 'max_age', 'sla_pickup_hours', 'sla_approval_hours',
                     'idle_minutes') then
      perform private.fail('QS_INVALID', format('Unknown policy setting %s.', left(v_key, 40)));
    end if;
    if jsonb_typeof(p_patch -> v_key) not in ('number', 'boolean') then
      perform private.fail('QS_INVALID', format('Policy setting %s must be a number (or true/false).', v_key));
    end if;
  end loop;

  select * into v_old from public.credit_policy where id = 1 for update;
  begin
    v_new := jsonb_populate_record(v_old, p_patch);
  exception when others then
    perform private.fail('QS_INVALID', 'A policy value is not valid (wrong type or far out of range).');
  end;

  begin
    update public.credit_policy
       set max_share_disposable_pct = v_new.max_share_disposable_pct,
           default_interest_rate = v_new.default_interest_rate,
           default_service_fee = v_new.default_service_fee,
           cost_cap_pct = v_new.cost_cap_pct,
           max_principal = v_new.max_principal,
           max_term_months = v_new.max_term_months,
           bureau_required = v_new.bureau_required,
           red_flag_threshold = v_new.red_flag_threshold,
           principal_round_step = v_new.principal_round_step,
           min_age = v_new.min_age,
           max_age = v_new.max_age,
           sla_pickup_hours = v_new.sla_pickup_hours,
           sla_approval_hours = v_new.sla_approval_hours,
           idle_minutes = v_new.idle_minutes,
           updated_at = now(),
           updated_by = v_me.user_id
     where id = 1
    returning * into v_new;
  exception when check_violation or not_null_violation or numeric_value_out_of_range then
    get stacked diagnostics v_constraint = constraint_name;
    perform private.fail('QS_INVALID', case v_constraint
      when 'credit_policy_d5_check' then 'The share of disposable income must be above 0% and at most 100%.'
      when 'credit_policy_rate_check' then 'The default interest rate can''t be negative.'
      when 'credit_policy_fee_check' then 'The default service fee can''t be negative.'
      when 'credit_policy_cost_cap_check' then 'The charges cap must be above 0% and at most 30% of the principal.'
      when 'credit_policy_max_principal_check' then 'The largest loan must be above N$0 and at most N$100,000.'
      when 'credit_policy_max_term_check' then 'The longest term must be 1 to 5 months.'
      when 'credit_policy_red_flag_check' then 'The warning-sign threshold must be 1 to 7.'
      when 'credit_policy_round_step_check' then 'The rounding step must be above N$0 and at most N$10,000.'
      when 'credit_policy_age_check' then 'The applicant age range must be within 16–100, youngest below oldest.'
      when 'credit_policy_rate_within_cap' then 'The default interest rate can''t be above the charges cap.'
      when 'credit_policy_sla_pickup_check' then 'The pick-up target must be 1 to 720 hours.'
      when 'credit_policy_sla_approval_check' then 'The approval target must be 1 to 720 hours.'
      when 'credit_policy_idle_check' then 'The sign-out time must be 5 to 240 minutes.'
      else 'A policy value is out of range.' end);
  end;

  v_before := to_jsonb(v_old);
  v_after := to_jsonb(v_new);
  for v_key in select jsonb_object_keys(p_patch) loop
    if v_before -> v_key is distinct from v_after -> v_key then
      v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('from', v_before -> v_key, 'to', v_after -> v_key));
    end if;
  end loop;
  perform private.audit('policy.updated', 'access', null, 'credit_policy', '1', jsonb_build_object('changes', v_changes));
  return v_after;
end;
$$;

-- ===========================================================================
-- 8. RPCs — the queue and the application file
-- ===========================================================================

create function public.app_queue(p_tab text, p_search text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_q      text := nullif(btrim(coalesce(p_search, '')), '');
  v_qid    text;
  v_qphone text;
  v_counts jsonb;
  v_rows   jsonb;
  v_data   jsonb;
begin
  perform private.require_staff();
  if p_tab is null or p_tab not in ('open', 'submitted', 'in_review', 'info_requested', 'awaiting_approval', 'approved', 'closed') then
    perform private.fail('QS_INVALID', 'Unknown queue tab.');
  end if;
  if length(v_q) > 100 then
    v_q := left(v_q, 100);
  end if;
  v_qid := private.norm_id(v_q);
  v_qphone := regexp_replace(coalesce(v_q, ''), '[^0-9]', '', 'g');
  v_data := coalesce(private.ledger_data(), '{}'::jsonb);

  select jsonb_build_object(
    'open', count(*) filter (where status in ('submitted', 'in_review', 'info_requested', 'awaiting_approval', 'approved')),
    'submitted', count(*) filter (where status = 'submitted'),
    'in_review', count(*) filter (where status = 'in_review'),
    'info_requested', count(*) filter (where status = 'info_requested'),
    'awaiting_approval', count(*) filter (where status = 'awaiting_approval'),
    'approved', count(*) filter (where status = 'approved'),
    'closed', count(*) filter (where status in ('disbursed', 'declined', 'withdrawn', 'archived')))
  into v_counts
  from public.applications;

  with cl as (
    select c ->> 'id' as client_id, c ->> 'ref' as client_ref, private.norm_id(c ->> 'nationalId') as nid,
           private.ref_number(c ->> 'ref') as refn, ord
    from jsonb_array_elements(private.jarr(v_data -> 'clients')) with ordinality as x(c, ord)
    where jsonb_typeof(c) = 'object' and private.norm_id(c ->> 'nationalId') <> ''
  ),
  ln as materialized (
    select l.client_id, l.application_id, l.days_late from private.ledger_loans(v_data, private.today_na()) l
  ),
  apps as (
    select a.* from public.applications a
    where case p_tab
            when 'open' then a.status in ('submitted', 'in_review', 'info_requested', 'awaiting_approval', 'approved')
            when 'closed' then a.status in ('disbursed', 'declined', 'withdrawn', 'archived')
            else a.status = p_tab end
      and (v_q is null
           or strpos(lower(a.full_name), lower(v_q)) > 0
           or strpos(lower(a.ref), lower(v_q)) > 0
           or (length(v_qid) >= 3 and strpos(a.national_id_norm, v_qid) > 0)
           or (length(v_qphone) >= 4 and strpos(a.phone_norm, right(v_qphone, 9)) > 0))
    order by a.submitted_at desc
    limit 300
  )
  select coalesce(jsonb_agg(r.row order by r.submitted_at desc), '[]'::jsonb) into v_rows
  from (
    select a.submitted_at, jsonb_build_object(
      'id', a.id, 'ref', a.ref, 'status', a.status,
      'submitted_at', a.submitted_at, 'status_changed_at', a.status_changed_at,
      'age_hours', round(extract(epoch from (now() - a.status_changed_at)) / 3600, 1),
      'full_name', a.full_name, 'national_id', a.national_id, 'phone', a.phone, 'employer', a.employer,
      'declared_income', a.declared_income, 'amount_requested', a.amount_requested,
      'assigned_to', a.assigned_to, 'assigned_name', private.staff_name(a.assigned_to),
      'returning', exists (
        select 1 from cl join ln on ln.client_id = cl.client_id
        where cl.nid = a.national_id_norm and ln.application_id is distinct from a.id::text),
      'client_ref', (select cl.client_ref from cl where cl.nid = a.national_id_norm order by cl.refn, cl.ord limit 1),
      'late_loans', (
        select count(*) from cl join ln on ln.client_id = cl.client_id
        where cl.nid = a.national_id_norm and ln.days_late > 0 and ln.application_id is distinct from a.id::text),
      'dup_open', (
        select count(*) from public.applications d
        where d.id <> a.id and a.national_id_norm <> '' and d.national_id_norm = a.national_id_norm
          and d.status in ('submitted', 'in_review', 'info_requested', 'awaiting_approval', 'approved')),
      'recommendation', case when asm.submitted_at is not null then asm.recommendation end,
      'hard_fail', coalesce(cardinality(asm.hard_fail_codes) > 0, false),
      'above_limit', coalesce(cardinality(asm.owner_fail_codes) > 0, false)
    ) as row
    from apps a
    left join lateral (
      select s.* from public.assessments s where s.application_id = a.id order by s.version desc limit 1
    ) asm on true
  ) r;

  return jsonb_build_object('counts', v_counts, 'rows', v_rows);
end;
$$;

create function private.id_dob(p_norm text, p_today date) returns date
language plpgsql immutable set search_path = '' as $$
declare
  v_yy int;
begin
  if p_norm is null or p_norm !~ '^[0-9]{11}$' then
    return null;
  end if;
  v_yy := substr(p_norm, 1, 2)::int;
  return make_date(case when v_yy > extract(year from p_today)::int % 100 then 1900 + v_yy else 2000 + v_yy end,
                   substr(p_norm, 3, 2)::int, substr(p_norm, 5, 2)::int);
exception when others then
  return null;
end;
$$;

create function private.kyc_json(p_app public.applications, p_policy jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_today   date := private.today_na();
  v_data    jsonb := coalesce(private.ledger_data(), '{}'::jsonb);
  v_nam     boolean := p_app.national_id_norm ~ '^[0-9]{11}$';
  v_id_dob  date := private.id_dob(p_app.national_id_norm, v_today);
  v_dob     date := coalesce(v_id_dob, p_app.date_of_birth);
  v_age     int := case when v_dob is not null then date_part('year', age(v_today, v_dob))::int end;
  v_matches jsonb := private.ledger_id_matches(v_data, p_app.national_id_norm);
  v_first   jsonb := v_matches -> 0;
begin
  return jsonb_build_object(
    'id_is_namibian', v_nam,
    'id_valid', v_id_dob is not null,
    'dob', v_dob,
    'age', v_age,
    'age_ok', case when v_age is null then null
                   else v_age between (p_policy ->> 'min_age')::int and (p_policy ->> 'max_age')::int end,
    'dup_open', (
      select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'ref', d.ref, 'status', d.status) order by d.submitted_at desc), '[]'::jsonb)
      from public.applications d
      where d.id <> p_app.id and p_app.national_id_norm <> '' and d.national_id_norm = p_app.national_id_norm
        and d.status in ('submitted', 'in_review', 'info_requested', 'awaiting_approval', 'approved')),
    'ledger_match', case when v_first is null then null else jsonb_build_object(
        'client_id', v_first ->> 'id', 'client_ref', v_first ->> 'ref', 'name', v_first ->> 'name',
        'loans', private.client_loan_count(v_data, v_first ->> 'id'),
        'matches', jsonb_array_length(v_matches)) end,
    'phone_matches', (
      select coalesce(jsonb_agg(jsonb_build_object('client_ref', c ->> 'ref', 'name', c ->> 'name')
                                order by private.ref_number(c ->> 'ref'), ord), '[]'::jsonb)
      from jsonb_array_elements(private.jarr(v_data -> 'clients')) with ordinality as x(c, ord)
      where jsonb_typeof(c) = 'object' and length(p_app.phone_norm) >= 7
        and private.norm_phone(c ->> 'phone') = p_app.phone_norm
        and not (p_app.national_id_norm <> '' and private.norm_id(c ->> 'nationalId') = p_app.national_id_norm))
  );
end;
$$;

create function private.assessment_json(p_asm public.assessments) returns jsonb
language sql stable set search_path = '' as $$
  select case when p_asm.id is null then null else
    to_jsonb(p_asm) || jsonb_build_object(
      'submitted_by_name', private.staff_name(p_asm.submitted_by),
      'updated_by_name', private.staff_name(p_asm.updated_by)) end;
$$;

create function private.decision_json(p_dec public.decisions) returns jsonb
language sql stable set search_path = '' as $$
  select (to_jsonb(p_dec) - 'snapshot') || jsonb_build_object('decided_by_name', private.staff_name(p_dec.decided_by));
$$;

create function private.note_json(p_note public.application_notes) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('id', p_note.id, 'kind', p_note.kind, 'body', p_note.body,
    'author_name', p_note.author_name, 'created_at', p_note.created_at);
$$;

create function public.app_get(p_app_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me     public.staff := private.require_staff();
  v_app    public.applications := private.get_app(p_app_id);
  v_asm    public.assessments := private.current_assessment(p_app_id);
  v_policy jsonb := private.policy_json();
begin
  return jsonb_build_object(
    'application', private.app_json(v_app),
    'documents', (
      select coalesce(jsonb_agg(jsonb_build_object(
          'id', d.id, 'kind', d.kind, 'seq', d.seq, 'mime', d.mime, 'bytes', d.bytes,
          'original_name', d.original_name, 'uploaded_at', d.uploaded_at,
          'viewed_by_me_at', (select max(a.at) from public.audit_log a
                              where a.actor = v_me.user_id and a.action = 'doc.viewed' and a.entity_id = d.id::text))
        order by array_position(array['id', 'payslip', 'bank', 'proof_address', 'other'], d.kind), d.seq), '[]'::jsonb)
      from public.application_documents d where d.application_id = v_app.id),
    'assessment', private.assessment_json(v_asm),
    'decisions', (
      select coalesce(jsonb_agg(private.decision_json(d) order by d.decided_at desc), '[]'::jsonb)
      from public.decisions d where d.application_id = v_app.id),
    'notes', (
      select coalesce(jsonb_agg(private.note_json(n) order by n.created_at desc), '[]'::jsonb)
      from public.application_notes n where n.application_id = v_app.id),
    'kyc', private.kyc_json(v_app, v_policy),
    'policy', v_policy,
    'allowed_actions', private.allowed_actions(v_app, v_me, v_asm),
    'me', jsonb_build_object('user_id', v_me.user_id, 'role', v_me.role)
  );
end;
$$;

create function public.app_update_applicant(p_app_id uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me      public.staff := private.require_staff();
  v_app     public.applications := private.get_app(p_app_id, true);
  v_err     text := private.check_action(v_app, v_me, 'update_applicant', null);
  v_clean   jsonb;
  v_new     public.applications;
  v_before  jsonb;
  v_after   jsonb;
  v_changes jsonb := '{}'::jsonb;
  v_key     text;
begin
  if v_err is not null then
    raise exception using errcode = 'P0001', message = v_err;
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    perform private.fail('QS_INVALID', 'Nothing to change.');
  end if;
  v_clean := private.app_clean(p_patch, 'staff', (private.policy_json() ->> 'max_principal')::numeric);
  v_new := jsonb_populate_record(v_app, v_clean);
  -- The ID number and phone decide whose ledger history the file shows, so
  -- only an owner may change them (an analyst could otherwise look anyone up).
  if v_me.role <> 'owner'
     and (v_new.national_id is distinct from v_app.national_id or v_new.phone is distinct from v_app.phone) then
    perform private.fail('QS_FORBIDDEN', 'Only an owner can change the ID number or phone number. Add a note asking them to correct it.');
  end if;

  update public.applications
     set full_name = v_new.full_name, national_id = v_new.national_id, date_of_birth = v_new.date_of_birth,
         phone = v_new.phone, email = v_new.email, address = v_new.address, town = v_new.town,
         dependants = v_new.dependants, employer = v_new.employer, job_title = v_new.job_title,
         employment_type = v_new.employment_type, pay_day = v_new.pay_day, bank_name = v_new.bank_name,
         bank_account_holder = v_new.bank_account_holder, bank_account_no = v_new.bank_account_no,
         salary_into_account = v_new.salary_into_account, kin_name = v_new.kin_name,
         kin_relationship = v_new.kin_relationship, kin_phone = v_new.kin_phone,
         amount_requested = v_new.amount_requested, repay_date = v_new.repay_date, purpose = v_new.purpose,
         declared_income = v_new.declared_income, declared_deductions = v_new.declared_deductions,
         declared_expenses = v_new.declared_expenses, other_lender_loans = v_new.other_lender_loans,
         other_lender_count = v_new.other_lender_count, updated_at = now()
   where id = v_app.id
  returning * into v_new;

  v_before := to_jsonb(v_app);
  v_after := to_jsonb(v_new);
  for v_key in select jsonb_object_keys(v_clean) loop
    if v_before -> v_key is distinct from v_after -> v_key then
      v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('from', v_before -> v_key, 'to', v_after -> v_key));
    end if;
  end loop;
  perform private.audit('app.updated', 'application', v_app.id, 'application', v_app.id::text,
    jsonb_build_object('ref', v_app.ref, 'changes', v_changes));
  return private.app_json(v_new);
end;
$$;

create function private.add_note(p_app_id uuid, p_kind text, p_body text, p_author public.staff)
returns public.application_notes
language plpgsql set search_path = '' as $$
declare
  v public.application_notes;
begin
  insert into public.application_notes (application_id, kind, body, author, author_name)
  values (p_app_id, p_kind, left(p_body, 4000), p_author.user_id,
          case when p_kind = 'system' then 'System' else p_author.full_name end)
  returning * into v;
  return v;
end;
$$;

create function private.require_text(p_text text, p_min int, p_what text) returns text
language plpgsql set search_path = '' as $$
declare
  v text := btrim(coalesce(p_text, ''));
begin
  if length(v) < p_min then
    perform private.fail('QS_INVALID', format('Write %s (at least %s characters).', p_what, p_min));
  end if;
  if length(v) > 4000 then
    perform private.fail('QS_INVALID', format('%s is too long (4,000 characters at most).', initcap(p_what)));
  end if;
  return v;
end;
$$;

create function public.app_claim(p_app_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me  public.staff := private.require_staff();
  v_app public.applications := private.transition(p_app_id, 'claim');
begin
  perform private.add_note(v_app.id, 'system', 'Picked up by ' || v_me.full_name || '.', v_me);
  return private.app_json(v_app);
end;
$$;

create function public.app_request_info(p_app_id uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me   public.staff := private.require_staff();
  v_note text;
  v_app  public.applications := private.get_app(p_app_id, true);
  v_err  text := private.check_action(v_app, v_me, 'request_info', null);
begin
  if v_err is not null then
    raise exception using errcode = 'P0001', message = v_err;
  end if;
  v_note := private.require_text(p_note, 10, 'what the applicant must send or explain');
  v_app := private.transition(p_app_id, 'request_info', jsonb_build_object('note', left(v_note, 500)));
  perform private.add_note(v_app.id, 'info_request', v_note, v_me);
  return private.app_json(v_app);
end;
$$;

create function public.app_resume(p_app_id uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me   public.staff := private.require_staff();
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_app  public.applications;
begin
  if length(v_note) > 4000 then
    perform private.fail('QS_INVALID', 'The note is too long (4,000 characters at most).');
  end if;
  v_app := private.transition(p_app_id, 'resume', jsonb_build_object('note', left(v_note, 500)));
  if v_note is not null then
    perform private.add_note(v_app.id, 'note', v_note, v_me);
  end if;
  return private.app_json(v_app);
end;
$$;

create function public.app_recall(p_app_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  return private.app_json(private.transition(p_app_id, 'recall'));
end;
$$;

create function public.app_withdraw(p_app_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me     public.staff := private.require_staff();
  v_reason text;
  v_app    public.applications := private.get_app(p_app_id, true);
  v_err    text := private.check_action(v_app, v_me, 'withdraw', null);
begin
  if v_err is not null then
    raise exception using errcode = 'P0001', message = v_err;
  end if;
  v_reason := private.require_text(p_reason, 10, 'why it is being withdrawn');
  v_app := private.transition(p_app_id, 'withdraw', jsonb_build_object('reason', left(v_reason, 500)));
  perform private.add_note(v_app.id, 'system', 'Withdrawn by ' || v_me.full_name || ': ' || v_reason, v_me);
  return private.app_json(v_app);
end;
$$;

create function public.app_reopen(p_app_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me     public.staff := private.require_staff();
  v_reason text;
  v_app    public.applications := private.get_app(p_app_id, true);
  v_err    text := private.check_action(v_app, v_me, 'reopen', null);
begin
  if v_err is not null then
    raise exception using errcode = 'P0001', message = v_err;
  end if;
  v_reason := private.require_text(p_reason, 10, 'why it is being reopened');
  v_app := private.transition(p_app_id, 'reopen', jsonb_build_object('reason', left(v_reason, 500)));
  perform private.add_note(v_app.id, 'system', 'Reopened by ' || v_me.full_name || ': ' || v_reason, v_me);
  return private.app_json(v_app);
end;
$$;

create function public.app_mark_notified(p_app_id uuid, p_via text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me  public.staff := private.require_staff();
  v_app public.applications := private.get_app(p_app_id, true);
begin
  if p_via is null or p_via not in ('whatsapp', 'phone', 'in_person') then
    perform private.fail('QS_INVALID', 'Say how the applicant was told: whatsapp, phone or in_person.');
  end if;
  update public.applications
     set notified_at = now(), notified_via = p_via, notified_by = v_me.user_id, updated_at = now()
   where id = v_app.id
  returning * into v_app;
  perform private.audit('app.notified', 'application', v_app.id, 'application', v_app.id::text,
    jsonb_build_object('ref', v_app.ref, 'via', p_via, 'status', v_app.status));
  return private.app_json(v_app);
end;
$$;

create function public.app_add_note(p_app_id uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me   public.staff := private.require_staff();
  v_app  public.applications := private.get_app(p_app_id);
  v_body text := private.require_text(p_body, 1, 'a note');
  v_note public.application_notes;
begin
  v_note := private.add_note(v_app.id, 'note', v_body, v_me);
  perform private.audit('note.added', 'application', v_app.id, 'note', v_note.id::text,
    jsonb_build_object('ref', v_app.ref, 'text', left(v_body, 200)));
  return private.note_json(v_note);
end;
$$;

-- Plain-English line for one audit entry (app_timeline).
create function private.timeline_text(p_action text, p_detail jsonb, p_actor text) returns text
language sql stable set search_path = '' as $$
  select case p_action
    when 'app.submitted' then 'Application received from the website'
    when 'app.imported' then 'Imported from the old inbox (' || coalesce(p_detail ->> 'legacy_status', '?') || ')'
    when 'app.claimed' then 'Picked up by ' || coalesce(p_actor, 'someone')
    when 'app.info_requested' then 'Asked the applicant for more: ' || coalesce(p_detail ->> 'note', '')
    when 'app.resumed' then 'Back in review' || coalesce(': ' || (p_detail ->> 'note'), '')
    when 'app.updated' then 'Applicant details corrected ('
      || coalesce((select string_agg(replace(k, '_', ' '), ', ') from jsonb_object_keys(coalesce(p_detail -> 'changes', '{}'::jsonb)) as k), '') || ')'
    when 'app.recalled' then 'Recalled from approval'
    when 'app.withdrawn' then 'Withdrawn: ' || coalesce(p_detail ->> 'reason', '')
    when 'app.reopened' then 'Reopened: ' || coalesce(p_detail ->> 'reason', '')
    when 'app.notified' then 'Applicant told by ' || replace(coalesce(p_detail ->> 'via', ''), '_', ' ')
    when 'note.added' then 'Note: ' || coalesce(p_detail ->> 'text', '')
    when 'assessment.saved' then 'Worksheet saved (version ' || coalesce(p_detail ->> 'version', '?') || ')'
    when 'assessment.submitted' then 'Sent for approval — recommends ' || replace(coalesce(p_detail ->> 'recommendation', ''), '_', ' ')
      || ' (version ' || coalesce(p_detail ->> 'version', '?') || ')'
    when 'decision.approved' then 'Approved ' || private.money_text((p_detail ->> 'principal')::numeric)
    when 'decision.declined' then 'Declined'
    when 'decision.returned' then 'Returned to the analyst: ' || coalesce(p_detail ->> 'reasons', '')
    when 'ledger.booked' then 'Paid out and booked as ' || coalesce(p_detail ->> 'loan_ref', '?')
      || ' for client ' || coalesce(p_detail ->> 'client_ref', '?')
    when 'doc.viewed' then 'Viewed ' || case p_detail ->> 'kind'
        when 'id' then 'the ID document' when 'payslip' then 'the payslip'
        when 'bank' then 'bank statement ' || coalesce(p_detail ->> 'seq', '')
        when 'proof_address' then 'the proof of address' else 'a document' end
    when 'history.viewed' then 'Viewed the borrower history'
      || case when p_detail ->> 'name_differs' = 'true'
              then ' (the ledger has a different name for this ID number)' else '' end
    else p_action
  end;
$$;

create function public.app_timeline(p_app_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_app public.applications;
begin
  perform private.require_staff();
  v_app := private.get_app(p_app_id);
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'at', e.at, 'actor_name', e.actor_name, 'action', e.action,
             'text', private.timeline_text(e.action, e.detail, e.actor_name))
             order by e.at desc, e.id desc), '[]'::jsonb)
    from (
      select a.id, a.at, a.action, a.detail,
             case when a.actor_role = 'intake' then 'Website'
                  else coalesce(private.staff_name(a.actor), 'System') end as actor_name
      from public.audit_log a
      where a.application_id = v_app.id
      order by a.at desc, a.id desc
      limit 500
    ) e
  );
end;
$$;

create function public.borrower_history(p_app_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me   public.staff := private.require_staff();
  v_app  public.applications := private.get_app(p_app_id);
  v_hist jsonb := private.history_json(v_app);
begin
  -- Audited, at most once per person, application and (Windhoek) day.
  -- The website needs no login, so anyone can hand in an application with
  -- someone else's ID number and then look at that person's loans here. The
  -- entry says when the ledger's name for that ID is a different name, so the
  -- owner sees it in the audit trail and on the file's timeline.
  if not exists (
    select 1 from public.audit_log a
    where a.actor = v_me.user_id and a.action = 'history.viewed' and a.application_id = v_app.id
      and (a.at at time zone 'Africa/Windhoek')::date = private.today_na()
  ) then
    perform private.audit('history.viewed', 'document', v_app.id, 'application', v_app.id::text,
      jsonb_build_object('ref', v_app.ref,
        'client_refs', (select coalesce(jsonb_agg(m -> 'client' ->> 'ref'), '[]'::jsonb)
                        from jsonb_array_elements(v_hist -> 'matches') as m where m ->> 'match' = 'id'),
        'name_differs', exists (select 1 from jsonb_array_elements(v_hist -> 'matches') as m
                                where m ->> 'match' = 'id'
                                  and not private.names_match(m -> 'client' ->> 'name', v_app.full_name))));
  end if;
  return v_hist;
end;
$$;

create function public.doc_access(p_doc_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me  public.staff := private.require_staff();
  v_doc public.application_documents;
  v_ref text;
begin
  select * into v_doc from public.application_documents where id = p_doc_id;
  if v_doc.id is null then
    perform private.fail('QS_NOT_FOUND', 'That document doesn''t exist.');
  end if;
  select a.ref into v_ref from public.applications a where a.id = v_doc.application_id;
  perform private.audit('doc.viewed', 'document', v_doc.application_id, 'document', v_doc.id::text,
    jsonb_build_object('ref', v_ref, 'kind', v_doc.kind, 'seq', v_doc.seq));
  return jsonb_build_object('r2_key', v_doc.r2_key, 'mime', v_doc.mime, 'original_name', v_doc.original_name,
    'kind', v_doc.kind);
end;
$$;

-- ===========================================================================
-- 9. RPCs — worksheet, recommendation, decision
-- ===========================================================================

create function public.assessment_save(p_app_id uuid, p_worksheet jsonb, p_terms jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me       public.staff := private.require_staff();
  v_app      public.applications := private.get_app(p_app_id, true);
  v_asm      public.assessments := private.current_assessment(p_app_id);
  v_err      text := private.check_action(v_app, v_me, 'save_assessment', v_asm);
  v_terms    jsonb;
  v_ws       jsonb;
  v_computed jsonb;
begin
  if v_err is not null then
    raise exception using errcode = 'P0001', message = v_err;
  end if;
  perform private.check_worksheet(p_worksheet);
  v_terms := private.clean_terms(p_terms);
  v_ws := private.ws_with_b8(p_worksheet, private.qs_balance(v_app));
  v_computed := private.assessment_compute(v_ws, v_terms, private.app_bits(v_app), private.policy_json());

  if v_asm.id is null or v_asm.submitted_at is not null then
    -- First save, or the first save after a recall/return: a new version.
    insert into public.assessments (application_id, version, worksheet, terms, computed, created_by, updated_by)
    values (v_app.id, coalesce(v_asm.version, 0) + 1, v_ws, v_terms, v_computed, v_me.user_id, v_me.user_id)
    returning * into v_asm;
  else
    update public.assessments
       set worksheet = v_ws, terms = v_terms, computed = v_computed, updated_at = now(), updated_by = v_me.user_id
     where id = v_asm.id
    returning * into v_asm;
  end if;

  update public.assessments
     set disposable_income = (v_computed ->> 'd4')::numeric,
         max_repayment = (v_computed ->> 'd6')::numeric,
         total_repayable = (v_computed ->> 'e7')::numeric,
         affordable = (v_computed ->> 'f3')::boolean,
         max_principal_passing = (v_computed ->> 'f5')::numeric,
         hard_fail_codes = array(select jsonb_array_elements_text(v_computed -> 'hard_fail_codes')),
         owner_fail_codes = array(select jsonb_array_elements_text(v_computed -> 'owner_fail_codes')),
         soft_fail_codes = array(select jsonb_array_elements_text(v_computed -> 'soft_fail_codes'))
   where id = v_asm.id
  returning * into v_asm;

  -- Autosave-friendly: one audit entry per person and version per 10 minutes.
  if not exists (
    select 1 from public.audit_log a
    where a.actor = v_me.user_id and a.action = 'assessment.saved' and a.application_id = v_app.id
      and a.detail ->> 'version' = v_asm.version::text and a.at > now() - interval '10 minutes'
  ) then
    perform private.audit('assessment.saved', 'application', v_app.id, 'assessment', v_asm.id::text,
      jsonb_build_object('ref', v_app.ref, 'version', v_asm.version, 'd4', v_computed -> 'd4', 'd6', v_computed -> 'd6',
        'e7', v_computed -> 'e7', 'f3', v_computed -> 'f3', 'hard_fail_codes', v_computed -> 'hard_fail_codes'));
  end if;

  return jsonb_build_object('version', v_asm.version, 'computed', v_computed, 'updated_at', v_asm.updated_at);
end;
$$;

create function public.assessment_submit(
  p_app_id         uuid,
  p_recommendation text,
  p_reasons        text,
  p_motivation     text default null,
  p_declaration    jsonb default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me         public.staff := private.require_staff();
  v_app        public.applications := private.get_app(p_app_id, true);
  v_asm        public.assessments := private.current_assessment(p_app_id);
  v_err        text := private.check_action(v_app, v_me, 'submit_assessment', v_asm);
  v_reasons    text := btrim(coalesce(p_reasons, ''));
  v_motivation text := nullif(btrim(coalesce(p_motivation, '')), '');
  v_ws         jsonb;
  v_computed   jsonb;
  v_hard       int;
  v_owner      int;
  v_principal  numeric;
begin
  if v_err is not null then
    raise exception using errcode = 'P0001', message = v_err;
  end if;
  if v_asm.id is null then
    perform private.fail('QS_INVALID', 'Save the worksheet before sending it for approval.');
  end if;
  if p_recommendation is null or p_recommendation not in ('approve', 'approve_above_limit', 'approve_reduced', 'decline', 'refer') then
    perform private.fail('QS_INVALID', 'Choose a recommendation.');
  end if;
  if length(v_reasons) < 60 then
    perform private.fail('QS_INVALID', 'Write your reasons (at least 60 characters).');
  end if;
  if length(v_reasons) > 4000 or length(coalesce(v_motivation, '')) > 4000 then
    perform private.fail('QS_INVALID', 'The reasons are too long (4,000 characters at most).');
  end if;
  if p_declaration is null or jsonb_typeof(p_declaration) <> 'object'
     or exists (select 1 from generate_series(1, 7) as i
                where coalesce(p_declaration -> ('d12_' || i) <> 'true'::jsonb, true)) then
    perform private.fail('QS_INVALID', 'Tick every line of the declaration (12.1 to 12.7).');
  end if;

  -- Re-check on the latest ledger balance and policy.
  v_ws := private.ws_with_b8(v_asm.worksheet, private.qs_balance(v_app));
  v_computed := private.assessment_compute(v_ws, v_asm.terms, private.app_bits(v_app), private.policy_json());
  v_hard := jsonb_array_length(v_computed -> 'hard_fail_codes');
  v_owner := jsonb_array_length(v_computed -> 'owner_fail_codes');
  v_principal := private.jnum(v_asm.terms -> 'principal');

  if p_recommendation in ('approve', 'approve_reduced', 'approve_above_limit') and v_hard > 0 then
    perform private.fail('QS_HARD_FAIL', 'A rule that can''t be overridden fails ('
      || (select string_agg(x, ', ') from jsonb_array_elements_text(v_computed -> 'hard_fail_codes') as x)
      || '). Recommend a decline.');
  end if;
  if p_recommendation in ('approve', 'approve_reduced') and v_owner > 0 then
    perform private.fail('QS_OVERRIDE_REQUIRED', 'The repayment is above the affordability limit. Recommend a reduced amount that passes, or motivate for approval above the limit.');
  end if;
  if p_recommendation in ('approve', 'approve_reduced', 'approve_above_limit') then
    perform private.check_bookable_terms(v_asm.terms);
  end if;
  if p_recommendation = 'approve_reduced'
     and (v_app.amount_requested is null or v_principal >= v_app.amount_requested) then
    perform private.fail('QS_INVALID', 'A reduced amount must be less than the amount requested.');
  end if;
  if p_recommendation = 'approve_above_limit' then
    if v_owner = 0 then
      perform private.fail('QS_INVALID', 'Nothing is above the limit — recommend approval as applied instead.');
    end if;
    if length(coalesce(v_motivation, '')) < 60 then
      perform private.fail('QS_INVALID', 'Write your motivation for going above the limit (at least 60 characters).');
    end if;
  end if;

  if v_asm.submitted_at is not null then
    -- Sent again after a recall/return without a new save: still a new version.
    insert into public.assessments (application_id, version, worksheet, terms, computed, created_by, updated_by)
    values (v_app.id, v_asm.version + 1, v_asm.worksheet, v_asm.terms, v_asm.computed, v_me.user_id, v_me.user_id)
    returning * into v_asm;
  end if;

  update public.assessments
     set worksheet = v_ws, computed = v_computed,
         disposable_income = (v_computed ->> 'd4')::numeric,
         max_repayment = (v_computed ->> 'd6')::numeric,
         total_repayable = (v_computed ->> 'e7')::numeric,
         affordable = (v_computed ->> 'f3')::boolean,
         max_principal_passing = (v_computed ->> 'f5')::numeric,
         hard_fail_codes = array(select jsonb_array_elements_text(v_computed -> 'hard_fail_codes')),
         owner_fail_codes = array(select jsonb_array_elements_text(v_computed -> 'owner_fail_codes')),
         soft_fail_codes = array(select jsonb_array_elements_text(v_computed -> 'soft_fail_codes')),
         recommendation = p_recommendation, reasons = v_reasons, motivation = v_motivation,
         declaration = p_declaration, submitted_at = now(), submitted_by = v_me.user_id,
         updated_at = now(), updated_by = v_me.user_id
   where id = v_asm.id
  returning * into v_asm;

  perform private.transition(v_app.id, 'submit_assessment', jsonb_build_object(
    'version', v_asm.version, 'recommendation', p_recommendation, 'principal', v_asm.terms -> 'principal',
    'hard_fail_codes', v_computed -> 'hard_fail_codes', 'owner_fail_codes', v_computed -> 'owner_fail_codes',
    'soft_fail_codes', v_computed -> 'soft_fail_codes'));

  return jsonb_build_object('version', v_asm.version, 'computed', v_computed);
end;
$$;

create function public.app_decide(
  p_app_id              uuid,
  p_assessment_version  integer,
  p_outcome             text,
  p_terms               jsonb default null,
  p_reasons             text default null,
  p_reason_to_applicant text default null,
  p_override_note       text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me        public.staff := private.require_owner();
  v_app       public.applications := private.get_app(p_app_id, true);
  v_asm       public.assessments := private.current_assessment(p_app_id);
  v_reasons   text := nullif(btrim(coalesce(p_reasons, '')), '');
  v_override  text := nullif(btrim(coalesce(p_override_note, '')), '');
  v_err       text;
  v_terms     jsonb;
  v_ws        jsonb;
  v_computed  jsonb;
  v_owner     jsonb;
  v_soft      jsonb;
  v_codes     text[] := '{}';
  v_self      boolean;
  v_dec       public.decisions;
  v_action    text;
begin
  if p_outcome is null or p_outcome not in ('approved', 'declined', 'returned') then
    perform private.fail('QS_INVALID', 'The outcome must be approved, declined or returned.');
  end if;
  v_action := case p_outcome when 'approved' then 'approve' when 'declined' then 'decline' else 'return' end;
  v_err := private.check_action(v_app, v_me, v_action, v_asm);
  if v_err is not null then
    raise exception using errcode = 'P0001', message = v_err;
  end if;
  -- Optimistic lock: decide exactly what was on screen.
  if coalesce(p_assessment_version, 0) <> coalesce(v_asm.version, 0) then
    perform private.fail('QS_STALE', format(
      'The worksheet changed since you opened it (it is now version %s). Reload the file and check it again.',
      coalesce(v_asm.version, 0)));
  end if;
  if length(coalesce(v_reasons, '')) > 4000 or length(coalesce(v_override, '')) > 4000 then
    perform private.fail('QS_INVALID', 'The note is too long (4,000 characters at most).');
  end if;
  v_self := v_asm.submitted_by is not null and v_asm.submitted_by = v_me.user_id;

  if p_outcome = 'approved' then
    if v_asm.submitted_at is null then
      perform private.fail('QS_BAD_STATE', 'There is no submitted worksheet to approve.');
    end if;
    -- Final terms: the assessed ones, with any of the five keys the owner changed.
    v_terms := private.clean_terms(coalesce(v_asm.terms, '{}'::jsonb) || private.clean_terms(p_terms, true));
    perform private.check_bookable_terms(v_terms);
    v_ws := private.ws_with_b8(v_asm.worksheet, private.qs_balance(v_app));
    v_computed := private.assessment_compute(v_ws, v_terms, private.app_bits(v_app), private.policy_json());
    v_owner := v_computed -> 'owner_fail_codes';
    v_soft := v_computed -> 'soft_fail_codes';

    if jsonb_array_length(v_computed -> 'hard_fail_codes') > 0 then
      perform private.fail('QS_HARD_FAIL', 'A rule that can''t be overridden fails ('
        || (select string_agg(x, ', ') from jsonb_array_elements_text(v_computed -> 'hard_fail_codes') as x)
        || '). This can''t be approved.');
    end if;
    if jsonb_array_length(v_owner) > 0 then
      if coalesce(v_asm.recommendation, '') <> 'approve_above_limit' or length(coalesce(v_asm.motivation, '')) < 60 then
        perform private.fail('QS_OVERRIDE_REQUIRED', 'The repayment is above the affordability limit, and the assessor did not motivate for it. Approve an amount that passes, or return it to the analyst.');
      end if;
      if length(coalesce(v_override, '')) < 20 then
        perform private.fail('QS_OVERRIDE_REQUIRED', 'Write an override note (at least 20 characters) to approve above the limit.');
      end if;
    end if;
    if jsonb_array_length(v_soft) > 0 and length(coalesce(v_override, '')) < 20 then
      perform private.fail('QS_OVERRIDE_REQUIRED', 'Some checks fail ('
        || (select string_agg(x, ', ') from jsonb_array_elements_text(v_soft) as x)
        || '). Write an override note (at least 20 characters) to approve anyway.');
    end if;
    v_codes := array(select jsonb_array_elements_text(v_owner)) || array(select jsonb_array_elements_text(v_soft));
  elsif p_outcome = 'declined' then
    if p_reason_to_applicant is null or p_reason_to_applicant not in ('afford', 'docs', 'history', 'other') then
      perform private.fail('QS_INVALID', 'Choose the reason the applicant will be given.');
    end if;
    if length(coalesce(v_reasons, '')) < 20 then
      perform private.fail('QS_INVALID', 'Write your reasons for declining (at least 20 characters).');
    end if;
    v_terms := v_asm.terms;
    v_computed := v_asm.computed;
  else
    if length(coalesce(v_reasons, '')) < 10 then
      perform private.fail('QS_INVALID', 'Tell the analyst what to look at again (at least 10 characters).');
    end if;
    v_terms := v_asm.terms;
    v_computed := v_asm.computed;
  end if;

  insert into public.decisions (application_id, assessment_id, assessment_version, outcome, terms, computed, reasons,
                                reason_to_applicant, override_note, overridden_codes, self_assessed, decided_by, snapshot)
  values (v_app.id, v_asm.id, v_asm.version, p_outcome, v_terms, v_computed, v_reasons,
          case when p_outcome = 'declined' then p_reason_to_applicant end,
          case when p_outcome = 'approved' then v_override end,
          v_codes, v_self, v_me.user_id,
          jsonb_build_object('application', private.app_json(v_app),
            'assessment', case when v_asm.id is null then null else jsonb_build_object(
              'version', v_asm.version, 'recommendation', v_asm.recommendation, 'reasons', v_asm.reasons,
              'motivation', v_asm.motivation, 'terms', v_asm.terms, 'computed', v_asm.computed,
              'submitted_by', v_asm.submitted_by, 'submitted_at', v_asm.submitted_at) end))
  returning * into v_dec;

  perform private.transition(v_app.id, v_action, jsonb_build_object(
    'decision_id', v_dec.id, 'version', v_asm.version, 'principal', v_terms -> 'principal',
    'terms', v_terms, 'overridden_codes', to_jsonb(v_codes), 'self_assessed', v_self,
    'reason_to_applicant', v_dec.reason_to_applicant,
    'reasons', case when p_outcome = 'returned' then left(v_reasons, 500) end));

  if p_outcome = 'returned' then
    perform private.add_note(v_app.id, 'note', 'Returned for another look: ' || v_reasons, v_me);
  end if;
  return private.decision_json(v_dec);
end;
$$;

-- ===========================================================================
-- 10. RPCs — paying out and booking into the ledger (CONTRACT §7)
-- ===========================================================================

-- The terms of the latest approval, with the payout dates filled in.
create function private.approved_terms(p_app_id uuid, p_issue date, p_due date) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(d.terms, '{}'::jsonb) || jsonb_build_object(
    'issue_date', to_char(p_issue, 'YYYY-MM-DD'), 'due_date', to_char(p_due, 'YYYY-MM-DD'))
  from public.decisions d
  where d.application_id = p_app_id and d.outcome = 'approved'
  order by d.decided_at desc
  limit 1;
$$;

create function private.disburse_checks(p_app public.applications, p_terms jsonb, p_issue date) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_asm      public.assessments := private.current_assessment(p_app.id);
  v_computed jsonb := private.assessment_compute(coalesce(v_asm.worksheet, '{}'::jsonb), p_terms,
                        private.app_bits(p_app), private.policy_json());
  v_rule     jsonb;
  v_out      jsonb := '{}'::jsonb;
begin
  for v_rule in select r from jsonb_array_elements(v_computed -> 'rules') as r loop
    if v_rule ->> 'code' in ('G1', 'G2', 'G3') then
      v_out := v_out || jsonb_build_object(v_rule ->> 'code', v_rule ->> 'result' = 'pass');
    end if;
  end loop;
  return v_out || jsonb_build_object('issue_not_future', p_issue is not null and p_issue <= private.today_na(),
    'total_repayable', v_computed -> 'e7');
end;
$$;

create function public.app_disburse_preview(p_app_id uuid, p_issue_date date, p_due_date date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me      public.staff := private.require_owner();
  v_app     public.applications := private.get_app(p_app_id);
  v_err     text := private.check_action(v_app, v_me, 'disburse', null);
  v_data    jsonb := coalesce(private.ledger_data(), '{}'::jsonb);
  v_matches jsonb;
  v_terms   jsonb;
  v_checks  jsonb;
begin
  if v_err is not null then
    raise exception using errcode = 'P0001', message = v_err;
  end if;
  v_matches := private.ledger_id_matches(v_data, v_app.national_id_norm);
  v_terms := private.approved_terms(v_app.id, p_issue_date, p_due_date);
  v_checks := private.disburse_checks(v_app, v_terms, p_issue_date);
  return jsonb_build_object(
    'client_match', jsonb_build_object(
      'mode', case jsonb_array_length(v_matches) when 0 then 'new' when 1 then 'existing' else 'ambiguous' end,
      'candidates', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', c ->> 'id', 'ref', c ->> 'ref', 'name', c ->> 'name', 'national_id', c ->> 'nationalId',
          'loans', private.client_loan_count(v_data, c ->> 'id')) order by n), '[]'::jsonb)
        from jsonb_array_elements(v_matches) with ordinality as x(c, n))),
    'next_client_ref', private.next_ref(v_data -> 'clients', 'QS-'),
    'next_loan_ref', private.next_ref(v_data -> 'loans', 'QSL-'),
    'terms', jsonb_build_object(
      'principal', v_terms -> 'principal', 'interest_rate', v_terms -> 'interest_rate',
      'service_fee', v_terms -> 'service_fee', 'total_repayable', v_checks -> 'total_repayable'),
    'checks', jsonb_build_object('G1', v_checks -> 'G1', 'G2', v_checks -> 'G2', 'G3', v_checks -> 'G3',
      'issue_not_future', v_checks -> 'issue_not_future')
  );
end;
$$;

-- client_/loan_ + base36(epoch ms) + _ + 6 × [a-z0-9], never an id already in p_items.
create function private.new_ledger_id(p_prefix text, p_items jsonb, p_ms bigint) returns text
language plpgsql volatile set search_path = '' as $$
declare
  v_id text;
begin
  loop
    v_id := p_prefix || '_' || private.base36(p_ms) || '_' || private.rand_chars('0123456789abcdefghijklmnopqrstuvwxyz', 6);
    exit when not exists (
      select 1 from jsonb_array_elements(private.jarr(p_items)) as e where e ->> 'id' = v_id);
  end loop;
  return v_id;
end;
$$;

create function public.app_disburse(
  p_app_id     uuid,
  p_checklist  jsonb,
  p_issue_date date,
  p_due_date   date,
  p_method     text,
  p_reference  text,
  p_client_id  text default null,
  p_new_client boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me        public.staff := private.require_owner();
  v_app       public.applications := private.get_app(p_app_id, true);
  v_err       text := private.check_action(v_app, v_me, 'disburse', null);
  v_reference text := nullif(btrim(coalesce(p_reference, '')), '');
  v_ledger    public.ledger;
  v_data      jsonb;
  v_clients   jsonb;
  v_loans     jsonb;
  v_terms     jsonb;
  v_checks    jsonb;
  v_matches   jsonb;
  v_client    jsonb;
  v_idx       int;
  v_new       boolean;
  v_now       timestamptz := clock_timestamp();
  v_ms        bigint := floor(extract(epoch from v_now) * 1000)::bigint;
  v_created   text := to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_today     date := private.today_na();
  v_loan      jsonb;
  v_address   text;
  v_kin       text;
  v_rev       bigint;
begin
  if v_err is not null then
    raise exception using errcode = 'P0001', message = v_err;
  end if;

  -- The pre-payout checklist 13.1 … 13.10, every item ticked.
  if p_checklist is null or jsonb_typeof(p_checklist) <> 'object'
     or exists (select 1 from generate_series(1, 10) as i
                where coalesce(p_checklist -> ('13.' || i) <> 'true'::jsonb, true)) then
    perform private.fail('QS_INVALID', 'Tick all 10 checklist items (13.1 to 13.10) before paying out.');
  end if;
  if p_method is null or p_method not in ('Cash', 'Bank transfer', 'E-wallet', 'Other') then
    perform private.fail('QS_INVALID', 'Choose how the money was paid out.');
  end if;
  if p_method <> 'Cash' and length(coalesce(v_reference, '')) < 3 then
    perform private.fail('QS_INVALID', 'Add the payment reference (at least 3 characters).');
  end if;
  if length(coalesce(v_reference, '')) > 100 then
    perform private.fail('QS_INVALID', 'The payment reference is too long (100 characters at most).');
  end if;
  if p_issue_date is null or p_due_date is null then
    perform private.fail('QS_INVALID', 'Enter the issue date and the due date.');
  end if;
  if p_issue_date > v_today then
    perform private.fail('QS_INVALID', 'The issue date can''t be in the future.');
  end if;

  v_terms := private.approved_terms(v_app.id, p_issue_date, p_due_date);
  if v_terms is null then
    perform private.fail('QS_BAD_STATE', 'There is no approval to pay out.');
  end if;
  perform private.check_bookable_terms(v_terms);
  v_checks := private.disburse_checks(v_app, v_terms, p_issue_date);
  if not (coalesce((v_checks ->> 'G1')::boolean, false) and coalesce((v_checks ->> 'G2')::boolean, false)
          and coalesce((v_checks ->> 'G3')::boolean, false)) then
    perform private.fail('QS_HARD_FAIL', 'The loan breaks a legal limit: '
      || concat_ws(', ',
           case when not coalesce((v_checks ->> 'G1')::boolean, false) then 'charges above the cap (G1)' end,
           case when not coalesce((v_checks ->> 'G2')::boolean, false) then 'principal above the maximum (G2)' end,
           case when not coalesce((v_checks ->> 'G3')::boolean, false) then 'due date not after the issue date or beyond the longest term (G3)' end)
      || '.');
  end if;

  -- The ledger row, locked until this transaction ends: a phone saving at the
  -- same moment waits, then finds the version moved on. Note the phone's
  -- "Sync now" then takes the cloud copy whole (cloud.js adoptRemote), so
  -- anything unsynced on it drops out: the owner syncs the phone before
  -- booking (RUNBOOK, "Paying out while the phone app is in use").
  select * into v_ledger from public.ledger where id = 'main' for update;
  if v_ledger.id is null then
    perform private.fail('QS_LEDGER_MISSING', 'The cloud ledger doesn''t exist yet. Open the phone app and sync once, then try again.');
  end if;
  v_data := case when jsonb_typeof(v_ledger.data) = 'object' then v_ledger.data else '{}'::jsonb end;
  v_clients := private.jarr(v_data -> 'clients');
  v_loans := private.jarr(v_data -> 'loans');

  -- Find or create the client, by normalised national ID.
  v_matches := private.ledger_id_matches(v_data, v_app.national_id_norm);
  v_new := coalesce(p_new_client, false);
  if not v_new then
    if nullif(btrim(coalesce(p_client_id, '')), '') is not null then
      select c into v_client from jsonb_array_elements(v_clients) as c where c ->> 'id' = btrim(p_client_id) limit 1;
      if v_client is null then
        perform private.fail('QS_NOT_FOUND', 'That client isn''t in the ledger.');
      end if;
      if private.norm_id(v_client ->> 'nationalId') <> '' and private.norm_id(v_client ->> 'nationalId') <> v_app.national_id_norm then
        perform private.fail('QS_INVALID', 'That client has a different ID number from the applicant.');
      end if;
    elsif jsonb_array_length(v_matches) = 1 then
      v_client := v_matches -> 0;
    elsif jsonb_array_length(v_matches) > 1 then
      perform private.fail('QS_AMBIGUOUS_CLIENT', 'More than one client in the ledger has this ID number. Choose which one this loan belongs to.');
    else
      v_new := true;
    end if;
  end if;

  -- Address with the town appended (the form asks for them separately);
  -- next of kin as "Name (phone)", like the phone app's free-text field.
  v_address := nullif(btrim(coalesce(v_app.address, '')), '');
  if nullif(btrim(coalesce(v_app.town, '')), '') is not null
     and strpos(lower(coalesce(v_address, '')), lower(btrim(v_app.town))) = 0 then
    v_address := concat_ws(', ', v_address, btrim(v_app.town));
  end if;
  v_kin := case when nullif(btrim(coalesce(v_app.kin_name, '')), '') is null then ''
                when nullif(btrim(coalesce(v_app.kin_phone, '')), '') is null then btrim(v_app.kin_name)
                else btrim(v_app.kin_name) || ' (' || btrim(v_app.kin_phone) || ')' end;

  if v_new then
    v_client := jsonb_build_object(
      'id', private.new_ledger_id('client', v_clients, v_ms),
      'ref', private.next_ref(v_clients, 'QS-'),
      'createdAt', v_created,
      'name', v_app.full_name,
      'phone', v_app.phone,
      'nationalId', v_app.national_id,
      'employer', coalesce(v_app.employer, ''),
      'address', coalesce(v_address, ''),
      'nextOfKin', v_kin,
      'notes', 'From application ' || v_app.ref || ' (' || to_char(v_today, 'YYYY-MM-DD') || ')');
    v_clients := v_clients || jsonb_build_array(v_client);
  else
    -- Existing client: only fill in details that are empty in the ledger.
    select ord - 1 into v_idx from jsonb_array_elements(v_clients) with ordinality as x(c, ord)
    where c ->> 'id' = v_client ->> 'id' limit 1;
    if nullif(btrim(coalesce(v_client ->> 'phone', '')), '') is null and v_app.phone <> '' then
      v_client := v_client || jsonb_build_object('phone', v_app.phone);
    end if;
    if nullif(btrim(coalesce(v_client ->> 'employer', '')), '') is null and nullif(btrim(coalesce(v_app.employer, '')), '') is not null then
      v_client := v_client || jsonb_build_object('employer', v_app.employer);
    end if;
    if nullif(btrim(coalesce(v_client ->> 'address', '')), '') is null and v_address is not null then
      v_client := v_client || jsonb_build_object('address', v_address);
    end if;
    if nullif(btrim(coalesce(v_client ->> 'nextOfKin', '')), '') is null and v_kin <> '' then
      v_client := v_client || jsonb_build_object('nextOfKin', v_kin);
    end if;
    v_clients := jsonb_set(v_clients, array[v_idx::text], v_client);
  end if;

  v_loan := jsonb_build_object(
    'id', private.new_ledger_id('loan', v_loans, v_ms),
    'ref', private.next_ref(v_loans, 'QSL-'),
    'createdAt', v_created,
    'status', 'active',
    'clientId', v_client ->> 'id',
    'principal', trim_scale(private.jnum(v_terms -> 'principal')),
    'interestRate', trim_scale(private.jnum(v_terms -> 'interest_rate')),
    'serviceFee', trim_scale(private.jnum(v_terms -> 'service_fee')),
    'issueDate', to_char(p_issue_date, 'YYYY-MM-DD'),
    'dueDate', to_char(p_due_date, 'YYYY-MM-DD'),
    'purpose', coalesce(v_app.purpose, ''),
    'applicationId', v_app.id::text,
    'applicationRef', v_app.ref,
    'payoutMethod', p_method,
    'payoutReference', coalesce(v_reference, ''));
  v_loans := v_loans || jsonb_build_array(v_loan);

  -- Unknown top-level keys (settings, payments, …) are carried over untouched.
  update public.ledger
     set data = v_data || jsonb_build_object('clients', v_clients, 'loans', v_loans, 'updatedAt', v_created),
         rev = rev + 1,
         updated_at = now(),
         updated_by = v_me.email
   where id = 'main'
  returning rev into v_rev;

  update public.applications
     set client_id = v_client ->> 'id', client_ref = v_client ->> 'ref',
         loan_id = v_loan ->> 'id', loan_ref = v_loan ->> 'ref',
         payout_method = p_method, payout_reference = v_reference, checklist = p_checklist,
         disbursed_at = now(), disbursed_by = v_me.user_id
   where id = v_app.id;

  perform private.transition(v_app.id, 'disburse', jsonb_build_object(
    'loan_id', v_loan ->> 'id', 'loan_ref', v_loan ->> 'ref',
    'client_id', v_client ->> 'id', 'client_ref', v_client ->> 'ref', 'new_client', v_new,
    'principal', v_loan -> 'principal', 'interest_rate', v_loan -> 'interestRate', 'service_fee', v_loan -> 'serviceFee',
    'issue_date', v_loan -> 'issueDate', 'due_date', v_loan -> 'dueDate',
    'method', p_method, 'reference', v_reference, 'checklist_ticked', 10,
    'rev_from', v_ledger.rev, 'rev_to', v_rev));

  return jsonb_build_object('loan_id', v_loan ->> 'id', 'loan_ref', v_loan ->> 'ref',
    'client_id', v_client ->> 'id', 'client_ref', v_client ->> 'ref', 'ledger_rev', v_rev);
end;
$$;

-- ===========================================================================
-- 11. RPCs — audit trail (owner)
-- ===========================================================================

create function public.audit_list(p_category text default null, p_before timestamptz default null, p_limit integer default 200)
returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_owner();
  if p_category is not null and p_category not in ('application', 'decision', 'ledger', 'document', 'access') then
    perform private.fail('QS_INVALID', 'Unknown audit category.');
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', e.id, 'at', e.at, 'actor_name', e.actor_name, 'actor_email', e.actor_email,
             'actor_role', e.actor_role, 'action', e.action, 'category', e.category,
             'application_ref', e.application_ref, 'detail', e.detail)
             order by e.at desc, e.id desc), '[]'::jsonb)
    from (
      select a.id, a.at, a.actor_email, a.actor_role, a.action, a.category, a.detail,
             case when a.actor_role = 'intake' then 'Website'
                  else coalesce(private.staff_name(a.actor), a.actor_email, 'System') end as actor_name,
             (select x.ref from public.applications x where x.id = a.application_id) as application_ref
      from public.audit_log a
      where (p_category is null or a.category = p_category)
        and (p_before is null or a.at < p_before)
      order by a.at desc, a.id desc
      limit greatest(1, least(coalesce(p_limit, 200), 500))
    ) e
  );
end;
$$;

-- ===========================================================================
-- 12. The website (anon, key-checked)
-- ===========================================================================

-- Returns a new random intake key ONCE and stores only its sha256. Run by
-- hand in the SQL editor; paste the result straight into
-- `npx wrangler secret put INTAKE_KEY` — never into a chat or a file.
create function private.intake_rotate_key() returns text
language plpgsql volatile set search_path = '' as $$
declare
  v_key text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
begin
  update private.intake_config
     set key_sha256 = encode(sha256(convert_to(v_key, 'UTF8')), 'hex'), rotated_at = now()
   where id;
  perform private.audit('intake.key_rotated', 'access', null, 'intake_config', null, '{}'::jsonb, 'system');
  return v_key;
end;
$$;

create function private.check_intake_key(p_key text) returns void
language plpgsql stable set search_path = '' as $$
declare
  v_hash text;
begin
  select c.key_sha256 into v_hash from private.intake_config c where c.id;
  if v_hash is null or p_key is null or length(p_key) < 32 or length(p_key) > 256
     or encode(sha256(convert_to(p_key, 'UTF8')), 'hex') <> v_hash then
    perform private.fail('QS_BAD_KEY', 'The intake key is not valid.');
  end if;
end;
$$;

create function private.new_app_ref() returns text
language plpgsql volatile set search_path = '' as $$
declare
  v_ref text;
begin
  for i in 1 .. 20 loop
    v_ref := 'QSA-' || private.rand_chars('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 6);
    if not exists (select 1 from public.applications a where a.ref = v_ref) then
      return v_ref;
    end if;
  end loop;
  perform private.fail('QS_INVALID', 'Could not make a unique application reference. Try again.');
end;
$$;

create function public.intake_submit(p_key text, p_app jsonb, p_docs jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_policy jsonb;
  v_clean  jsonb;
  v_upload text;
  v_doc    jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_total  bigint := 0;
  v_ref    text;
  v_app    public.applications;
begin
  perform private.check_intake_key(p_key);
  v_policy := private.policy_json();
  v_clean := private.app_clean(p_app, 'intake', (v_policy ->> 'max_principal')::numeric);

  -- Documents: ID (1), payslip (1), bank statements (1–6), proof of address
  -- (0–1); only the sniffed, whitelisted types; all under one upload folder.
  if p_docs is null or jsonb_typeof(p_docs) <> 'array' or jsonb_array_length(p_docs) = 0 or jsonb_array_length(p_docs) > 9 then
    perform private.fail('QS_INVALID', 'Check these fields: documents.');
  end if;
  for v_doc in select d from jsonb_array_elements(p_docs) as d loop
    -- r2_key must be exactly apps/<upload_id>/<kind>-<seq>.<ext>, as the Worker writes it.
    if not coalesce(
         jsonb_typeof(v_doc) = 'object'
         and v_doc ->> 'kind' in ('id', 'payslip', 'bank', 'proof_address')
         and v_doc ->> 'mime' in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'image/heic', 'image/heif')
         and jsonb_typeof(v_doc -> 'seq') = 'number' and (v_doc ->> 'seq') ~ '^[1-9]$'
         and jsonb_typeof(v_doc -> 'bytes') = 'number' and (v_doc ->> 'bytes') ~ '^[0-9]{1,9}$'
         and (v_doc ->> 'bytes')::bigint <= 10 * 1024 * 1024
         and (v_doc ->> 'r2_key') ~ '^apps/[A-Za-z0-9_-]{8,64}/[a-z_]+-[0-9]\.[a-z0-9]{2,5}$'
         and split_part(v_doc ->> 'r2_key', '/', 3) ~ ('^' || (v_doc ->> 'kind') || '-' || (v_doc ->> 'seq') || '\.[a-z0-9]{2,5}$')
         and coalesce(jsonb_typeof(v_doc -> 'original_name'), 'null') in ('string', 'null'),
       false) then
      perform private.fail('QS_INVALID', 'Check these fields: documents.');
    end if;
    if v_upload is null then
      v_upload := split_part(v_doc ->> 'r2_key', '/', 2);
    elsif split_part(v_doc ->> 'r2_key', '/', 2) <> v_upload then
      perform private.fail('QS_INVALID', 'Check these fields: documents.');
    end if;
    v_counts := v_counts || jsonb_build_object(v_doc ->> 'kind', coalesce((v_counts ->> (v_doc ->> 'kind'))::int, 0) + 1);
    v_total := v_total + (v_doc ->> 'bytes')::bigint;
  end loop;
  if coalesce((v_counts ->> 'id')::int, 0) <> 1 or coalesce((v_counts ->> 'payslip')::int, 0) <> 1
     or coalesce((v_counts ->> 'bank')::int, 0) not between 1 and 6 or coalesce((v_counts ->> 'proof_address')::int, 0) > 1
     or v_total > 40 * 1024 * 1024 then
    perform private.fail('QS_INVALID', 'Check these fields: documents.');
  end if;

  -- At most 3 applications per IP (hashed) per hour. The advisory lock makes
  -- simultaneous submissions from one IP queue up behind each other.
  perform pg_advisory_xact_lock(hashtextextended('qs_intake:' || (v_clean ->> 'ip_hash'), 0));

  -- Idempotent on the upload folder. When the Worker can't tell whether a
  -- call went through (the connection dropped, or a gateway timed out after
  -- the commit) it sends the same submission once more; the same folder from
  -- the same sender is the same application, so answer with what is stored
  -- (no second row, no second audit entry, not counted by the rate limit).
  select a.* into v_app from public.applications a where a.upload_id = v_upload;
  if v_app.id is not null then
    if v_app.ip_hash is distinct from v_clean ->> 'ip_hash' then
      perform private.fail('QS_INVALID', 'Check these fields: documents.');
    end if;
    return jsonb_build_object('id', v_app.id, 'ref', v_app.ref);
  end if;

  if (select count(*) from public.applications a
      where a.ip_hash = v_clean ->> 'ip_hash' and a.submitted_at > now() - interval '1 hour') >= 3 then
    perform private.fail('QS_RATE_LIMIT', 'Too many applications from this connection. Please try again in an hour.');
  end if;

  v_ref := private.new_app_ref();
  v_app := jsonb_populate_record(null::public.applications, v_clean);
  insert into public.applications (
    ref, source, status, full_name, national_id, date_of_birth, phone, email, address, town, dependants,
    employer, job_title, employment_type, pay_day, bank_name, bank_account_holder, bank_account_no,
    salary_into_account, kin_name, kin_relationship, kin_phone, amount_requested, repay_date, purpose,
    declared_income, declared_deductions, declared_expenses, declared, other_lender_loans, other_lender_count,
    consent_processing, consent_bureau, consent_version, ip_hash, upload_id)
  values (
    v_ref, 'web', 'submitted', v_app.full_name, v_app.national_id, v_app.date_of_birth, v_app.phone, v_app.email,
    v_app.address, v_app.town, v_app.dependants, v_app.employer, v_app.job_title, v_app.employment_type,
    v_app.pay_day, v_app.bank_name, v_app.bank_account_holder, v_app.bank_account_no, v_app.salary_into_account,
    v_app.kin_name, v_app.kin_relationship, v_app.kin_phone, v_app.amount_requested, v_app.repay_date,
    v_app.purpose, v_app.declared_income, v_app.declared_deductions, v_app.declared_expenses,
    coalesce(v_app.declared, '{}'::jsonb), v_app.other_lender_loans, v_app.other_lender_count,
    true, coalesce(v_app.consent_bureau, false), v_app.consent_version, v_app.ip_hash, v_upload)
  returning * into v_app;

  insert into public.application_documents (application_id, kind, seq, r2_key, mime, bytes, original_name)
  select v_app.id, d ->> 'kind', (d ->> 'seq')::int, d ->> 'r2_key', d ->> 'mime', (d ->> 'bytes')::bigint,
         left(nullif(btrim(coalesce(d ->> 'original_name', '')), ''), 120)
  from jsonb_array_elements(p_docs) as d;

  perform private.audit('app.submitted', 'application', v_app.id, 'application', v_app.id::text,
    jsonb_build_object('ref', v_ref, 'documents', jsonb_array_length(p_docs), 'amount_requested', v_app.amount_requested),
    'intake');
  return jsonb_build_object('id', v_app.id, 'ref', v_ref);
exception
  when unique_violation then
    -- Two uploads of the same R2 key/slot: treat as bad input, never a 500 leak.
    perform private.fail('QS_INVALID', 'Check these fields: documents.');
end;
$$;

-- One-time copy of the old D1 inbox (via the Worker's POST /legacy/migrate).
-- Idempotent on the old reference: a row already imported is skipped.
-- D1 status new → submitted; approved/declined → archived (they were handled
-- outside the credit desk and must never be booked again).
create function public.intake_import_legacy(p_key text, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_row      jsonb;
  v_doc      jsonb;
  v_ref      text;
  v_status   text;
  v_created  timestamptz;
  v_decided  timestamptz;
  v_income   numeric;
  v_app      public.applications;
  v_imported int := 0;
  v_skipped  int := 0;
  v_docs     int;
begin
  perform private.check_intake_key(p_key);
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 100 then
    perform private.fail('QS_INVALID', 'Send the old applications as a list of at most 100.');
  end if;

  for v_row in select r from jsonb_array_elements(p_rows) as r loop
    v_ref := upper(btrim(coalesce(v_row ->> 'ref', v_row ->> 'id', '')));
    if jsonb_typeof(v_row) <> 'object' or v_ref !~ '^QS-[A-Z0-9]{4,12}$'
       or nullif(btrim(coalesce(v_row ->> 'full_name', '')), '') is null
       or exists (select 1 from public.applications a where a.ref = v_ref) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_status := case lower(coalesce(v_row ->> 'status', 'new')) when 'new' then 'submitted' else 'archived' end;
    v_created := coalesce(private.try_timestamptz(v_row ->> 'created_at'), now());
    v_decided := private.try_timestamptz(v_row ->> 'decided_at');
    v_income := case
      when jsonb_typeof(v_row -> 'declared_income') = 'number' and (v_row ->> 'declared_income')::numeric between 0 and 10000000
        then round((v_row ->> 'declared_income')::numeric, 2)
      when btrim(coalesce(v_row ->> 'income', '')) ~ '^[0-9]+(\.[0-9]{1,2})?$' and btrim(v_row ->> 'income')::numeric <= 10000000
        then btrim(v_row ->> 'income')::numeric
    end;

    insert into public.applications (
      ref, source, status, submitted_at, status_changed_at, full_name, national_id, phone, address, employer,
      kin_name, kin_phone, purpose, repay_date, declared_income, declared, consent_processing, consent_bureau,
      consent_version, legacy)
    values (
      v_ref, 'legacy', v_status, v_created, coalesce(v_decided, v_created),
      left(btrim(v_row ->> 'full_name'), 120),
      left(btrim(coalesce(v_row ->> 'national_id', '')), 30),
      left(btrim(coalesce(v_row ->> 'phone', '')), 30),
      left(nullif(btrim(coalesce(v_row ->> 'address', '')), ''), 300),
      left(nullif(btrim(coalesce(v_row ->> 'employer', '')), ''), 120),
      left(nullif(btrim(coalesce(v_row ->> 'kin_name', '')), ''), 120),
      left(nullif(btrim(coalesce(v_row ->> 'kin_phone', '')), ''), 30),
      left(nullif(btrim(coalesce(v_row ->> 'purpose', '')), ''), 300),
      private.try_date(v_row ->> 'repay_date'),
      v_income,
      case when v_income is null and nullif(btrim(coalesce(v_row ->> 'income', '')), '') is not null
           then jsonb_build_object('income_text', left(btrim(v_row ->> 'income'), 120)) else '{}'::jsonb end,
      coalesce(v_row -> 'consent_processing' = 'true'::jsonb, false) or lower(coalesce(v_row ->> 'consent', '')) = 'yes',
      false,
      'legacy-v0',
      v_row - 'docs')
    returning * into v_app;

    v_docs := 0;
    for v_doc in select d from jsonb_array_elements(private.jarr(v_row -> 'docs')) as d loop
      continue when not coalesce(
        jsonb_typeof(v_doc) = 'object'
        and v_doc ->> 'kind' in ('id', 'payslip', 'bank', 'proof_address', 'other')
        and v_doc ->> 'mime' in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'image/heic', 'image/heif')
        and (v_doc ->> 'r2_key') ~ '^(applications|apps)/[!-~]+$' and length(v_doc ->> 'r2_key') <= 300
        and strpos(v_doc ->> 'r2_key', '..') = 0
        and coalesce(v_doc ->> 'seq', '1') ~ '^[1-9][0-9]?$',
        false);
      insert into public.application_documents (application_id, kind, seq, r2_key, mime, bytes, original_name)
      values (v_app.id, v_doc ->> 'kind', coalesce((v_doc ->> 'seq')::int, 1), v_doc ->> 'r2_key', v_doc ->> 'mime',
              case when (v_doc ->> 'bytes') ~ '^[0-9]{1,12}$' then (v_doc ->> 'bytes')::bigint end,
              left(nullif(btrim(coalesce(v_doc ->> 'original_name', '')), ''), 120))
      on conflict do nothing;
      if found then
        v_docs := v_docs + 1;
      end if;
    end loop;

    perform private.audit('app.imported', 'application', v_app.id, 'application', v_app.id::text,
      jsonb_build_object('ref', v_ref, 'legacy_status', coalesce(v_row ->> 'status', 'new'), 'documents', v_docs),
      'intake');
    v_imported := v_imported + 1;
  end loop;

  return jsonb_build_object('imported', v_imported, 'skipped', v_skipped);
end;
$$;

-- ===========================================================================
-- 13. Row-level security and grants
-- ===========================================================================
-- Staff may READ the credit tables (the console mostly uses the RPCs above),
-- minus applications.ip_hash / upload_id and application_documents.r2_key.
-- There are NO insert/update/delete policies: the RPCs are the only way in.

alter table public.credit_policy enable row level security;
alter table public.applications enable row level security;
alter table public.application_documents enable row level security;
alter table public.assessments enable row level security;
alter table public.decisions enable row level security;
alter table public.application_notes enable row level security;

create policy "credit policy: staff read" on public.credit_policy
  for select to authenticated using ((select public.is_staff()));
create policy "applications: staff read" on public.applications
  for select to authenticated using ((select public.is_staff()));
create policy "documents: staff read" on public.application_documents
  for select to authenticated using ((select public.is_staff()));
create policy "assessments: staff read" on public.assessments
  for select to authenticated using ((select public.is_staff()));
create policy "decisions: staff read" on public.decisions
  for select to authenticated using ((select public.is_staff()));
create policy "notes: staff read" on public.application_notes
  for select to authenticated using ((select public.is_staff()));

do $$
declare
  v_rpc text;
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    -- Take back Supabase's default "everything to everyone" on the new tables.
    execute 'revoke all on public.credit_policy, public.applications, public.application_documents,
             public.assessments, public.decisions, public.application_notes from anon, authenticated';
    execute 'grant select on public.credit_policy, public.assessments, public.decisions,
             public.application_notes to authenticated';
    -- Applications and documents: every column except the intake internals
    -- the RPCs never show either (app_json, app_get): the sender's IP hash
    -- (it links submissions from one connection) and the R2 upload folder.
    execute (select format('grant select (%s) on public.applications to authenticated',
                           string_agg(quote_ident(a.attname), ', ' order by a.attnum))
             from pg_attribute a
             where a.attrelid = 'public.applications'::regclass and a.attnum > 0 and not a.attisdropped
               and a.attname not in ('ip_hash', 'upload_id'));
    execute (select format('grant select (%s) on public.application_documents to authenticated',
                           string_agg(quote_ident(a.attname), ', ' order by a.attnum))
             from pg_attribute a
             where a.attrelid = 'public.application_documents'::regclass and a.attnum > 0 and not a.attisdropped
               and a.attname <> 'r2_key');

    -- Functions: nobody by default, then exactly who needs each one.
    execute 'revoke execute on all functions in schema public from public, anon, authenticated';
    execute 'grant execute on function public.is_staff(), public.is_owner(), public.staff_role() to authenticated';
    foreach v_rpc in array array[
      'public.whoami()', 'public.staff_list()', 'public.staff_add(text, text, text)',
      'public.staff_set_active(uuid, boolean)', 'public.policy_get()', 'public.policy_update(jsonb)',
      'public.app_queue(text, text)', 'public.app_get(uuid)', 'public.app_update_applicant(uuid, jsonb)',
      'public.app_claim(uuid)', 'public.app_request_info(uuid, text)', 'public.app_resume(uuid, text)',
      'public.app_recall(uuid)', 'public.app_withdraw(uuid, text)', 'public.app_reopen(uuid, text)',
      'public.assessment_save(uuid, jsonb, jsonb)', 'public.assessment_submit(uuid, text, text, text, jsonb)',
      'public.app_decide(uuid, integer, text, jsonb, text, text, text)',
      'public.app_mark_notified(uuid, text)', 'public.app_add_note(uuid, text)', 'public.app_timeline(uuid)',
      'public.borrower_history(uuid)', 'public.doc_access(uuid)',
      'public.app_disburse_preview(uuid, date, date)',
      'public.app_disburse(uuid, jsonb, date, date, text, text, text, boolean)',
      'public.audit_list(text, timestamptz, integer)'
    ] loop
      execute format('grant execute on function %s to authenticated', v_rpc);
    end loop;
    -- The website's Worker (publishable key = anon): the two key-checked RPCs only.
    execute 'grant execute on function public.intake_submit(text, jsonb, jsonb), public.intake_import_legacy(text, jsonb) to anon';
  end if;
end $$;

-- Internals: only their owner (postgres) may run or read them.
revoke all on all functions in schema private from public;
revoke all on all tables in schema private from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all functions in schema private from anon, authenticated';
    execute 'revoke all on all tables in schema private from anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on all functions in schema private from service_role';
    execute 'revoke all on all tables in schema private from service_role';
  end if;
end $$;

insert into private.schema_migrations (version) values ('004');

commit;
