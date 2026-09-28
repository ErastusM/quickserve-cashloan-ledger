# Credit Desk go-live runbook (owner)

This is the step-by-step for switching on the credit desk in your Supabase
project. Follow it in order and tick each step as you go. It takes about an
hour. Every step can be undone; the undo is at the end of each step.

**You need:**

- a laptop with the Supabase dashboard open (your project) and a terminal
  in the `intake-worker/` folder of this repo (`npx wrangler login` done);
- your phone with the QuickServe app, signed in to cloud sync;
- the SQL files from this repo: `supabase/migrations/002_staff_audit.sql`,
  `003_ledger_lockdown.sql` and `004_credit.sql` (plus the `.down.sql` files,
  in case you need to undo).

**Golden rules:**

- **Never paste a key or password into a chat, an email, a ticket or a
  file.** The only secret made here (the intake key) goes straight from
  the SQL editor into `npx wrangler secret put INTAKE_KEY` in your own
  terminal.
- Run each SQL file **whole**: open a new query in the SQL editor
  (Dashboard → SQL Editor → New query), paste the entire file and press
  **Run**. Each file runs as one transaction. If it fails, *nothing* has
  changed. Read the message, fix what it says and run it again.
- The files refuse to run twice or out of order, so re-running one by
  mistake is harmless.

---

## Step 1: Back up the ledger (2 copies)

1. **JSON export.** In the admin console go to **Settings → Export &
   backup → Download backup (.json)**. Keep the file somewhere private.
   It can be restored on the phone (**Reports → Restore**).
2. **A copy inside the database.** It goes in a schema the website can't
   reach. In the SQL editor, run this (change the date):

   ```sql
   create schema if not exists backup;
   revoke all on schema backup from public, anon, authenticated;
   create table backup.ledger_20261001 as select * from public.ledger;
   revoke all on all tables in schema backup from public, anon, authenticated;
   select id, rev, updated_at, updated_by,
          jsonb_array_length(data -> 'clients') as clients,
          jsonb_array_length(data -> 'loans')   as loans
   from backup.ledger_20261001;
   ```

   Check that the client and loan counts match what the phone shows.

**Undo / restore:** see "Restoring the ledger from the backup" at the end.

## Step 2: Pre-flight check: who can log in?

Run:

```sql
select email, created_at, last_sign_in_at from auth.users order by created_at;
select id, rev, updated_at, updated_by from public.ledger;
```

- `updated_by` is the login that last saved the book, normally the phone
  app's. It should be **erastusmatheus3@gmail.com**.
- Every login in the list that **should keep full access to the loan book**
  (for example a second phone that syncs) must become an **owner** in step
  5. Any other login loses access to the ledger in step 6. That is the
  point of this change.
- If a login you don't recognise is in the list, delete it now
  (**Authentication → Users → … → Delete user**).

## Step 3: Turn off public sign-up

**Authentication → Sign In / Providers → "Allow new users to sign up" →
off → Save.**

From now on only you create logins, in **Authentication → Users → Add
user**. The phone app's "Create account" button stops working, which is
intended.

**Undo:** switch it back on. This is not recommended.

## Step 4: Run migration 002 (staff and the audit trail)

Paste all of `supabase/migrations/002_staff_audit.sql` and press **Run**.
You should see "Success. No rows returned".

This adds the team table, the role checks and the append-only audit trail.
It also starts recording every ledger save: who saved, the version number,
and how many records changed. **Nothing changes for the phone app yet.**

**Undo** (only if you also undo steps 6 and 7 first). This permanently
deletes the audit trail:

```sql
begin;
drop trigger if exists ledger_audit on public.ledger;
drop function if exists public.is_staff(), public.is_owner(), public.staff_role();
drop table if exists public.audit_log, public.staff;
drop schema if exists private cascade;
commit;
```

## Step 5: Make yourself the owner

```sql
select private.seed_owner('erastusmatheus3@gmail.com', 'Erastus Matheus');
```

