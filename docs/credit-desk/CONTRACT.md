# Credit Desk — build contract (frozen)

This is the single source of truth that the database (`supabase/migrations/`),
the intake Worker (`intake-worker/`), the public form (`apply.html`) and the
admin console (`admin/index.html`) are built against. Change it only by
agreement; every part must match it exactly.

Visual reference: `design/credit-desk/*.dc.html` (signed-off clickable
designs; "Statement (light)" look already used by `admin/index.html`).

## 1. Business decisions (owner-confirmed)

| Setting | Value |
|---|---|
| Maker-checker | Credit analyst verifies and recommends; **only an owner** approves, declines and pays out. |
| Analyst visibility | Applications + that applicant's own history/KYC only. Never the ledger, company figures, expenses, settings, audit log. **Enforced in Postgres (RLS + RPC checks).** |
| Booking | On disbursement only. Approved → "Ready to disburse" → owner ticks checklist 13.1–13.10 and records payout → client found/created by ID + loan appended to the ledger atomically. |
| D5 (share of disposable income one repayment may take) | **70 %** (policy, owner-editable) |
| Above the D5 limit | Allowed **only** if the assessor writes a motivation (≥ 60 chars) **and** an owner approves with an override note (≥ 20 chars). Rule class `owner`. |
| Credit bureau | No subscription yet → `bureau_required = false` → G4 = `na` (pass). |
| Owner assesses own file (analyst away) | Allowed; decision flagged `self_assessed = true`. |
| Analyst may withdraw spam/duplicates | Yes, with reason (pre-approval states only). Owner may also withdraw `approved`. |
| Max principal | N$100,000 (legal cap; policy value). |
| Max term | 5 months (issue → due). |
| Charges cap | interest + fees ≤ 30 % of principal. |
| Default rate / fee | 30 % once-off / N$0. |
| Red-flag threshold | 2 (8.1–8.7 "yes" count ≥ 2 → soft fail). |
| F5 rounding step | N$50. |
| Applicant age | 18–70 (soft warning on the form; KYC flag for staff). |
| SLA | pick-up 24 h, approval 24 h (display only). |
| Idle sign-out (console) | 20 minutes. |
| Owner login to seed | `erastusmatheus3@gmail.com` (also the phone-app sync login). |
| Time zone | `Africa/Windhoek` (UTC+2, no DST). "Today" = `(now() at time zone 'Africa/Windhoek')::date`. |
| Application refs | New: `QSA-` + 6 chars from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`. Legacy D1 refs `QS-XXXXXX` kept as-is. |

## 2. Roles

`public.staff(user_id uuid pk → auth.users, email, full_name, role 'owner'|'analyst', active bool, …)`.
A Supabase login with no active staff row can do **nothing** (ledger included).

| Capability | analyst | owner |
|---|---|---|
| Queue, pick up, request info, notes, WhatsApp links | ✓ | ✓ |
| View documents (audited), borrower history (audited) | ✓ | ✓ |
| Worksheet save / submit / recall | ✓ (assignee) | ✓ |
| Withdraw pre-approval (spam/duplicate) | ✓ | ✓ |
| Decide (approve / approve above limit / decline / return) | — | ✓ |
| Disburse & book | — | ✓ |
| Ledger read/write (phone app + console loan book) | — | ✓ |
| Team, credit policy, audit trail, legacy import | — | ✓ |

## 3. Status machine

Open: `submitted`, `in_review`, `info_requested`, `awaiting_approval`, `approved`.
Closed: `disbursed`, `declined`, `withdrawn`, `archived` (legacy import).

| From → To | Who | RPC |
|---|---|---|
| submitted → in_review | staff (becomes `assigned_to`) | `app_claim` |
| in_review → info_requested | assignee or owner | `app_request_info` |
| info_requested → in_review | staff | `app_resume` |
| in_review → awaiting_approval | assignee or owner | `assessment_submit` |
| awaiting_approval → in_review | submitter (recall) | `app_recall` |
| awaiting_approval → in_review | owner (return) | `app_decide(outcome='returned')` |
| awaiting_approval → approved | owner | `app_decide(outcome='approved')` |
| submitted/in_review/info_requested/awaiting_approval → declined | owner | `app_decide(outcome='declined')` |
| approved → disbursed | owner | `app_disburse` |
| submitted/in_review/info_requested/awaiting_approval → withdrawn | staff | `app_withdraw` |
| approved → withdrawn | owner | `app_withdraw` |
| declined/withdrawn → in_review | owner | `app_reopen` |
| disbursed, archived → * | nobody | — |

## 4. Worksheet data (assessments.worksheet jsonb) and maths

Numbers are JSON numbers (N$). Missing → 0. Booleans as JSON booleans.

```json
{
  "docs":   { "d2_1": true, "d2_2": true, "d2_3": true, "d2_4": true, "d2_5": true, "d2_6": null, "d2_7": true },
  "verify": { "v2_8": true, "v2_9": true, "v2_10": true, "v2_11": "" },
  "bureau": { "used": null, "date": null, "ref": null, "open_accounts": null, "monthly_commitments": null, "adverse": null, "enquiries_3m": null, "agrees": null, "explain": "" },
  "income": { "a1": 24500, "a2": 4150, "a3": 2100, "a5": 18100, "a7": 0, "irregular": false, "a11": 0, "notes": "" },
  "commitments": { "b1": 0, "b2": 0, "b3": 0, "b4": 0, "b5": 1200, "b6": 0, "b7": 0, "b8": 0, "b9": 280, "b10": 0, "b11": 0, "b11_desc": "" },
  "living": { "c1": 2500, "c2": 700, "c3": 2800, "c4": 1200, "c5": 400, "c6": 600, "c7": 800, "c8": 0, "c9": 0, "c9_desc": "", "dependants": 2, "credible": true, "adjust_note": "" },
  "flags":  { "f8_1": false, "f8_2": false, "f8_3": false, "f8_4": false, "f8_5": true, "f8_6": false, "f8_7": false, "detail": "" },
  "conduct": { "g9": "na", "g10": true, "g11": true }
}
```
`d2_6`, `d2_7`: `true` / `false` / `null` (= not required). `conduct.g9`: `"na" | "yes" | "no"`.
`b8` is **overwritten server-side** with the applicant's current QuickServe balance (from `borrower_history`).

`terms` jsonb: `{ "principal": 4000, "interest_rate": 30, "service_fee": 0, "issue_date": "2026-09-28", "due_date": "2026-10-28" }`.

### Formulas (SQL `private.assessment_compute` and JS `QSCredit.compute` MUST agree to the cent)
`r2(x)` = round half away from zero to 2 decimals. Policy `p` = the `credit_policy` row.

```
A4 = r2(a1 − a2 − a3)
A6 = irregular ? a11 : min(A4, a5)
A8 = r2(A6 + a7)
B12 = r2(b1+…+b11)
C10 = r2(c1+…+c9)
D1 = A8; D2 = B12; D3 = C10
D4 = r2(D1 − D2 − D3)
D5 = p.max_share_disposable_pct            (70)
D6 = r2(max(0, D4 × D5 / 100))
E1 = principal; E2 = r2(E1 × interest_rate / 100); E3 = service_fee
E4 = r2(E2 + E3); E5 = E7 = r2(E1 + E4)
E10 = due_date − issue_date (days)
F1 = E7; F2 = D6
F3 = (E7 > 0 and E7 ≤ D6)
F4 = r2(D4 − E7)
F5 = D6 > E3 ? floor(((D6 − E3) / (1 + interest_rate/100)) / p.principal_round_step) × p.principal_round_step : 0 ; F5 = min(F5, p.max_principal)
G7 = any of b1..b7, b9..b11 > 0   (b8 is our own loan, excluded)
flag_count = number of true among f8_1..f8_7
```

### Rules (codes, classes, pass condition)
| code | class | passes when |
|---|---|---|
| `D4` | hard | D4 > 0 |
| `DOCS` | hard | d2_1..d2_5 all true |
| `G1` | hard | E1 > 0 and E4 ≤ E1 × p.cost_cap_pct/100 (+0.005 tolerance) |
| `G2` | hard | 0 < E1 ≤ p.max_principal |
| `G3` | hard | issue < due and due ≤ issue + p.max_term_months months |
| `G4` | hard | p.bureau_required = false → result `na`; else bureau.used, date, ref all non-empty |
| `G10` | hard | conduct.g10 = true |
| `G11` | hard | conduct.g11 = true |
| `F3` | owner | F3 |
| `G8` | owner | G7 ? F3 : true |
| `G5` | soft | application.consent_bureau = true |
| `G6` | soft | application has amount_requested, bank_account_no, pay_day, employer, kin_name, kin_phone |
| `G9` | soft | conduct.g9 ∈ {"na","yes"} |
| `FLAGS` | soft | flag_count < p.red_flag_threshold |
| `VERIFY` | soft | v2_8 and v2_9 and v2_10 all true |
| `G7` | info | result `yes`/`no` (never fails) |

`computed` jsonb = `{ a4,a6,a8,b12,c10,d1,d2,d3,d4,d5,d6,e1,e2,e3,e4,e5,e7,e10,f3,f4,f5,g7,flag_count,
rules:[{code,class,result:'pass'|'fail'|'na'|'yes'|'no'}], hard_fail_codes:[], owner_fail_codes:[], soft_fail_codes:[] }`
(rules in the table order above). Fixtures: `tests/fixtures/credit-cases.json` = `[{name, worksheet, terms, application:{consent_bureau, amount_requested, bank_account_no, pay_day, employer, kin_name, kin_phone}, policy, expected: computed}]`.

### Recommendation (assessment_submit)
`recommendation ∈ approve | approve_above_limit | approve_reduced | decline | refer`
- always: `reasons` ≥ 60 chars; `declaration` = `{"d12_1":true,…,"d12_7":true}` all true.
- `approve`: hard = 0 and owner = 0.
- `approve_reduced`: hard = 0 and owner = 0 and terms.principal < amount_requested.
- `approve_above_limit`: hard = 0 and owner > 0 and `motivation` ≥ 60 chars.
- `decline`, `refer`: always allowed.

### Owner decision (app_decide) — re-computed server-side on the FINAL terms
- `approved`: final terms (default = assessment terms; owner may lower/raise principal, change rate/fee/dates) recomputed against the submitted worksheet →
  hard fails must be 0; if owner-class fails > 0 → requires assessment.recommendation = `approve_above_limit` (i.e. a written motivation exists) **and** `override_note` ≥ 20; if soft fails > 0 → `override_note` ≥ 20. `overridden_codes` = owner+soft fail codes accepted.
- `declined`: `reason_to_applicant` ∈ `afford|docs|history|other` required; `reasons` ≥ 20.
- `returned`: `reasons` (note to analyst) ≥ 10 → status back to `in_review`.
- `p_assessment_version` must equal the current assessment version (optimistic lock) else `QS_STALE`.
- `self_assessed` = (decided_by = assessment.submitted_by).

## 5. RPCs (PostgREST: `POST /rest/v1/rpc/<name>` with JSON body of params)

Errors: `raise exception using errcode = 'P0001', message = 'QS_<CODE>: <plain English sentence>'`.
Codes: `QS_FORBIDDEN, QS_NOT_FOUND, QS_BAD_STATE, QS_STALE, QS_INVALID, QS_HARD_FAIL, QS_OVERRIDE_REQUIRED, QS_RATE_LIMIT, QS_BAD_KEY, QS_AMBIGUOUS_CLIENT, QS_LEDGER_MISSING`.
The console shows the text after `": "`.

All workflow RPCs: `security definer`, `set search_path = ''`, check caller via `private.require_staff()` / `private.require_owner()`, write `audit_log`, return `jsonb`.

| RPC | params | returns | who |
|---|---|---|---|
| `whoami` | — | `{user_id,email,full_name,role,active}` or `null` | any authenticated |
| `staff_list` | — | `[{user_id,email,full_name,role,active,created_at,last_sign_in_at}]` | owner |
| `staff_add` | `p_email, p_full_name, p_role` | staff row (login must already exist in auth.users, else `QS_NOT_FOUND`) | owner |
| `staff_set_active` | `p_user_id, p_active` | staff row (not self, not last active owner) | owner |
| `policy_get` | — | credit_policy row | staff |
| `policy_update` | `p_patch jsonb` | credit_policy row (audited before/after) | owner |
| `app_queue` | `p_tab text` (`open`,`submitted`,`in_review`,`info_requested`,`awaiting_approval`,`approved`,`closed`), `p_search text default null` | `{counts:{open,submitted,in_review,info_requested,awaiting_approval,approved,closed}, rows:[{id,ref,status,submitted_at,status_changed_at,age_hours,full_name,national_id,phone,employer,declared_income,amount_requested,assigned_to,assigned_name,returning,client_ref,late_loans,dup_open,recommendation,hard_fail,above_limit}]}` (max 300 rows, newest first; `age_hours` since status_changed_at) | staff |
| `app_get` | `p_app_id uuid` | `{application, documents:[{id,kind,seq,mime,bytes,original_name,uploaded_at,viewed_by_me_at}], assessment|null, decisions:[…], notes:[{id,kind,body,author_name,created_at}], kyc:{id_is_namibian,id_valid,dob,age,age_ok,dup_open:[{id,ref,status}],ledger_match:{client_id,client_ref,name,loans}|null,phone_matches:[{client_ref,name}]}, policy, allowed_actions:[…], me:{user_id,role}}` | staff |
| `app_update_applicant` | `p_app_id, p_patch jsonb` (whitelisted applicant fields) | application | staff, pre-approval states |
| `app_claim` | `p_app_id` | application | staff |
| `app_request_info` | `p_app_id, p_note` | application | assignee/owner |
| `app_resume` | `p_app_id, p_note default null` | application | staff |
| `app_recall` | `p_app_id` | application | submitter |
| `app_withdraw` | `p_app_id, p_reason` | application | see §3 |
| `app_reopen` | `p_app_id, p_reason` | application | owner |
| `assessment_save` | `p_app_id, p_worksheet jsonb, p_terms jsonb` | `{version, computed, updated_at}` | assignee/owner, status in_review |
| `assessment_submit` | `p_app_id, p_recommendation, p_reasons, p_motivation default null, p_declaration jsonb` | `{version, computed}` → status awaiting_approval | assignee/owner |
| `app_decide` | `p_app_id, p_assessment_version int, p_outcome ('approved'|'declined'|'returned'), p_terms jsonb default null, p_reasons text, p_reason_to_applicant text default null, p_override_note text default null` | decision row | owner |
| `app_mark_notified` | `p_app_id, p_via ('whatsapp'|'phone'|'in_person')` | application | staff |
| `app_add_note` | `p_app_id, p_body` | note | staff |
| `app_timeline` | `p_app_id` | `[{at, actor_name, action, text}]` newest first | staff |
| `borrower_history` | `p_app_id` | see §6 (audited `history.viewed`, max once per user+app+day) | staff |
| `doc_access` | `p_doc_id uuid` | `{r2_key, mime, original_name, kind}` (audited `doc.viewed`) | staff |
| `app_disburse_preview` | `p_app_id, p_issue_date date, p_due_date date` | `{client_match:{mode:'existing'|'new'|'ambiguous', candidates:[{id,ref,name,national_id,loans}]}, next_client_ref, next_loan_ref, terms:{principal,interest_rate,service_fee,total_repayable}, checks:{G1,G2,G3,issue_not_future}}` | owner, status approved |
| `app_disburse` | `p_app_id, p_checklist jsonb ({"13.1":true,…,"13.10":true}), p_issue_date date, p_due_date date, p_method ('Cash'|'Bank transfer'|'E-wallet'|'Other'), p_reference text, p_client_id text default null, p_new_client boolean default false` | `{loan_id, loan_ref, client_id, client_ref, ledger_rev}` | owner |
| `audit_list` | `p_category text default null` (`application`,`decision`,`ledger`,`document`,`access`), `p_before timestamptz default null`, `p_limit int default 200` | `[{id,at,actor_name,actor_email,actor_role,action,category,application_ref,detail}]` | owner |
| `intake_submit` | `p_key text, p_app jsonb, p_docs jsonb` | `{id, ref}` | **anon** (key-checked) |
| `intake_import_legacy` | `p_key text, p_rows jsonb` | `{imported, skipped}` | **anon** (key-checked) |

`allowed_actions` vocabulary: `claim, request_info, resume, save_assessment, submit_assessment, recall, decide, withdraw, reopen, disburse, add_note, mark_notified, update_applicant`.

## 6. Borrower history shape
```json
{ "matches": [ { "match": "id" | "phone",
    "client": { "id","ref","name","phone","national_id","employer","address","next_of_kin" },
    "summary": { "loans": 3, "borrowed": 9500, "repaid": 12350, "late_loans": 1, "max_days_late": 4, "outstanding": 0 },
    "loans": [ { "id","ref","issue_date","due_date","principal","interest_rate","service_fee","extension_interest","total_due","paid","outstanding","status","paid_date","days_late","extensions","payments":[{"date","amount","method"}] } ] } ],
  "qs_balance": 0 }
