# QuickServe Cashloan — intake Worker (v2, credit desk)

A small Cloudflare Worker that is the public front door of the **credit desk**:

```
Borrower texts your WhatsApp number
      │  (WhatsApp Business App greeting auto-reply: "Apply here: <link>")
      ▼
apply.html ──POST /applications──► Worker ──┬─► R2: documents (type checked from the file's own bytes)
                                            └─► Supabase rpc/intake_submit (key-checked, rate-limited)
                                                        │
                                                        ▼
                     admin console (credit queue) ──► analyst assesses ──► owner approves ──► disburse
                                │
                                └─► GET /docs/:id  (Worker checks the staff login with Supabase, then streams)
```

- **Supabase is the system of record** for applications, assessments, decisions and the audit trail.
  The Worker holds **no service-role key**. It can only call the two key-checked intake RPCs,
  or act as the signed-in staff member whose login it forwards.
- **Documents stay in R2** (10 GB free). Nobody gets a public link. Staff open a document through
  `GET /docs/:id`, and every view is recorded in the audit log.
- The old D1 inbox (`inbox.html` + `OWNER_TOKEN`) keeps working read-only until it is retired.
  `POST /legacy/migrate` copies its applications into the credit desk once.

Everything here is **free-tier** on Cloudflare. This folder contains **no data and no secrets**.
The only key in it is the Supabase *publishable* key, which is public by design.

---

## Routes

| Route | Who | What |
|---|---|---|
| `POST /applications` | public (apply form) | Submit an application (multipart). → `201 {ok:true, reference:"QSA-…"}` |
| `GET /docs/:docId` | staff (`Authorization: Bearer <Supabase access token>`) | Stream one document after `rpc/doc_access` allows it |
| `POST /legacy/migrate` | owner (`Authorization: Bearer <OWNER_TOKEN>`) | Import the old D1 applications into Supabase (safe to re-run) |
| `GET /applications[?status=]`, `GET /applications/:id`, `POST /applications/:id/status`, `GET /applications/:id/file/:field[/:n]` | owner (`OWNER_TOKEN`) | **Legacy** routes for the old `inbox.html`. Retire with D1 |

### `POST /applications` — what the form sends
Multipart form fields (form name → database field): `fullName`, `nationalId`, `dateOfBirth` (YYYY-MM-DD),
`phone`, `email`, `address`, `town`, `dependants`, `employer`, `jobTitle`, `employmentType`, `payDay`,
`bankName`, `bankAccountHolder`, `bankAccountNo`, `salaryIntoAccount` (yes/no), `kinName`,
`kinRelationship`, `kinPhone`, `amountRequested`, `repayDate` (YYYY-MM-DD), `purpose`, `declaredIncome`,
`declaredDeductions`, `declaredExpenses`, `otherLenderLoans` (yes/no), `otherLenderCount`,
`consentProcessing` (**must be `yes`**), `consentBureau` (yes/no), `consentVersion`, and the
hidden honeypot `website` (must stay empty).

- **Required by the Worker:** `fullName`, `nationalId`, `phone`, `employer`, `kinName`, `kinPhone`,
  `purpose`, `repayDate` and processing consent. The old form's fields are translated too: `consent=yes`
  counts as processing consent (recorded as consent version `legacy-v0`), and a numeric `income` becomes
  the declared income (anything else is kept as `declared.income_text`).
- **The database checks everything again** (`intake_submit`). An amount, when sent, must be above N$0
  and at most the policy's maximum principal. A post from an old, cached copy of the form has no
  amount and is still accepted; the worksheet's G6 check flags it, and staff fill it in. Still, deploy the new
  `apply.html` before this Worker (see the runbook).
- **Limits** match the database, so a bad value is named in `fields` before anything is uploaded.
  Text is at most 120 characters (address and purpose 300, town and bank 80, job title 80, relationship 60,
  employment type and pay day 40). Email is at most 120 characters and the account number 4–30. Dependants
  and other-lender count are 0–50. Money is at most N$10,000,000 and the amount requested at most N$100,000.
  The date of birth can't be in the future.