It answers with your row (`"role": "owner", "active": true`). If it says
*"No Supabase login exists for …"*, create that login under
**Authentication → Users** first, or check the spelling.

Repeat this for every other login that must keep syncing the phone app (step 2).
Then check:

```sql
select email, full_name, role, active from public.staff;
```

**Undo:** `delete from public.staff where email = '…';`. Only do this before
step 6, or you lock that login out of the ledger.

## Step 6: Run migration 003 (lock the ledger to owners)

Paste all of `supabase/migrations/003_ledger_lockdown.sql` and press
**Run**.

It refuses and changes nothing if:

- *"No active owner yet"*: do step 5 first.
- *"The ledger was last saved by X who is not an active owner"*: seed X as
  an owner (step 5) if that phone should keep syncing. Otherwise sync once
  from your own phone, so that you are the last saver. Then run it again.

**Check straight away:**

1. On your phone, go to **Reports → Cloud sync → Sync now**. It must say
   it's up to date or synced.
2. The admin console loads the loan book as before.

After this step only an **active owner** can read or change the ledger. The
analyst, deactivated people and any other login see nothing.

**Undo:** paste and run `supabase/migrations/003_ledger_lockdown.down.sql`.
It puts back the old rule, where *every* login can use the ledger. For
that reason it refuses while an analyst login exists. Delete the analyst's
login under **Authentication → Users** first (you can add them back
later).

## Step 7: Run migration 004 (the credit desk)

Paste all of `supabase/migrations/004_credit.sql` and press **Run**.

This adds applications, documents, worksheets, decisions, notes, the
credit policy and all the credit-desk functions. The policy starts with
the values you confirmed:

| Setting | Value |
|---|---|
| Most one repayment may take (D5) | 70% of disposable income |
| Above the limit | Only if the analyst motivates it and you override |
| Default interest / fee | 30% once-off / N$0 |
| Charges cap | 30% of principal |
| Largest loan | N$100,000 |
| Longest term | 5 months |
| Credit bureau | Not required (no subscription yet) |
| Warning signs threshold | 2 |
| Rounding step | N$50 |
| Applicant age | 18–70 |
| Pick-up and approval targets | 24 h / 24 h |
| Idle sign-out | 20 minutes |

**Undo:** `supabase/migrations/004_credit.down.sql`. It deletes every
application, so it refuses while any exist. First export them (Table
editor → `applications` → Export to CSV). Then add this line above
`begin;` and run it again:

```sql
set qs.confirm = 'drop-credit-data';
```

The ledger, the team and the audit trail are kept.

## Step 8: Create the intake key and give it to the Worker

1. In the SQL editor:

   ```sql
   select private.intake_rotate_key();
   ```

   It shows a long random key **once**. The database keeps only a
   fingerprint of it (a sha256 hash), so it can never show it again.
2. In **your own terminal**, in the `intake-worker/` folder:

   ```bash
   npx wrangler secret put INTAKE_KEY
   ```

   Paste the key when it asks, press Enter, then close the SQL editor tab.
   **Don't paste it anywhere else.**

**Rotate** (if the key may have leaked, or just yearly): do both steps
again. The old key stops working the moment you run the query, so do step 2
right away. Until then, applications from the website fail safely: nothing
is stored and the applicant sees an error.

## Step 9: Publish the new pages, then deploy the Worker

The order matters. The new application form works with the old Worker too, so
it goes live first. The new Worker only goes live once the new form is up.

**9a. The new form and console.**

1. On GitHub, merge the credit-desk pull request into `main`.
2. Open **Actions → Deploy to GitHub Pages** and wait for the run on `main`.
   Both jobs, **test** and **deploy**, must be green. If **test** fails,
   nothing is published: stop here and have it fixed.
3. Open the apply page on your phone (reload it once) and check that it is the
   new form. Its first card is **The loan**, which asks for the amount.
4. Open the console at
   `https://erastusm.github.io/quickserve-cashloan-ledger/admin/` (reload it
   once). Pages published the new build in step 2. Sign in and check the loan
   book still opens and your name shows as **Owner**.

