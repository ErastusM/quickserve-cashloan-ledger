-- Test helpers (schema "tests"), installed into the throwaway test databases
-- only. They let a test act as a given login the way PostgREST does it:
-- switch to the API role and put the user's JWT claims in
-- request.jwt.claims. Settings are session-level, so they last until the
-- next as_*() call (or tests.as_postgres()).
--
--   select tests.as_user('analyst@quickserve.test');   -- role authenticated + claims
--   select tests.as_anon();                             -- role anon, no user
--   select tests.as_postgres();                         -- back to the superuser
--   select tests.expect_error($$ select public.app_claim(...) $$, 'QS_FORBIDDEN');
--   select tests.eq(actual, expected, 'what is being checked');

create schema tests;
grant usage on schema tests to public;

-- Security definer so it can read auth.users while acting as anon/authenticated.
create function tests.user_id(p_email text) returns uuid
language sql stable security definer set search_path = '' as $$
  select u.id from auth.users u where lower(u.email) = lower(p_email);
$$;

create function tests.create_user(p_email text) returns uuid
language sql as $$
  insert into auth.users (email, last_sign_in_at) values (lower(p_email), now()) returning id;
$$;

create function tests.as_user(p_email text) returns void
language plpgsql as $$
declare
  v_id uuid := tests.user_id(p_email);
begin
  if v_id is null then
    raise exception 'tests.as_user: no login %', p_email;
  end if;
  perform set_config('role', 'authenticated', false);
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_id, 'email', lower(p_email), 'role', 'authenticated', 'aud', 'authenticated')::text, false);
end;
$$;

create function tests.as_anon() returns void
language plpgsql as $$
begin
  perform set_config('role', 'anon', false);
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, false);
end;
$$;

create function tests.as_postgres() returns void
language plpgsql as $$
begin
  perform set_config('role', 'none', false);
  perform set_config('request.jwt.claims', '', false);
end;
$$;

create function tests.assert(p_ok boolean, p_what text) returns void
language plpgsql as $$
begin
  if p_ok is distinct from true then
    raise exception 'ASSERTION FAILED: %', p_what;
  end if;
end;
$$;

create function tests.eq(p_actual anyelement, p_expected anyelement, p_what text) returns void
language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'ASSERTION FAILED: % — expected %, got %', p_what, p_expected, p_actual;
  end if;
end;
$$;

-- Run p_sql (as the current role) and require it to fail with a message that
-- starts with p_prefix (e.g. 'QS_FORBIDDEN', or 'permission denied').
create function tests.expect_error(p_sql text, p_prefix text) returns text
language plpgsql as $$
declare
  v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    v_msg := sqlerrm;
    if position(p_prefix in v_msg) <> 1 then
      raise exception 'ASSERTION FAILED: expected an error starting with "%", got "%" from: %', p_prefix, v_msg, p_sql;
    end if;
    return v_msg;
  end;
  raise exception 'ASSERTION FAILED: expected an error starting with "%" but it succeeded: %', p_prefix, p_sql;
end;
$$;

-- Same, but for contract errors also check the errcode is P0001.
create function tests.expect_qs(p_sql text, p_code text) returns text
language plpgsql as $$
declare
  v_msg   text;
  v_state text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
    if position(p_code || ': ' in v_msg) <> 1 or v_state <> 'P0001' then
      raise exception 'ASSERTION FAILED: expected % (P0001), got "%" (%) from: %', p_code, v_msg, v_state, p_sql;
    end if;
    return v_msg;
  end;
  raise exception 'ASSERTION FAILED: expected % but it succeeded: %', p_code, p_sql;
end;
$$;

-- Named values for use inside dollar-quoted SQL, where psql's :'var' does not
-- interpolate:  select tests.put('app', :'app');  … $$ select public.app_claim(tests.id('app')) $$
create function tests.put(p_name text, p_value text) returns void
language sql as $$
  select set_config('qstest.' || p_name, coalesce(p_value, ''), false);
$$;

create function tests.v(p_name text) returns text
language sql stable as $$
  select nullif(current_setting('qstest.' || p_name, true), '');