- **Money** can be written `18400`, `18 400`, `18,400` or `N$18400.50`. A decimal comma (`18400,50`) is refused.
- **Files:** `docId` (exactly 1), `docPayslip` (exactly 1), `docBank` (1 to 6) and `docAddress` (0 or 1, optional).
  Each file can be up to **10 MB**, and all files together up to **40 MB**. The type is decided from the file's
  first 16 bytes, never from its name or the browser's claim. Accepted types are JPEG, PNG, WEBP, PDF and HEIC.
- **Order:** every field and file is checked **before anything is stored**. Documents are then
  written to `apps/<random upload id>/<kind>-<n>.<ext>` and `rpc/intake_submit` is called.
  - **Refused** (any `4xx` from Supabase except `408`/`409`, e.g. `QS_INVALID`, `QS_RATE_LIMIT`, a bad
    key): nothing was stored, so the uploaded files are deleted again.
  - **Unclear** (no answer, a `5xx` such as a gateway timeout, `408` or `409`): the database may have
    stored the application just before the connection failed. The Worker asks once more with the
    same payload; `intake_submit` answers a repeat of the same upload folder with the application it
    already stored, so the applicant gets their reference and no duplicate is made. If it is still
    unclear, the files are **kept** (a stored application may point at them), the Worker logs
    `{"event":"intake_unclear","keys":[…]}` (no personal data) and answers `500`. See
    "Unclear submissions" below.

| Status | Body | Meaning |
|---|---|---|
| `201` | `{ok:true, reference}` | Received (show the reference: "screenshot this") |
| `400` | `{error:"invalid", fields:[form names]}` | Missing or malformed fields/files, found by the Worker or by the database (its field list is translated to form names; `fields` may be absent) |
| `413` | `{error:"too_large", fields:[…]}` | A file over 10 MB (its form name), or `["documents"]` for over 40 MB in total |
| `415` | `{error:"unsupported_type", fields:[…]}` | A file that isn't a real JPEG/PNG/WEBP/PDF/HEIC |
| `429` | `{error:"rate_limited"}` | Too many applications from this connection. Try later (`Retry-After`) |
| `500` | `{error:"server_error"}` | Anything else. Never includes internal details |
| `403` | `{error:"forbidden"}` | The page's origin isn't in `ALLOWED_ORIGINS` |

### `GET /docs/:docId` — how the console opens a document
The console sends the signed-in user's Supabase access token. The Worker forwards it to
`rpc/doc_access`, which checks for an active staff member, writes `doc.viewed` to the audit log and
returns the R2 key. A `401`, `403` or `404` from Supabase is passed straight back. The file is streamed with:

- `Content-Type` = the whitelisted type (anything else → `application/octet-stream`)
- `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`
- `Content-Disposition: inline; filename="<kind>.<ext>"` for JPEG/PNG/WEBP/PDF, `attachment` for HEIC/other
- images also get `Content-Security-Policy: sandbox; default-src 'none'`

---

## Configuration

| Name | Kind | Value |
|---|---|---|
| `SUPABASE_URL` | var (wrangler.toml) | `https://ptlwhpvzyfpxtpghwlqs.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | var (wrangler.toml) | the `sb_publishable_…` key (public; the Worker refuses to run with a secret/service-role key here) |
| `ALLOWED_ORIGINS` | var (wrangler.toml) | comma list of exact origins allowed to call from a browser: `https://erastusm.github.io,https://quickserve.group,https://apply.quickserve.group,https://admin.quickserve.group`. GitHub Pages is where the console and form live today; the `quickserve.group` addresses are ready for the move to your own domain. (`*` = any site; don't.) The old single `ALLOWED_ORIGIN` var is still read if this is unset |
| `INTAKE_KEY` | **secret** | the credit desk's intake key (from Supabase, see below). Also keys the `ip_hash` |
| `OWNER_TOKEN` | **secret** | the old inbox password. Only for the legacy routes and `/legacy/migrate` |
| `DB` | D1 binding | legacy `quickserve-intake` database (old applications) |
| `DOCS` | R2 binding | `quickserve-docs` bucket (all documents, old and new) |

