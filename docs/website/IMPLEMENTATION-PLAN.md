# QuickServe public website and online applications: implementation plan

**Status:** proposal for review. No code changes yet.
**Designs:** https://claude.ai/artifact/9RXmGxynsy7zUV1sB8v1VA ("No small print" direction: desktop and mobile homepage, the 4-sheet application, customer copy, tracking, and the admin review screen).

---

## 1. Goal

Build a public website at **quickserve.group** where people can:

1. see what a loan costs (a live calculator capped at the 30% once-off maximum),
2. apply online in about 5 minutes from a phone,
3. upload their ID, latest payslip and 3 months of bank statements,
4. track the application and upload anything else they are asked for.

Every application must land in the **existing admin console** (admin.quickserve.group). Staff review it there, then approve it into the loan book with one click, without retyping anything.

## 2. What exists today

| Piece | Where | Notes |
|---|---|---|
| Admin console | `admin/index.html` → Hostinger `hostinger` branch → admin.quickserve.group | One-file SPA. Supabase login. Reads and writes the `ledger` jsonb document (clients, loans, payments). |
| Intake backend | `intake-worker/` (Cloudflare Worker + D1 + R2) | `POST /applications` is public (multipart). Owner-token routes handle list, detail, status and file download. |
| Applications tab | `admin/index.html` → `renderApplications` | **List only.** It has no detail view and no way to approve, decline or view documents. (The old `inbox.html` had those, but it is no longer published.) |
| Apply form | `apply.html` | Single long form. Not published (`site/assemble.sh` ships only the console). |
| Document pack | `documents/` | Doc 01 (application), 02 (pre-agreement quotation), 03 (affordability) and 10 (consent and privacy) map directly onto the online flow. |

**Main decision:** we **extend the Worker + D1 + R2 we already have**. We do not add a new backend. The website stays a static site (no framework), like the rest of the repo. The console stays the single place where staff work.

## 3. Architecture

```
quickserve.group  (static site, Hostinger)
  ├─ /            home + calculator
  ├─ /apply       4-step wizard (draft saved on the phone)
  ├─ /track       reference + phone → status, upload requested docs
  └─ /privacy /fees /complaints /contact
        │  HTTPS (CORS: quickserve.group, admin.quickserve.group)
        ▼
quickserve-intake Worker (Cloudflare)
  ├─ D1: applications, application_files, application_events
  ├─ R2: private documents (never public URLs)
  ├─ Turnstile (bot check) + per-IP rate limits
  └─ (phase 4) WhatsApp Cloud API for OTP and status messages
        ▲
        │  Supabase JWT (staff login), replacing the shared owner password
admin.quickserve.group (console)
  └─ Applications → detail → Approve & create loan ──► Supabase ledger (client + loan)
```

## 3a. Product scope at launch

- **Payday loans only:** one repayment on the applicant's next payday, at a 30% interest rate. Longer loans show a "Coming soon" banner on the site and in the application.
- **Online only:** no branch and no physical address on the site.

## 3b. Running costs (customer data storage)

Applications stay on Cloudflare (D1 for details, R2 for documents). The loan book stays on Supabase. At QuickServe's volume both fit inside the free tiers, so storage should cost **nothing** for a long time:

| Service | Free allowance | What it holds | When it starts costing |
|---|---|---|---|
| Cloudflare R2 | 10 GB, no download fees | ID, payslip and statement files | After roughly 3,000 applications (about 3 MB each once photos are compressed on the phone); then about US$0.015 per GB per month |
| Cloudflare D1 | 5 GB | Application details | Not at this volume (a few KB per application) |
| Cloudflare Workers | 100,000 requests a day | The application API | Not at this volume; the paid plan is US$5 per month if ever needed |
| Supabase (free) | 500 MB database | The loan book | Not at this volume. The free plan has no automatic daily backups, so keep the console's backups, or move to Pro (US$25 per month) for daily backups |

