# QuickServe Admin Console — the credit desk and the loan book

A single self-contained web page (`index.html`): no build step, no server, no
framework and no external dependencies (the typeface is embedded). Staff sign
in with their own Supabase login. The page asks the database who they are
(`whoami`) and shows only what their role may use.

- **Credit desk** (owner and credit analyst): loan applications from the
  website, worked the way a bank does it. The analyst verifies and recommends.
  Only the owner approves, declines and pays out.
- **Loan book** (owner only): the same ledger the phone app writes. It covers
  clients, loans, payments, expenses, reports and projections, with full
  create, edit and delete.
- **Control** (owner only): Team & access, the Audit trail and the Credit
  policy.

The rules live in the database (Postgres row-level security and RPCs), not in
this page. Hiding a menu item is a convenience; the database is what refuses
an analyst the loan book. The full specification is
[`../docs/credit-desk/CONTRACT.md`](../docs/credit-desk/CONTRACT.md).

```
Applicant ─► apply form ─► intake Worker ─┬─► R2 (documents)
                                          └─► Supabase: applications
Owner / analyst ─► this console ─► Supabase RPCs (queue, worksheet, decision, booking)
                                └─► Worker GET /docs/<id> (the person's own login token)
Owner "Book" ─► app_disburse ─► client + loan added to the ledger ─► phone app syncs
```

## What each page does

### Credit desk

- **Credit queue** (`#credit`, tabs `#credit/submitted` … `#credit/closed`)
  - Every open application, with a count on each tab and a search over name,
    ID number and reference.
  - Flags on each row: *Returning* (matched to a client by ID number), *New
    client*, *Duplicate ID*, *Hard fail*, *Above limit* and late loans.
  - Waiting time turns amber after 24 hours, the SLA in the credit policy.
  - Row actions:
    - *Pick up*: the file becomes yours.
    - *Decide* (owner): opens the approval screen.
    - *Pay out* (owner): opens Ready to disburse.
    - Otherwise *Open*.
- **Application file** (`#app/<id>`)
  - Identity and KYC checks:
    - ID number format and date of birth.
    - Age against the policy.
    - Duplicate open applications.
    - Returning borrower.
    - Shared phone numbers.
    - Two staff confirmations: the name on the ID matches, and the employer
      has been confirmed. These are saved as staff notes that start
      "KYC check: …", so they show in Notes, the Timeline and the Audit trail
      with who confirmed and when.
  - The application as submitted. The bank account number stays masked until
    you click *show*.
  - The documents. Every view is logged. Images open in the page and full
    size. PDFs open in a new tab. Anything else can only be downloaded.
  - The borrower's own history with QuickServe.
  - Notes and the timeline.
  - WhatsApp messages (asking for documents, approval, decline) with a
    preview, and *Mark as told*.
  - The buttons at the top come only from what the database says you may do
    on that file right now (`allowed_actions`):
    - pick up
    - ask for documents
    - back in review
    - correct details
    - recall
    - withdraw (with a reason)
    - reopen (owner)
    - decide (owner)
    - pay out (owner)