Secrets are set with `npx wrangler secret put <NAME>`. **Never** write them into `wrangler.toml`,
this README, a commit or a chat. Paste them only at the wrangler prompt.

---

## Unclear submissions

Rare: Supabase didn't answer, or answered with a gateway error, twice in a row. The Worker log
(`npx wrangler tail`, or Workers → quickserve-intake → Logs) then has a line like
`{"event":"intake_unclear","keys":["apps/<upload id>/id-1.jpg", …]}` and the applicant was asked to try
again. Check whether that upload folder became an application:

```sql
select ref, full_name, submitted_at from public.applications where upload_id = '<upload id>';
```

- **A row comes back:** it was stored. If the applicant sent it again, withdraw the duplicate in the
  console (the queue flags a duplicate ID).
- **No row:** nothing points at those files. Delete the `apps/<upload id>/` folder in the R2 bucket
  (Cloudflare dashboard → R2 → `quickserve-docs`).

---

## Deploying v2 (upgrade from the old Worker)

Run all commands from this `intake-worker/` folder. `npx wrangler` downloads Cloudflare's CLI on first use.

1. **Database first.** The credit-desk migrations (`supabase/migrations/…004_credit.sql`) must already
   be applied. Until they are, `intake_submit` doesn't exist and every submission would fail (safely,
   with a `500`, and the files would be cleaned up).
   **The new `apply.html` must be live before you deploy** (merge to `main`, CI green, Pages
   deployed). It works with the old Worker too, so that order is safe. See
   `docs/credit-desk/RUNBOOK.md` step 9.
2. **Create the intake key** in the Supabase SQL editor:
   ```sql
   select private.intake_rotate_key();
   ```
   Copy the value it returns and paste it **straight** into:
   ```bash
   npx wrangler secret put INTAKE_KEY
   ```
   (Rotate any time by running both steps again. The old key stops working immediately.)
3. **Check `wrangler.toml`**: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `ALLOWED_ORIGINS`, and the
   D1 `database_id` of your existing database.
4. **Deploy:**
   ```bash
   npx wrangler deploy
   ```
5. **Import the old applications once** (see below), then send a test application from `apply.html`
   and check that it appears in the console's credit queue.

`OWNER_TOKEN` is already set from v1. If you are starting fresh, set it with
`npx wrangler secret put OWNER_TOKEN` (a long random string).

### Import the old D1 applications (`POST /legacy/migrate`)
This copies every D1 application into the credit desk. `new` becomes `submitted`; `approved` and
`declined` become `archived`, so they are never booked twice. Their documents stay where they are in
R2. Each one is re-typed from its first 16 bytes, and anything that isn't a real image or PDF (for
example an uploaded web page) is left out and listed under `docs_skipped`. Rows are sent in batches
of 25. **Re-running is safe**, because references that already exist are skipped.

Use the console's **Import legacy applications** button, or from a terminal (the password is read
without echo, so it stays out of your shell history):
```bash
read -rs OWNER_TOKEN && curl -sS -X POST \
  -H "Authorization: Bearer $OWNER_TOKEN" \
  https://quickserve-intake.<your-subdomain>.workers.dev/legacy/migrate ; unset OWNER_TOKEN
```
It answers with `{"imported": N, "skipped": M}`.

### Retiring the old inbox (later)
Once the console has been used for a few weeks: delete `inbox.html`, remove the legacy routes and the
`DB` binding, delete the `OWNER_TOKEN` secret (`npx wrangler secret delete OWNER_TOKEN`) and the D1 database.
Keep the R2 bucket, because imported applications still point at their old documents.

