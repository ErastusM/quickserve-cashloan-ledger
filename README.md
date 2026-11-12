# QuickServe Cashloan

The systems behind **QuickServe Cashloan** (Quickserve Financial Services CC, reg. CC/2026/01904): payday loans at 30% interest, paid once on payday, applied for and managed online only.

| Address | What it is | Code |
|---|---|---|
| **https://quickserve.group** | Public website: quote slip, online application, tracking page | `web/` |
| **https://admin.quickserve.group** | Admin portal for staff: applications, loan book, reports | `admin/` |
| **https://api.quickserve.group** | Application service that stores applications, documents and signatures | `intake-worker/` |

All three run on Cloudflare Workers. The loan book (clients, loans, payments, expenses) lives in Supabase.

## How a loan works, end to end

1. **Apply.** On quickserve.group the client picks an amount on the quote slip and sees the full cost before applying. They fill in four sheets (the loan, about them, documents, check & sign) and upload photos or PDFs of their ID or passport, latest payslip and 3 months' bank statements. They get a customer copy with a **QSA-YYMM-NNNN** reference.
2. **Track.** The client follows their application on the tracking page (by reference + cellphone, or from a WhatsApp link). It shows one stamp per step: Received → In review → Approved → Paid. If something is missing, staff ask for it and the client uploads it there.
3. **Review.** In the admin portal, staff open the application, view the documents and complete the affordability worksheet.
   - **Analysts** approve up to their limit and recommend above it.
   - **Owners** approve, decline and pay out.
   - Every action is recorded in the **Application audit**.
4. **After approval**, all on the client's phone:
   1. Read and accept the **Pre-Agreement Statement**.
   2. Give their bank account or e-wallet details, and a street address.
   3. Sign the one-page **Payday Loan Agreement** with their finger.

   Staff send each link on WhatsApp, follow progress in **Client steps**, and get a push notification at every step.
5. **Pay out.** The owner pays the client, then taps **Mark as paid out**. That:
   - creates the loan in the ledger, with a **QSL-YYMM-NNNN** number
   - notifies every staff device
   - opens WhatsApp with the payout and repayment message for the client
6. **Repay and collect.** The loan book tracks repayments, overdue loans, rollovers, write-offs, expenses, the cash float and reports. Repayment details: FNB Namibia, Quickserve Financial Services CC, account 64284783965, branch 282672, reference = the client's name and QSA-/QSL- number.

## What's in this repository

| Folder | Contents |
|---|---|
| `web/` | Website pages, styles and scripts. Shared header, footer and head are in `web/_partials/`. |
| `admin/` | The admin portal: a single page, `admin/index.html`. See `admin/README.md` for its features. |
| `intake-worker/` | The application service (Cloudflare Worker, D1 database, R2 file storage). Database changes are in `intake-worker/migrations/`, tests in `intake-worker/tests/`. |
| `site/` | Build scripts that pack the website and the portal into Workers (`site/web-worker/`, `site/admin-worker/`, `site/assemble.sh`). |
| `supabase/` | Database migrations for the loan book and staff roles. |
| `documents/` | The client document pack (application form, statement, agreement, fee schedule, letters, privacy notice) as Word and PDF, generated from `documents/pack.json`. **Read `00-read-me-first` before using it.** |
| `tools/` | Generators for the document pack, posters and flyer. |
| `marketing/` | How-to video, launch posters, flyer and their sources. |
| `docs/website/` | Cloudflare setup and the website implementation plan. |
| `tests/` | Loan-book money tests. |
| `app.js`, `index.html`, … (root) | The original phone app. It's retired and not online, but `app.js` still holds the money logic the tests check. |

## Deploying

Every push to `main` runs `.github/workflows/deploy.yml`:

1. **Tests:** loan-book money tests, application-service tests, and a build of the website and portal.
2. **If they pass, deploy:**
   1. apply the database migrations
   2. deploy the application service
   3. deploy the admin portal
   4. deploy the website

Pull requests run the tests only. The workflow needs one repository secret, `CLOUDFLARE_API_TOKEN`. Setup steps are in `docs/website/CLOUDFLARE-SETUP.md`.

Secrets live in Cloudflare, never in this repository. The application service needs `TURNSTILE_SECRET`, `VAPID_PRIVATE_JWK` and `TRACK_SESSION_SECRET`.

**Coming-soon mode:** `SITE_MODE = "soon"` in `site/web-worker/wrangler.toml` makes quickserve.group show a holding page; `"live"` shows the full site. preview.quickserve.group always has the full site and is hidden from search engines.

## Tests

```bash
node tests/money.test.js                          # loan-book maths: payments, rollovers, write-offs, float
node --test intake-worker/tests/worker.test.mjs   # application service: apply, review, statement, signing, payout, limits
```

Both need only Node 22 and run in the deploy workflow; a failing test stops the deploy.

## Privacy and data

This repository is public and contains **no client data and no secrets**. Applications, documents and signed agreements are stored in Cloudflare (private storage, no public links). The loan book is in Supabase, reachable only by signed-in staff. Declined and withdrawn applications lose their documents after 180 days, and unfinished applications are deleted after 7 days. The privacy notice is at https://quickserve.group/privacy.

## Before lending to real clients

QuickServe's NAMFISA registration is in progress. The website and documents deliberately make no registration claim until the certificate is issued. See `documents/pdf/00-read-me-first.pdf` for the remaining legal checks.