```
Per-loan maths = phone app `loanTerms`/`analyzeLoan` (app.js ≈ lines 532–605): interest = r2(principal×rate/100), fees = r2(serviceFee), extension_interest = Σ extensions[].addedInterest, total_due = principal + interest + fees + extension_interest; paid = Σ payments; outstanding = max(0, total_due − paid); status: `paid` if outstanding ≤ 0, else `written-off` if loan.status = 'written-off', else `overdue` if due_date < today, else `active`. `paid_date` = date of the payment that brought outstanding to 0; `days_late` = max(0, paid_date − due_date) for paid loans, max(0, today − due_date) for open ones. Client `notes` are **never** returned. `qs_balance` = Σ outstanding of `id` matches (non-written-off). Only `match:'id'` rows count for `qs_balance`/B8.
National-ID normalisation: upper-case, strip everything but A–Z0–9. Phone normalisation: digits only, last 9.

## 7. Ledger record shapes written by `app_disburse` (must match app.js exactly)
- ids: `client_` / `loan_` + base36(epoch ms) + `_` + 6 random `[a-z0-9]`; re-roll if it collides.
- refs: next `QS-%04d` (clients) and `QSL-%04d` (loans) = max existing numeric part + 1 (app.js `highestClientRef`/`highestLoanRef`).
- `createdAt`: `YYYY-MM-DDTHH:MM:SS.mmmZ` (UTC). Dates `YYYY-MM-DD`. Money as JSON numbers.
- client: `{id, ref, createdAt, name, phone, nationalId, employer, address, nextOfKin: "Name (phone)", notes: "From application QSA-… (<date>)"}`. Existing client: only fill **empty** phone/employer/address/nextOfKin.
- loan: `{id, ref, createdAt, status:"active", clientId, principal, interestRate, serviceFee, issueDate, dueDate, purpose, applicationId, applicationRef, payoutMethod, payoutReference}`.
- Row update: `data = data with clients/loans appended`, `data.updatedAt = createdAt`, `rev = rev + 1`, `updated_at = now()`, `updated_by = caller email`. Row locked `FOR UPDATE`; unknown top-level keys untouched.
- Checklist: all 10 keys `13.1`…`13.10` true. `issue_date ≤ today (Windhoek)`, G1–G3 on final decision terms.
- Client match: normalised `nationalId` equal → `existing` (1) / `ambiguous` (>1, requires `p_client_id`) / `new` (0). `p_new_client=true` forces new.

## 8. Intake Worker (Cloudflare) — `intake-worker/src/index.js`
Vars: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `ALLOWED_ORIGINS` (comma list; `*` allowed), secrets `INTAKE_KEY`, `OWNER_TOKEN` (legacy only). Bindings kept: `DB` (D1, legacy), `DOCS` (R2).

- `POST /applications` (public, multipart). Field names (form → `p_app` key):
  `fullName→full_name, nationalId→national_id, dateOfBirth→date_of_birth, phone, email, address, town, dependants, employer, jobTitle→job_title, employmentType→employment_type, payDay→pay_day, bankName→bank_name, bankAccountHolder→bank_account_holder, bankAccountNo→bank_account_no, salaryIntoAccount→salary_into_account (yes/no→bool), kinName→kin_name, kinRelationship→kin_relationship, kinPhone→kin_phone, amountRequested→amount_requested, repayDate→repay_date, purpose, declaredIncome→declared_income, declaredDeductions→declared_deductions, declaredExpenses→declared_expenses, otherLenderLoans→other_lender_loans (yes/no→bool), otherLenderCount→other_lender_count, consentProcessing→consent_processing (must be "yes"), consentBureau→consent_bureau (yes/no→bool), consentVersion→consent_version`.
  Legacy form compatibility: `income`→`declared_income` if numeric (else kept in `declared.income_text`), `consent=yes`→`consent_processing=true`.
  Honeypot field `website`: non-empty → fake `201 {ok:true, reference:"QSA-XXXXXX"-looking}` and store nothing.
  Files: `docId` (1, required), `docPayslip` (1, required), `docBank` (1–6, required), `docAddress` (0–1). ≤ 10 MB each, ≤ 40 MB total. Type sniffed from first 16 bytes: JPEG `FF D8 FF`, PNG `89 50 4E 47`, WEBP `RIFF....WEBP`, PDF `%PDF-`, HEIC `....ftyp(heic|heix|mif1|msf1|hevc)`; else `415`. Kinds: `id, payslip, bank, proof_address`.
  Order: validate everything (400/413/415 JSON `{error, fields?}`) **before any R2 write** → R2 put `apps/<upload_id>/<kind>-<seq>.<ext>` with sniffed content-type → `rpc/intake_submit` (publishable key as `apikey` + `Authorization: Bearer <publishable key>`) with `ip_hash = hex(HMAC-SHA256(INTAKE_KEY, CF-Connecting-IP))` → on any failure delete the uploaded keys, return `500 {error:"server_error"}` (never leak messages; `QS_RATE_LIMIT` → 429, `QS_INVALID` → 400). Success `201 {ok:true, reference}`.
- `GET /docs/:docId` — `Authorization: Bearer <user's Supabase access token>` required (else 401). Worker calls `rpc/doc_access` forwarding that token (+ publishable `apikey`); non-200 → pass through 401/403/404. Streams R2 object with `Content-Type` = whitelisted mime, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`, `Content-Disposition: inline; filename="<kind>.<ext>"` (images/PDF) or `attachment` (HEIC/other); images also `Content-Security-Policy: sandbox; default-src 'none'`.
- `POST /legacy/migrate` — `Authorization: Bearer <OWNER_TOKEN>`; reads all D1 `applications`, sniffs each R2 object's first 16 bytes (range read), calls `rpc/intake_import_legacy` in batches of 25; returns `{imported, skipped}`. Idempotent.
- Legacy `/applications*` owner routes stay (for the old inbox) until retirement.
- CORS: echo request `Origin` if in `ALLOWED_ORIGINS` (or `*`); methods `GET,POST,OPTIONS`; headers `Authorization,Content-Type`.

## 9. Admin console session & security
- Session key `quickserve_admin_session_v1` (`{access_token, refresh_token, expires_at, email}`); never touch `quickserve_cloud_v1` (phone app's). Sign-out calls `POST /auth/v1/logout` then removes only its own key.
- Boot: token → `rpc/whoami`; `null`/inactive → "Your login isn't enabled for the credit desk — ask the owner." + sign out.
- Analyst session must **never** request `/rest/v1/ledger`.
- Idle 20 min → sign out. My account → change password via `PUT /auth/v1/user {password}`.
- Documents fetched from `WORKER_BASE + /docs/<id>` with the user's token; blob re-wrapped with the whitelisted type before `URL.createObjectURL`.
- CSP meta; all applicant text through `esc()`; CSV cells starting `= + - @` prefixed with `'`.