**Undo:** on GitHub, open the merged pull request and press **Revert**, then
merge the revert. Pages publishes the old files again.

**9b. The Worker.** Check `intake-worker/wrangler.toml`:

- `SUPABASE_URL`;
- `SUPABASE_PUBLISHABLE_KEY` (the `sb_publishable_…` one, never the secret
  key);
- `ALLOWED_ORIGINS`: it must include the address of your console. Today that
  is GitHub Pages, `https://erastusm.github.io`, which is on the list (see
  "Moving the console" below for your own domain). Without it, viewing documents and
  step 10 fail with "forbidden".

Then:

```bash
npx wrangler deploy
```

Send a test application from the apply page. It should appear in the console
under **Credit queue → New**. A phone with the old form still cached can
still send; that application arrives without an amount, and the worksheet
flags it (G6) until you fill it in with **Correct details**.

**Undo:** `npx wrangler rollback` returns to the previous Worker version.

## Step 10: Import the old applications (once)

Use the console's **Import legacy applications** button, or the `curl`
command in `intake-worker/README.md`. It answers with
`{"imported": N, "skipped": M}`, and re-running is safe. Old "new"
applications arrive as **New**. Old "approved" and "declined" ones arrive
as **Archived**, so they can never be paid out twice.

Check:

```sql
select status, count(*) from public.applications where source = 'legacy' group by 1;
```

**Undo:** not needed. Archived rows are read-only.

## Step 11: Add the credit analyst

1. **Authentication → Users → Add user → Create new user**. Enter their
   email and a temporary password, and tick **Auto Confirm User**. Give
   them the password **in person**.
2. In the console, go to **Team & access → Add**, enter the same email and
   their full name, and choose the role **Credit analyst**.
3. They sign in and change the password under **My account**.

Check: signed in as the analyst, the console shows only the credit queue
and My account. The loan book, cash, reports and the audit trail are not
there, and the database refuses them even if asked directly.

**Undo:** in **Team & access**, choose **Deactivate**. The effect is
immediate. To remove the login entirely, delete it under
**Authentication → Users**.

## Step 12: Review the credit policy

Go to **Team & access → Credit policy → Edit policy** in the console. The
values from step 7 are already set. Every change is recorded with the old
and new value. The legal limits can't be exceeded: at most N$100,000, at
most 5 months, and charges at most 30%.

## Step 13: End-to-end test

1. Submit an application from the website with small numbers.
2. As the analyst: pick it up, open the documents, fill in the worksheet
   and send it for approval.
3. On the phone: **Reports → Cloud sync → Sync now**, and wait for "Up to
   date" or "Synced" (see "Paying out while the phone app is in use" below).
4. As yourself: approve it, then go to **Ready to disburse**, tick the
   checklist and record the payout.
5. On the phone: **Sync now**. The new `QSL-…` loan appears under the
   right client.
6. **Audit trail**: every step is listed with who did it.

If this was only a test, record a matching repayment or delete the test loan
on the phone as you normally would.

---

## Paying out while the phone app is in use

Booking a loan from the console saves a new version of the loan book, just as
a second phone would. When the phone then syncs, it takes the cloud's copy
**whole**. Anything recorded on the phone but not yet synced (a payment typed
in with no signal, or in the 2–3 seconds before it backs up) is dropped from
the loan book. The phone keeps it only in a hidden recovery copy that the app
can't show.

So, every time you book a payout:

1. **Before:** on the phone, **Reports → Cloud sync → Sync now**. Wait for
   "Up to date" or "Synced". Don't book while it says "Offline".
2. Don't record anything on the phone until the booking is done.
3. **After:** **Sync now** on the phone. The new loan appears.

If the phone ever says *"The other phone has newer data — tap Sync now to
merge"* while you have something unsynced, write that change down first.
**Sync now** doesn't merge: it replaces the phone's copy. Then enter the
change again.