$$;

create function tests.id(p_name text) returns uuid
language sql stable as $$
  select tests.v(p_name)::uuid;
$$;

-- ---------------------------------------------------------------------------
-- Builders for credit-desk tests (plpgsql, so they compile before 004 exists).
-- ---------------------------------------------------------------------------

-- The contract's example worksheet (CONTRACT §4): D4 7,620 · D6 5,334.
create function tests.ws_clean() returns jsonb
language sql immutable as $$
  select '{
    "docs":   { "d2_1": true, "d2_2": true, "d2_3": true, "d2_4": true, "d2_5": true, "d2_6": null, "d2_7": true },
    "verify": { "v2_8": true, "v2_9": true, "v2_10": true, "v2_11": "" },
    "bureau": { "used": null, "date": null, "ref": null, "open_accounts": null, "monthly_commitments": null, "adverse": null, "enquiries_3m": null, "agrees": null, "explain": "" },
    "income": { "a1": 24500, "a2": 4150, "a3": 2100, "a5": 18100, "a7": 0, "irregular": false, "a11": 0, "notes": "" },
    "commitments": { "b1": 0, "b2": 0, "b3": 0, "b4": 0, "b5": 1200, "b6": 0, "b7": 0, "b8": 0, "b9": 280, "b10": 0, "b11": 0, "b11_desc": "" },
    "living": { "c1": 2500, "c2": 700, "c3": 2800, "c4": 1200, "c5": 400, "c6": 600, "c7": 800, "c8": 0, "c9": 0, "c9_desc": "", "dependants": 2, "credible": true, "adjust_note": "" },
    "flags":  { "f8_1": false, "f8_2": false, "f8_3": false, "f8_4": false, "f8_5": true, "f8_6": false, "f8_7": false, "detail": "" },
    "conduct": { "g9": "na", "g10": true, "g11": true }
  }'::jsonb;
$$;

create function tests.terms(p_principal numeric default 4000, p_days integer default 30) returns jsonb
language sql stable as $$
  select jsonb_build_object('principal', p_principal, 'interest_rate', 30, 'service_fee', 0,
    'issue_date', to_char((now() at time zone 'Africa/Windhoek')::date, 'YYYY-MM-DD'),
    'due_date', to_char((now() at time zone 'Africa/Windhoek')::date + p_days, 'YYYY-MM-DD'));
$$;

create function tests.declaration() returns jsonb
language sql immutable as $$
  select '{"d12_1":true,"d12_2":true,"d12_3":true,"d12_4":true,"d12_5":true,"d12_6":true,"d12_7":true}'::jsonb;
$$;

create function tests.checklist() returns jsonb
language sql immutable as $$
  select '{"13.1":true,"13.2":true,"13.3":true,"13.4":true,"13.5":true,"13.6":true,"13.7":true,"13.8":true,"13.9":true,"13.10":true}'::jsonb;
$$;

-- A complete, valid website submission (what the Worker sends as p_app).
create function tests.app_payload(p_overrides jsonb default '{}'::jsonb) returns jsonb
language sql volatile as $$
  select jsonb_build_object(
    'full_name', 'Test Applicant', 'national_id', '95043000218', 'date_of_birth', '1995-04-30',
    'phone', '081 555 0101', 'email', 'applicant@example.com', 'address', '12 Sam Nujoma Ave',
    'town', 'Swakopmund', 'dependants', 2, 'employer', 'Namdeb', 'job_title', 'Clerk',
    'employment_type', 'Permanent', 'pay_day', '25th', 'bank_name', 'FNB Namibia',
    'bank_account_holder', 'Test Applicant', 'bank_account_no', '62001234567', 'salary_into_account', true,
    'kin_name', 'Martha Kin', 'kin_relationship', 'Mother', 'kin_phone', '085 612 3390',
    'amount_requested', 4000, 'repay_date', to_char(current_date + 30, 'YYYY-MM-DD'), 'purpose', 'School fees',
    'declared_income', 18400, 'declared_deductions', 1500, 'declared_expenses', 9000,
    'other_lender_loans', true, 'other_lender_count', 1,
    'consent_processing', true, 'consent_bureau', true, 'consent_version', 'v2026-10',
    'ip_hash', md5(random()::text) || md5(random()::text)
  ) || coalesce(p_overrides, '{}'::jsonb);
