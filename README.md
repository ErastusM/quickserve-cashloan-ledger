# QuickServe Cashloan Ledger

A local-first mobile web app for QuickServe Cashloan. It tracks clients, loans, repayments, rollovers, outstanding balances, overdue accounts, expenses, cash float, and monthly/yearly business figures.

The app runs entirely in a phone browser and stores all data **on that device only** (browser local storage). Nothing is sent to a server — there is no backend.

**Live app:** https://erastusm.github.io/quickserve-cashloan-ledger/

## Key Features

- Dashboard: outstanding, overdue, due this month, money collected, revenue, net profit, and active clients at a glance. Every figure is tappable and opens the matching filtered view.
- Cash float: cash on hand, out on loan, and total funds, backed by a running bank-style ledger of every movement.
- Client management: names, phone numbers, ID numbers, employer, address, next of kin, and notes.
- Loan tracking: amount, interest rate, service fee, issue date, due date, payment status, and write-off status.
- **Rollover:** extend an unpaid loan — push the due date out and charge another interest cycle — without creating a second loan or faking a cash movement.
- **Reminders:** one tap on an open loan builds a message with the balance and due date, ready to send over WhatsApp or SMS, or to copy.
- **Search:** find loans by client, purpose, status or amount; find payments by client, method, reference, note or amount.
- Payment tracking: repayments are linked to loans, so collected money, revenue, principal recovery, and outstanding amounts are calculated automatically.
- Expense tracking: record business costs so reports show true profit.
- Per-client statement: open a client to see every loan and payment with a running balance, then copy, share, or export it.
- PIN lock: protect the loan book on a phone with a passcode asked each time the app opens.
- Reports: monthly, yearly and all-time figures, a monthly breakdown table, and a collections trend chart.
- CSV export for the loan book, payments, and expenses.
- **Backup, with warnings:** save and restore the full loan book as a JSON file, optionally encrypted. The dashboard warns when the last backup is getting old.
- Offline / installable: a service worker and web app manifest let the app be installed to a phone home screen and used offline.

## Figure Definitions

These match the labels shown in the app.

**Period figures** (Reports, for the selected month / year / all-time)

- **Cash out** — money handed to clients as new loans.
- **Collections** (shown as *Collected* on the dashboard) — all repayment money received from clients.
- **Revenue** — the interest and service-fee portion of what was collected.
- **Expenses** — business costs you record.
- **Profit** (shown as *Net profit* on the dashboard) — revenue minus expenses.
- **Principal recovered** — the original loan money that has been paid back.
- **Collection rate** — amount paid divided by total due, on loans issued in that period.

**Position figures** (where the book stands right now)

- **Outstanding** — total still collectable: principal plus unpaid interest and fees.
- **Capital out** — original loan money still not recovered.
- **Overdue** — unpaid collectable balance where the due date has passed.
- **Written off** — balances marked unrecoverable; excluded from outstanding and from the float.

**Cash float**

- **Cash on hand** — live cash balance: starting capital + capital in − capital out + repayments − loans paid out − expenses.
- **Out on loan** — principal still in clients' hands.
- **Total funds** — cash on hand + out on loan, i.e. working capital.

If cash on hand looks lower than the capital you put in, the difference is usually **out on loan** — the money is with clients, not missing. Total funds is the figure that reconciles.

## Cash Trail Check

Reports replays every cash movement in date order and reports the lowest point your float ever reached.

You cannot lend money you do not have, so if the running balance ever goes **negative**, cash went into the business around that date which was never recorded. The check names the date and the shortfall. If the closing balance still matches the cash you actually hold, then an equal amount also left unrecorded — typically owner withdrawals. Totals can look right while the history is wrong, and this is what surfaces that.

## Staying Up To Date

The app shows its build number in **Reports > Data status** (`App version`), read from the `?v=` query on its own script tag so it cannot drift from what was deployed.

When a new build is published, the app detects it and shows a **"New version ready"** bar with Reload and dismiss buttons. It never reloads on its own — that would risk discarding a half-filled form. The bar only appears when the running page is genuinely older than the installed worker, so a normal launch after a release does not nag you about a version you already have.

Note that GitHub Pages serves assets with `Cache-Control: max-age=600`, so a new release can take up to ten minutes to reach a device. If the figures look wrong right after a deploy, check `App version` before assuming a bug.

## How Repayments Are Applied

A repayment clears **interest and fees first**, then principal. Profit is therefore recognised early in a loan's life, and principal recovery comes later. A rollover adds another interest charge to the same loan; it moves no cash, so it never shows up as a new disbursement or collection.

## Install on a Phone

1. Open the live app link above in the phone browser (Chrome on Android, Safari on iPhone).
2. Use the browser menu and choose **Add to Home screen** / **Install app**.
3. Open it from the home screen icon. It now works offline.

## Privacy and Your Data

This repository is public so it can be hosted for free on GitHub Pages, so it ships **with no client data in it**. The first time you open the app it is an empty ledger.

To load your real loan book onto a device:

1. Open the app on the phone.
2. Go to **Reports > Restore** and pick your backup `.json` file.

Your data stays in that phone's browser only. It is never uploaded anywhere.

**Backup habit:** use **Reports > Backup** regularly and keep the file somewhere safe (Google Drive, iCloud, OneDrive, WhatsApp to yourself). If the phone is lost or its browser data is cleared, the backup file is what restores the loan book. The dashboard shows a warning when the last backup is getting stale.

**Encrypted backup:** **Reports > Encrypted backup** asks for a passphrase and writes an AES-GCM encrypted file, with the key derived via PBKDF2-SHA256. Restore detects the format and asks for the passphrase. Use this if the backup will sit in cloud storage or a chat thread, since a plain backup contains names and ID numbers in readable text. **A forgotten passphrase cannot be recovered** — which is exactly why the plain backup stays available too.

**Storage durability:** on load the app asks the browser to keep its storage (`navigator.storage.persist()`), which reduces the chance of the loan book being evicted when a device is low on space or the app goes unused. **Reports > Data status** shows whether the browser agreed. This is best effort, not a guarantee, and it is not a substitute for backups.

**About the PIN:** the PIN lock keeps the book from being opened casually on a lost or borrowed phone. It is a client-side lock stored hashed in the browser; it is not full device encryption, so for highly sensitive use also rely on the phone's own lock screen.

## Running Locally

Open `index.html` directly, or serve the folder for full PWA behaviour:

```powershell
python -m http.server 8080
```

Then open `http://localhost:8080`, or from a phone on the same Wi-Fi use the computer's local IP, for example `http://192.168.8.121:8080`.

## Tests

The money maths — payment allocation, rollovers, write-offs, period figures and the cash float — are covered by regression tests that load the real `app.js` and exercise its actual functions rather than a copy of the logic:

```powershell
node tests/money.test.js
```

No dependencies and no framework; it needs only Node. These tests also run in CI and **must pass before the site deploys**, because a wrong balance is worse than a late release.

## Hosting (GitHub Pages)

The site is plain static files (HTML, CSS, JS) with no build step. On every push to `main`, the workflow in `.github/workflows/pages.yml` runs the tests and then publishes the repository root to GitHub Pages.

When releasing, bump the cache version in **both** `sw.js` (`CACHE_NAME`) and the `?v=` query strings in `sw.js` and `index.html`, so installed phones pick up the update instead of serving the cached copy.

To re-render the PNG app icons from the SVG source, use any SVG-to-PNG tool to produce `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`, and `favicon-32.png`.
