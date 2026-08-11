# QuickServe cloud sync — setup

The app works fully offline on one phone with no setup. These steps turn on
**cloud sync**: the loan book is backed up off-device and shared between two
phones. Do them once.

## 1. Rotate your secret key (security — do this first)

If you ever pasted the `sb_secret_…` key anywhere, replace it now:
**Project Settings → API keys → rotate the secret key.** The app never uses a
secret key, so nothing breaks. Only the **publishable** key (`sb_publishable_…`)
belongs in the app, and it's already wired in.

## 2. Create the database table

**Dashboard → SQL Editor → New query**, paste all of [`schema.sql`](./schema.sql),
and press **Run**. You should see "Success". This makes one `ledger` row that
only your logged-in users can read or write.

## 3. Set up the two logins

**Authentication → Users → Add user** — create one account for you and one for
your second person (set a password for each, tick "Auto Confirm User").

*Or*, to let people sign themselves up from inside the app, go to
**Authentication → Providers → Email** and turn **off** "Confirm email". Then
the app's **Create account** button works without an email round-trip. (Only
people you tell can sign up, since they need the app.)

## 4. Turn it on in the app

1. Open the app, go to the **Reports** tab, scroll to **Cloud sync**.
2. On your **main phone** (the one with all the loans), sign in first. It
   uploads your current book to the cloud — you'll see "Backed up to the cloud."
3. On the **second phone**, sign in with the other account. It pulls the book
   down. From then on, saving on either phone syncs to both.

## How it works / good to know

- The whole loan book is stored as one JSON document (`ledger.data`) and synced
  as a unit — simple and reliable for a two-person business.
- **If both phones edit at once**, the app avoids overwriting newer data: a
  phone with older data is asked to **Sync now** first, and the version it
  replaces is kept in a local recovery copy. It won't silently lose a change.
- Your keep-working-offline behaviour is unchanged: edits save on the phone and
  push to the cloud when there's a connection.
- Because the book now includes client IDs, access is limited to your logins by
  row-level security. Keep your passwords private and rotate the secret key.