---

## First-time setup (brand-new Cloudflare account)

1. `npx wrangler login` (free account at https://dash.cloudflare.com).
2. D1 (legacy only, needed while the old inbox exists):
   `npx wrangler d1 create quickserve-intake`. Copy the `database_id` into `wrangler.toml`, then run
   `npx wrangler d1 execute quickserve-intake --remote --file=./schema.sql`.
3. R2: `npx wrangler r2 bucket create quickserve-docs` (enable R2 once in the dashboard: Storage → R2).
4. Secrets: `npx wrangler secret put INTAKE_KEY` (step 2 above) and `npx wrangler secret put OWNER_TOKEN`.
5. `npx wrangler deploy`. It prints the Worker URL, e.g. `https://quickserve-intake.<sub>.workers.dev`.
6. Point the pages at it: in `apply.html` set `ENDPOINT` to `<worker-url>/applications`. In the admin
   console set `WORKER_BASE` to `<worker-url>`.
7. **WhatsApp auto-reply.** In the WhatsApp Business app, go to Settings → Business tools → Greeting message:
   > Thanks for contacting QuickServe Cashloan! To apply for a loan, please complete this
   > short form: https://erastusm.github.io/quickserve-cashloan-ledger/apply.html

## Local testing
```bash
node --test tests/worker/        # from the repo root: mocked R2, D1 and Supabase, no network
npx wrangler dev                 # run the Worker locally against Cloudflare's emulated D1/R2
```
`wrangler dev` reads secrets from `intake-worker/.dev.vars`. Use a throwaway test key there, never the
live `INTAKE_KEY`. The file is already in `intake-worker/.gitignore`; keep it that way.
If you use `wrangler dev` from a browser page, add that page's origin (e.g. `http://localhost:8080`)
to `ALLOWED_ORIGINS` for the local run only.

---

## Security notes
- **No service-role key anywhere.** Submissions use the publishable key plus `INTAKE_KEY`, which the
  database checks against a stored hash. Document access uses the viewer's own login, so row-level
  security and the staff check apply, and every view is audited.
- **Files are never trusted.** The type comes from the file's magic bytes (JPEG `FF D8 FF`, PNG `89 50 4E 47`,
  `RIFF…WEBP`, `%PDF-`, HEIC `ftyp` brands `heic/heix/mif1/msf1/hevc`). Everything else is refused
  with `415`. Stored objects get the sniffed type, and names are generated (`id-1.jpg`), not the
  uploader's file name.
- **Serving is inert.** `nosniff`, `no-store`, a sandbox CSP on images and `attachment` for anything
  a browser shouldn't render mean an uploaded web page can never run as a page on our origin. The
  legacy file route now uses the same headers, which closes the old inbox's document XSS hole.
- **Validate before write; clean up only what was refused.** Nothing reaches R2 unless the whole
  submission is valid. Files are deleted again only when the database definitely refused the
  application. Once it has accepted one, or might have, its files are never deleted.
- **No IP addresses are stored.** `ip_hash = hex(HMAC-SHA256(INTAKE_KEY, CF-Connecting-IP))` lets the
  database rate-limit (`QS_RATE_LIMIT` → `429`) without keeping the address.
- **Errors are generic.** Internal messages (`err.message`, Supabase errors) are never returned. Only the
  codes in the table above are.
- **Honeypot.** A filled `website` field gets a believable fake `201` and nothing is stored.
- **CORS is an allowlist.** Browser requests from any other origin get `403` and are not processed.
  A request without an `Origin` header (curl, servers) is allowed, but it still has to pass every other check.
- **Free-plan CPU (~10 ms).** Files are handed to R2 as streams. The Worker only ever reads 16 bytes
  of a file (no hashing, no copying), and requests declaring more than 41 MB are refused before parsing.
- **Retention.** Consider how long you keep documents, and cover intake and retention in your
  NAMFISA and data-protection compliance.
