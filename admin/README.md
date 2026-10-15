# QuickServe Admin Console

**Where it lives:** **https://admin.quickserve.group**, served by **Hostinger**
like the rest of quickserve.group (see *1. Hosting on Hostinger* below). Every push
to `main` publishes the console to two places:

- the **`hostinger` branch**, which Hostinger's Git deployment pulls into the
  `admin` subdomain (this is the address to use, on Wi-Fi and mobile data); and
- **GitHub Pages** at `https://erastusm.github.io/quickserve-cashloan-ledger/`,
  kept as a backup address. Some mobile networks block or intercept
  `*.github.io`, which shows as "connection is not secure" on mobile data only,
  so don't rely on it away from Wi-Fi.

Only the console is published (`site/assemble.sh`); the phone app, apply form
and old inbox stay in the repository but are not online.

A single self-contained web page (`index.html`) — no build step, no server, no
framework, and no external dependencies (the typeface is embedded). It signs in
against your existing Supabase project, reads the same loan-book ledger the phone
app writes, and presents it as an institutional statement on a full desktop
screen:

- **Dashboard** — a *Statement of Position* (cash, out on loan, total funds,
  receivable), a portfolio panel with the book's composition, this month's
  cashflow, and an *Attention* list (loans due, overdue, single-borrower
  concentration, and clients missing a National ID).
- **Clients / Loans / Payments** — searchable, filterable registers. Click any
  row to open a full drill-down: a client's whole borrowing history and KYC, or a
  loan's terms, schedule and payments.
- **Full CRUD on the loan book** — create, edit and delete clients and loans,
  and record or delete payments, all writing straight to the shared cloud
  ledger:
  - *New client* / *New loan* buttons and, inside each drawer, *Edit* and
    *Delete*; a loan drawer also has *Record payment*, and each payment can be
    removed.
  - Same validation the phone app enforces: required phone + ID, the 30%
    cost-of-credit cap, sane dates. Deleting a client is blocked while it still
    has loans; deleting a loan also removes its payments.
  - Every write is **rev-guarded** — a change made on the phone at the same
    moment is merged, never overwritten — and syncs back to the phone app.
- **Accounts** — the float split across your bank accounts (e.g. two FNB
  accounts). Each loan payout, repayment, expense and capital entry belongs to
  an account; **transfers** move money between them without changing total
  funds. Per-account **statements** with running balances, **reconcile**
  against the bank's balance (with one click to book bank charges), and
  **money in / out** for capital you put in or take out. Records from before
  accounts existed belong to the first (original) account.
- **Rollovers, write-offs and reminders** — roll a loan over (adds another
  interest cycle and moves the due date, exactly like the phone app did),
  write a loan off or reopen it, and open a prefilled WhatsApp payment
  reminder. Rollover interest is included in every balance.
- **Collections** — arrears ageing (not yet due, 1–30, 31–60, 61–90, 90+ days)
  with an optional provision for doubtful loans (rates start at 0% — set them
  under Collections → Provision rates; when above zero it shows on the dashboard
  as "total funds after provision"), a work list of overdue loans, a contact
  log per loan and **promises to pay** that show as due today / kept / broken.
- **Company letterhead** — the QuickServe Cashloan logo on the console header
  and sign-in page, and a full letterhead on every printout (statement of
  position, portfolio report, profit & loss): logo, legal name, CC and NAMFISA
  registration numbers, physical and postal address, cell, WhatsApp and email,
  with a "printed on … by …" footer. Printouts always use the light palette,
  even when the screen is in dark mode. The details live under **Settings →
  Company details → Edit** (saved in the book, so every device prints the
  same); add the NAMFISA registration number there once you have it.
- **Credit score** — every client gets a score out of 100 and a grade
  (A excellent · B good · C fair · D weak · E high risk; *New* when there is no
  history yet), worked out from how they have repaid QuickServe: loans repaid
  on time or late, rollovers, broken promises to pay, loans overdue now and
  write-offs, with anything older than 12 months counting half. The client
  drawer shows each reason and its points plus a **suggested next loan**
  (based on the largest loan they repaid within 30 days of the due date, scaled
  by grade, less what they still owe). The new-loan form shows the grade and
  asks for confirmation above the suggestion; Reports shows the open book by
  grade; the clients CSV includes score, grade and suggestion. It is a guide
  only — it never blocks a loan, uses nothing personal (age, gender, employer,
  address), and is worked out from the book each time (nothing is stored).
  *How the score works* in the console lists every rule.
- **Profit & loss** — monthly, cash basis: interest and fees collected
  (repayments pay interest first, like the phone app), expenses by category,
  bad debts written off, net profit and margin; last 12 months, by year or all
  time; CSV and print.
- **History & backups** — every save is recorded by the database (who, when,
  exactly what changed, full details of anything deleted) and the book from
  before each of the last 300 saves can be downloaded or restored. Restore from
  a backup file, a reminder when no backup has been downloaded for 7 days, and
  automatic sign-out after 20 minutes without activity. Needs
  `supabase/migrations/010_ledger_history.sql` run once (see below).
- **Expenses** — record, edit and delete business expenses (category, amount,
  date, note), with this-month / monthly-average / total tiles. Expenses net
  off cash on hand and set the default *monthly costs* in Projections.
- **Reports** — monthly cashflow (advanced vs collected, net flow) and borrower
  concentration, with a *Print statement* button that renders a clean document.
- **Projections** — a cash-flow outlook that mirrors the app's model: recovery,
  re-lend rate, monthly costs and horizon are adjustable, with a working-capital
  vs cash chart and a month-by-month table so you can see where the book is
  heading.