## What an analyst can look up (a known limit)

The website needs no login. Someone, an analyst included, could send an
application with another person's ID number, pick it up, and see that
person's loans and payments in the borrower history. They would also see the
name and reference of any client with the same phone number.

The database can't tell this apart from a real returning borrower. So:

- every look at a borrower history is in the **Audit trail** (the documents
  category, action `history.viewed`), with who looked and at which clients;
- when the ledger has a **different name** for that ID number, the file's
  timeline says "Viewed the borrower history (the ledger has a different name
  for this ID number)", and the audit entry carries `name_differs: true`;
- analysts can't change an application's ID number or phone number. Only you
  can.

Check the Audit trail for those entries weekly. Give analyst logins only to
people you would trust with your clients' loan history.

## Moving the console to `admin.quickserve.group` (later)

The console is on GitHub Pages today. `https://admin.quickserve.group` is
already on the Worker's `ALLOWED_ORIGINS` list, so when you have hosting (see
`admin/README.md`, "Where it lives"):

1. Upload `admin/index.html` to `admin.quickserve.group` and check that you
   can sign in and open a document. Your own domain also fixes the
   "connection is not secure" problem on mobile data.
2. Give staff the new address.
3. When nobody uses the GitHub Pages copy any more, you can remove
   `https://erastusm.github.io` from `ALLOWED_ORIGINS` and run
   `npx wrangler deploy` (only after the apply form has moved too).

## Restoring the ledger from the backup

If the loan book ever needs to go back to the step 1 copy, run this. The
version number goes **up**, so every phone pulls the restored book on its
next sync:

```sql
update public.ledger l
   set data = b.data, rev = l.rev + 1, updated_at = now(), updated_by = 'restore'
  from backup.ledger_20261001 b
 where l.id = b.id;
```

You can also restore the JSON file from step 1 on the phone
(**Reports → Restore**), then **Sync now**.

## When something says no

| Message starts with | Meaning / what to do |
|---|---|
| `Run migration 00X first` | Run the files in order: 002 → 003 → 004. |
| `… has already been applied` | That step is done. Nothing changed. |
| `No active owner yet` | Do step 5. |
| `The ledger was last saved by …` | Seed that login as an owner, or sync once from your phone (step 6). |
| `QS_NOT_FOUND: No Supabase login exists for …` | Create the login under Authentication → Users first. |
| `The analyst login … exists` (003 undo) | Delete the analyst's login first, then undo. |
| `… application(s) would be deleted` (004 undo) | Export them, then confirm as shown in step 7. |
| Phone: "sign in again" / can't sync after step 6 | That phone's login isn't an owner. Seed it (step 5) or undo step 6. |
| Console: "Your login isn't enabled for the credit desk" | That login has no active staff row. Add it in Team & access. |
| Console: a function "could not be found" right after a migration | The API reloads itself within a minute. If not, run `notify pgrst, 'reload schema';` in the SQL editor. |
| Console: "forbidden" when opening a document or importing | The console's address isn't in the Worker's `ALLOWED_ORIGINS`. Add it and run `npx wrangler deploy` (step 9b). |
| `At 27.5% the interest on N$117 comes to N$32.175, which is not a whole number of cents …` | The desk and the phone app could round it to different cents (here N$149.18 against N$149.17). Change the amount (e.g. N$118) or the rate slightly. |
| Phone: "The other phone has newer data" after a payout | Expected: the console booked a loan. Note down anything unsynced on the phone, then **Sync now** (see "Paying out while the phone app is in use"). |

## What changed, in one paragraph

Before, any Supabase login could read and change the whole loan book, and
anyone could sign up. After, sign-up is off, and only an **active owner**
can touch the ledger (the phone app and the console's loan book). Credit
analysts see applications and that applicant's own history, never the
book. Decisions and payouts are **owner-only** and enforced by the
database itself. Every action is written to an audit trail that nobody can
edit or delete. The website's Worker holds no admin key; it can only hand
in applications, with its own intake key.