$$;

-- ID, payslip and three bank statements under one fresh upload folder.
create function tests.docs_payload(p_upload text default null) returns jsonb
language plpgsql volatile as $$
declare
  u text := coalesce(p_upload, gen_random_uuid()::text);
begin
  return jsonb_build_array(
    jsonb_build_object('kind', 'id', 'seq', 1, 'r2_key', 'apps/' || u || '/id-1.jpg', 'mime', 'image/jpeg', 'bytes', 120000, 'original_name', 'id.jpg'),
    jsonb_build_object('kind', 'payslip', 'seq', 1, 'r2_key', 'apps/' || u || '/payslip-1.pdf', 'mime', 'application/pdf', 'bytes', 240000, 'original_name', 'payslip.pdf'),
    jsonb_build_object('kind', 'bank', 'seq', 1, 'r2_key', 'apps/' || u || '/bank-1.pdf', 'mime', 'application/pdf', 'bytes', 410000, 'original_name', 'june.pdf'),
    jsonb_build_object('kind', 'bank', 'seq', 2, 'r2_key', 'apps/' || u || '/bank-2.pdf', 'mime', 'application/pdf', 'bytes', 395000, 'original_name', 'july.pdf'),
    jsonb_build_object('kind', 'bank', 'seq', 3, 'r2_key', 'apps/' || u || '/bank-3.pdf', 'mime', 'application/pdf', 'bytes', 402000, 'original_name', 'august.pdf'));
end;
$$;

-- The intake key for this test database (rotates it; returns the new key).
create function tests.intake_key() returns text
language plpgsql as $$
begin
  return private.intake_rotate_key();
end;
$$;

-- Submit through intake_submit (as the Worker would, i.e. as anon) and return
-- the id. Ends as postgres.
create function tests.submit_app(p_key text, p_overrides jsonb default '{}'::jsonb) returns uuid
language plpgsql as $$
declare
  v uuid;
begin
  perform tests.as_anon();
  v := (public.intake_submit(p_key, tests.app_payload(p_overrides), tests.docs_payload()) ->> 'id')::uuid;
  perform tests.as_postgres();
  return v;
end;
$$;

-- Take an application from submitted to awaiting_approval: the analyst claims
-- it, saves the example worksheet with p_terms and recommends p_rec.
create function tests.to_awaiting(p_app uuid, p_terms jsonb, p_rec text default 'approve',
                                  p_analyst text default 'analyst@quickserve.test',
                                  p_ws jsonb default null, p_motivation text default null) returns integer
language plpgsql as $$
declare
  v jsonb;
begin
  perform tests.as_user(p_analyst);
  perform public.app_claim(p_app);
  perform public.assessment_save(p_app, coalesce(p_ws, tests.ws_clean()), p_terms);
  v := public.assessment_submit(p_app, p_rec,
    'Verified income from payslip and three bank statements; affordable with room to spare after all commitments.',
    p_motivation, tests.declaration());
  perform tests.as_postgres();
  return (v ->> 'version')::int;
end;
$$;

-- A new application, taken all the way to "approved" (ready to disburse).
-- Returns the application id. Acts as intake → analyst → owner, ends as postgres.
create function tests.approved_app(p_key text, p_overrides jsonb default '{}'::jsonb, p_principal numeric default 1500,
                                   p_override_note text default null) returns uuid
language plpgsql as $$
declare
  v_app uuid := tests.submit_app(p_key, p_overrides);
  v_ver integer := tests.to_awaiting(v_app, tests.terms(p_principal));
begin
  perform tests.as_user('owner@quickserve.test');
  perform public.app_decide(v_app, v_ver, 'approved', null, null, null, p_override_note);
  perform tests.as_postgres();
  return v_app;
end;
$$;

grant execute on all functions in schema tests to public;