- **Applications** — the intake inbox, read through the Worker's owner token.
- **Settings** — the registered entity, lending parameters, the live status of
  the cloud ledger and intake service, and **Export & backup**: download the
  live book as a JSON backup (same format as the phone app, so it re-imports
  there) or as clients / loans / payments CSVs.

Nothing lives in this file but code: every figure is pulled live from Supabase at
sign-in.

```
Browser (admin.quickserve.group)
      │  sign in (email + password)
      ▼
  Supabase  ──►  ledger row (clients, loans, payments)   ← same data as the phone app
      │
      └─►  intake Worker  ──►  loan applications (Applications tab)
```

## What you need first

You already have these from setting up the phone app — reuse them:

1. **Supabase project** with the `ledger` table and at least one user login
   (see [`../supabase/README.md`](../supabase/README.md)). The console uses the
   same project URL and **publishable** key that are wired into the app.
2. **Intake Worker** deployed (see [`../intake-worker/README.md`](../intake-worker/README.md)).
   Only needed for the Applications tab.
3. A **Hostinger** plan and the **quickserve.group** domain.

No new accounts, no new keys. The console is already pointed at your project.

## 1. Hosting on Hostinger (works on mobile data)

The `hostinger` branch always holds the latest published console (index.html,
404.html, sw.js and an `.htaccess` that forces https, blocks the `.git` folder
and stops browsers caching an old version). Connect it once in **hPanel**:

1. **If you pointed `admin` at GitHub before:** in **Domains → DNS**, delete
   the `CNAME admin → erastusm.github.io` record; in GitHub **Settings → Pages**,
   remove the custom domain (the github.io address then keeps working as a
   backup).
2. **Domains → Subdomains → Create** `admin` for `quickserve.group` (skip if it
   exists). Open its folder (usually `public_html/admin`) in **File Manager**
   and delete anything Hostinger put there; Git needs an empty folder.
3. **Websites → quickserve.group → Advanced → GIT → Create a new repository:**
   repository `https://github.com/ErastusM/quickserve-cashloan-ledger.git`,
   branch `hostinger`, directory `admin` (the subdomain's folder). **Create**,
   then **Deploy**.
4. Same page → **Auto Deployment → copy the Webhook URL**. In GitHub
   **Settings → Webhooks → Add webhook**, paste it as the Payload URL and save
   (push events only). From then on every console update reaches Hostinger by
   itself within a minute.
5. **Security → SSL:** check `admin.quickserve.group` has a certificate (free;
   install it if not), then open **https://admin.quickserve.group** on mobile
   data.

If Git deployment isn't available on your plan, upload the files from the
`hostinger` branch (GitHub → branch `hostinger` → Code → Download ZIP) into the
subdomain folder with **File Manager** instead; repeat after updates.

## 2. Sign in

Use one of the Supabase logins you created for the app
(**Authentication → Users** in Supabase). The console shares the browser
session with nothing else on that domain; signing out clears it.

If sign-in fails with a network/CORS error, see the box below.

## 3. Connect the Applications inbox (optional)

Open the **Applications** tab. The first time, it asks for the **owner
password** — the same `OWNER_TOKEN` you set on the intake Worker
(`wrangler secret put OWNER_TOKEN`). It's stored in this browser only and sent
as a bearer token to the Worker. Enter it once and applications load.

## CORS — why it already works, and how to lock it down

Two services must accept requests coming from `https://admin.quickserve.group`:

- **Supabase** allows browser requests from any origin on its REST and Auth
  endpoints when you send the publishable `apikey` (which the console does), so
  there is nothing to configure. Access is still gated by login + the table's
  row-level security — the key alone reads nothing.
- **The intake Worker** is set to `ALLOWED_ORIGIN = "*"` in
  [`../intake-worker/wrangler.toml`](../intake-worker/wrangler.toml). Owner
  endpoints are gated by the token regardless of origin and the apply form is
  public, so `*` is safe. To tighten it once this is your only admin origin, set
  `ALLOWED_ORIGIN = "https://admin.quickserve.group"` and
  `wrangler deploy`. (Leaving it `*` keeps the old GitHub-Pages inbox working
  too — set a single origin only if you want to retire that.)

## Updating the console later

Nothing to do: merging a change into `main` republishes both copies (GitHub
Pages and, through the `hostinger` branch and its webhook, Hostinger). Reload
the page to get the new build. Data, logins and applications are untouched.

## Security notes

- The page carries `<meta name="robots" content="noindex">` so search engines
  skip it, and it's on a subdomain nobody is told about. The real protection is
  the **login** — use strong, unique passwords for each Supabase user.
- The only key baked into the file is the **publishable** key, which is
  designed to be public. Never put a `sb_secret_…` key in this file.
- The owner password for the Applications inbox is stored in the admin's
  browser (`localStorage`), never in the file. On a shared computer, sign out
  and clear site data when done.

## Files

- **`index.html`** — the entire admin console (HTML + CSS + JS in one file).

The config block near the top of `index.html` holds the public Supabase URL,
the publishable key, and the Worker base URL. Change those only if you move
projects.

## Switching on history (once)

In Supabase: **SQL Editor → New query**, paste the whole of
[`../supabase/migrations/010_ledger_history.sql`](../supabase/migrations/010_ledger_history.sql)
and press **Run**. It adds the version history and the change log and doesn't
touch any loan-book data; running it again is harmless. Until it's run, the
History page shows these instructions and everything else works as before.
