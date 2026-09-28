# QuickServe cloud sync and credit desk: Supabase setup

The app works fully offline on one phone with no setup. These steps turn on
**cloud sync**: the loan book is backed up off-device and shared between two
phones. They also set up the database for the **credit desk**, where applications
are assessed, approved and paid out. Do them once.

## What's in this folder

| File | What it does |
|---|---|
| [`schema.sql`](./schema.sql) | Migration 001: the shared `ledger` row the phone app syncs. |
| [`migrations/002_staff_audit.sql`](./migrations/002_staff_audit.sql) | The team (`staff`: owner / credit analyst), role checks, and the append-only audit trail. It also records every ledger save. |
| [`migrations/003_ledger_lockdown.sql`](./migrations/003_ledger_lockdown.sql) | Only an **active owner** may read or write the ledger. `.down.sql` undoes it. |
| [`migrations/004_credit.sql`](./migrations/004_credit.sql) | Credit desk: applications, documents, worksheets, decisions, the credit policy, and all the RPCs. `.down.sql` undoes it. |

Run them in order in **Dashboard → SQL Editor**, each file whole. They refuse
to run twice or out of order, and each one is a single transaction.

**Going live with the credit desk?** Follow
[`docs/credit-desk/RUNBOOK.md`](../docs/credit-desk/RUNBOOK.md) step by step.
It covers the backup, turning off sign-up, seeding the owner, the intake key
and the Worker. The rules the database enforces are in
[`docs/credit-desk/CONTRACT.md`](../docs/credit-desk/CONTRACT.md).

## 1. Rotate your secret key (security: do this first)

If you ever pasted the `sb_secret_…` key anywhere, replace it now:
**Project Settings → API keys → rotate the secret key.** Nothing here uses a
secret or service-role key, so nothing breaks. Only the **publishable** key
(`sb_publishable_…`) belongs in the app, the console and the Worker, and it's
already wired in.

## 2. Create the database

**Dashboard → SQL Editor → New query**, paste all of [`schema.sql`](./schema.sql),
and press **Run**. You should see "Success". Then apply the migrations as
described in the runbook.

## 3. Set up the logins

**Turn off "Allow new users to sign up"** (Authentication → Sign In /
Providers). Then create each login yourself under **Authentication → Users →
Add user**, with a password and "Auto Confirm User" ticked.

Every login that syncs the phone app must be an **owner**:

```sql
select private.seed_owner('you@example.com', 'Your Name');
```

Credit analysts are added from the console's **Team & access** page. After
migration 003, a login that isn't an active owner can't see the loan book at
all.

## 4. Turn it on in the app

1. Open the app, go to the **Reports** tab and scroll to **Cloud sync**.
2. On your **main phone** (the one with all the loans), sign in first. It
   uploads your current book to the cloud, and you'll see "Backed up to the
   cloud."
3. On the **second phone**, sign in with the other owner login. It pulls the
   book down. From then on, saving on either phone syncs to both.

## How it works and good to know

- The whole loan book is stored as one JSON document (`ledger.data`) and
  synced as a unit. This is simple and reliable for a small business.
- **If two devices edit at once**, the app never overwrites newer cloud data.
  A phone with older data is asked to **Sync now**, which replaces the
  phone's copy with the cloud's. It does **not** merge: a change made on that
  phone and not yet synced drops out of the loan book (it is kept only in a
  hidden recovery copy). A payout booked from the credit desk is a newer
  version too, so sync the phone before booking and don't record on it until
  the booking is done. See the runbook, "Paying out while the phone app is in
  use".
- Offline working is unchanged: edits save on the phone and go to the cloud
  when there's a connection.
- Row-level security keeps the loan book to owners. The credit tables are
  readable by staff but writable only through the database functions, which
  check the caller's role and record every action in the audit trail. The
  sender's IP hash and the document storage keys are not readable at all.

## Testing the database locally

`node tests/sql/run.js` builds a throwaway PostgreSQL (15+) with a small
Supabase stand-in, applies `schema.sql` → 002 → 003 → 004, and runs every
`tests/sql/t_*` test in a fresh copy. It needs only the PostgreSQL server
binaries (`/usr/lib/postgresql/<n>/bin`, or set `PG_BIN`), and it never
touches your real project.
