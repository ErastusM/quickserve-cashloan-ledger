# QuickServe Cashloan Ledger

A local-first mobile web app for QuickServe Cashloan. It tracks clients, loans, repayments, outstanding balances, overdue accounts, expenses, and monthly/yearly business figures.

The app runs entirely in a phone browser and stores all data **on that device only** (browser local storage). Nothing is sent to a server — there is no backend.

**Live app:** https://erastusm.github.io/quickserve-cashloan-ledger/

## Key Features

- Dashboard: capital out, outstanding balance, overdue balance, monthly revenue, monthly profit, due-this-month collections, yearly profit, and active clients at a glance.
- Clickable dashboard figures: each figure opens the matching filtered view (open loans, overdue loans, current-month payments, reports, or clients).
- Client management: names, phone numbers, ID numbers, employer, address, next of kin, and notes.
- Loan tracking: amount, interest rate, fees, issue date, due date, payment status, and write-off status.
- Monthly loan view: the Loans section is grouped by month.
- Payment tracking: repayments are linked to loans so collected money, profit, principal recovery, and outstanding amounts are calculated automatically.
- **Expense tracking: record business costs so reports show true net profit (profit collected minus expenses).**
- **Per-client statement: open a client to see every loan and payment with a running balance, then copy, share, or export it.**
- **PIN lock: protect the loan book on a phone with a passcode asked each time the app opens.**
- Reports: monthly and yearly revenue, profit, expected profit, principal recovered, cash spent, expenses, net profit, net cash movement, interest rate, and profit return.
- Monthly breakdown and a revenue trend chart.
- CSV export for the loan book, payments, and expenses.
- Backup and restore: save and restore the full local loan book as a JSON file.
- Offline / installable: a service worker and web app manifest let the app be installed to a phone home screen and used offline.

## Figure Definitions

- Revenue: all repayments collected from clients. Total money that came in.
- Profit: the interest and fees portion of repayments collected.
- Expenses: business costs you record (transport, bank charges, rent, etc.).
- Net profit: profit collected minus expenses for the period.
- Expected profit: the interest and fees expected from loans issued.
- Principal recovered: the original loan money that has been paid back.
- Cash spent: money given out to clients as loans.
- Capital out: original loan money still not recovered.
- Outstanding: total amount still collectable (principal plus unpaid interest and fees).
- Overdue: unpaid collectable balance where the due date has passed.
- Net cash movement: revenue minus cash spent for the selected period.
- Interest rate: expected profit divided by cash spent.
- Profit return: profit collected divided by cash spent.

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

**Backup habit:** use **Reports > Backup** regularly and keep the file somewhere safe (Google Drive, iCloud, OneDrive, WhatsApp to yourself). If the phone is lost or its browser data is cleared, the backup file is what restores the loan book.

**About the PIN:** the PIN lock keeps the book from being opened casually on a lost or borrowed phone. It is a client-side lock stored hashed in the browser; it is not full device encryption, so for highly sensitive use also rely on the phone's own lock screen.

## Running Locally

Open `index.html` directly, or serve the folder for full PWA behaviour:

```powershell
python -m http.server 8080
```

Then open `http://localhost:8080`, or from a phone on the same Wi-Fi use the computer's local IP, for example `http://192.168.8.121:8080`.

## Hosting (GitHub Pages)

The site is plain static files (HTML, CSS, JS) with no build step. On every push to `main`, the workflow in `.github/workflows/pages.yml` publishes the repository root to GitHub Pages.

To re-render the PNG app icons from the SVG source, use any SVG-to-PNG tool to produce `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`, and `favicon-32.png`.