Deleting files of declined applications on a schedule (see 4.3) keeps R2 inside the free 10 GB. Prices are as last checked; confirm them on the providers' pricing pages before launch.

## 4. Backend changes (intake Worker)

### 4.1 Schema migration (`intake-worker/migrations/002_web_applications.sql`)

`applications`: add the following columns (all nullable, so existing rows keep working):

- `amount_requested` (integer cents), `term_months` (always 1 for now: payday loans only; kept so longer loans can be added later), `purpose_category`, `email`
- `net_income` (cents), `payday`, `source` (`web` | `whatsapp` | `legacy-form`)
- `phone_verified_at`, `consent_version`, `consent_at`, `consent_ip`, `consent_ua`
- `track_token_hash` (SHA-256 of a random token shown once to the applicant)
- `affordability_json` (staff worksheet from doc 03), `applicant_message` (text the applicant sees on /track)
- `assigned_to`, `ledger_client_id`, `ledger_loan_id`, `converted_at`
- status set widened to: `new → in_review → info_requested → approved | declined | withdrawn → converted`

New tables:

- `application_files (id, application_id, kind [id|payslip|bank|other], label, r2_key, mime, bytes, sha256, uploaded_at, uploaded_by [applicant|staff])` replaces the three `doc_*` columns. The migration backfills from them, and the old columns stay read-only.
- `application_events (id, application_id, at, actor, type, detail_json)`: an audit trail for "submitted", "opened", "info requested", "approved" and so on. It feeds the Activity panel.

### 4.2 Routes

Public (Turnstile + rate limited):

| Route | Purpose |
|---|---|
| `POST /v2/applications` | Create a **draft** with JSON details. Returns `{id, reference, uploadToken}`. |
| `PUT /v2/applications/:id/files/:kind` | Upload **one file at a time** (≤10 MB; JPEG/PNG/HEIC/PDF checked by magic bytes). One file per request means a dropped connection on mobile data only retries that file. |
| `POST /v2/applications/:id/submit` | Validate (3 doc kinds present, consent ticked, 30% cap) and move to `new`. Returns the tracking token once. |
| `POST /v2/track` | `{reference, phone}` or the tracking token → status, applicant message, list of missing items. |
| `PUT /v2/track/:id/files/:kind` | Upload a requested document once status is `info_requested`. |

`POST /applications` (v1) **stays as it is**, so old WhatsApp links keep working during the switch.

Staff routes (authenticated):

| Route | Purpose |
|---|---|
| `GET /v2/admin/applications?status=&q=` | List with counts per status. |
| `GET /v2/admin/applications/:id` | Full record, files and events. |
| `GET /v2/admin/applications/:id/files/:fileId` | Stream from R2 (`Cache-Control: private, no-store`). |
| `POST /v2/admin/applications/:id/status` | `{status, note, applicantMessage}`. |
| `PUT /v2/admin/applications/:id/affordability` | Save the doc 03 worksheet. |
| `POST /v2/admin/applications/:id/converted` | Record `ledger_client_id` and `ledger_loan_id` after the console writes the ledger. |

### 4.3 Security

