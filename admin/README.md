# QuickServe Admin Console — deploy to `admin.quickserve.global`

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
- **Reports** — monthly cashflow (advanced vs collected, net flow) and borrower
  concentration, with a *Print statement* button that renders a clean document.
- **Applications** — the intake inbox, read through the Worker's owner token.
- **Settings** — the registered entity, lending parameters, and the live status
  of the cloud ledger and intake service.

Nothing lives in this file but code: every figure is pulled live from Supabase at
sign-in.

```
Browser (admin.quickserve.global)
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
3. A **Hostinger** plan and the **quickserve.global** domain.

No new accounts, no new keys. The console is already pointed at your project.

## 1. Upload the file to Hostinger

You are putting one file on a subdomain. In **hPanel**:

1. **Domains → Subdomains → Create.** Subdomain: `admin`, domain:
   `quickserve.global`. Note the **document root** it creates, usually
   `public_html/admin`.
2. **Files → File Manager**, open that `admin` folder.
3. Upload **`index.html`** from this folder into it. That's the whole app.

Hostinger issues a free SSL certificate for the subdomain automatically
(**Security → SSL** if it doesn't appear within a few minutes). Wait for it —
the console needs `https://` to talk to Supabase.

> **DNS:** because the subdomain is created inside Hostinger and the domain's
> nameservers point at Hostinger, the record is added for you — nothing to type.
> If `quickserve.global` uses external nameservers (e.g. Cloudflare), add a
> **CNAME** `admin → your-hostinger-target` (hPanel shows the target), or the
> **A** record Hostinger lists for the subdomain.

Open **https://admin.quickserve.global** — you should see the sign-in card.

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

Two services must accept requests coming from `https://admin.quickserve.global`:

- **Supabase** allows browser requests from any origin on its REST and Auth
  endpoints when you send the publishable `apikey` (which the console does), so
  there is nothing to configure. Access is still gated by login + the table's
  row-level security — the key alone reads nothing.
- **The intake Worker** is set to `ALLOWED_ORIGIN = "*"` in
  [`../intake-worker/wrangler.toml`](../intake-worker/wrangler.toml). Owner
  endpoints are gated by the token regardless of origin and the apply form is
  public, so `*` is safe. To tighten it once this is your only admin origin, set
  `ALLOWED_ORIGIN = "https://admin.quickserve.global"` and
  `wrangler deploy`. (Leaving it `*` keeps the old GitHub-Pages inbox working
  too — set a single origin only if you want to retire that.)

## Updating the console later

Re-upload `index.html`, replacing the old one. There is no cache-busting to
worry about — it's one file; a hard refresh (Ctrl/Cmd-Shift-R) shows the new
build. Everything else (data, logins, applications) is untouched.

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