- **Affordability worksheet** (`#worksheet/<id>`)
  - The paper worksheet (documents pack 03), sections 1–9: documents
    examined, credit bureau, income A1–A8, commitments B1–B12, living costs
    C1–C13, bank-statement warning signs, the loan E1–E10, conduct checks
    G9–G11, and your recommendation.
  - The live result (D1–D6, F1–F5) and the rules list (Hard / Owner / Soft)
    update as you type. The maths is the same as the database's, to the cent.
  - It saves as you type.
  - B8 (the applicant's QuickServe balance) is filled in from the ledger and
    can't be edited.
  - Sending it for approval needs every line filled in, your reasons (at
    least 60 characters) and the declaration 12.1–12.7.
  - *Motivate for approval above the limit* appears only when the repayment is
    above the limit (an owner-class rule fails) and no hard rule fails. It
    needs a written motivation of at least 60 characters.
- **Approval** (owner, `#approval/<id>`)
  - Shows:
    - The analyst's recommendation and reasons, with the motivation when it
      goes above the limit.
    - The affordability figures.
    - The rules that fail.
    - A snapshot of the borrower.
  - You can:
    - Approve as recommended.
    - Approve a different amount. It is re-checked live.
    - Return the file to the analyst with a note.
    - Decline. The applicant is given one of four reasons, and your own
      reasons are kept on the file.
  - A hard fail blocks approval. Going above the limit needs the analyst's
    motivation and your override note (at least 20 characters). So do soft
    fails.
  - If the worksheet changed while you were reading it, the database refuses
    the decision (`QS_STALE`) and you reload the file.
- **Ready to disburse** (owner, `#disburse`)
  - Approved applications waiting for cash.
  - For each one:
    - Payout dates.
    - The client match: the existing client found by ID number, a choice when
      several share the ID, or a new client.
    - Payout method, plus a reference unless it was cash.
    - The pre-payout checklist 13.1–13.10. The *Book* button stays locked
      until the checklist is complete.
  - Booking adds the client and the loan to the ledger in one step
    (`app_disburse`). The console then reloads the loan book, so Clients and
    Loans show the new loan at once. The phone app picks it up on its next
    sync.

The rail badges count open applications, files awaiting your approval and
approved loans ready to pay out. The owner's Dashboard lists the last two under
*Attention* and links to them.

### Loan book and control (owner)

- **Dashboard, Clients, Loans, Payments, Expenses, Reports, Projections**
  work as before, on the shared ledger.
  - Every write is rev-guarded, so a change made on the phone at the same
    moment is merged, never overwritten.
  - CSV exports defuse spreadsheet formulas.
- **Team & access**: add a login as a credit analyst or owner, and deactivate
  or reactivate people.
- **Audit trail**: every action by everyone, filterable and exportable. Nobody
  can edit or delete it.
- **Credit policy** (on Team & access and in Settings): the repayment share
  (D5, 70 %), charges cap, largest loan (N$100,000), longest term (5 months)
  and the rest. Every change is logged with the old and new value.
- **Settings**:
  - The live ledger status.
  - Export & backup.
  - A one-time **Import applications from the old inbox** button.
- **My account** (everyone): change your own password.

## Roles

| | Credit analyst | Owner |
|---|---|---|
| Credit queue, pick up, ask for documents, notes, WhatsApp | ✓ | ✓ |
| View documents and the applicant's own history (both logged) | ✓ | ✓ |
| Worksheet: fill in, send for approval, recall | ✓ (files they picked up) | ✓ |
| Withdraw spam or duplicates (with a reason) | ✓ | ✓ |
| Approve, decline, return, approve above the limit | — | ✓ |
| Pay out and book into the ledger | — | ✓ |
| Loan book, cash, reports (the ledger) | — | ✓ |
| Team, credit policy, audit trail, legacy import | — | ✓ |

An analyst's console shows only **Credit queue** and **My account**. It never
requests the ledger (`/rest/v1/ledger`), and the database would return nothing
if it did. A login without an active staff row sees "Your login isn't enabled
for the credit desk — ask the owner." and is signed out.

## Giving the credit analyst access

Follow [`../docs/credit-desk/RUNBOOK.md`](../docs/credit-desk/RUNBOOK.md),
**Step 11: Add the credit analyst**. In short:

1. In Supabase, go to **Authentication → Users → Add user**. Tick *Auto
   Confirm User* and hand over the temporary password in person.
2. In this console, go to **Team & access → Add**. Use the same email, their
   full name and the role **Credit analyst**.
3. They sign in and change the password under **My account**.

The credit desk needs migrations 002–004 and the rest of the runbook done
first, steps 1–10. Before 004 is run, the loan-book pages keep working, and the
credit pages say they aren't set up on the server yet.

## Where it lives: moving to `admin.quickserve.group`

Today the console is published with the rest of this repository on GitHub
Pages: **`https://erastusm.github.io/quickserve-cashloan-ledger/admin/`**. Its
long-term home is **`https://admin.quickserve.group`**, one of the origins the intake Worker
accepts (`ALLOWED_ORIGINS` in
[`../intake-worker/wrangler.toml`](../intake-worker/wrangler.toml)). The
Worker refuses other origins. From anywhere else, viewing documents and the
legacy import fail with `403`, even though sign-in and the queue still work.

GitHub Pages is on the allowlist too.

To host it on the new subdomain once you have hosting (Hostinger shown; any
static host with HTTPS works):

1. **Domains → Subdomains → Create**. Subdomain `admin`, domain
   `quickserve.group`. Note the document root, usually `public_html/admin`.
2. **Files → File Manager**. Open that folder and upload **`index.html`**.
3. Wait for the free SSL certificate (**Security → SSL**). The console needs
   `https://`.
4. Open `https://admin.quickserve.group` and sign in.
5. Once it works there, tell staff the new address. GitHub Pages keeps
   publishing the same build until you retire it.

If you ever serve it from another address, add that exact origin to
`ALLOWED_ORIGINS` and run `npx wrangler deploy`. The page's Content Security
Policy only lets it talk to the Supabase project and the intake Worker. If
either address changes, update the `connect-src` line near the top of
`index.html` together with `SB` / `WORKER_BASE` in the config block.

## Sessions and security

- **The console has its own session** (`quickserve_admin_session_v1`).
  - Signing out ends only this browser's session. The phone app's sync
    session on the same login is not touched, and neither is its own key
    (`quickserve_cloud_v1`) on the GitHub Pages origin.
  - The console signs out after **20 minutes** without activity, including
    when it is reopened later.
- **Documents are fetched from the Worker with the person's own login.**
  - The console re-types the file as JPEG, PNG, WEBP, PDF or HEIC before
    showing it. Anything else is only ever downloaded, so an uploaded web page
    can never run inside the console.
  - Every view is recorded in the audit trail.
- **Every applicant-provided text is escaped before it is shown.** CSV
  exports prefix cells that start with `= + - @`, so a spreadsheet can't run
  them.
- **The only key in the file is the Supabase publishable key**
  (`sb_publishable_…`), which is designed to be public. Never put an
  `sb_secret_…` or service-role key in this file.
- **The legacy import never saves the old inbox password.**
  - It is held in the open page's memory only, so a second run in the same
    session doesn't ask again. Signing out (or the idle sign-out) forgets it.
  - That password also opens the old inbox's owner-only routes, so the
    console removes any copy saved in this browser (`qs_owner_token`, left by
    the old console's Applications tab or by `inbox.html`). It does this when
    the page loads, at every sign-in and at sign-out.
  - If you still use the old `inbox.html` on the same address, it will ask
    for its password again after you use the console. `inbox.html` itself
    still saves the password until it is retired, so don't use it on a
    shared computer.

## Updating the console

Re-upload `index.html` and do a hard refresh (Ctrl/Cmd-Shift-R). Data, logins
and applications are untouched.

## Tests

With Node 22 and Playwright (Chromium):

```bash
NODE_PATH=/path/to/node_modules node tests/ui/admin-core.test.js    # session, roles, team, audit, policy, maths
NODE_PATH=/path/to/node_modules node tests/ui/admin-credit.test.js  # queue, file, worksheet, approval, disburse
```

Both serve the repository locally and stand in for Supabase and the Worker.
The credit tests use realistic responses from
[`../tests/fixtures/rpc-mocks.json`](../tests/fixtures/rpc-mocks.json).

## Files

- **`index.html`**: the entire console (HTML, CSS and JS in one file). The
  `<script id="credit-calc">` block is the worksheet maths (`QSCredit`). It
  is kept pure so tests can run it against
  `tests/fixtures/credit-cases.json`.