- **Staff authentication:** the Worker verifies the **Supabase JWT** (from Supabase's JWKS) instead of the shared `OWNER_TOKEN`. Staff use their existing console login, and every action is attributed to a person. `OWNER_TOKEN` stays as a fallback until the switch is done.
- **CORS:** `ALLOWED_ORIGIN` becomes a list (`https://quickserve.group,https://admin.quickserve.group`), and the Worker echoes back the origin that matched.
- **Abuse:** Cloudflare Turnstile on draft and submit, a per-IP limit (for example 5 drafts per hour), file-type sniffing, and a cap of 12 files per application.
- **Retention (cron trigger):** files of declined or withdrawn applications are deleted after a set period (**owner to decide, e.g. 6 months**). Drafts never submitted are deleted after 7 days. This must match doc 10.
- **R2:** stays private; files are only reachable through authenticated Worker routes.

## 5. Public website

- **Stack:** static HTML, CSS and vanilla JS. Same approach as the console: no framework and no runtime dependencies. A small `site/build-web.sh` adds shared header and footer partials, a fingerprinted CSS file, `sitemap.xml` and `robots.txt`.
- **Pages:** Home (hero, calculator, how it works, requirements, costs, WhatsApp band, FAQ), Apply, Track, Privacy notice (doc 10), Schedule of fees (doc 05 PDF), Complaints, Contact, 404.
- **Apply wizard** (follows designs Apply 1–4):
  1. Loan: amount, term and purpose, with the live cost shown.
  2. About you: name, ID (Namibian 11-digit format check), WhatsApp number, employer, net pay, payday, next of kin.
  3. Documents: per-file upload with progress and retry. Photos are compressed on the phone (longest side 2000px, JPEG ~80%) before upload to save data.
  4. Review and consent: three consent checkboxes, and a reminder that a Pre-Agreement Statement comes before signing.
  - The draft is kept in `localStorage`, so a refresh or a dropped connection doesn't lose the form. Files are not kept, but uploaded files are remembered by server id.
- **Design direction: "No small print".** The site is built from the paperwork of a cash-loan counter: perforated quote slips, carbon-copy "customer copy" receipts, rubber stamps and numbered clauses. The promise is shown, not claimed: the calculator is a quote slip with a double-ruled total, the terms are set in large type ("the fine print, in big print"), and each application collects stamps (Received → Checked → Quoted → Paid) that the applicant can see on the tracking page.
  - **Colour:** brand dark teal `#053437` as the counter-top, bond paper `#f8f8f3` and `#e7eae2` for slips and sections, brand green `#12b84f` for actions on teal, stamp-ink green `#0b7a37` on paper, canary-carbon yellow `#f3d94a` for customer copies and notes from staff, rubber red `#b23a2a` only for "waiting on you".
  - **Type:** Big Shoulders Display (condensed, uppercase headlines), Instrument Sans (body), IBM Plex Mono (amounts, labels, references; the same mono the admin console uses). Amounts use Namibian spacing: `N$ 2 600.00`.
  - **Shape:** square corners, hard offset shadows on buttons, no rounded cards, no gradients.
- **Quality bar:** works from 320px wide, Lighthouse ≥ 95 on all four scores, every interactive element ≥ 44px, keyboard and screen-reader friendly, < 150 KB on the first visit.
- **Analytics:** Cloudflare Web Analytics, which uses no cookies and needs no consent banner. It tracks funnel steps (step 1 → submit).

## 6. Admin console changes (`admin/index.html`)

Follows the "Admin · application review" design.

1. **Applications list:** status tabs (New, In review, Info requested, Approved, Declined, Converted), search by name, ID, phone or reference, and the new-count badge (already exists).
2. **Application detail:** Requested, Applicant, Affordability worksheet (doc 03, editable expenses, auto-calculated left-over), a document viewer with tabs, a checklist and an Activity timeline.
3. **Returning-client match:** compare ID number and phone against `state.clients`. If found, show their reference (QS-00xx), credit grade and open balance.
4. **Actions:**
   - **Request info:** a short template list ("missing October statement", "ID unreadable", and so on). Sets `info_requested`, shows the message on /track, and opens a prefilled `wa.me` link (phase 1) or sends a WhatsApp template (phase 4).
   - **Decline:** a reason (kept internally) and a polite message to the applicant.
   - **Approve & create loan:** opens the console's **existing** client and loan forms prefilled from the application. That creates a new client, or attaches the loan to the matched returning client. Charges are clamped to the 30% cap, which the console already enforces. On save the console calls `/converted`, so the application and the loan stay linked both ways.
5. **Settings:** remove the "owner password" box once JWT authentication is live.

## 7. Hosting and deploy

- `site/assemble.sh` gains a second output, `_web/`, built from `web/` (new folder).
- `.github/workflows/pages.yml`: a new job commits `_web/` to a **`hostinger-web`** branch. Hostinger Git deploy pulls it into `public_html` (the root domain), the same way the `hostinger` branch feeds the `admin` subdomain today.
- Worker: `wrangler d1 migrations apply`, then `wrangler deploy`. A **staging** Worker and D1 (`quickserve-intake-staging`) let us test without touching real applications.
- The old `apply.html` and `inbox.html` are deleted once v2 has run in production for 2 weeks.

## 8. Testing

- **Worker:** Vitest with `@cloudflare/vitest-pool-workers` covering validation, the 30% cap, file sniffing, status transitions, authentication (JWT and owner token) and CORS.
- **Website:** Playwright on a phone viewport for the full apply flow (with fake files) against the staging Worker, plus axe accessibility checks.
- **Console:** Playwright for list → detail → approve, checking that the ledger gets a client and loan with the right amounts.
- **Existing:** `tests/money.test.js` keeps running in CI.

## 9. Phases

| Phase | Scope | Rough effort |
|---|---|---|
| **0. Decisions and content** (owner) | NAMFISA registration (the site shows CC/2026/01904 until then), maximum loan amount, cut-off times, retention period, privacy notice wording, **attorney review of the site copy** | Owner-led |
| **1. Backend v2** | Migration, v2 routes, Turnstile, multi-origin CORS, JWT authentication, tests, staging Worker | ~1 week |
| **2. Public site** | Home, apply wizard, track, legal pages, build and deploy to `hostinger-web` | ~1–1.5 weeks |
| **3. Console** | Applications list and detail, document viewer, affordability, request info, decline, approve → ledger | ~1 week |
| **4. Automation** (optional) | WhatsApp Cloud API (OTP and status templates), Pre-Agreement Statement (doc 02) generated as a PDF from the application, e-signature, retention cron | ~1–2 weeks |

Phases 1–3 make up a complete, usable launch. Phase 4 adds automation on top.

## 10. Compliance checklist (Namibia; for the attorney)

- Company registration CC/2026/01904 shown in the footer and terms. Add the NAMFISA number once it is issued.
- Online only: no physical address is published.
- The 30% once-off total cost (interest + service fee) shown as a **maximum**, with the exact cost given in the Pre-Agreement Statement (doc 02) **before** signing.
- An affordability assessment (doc 03) recorded for every approved loan. It is stored with the application.
- Consent and privacy notice (doc 10): versioned, with the accepted version and time stored per application.
- No bank cards, PINs or IDs held. This is stated on the site.
- Document retention and deletion as decided in phase 0.
- Marketing claims ("fast approval") reviewed. No promises of approval.

## 11. Open questions for the owner

1. **Maximum loan amount**, and whether it differs for first-time and returning clients. The designs assume N$500–N$5,000 as a placeholder.
2. **Actual pricing.** Is it always 30%, or lower for some terms or clients? The calculator currently shows the 30% maximum.
3. **Payout and repayment:** EFT only? Debit order (doc 11) for everyone?
4. **Reference format.** Today applications use `QS-ABC123` and clients use `QS-0001`, which look alike. Proposal (already used in the designs): new applications use `AP-ABC123`.
5. **WhatsApp Business API:** do you want to register for it in phase 4 (it has a per-message cost), or keep the free click-to-chat links?
6. **Email:** should we ask for an email address (optional) and send confirmations by email too?
7. **Staff:** who besides the owner reviews applications? This decides the roles we need.

## 12. About Figma

These designs are built as an interactive design canvas (link at the top), not in Figma. They can be moved into Figma with an HTML-to-Figma import plugin, or rebuilt there directly if a Figma connection is added to this workspace. Brand tokens are listed in §5.
