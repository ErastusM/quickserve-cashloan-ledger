# QuickServe Cashloan — WhatsApp intake backend

A small Cloudflare Worker that powers automated loan-request intake:

```
Borrower texts your WhatsApp number
      │  (WhatsApp Business App greeting auto-reply: "Apply here: <link>")
      ▼
apply.html  ──POST──►  Worker  ──►  D1 (details)  +  R2 (ID / bank / payslip)
                                        │
                                        ▼
                                    inbox.html   (you review · approve · decline)
                                        │
                                        ▼
                          WhatsApp reply to the applicant + record the loan in your app
```

Everything here is **free-tier** on Cloudflare. No Meta app or business verification is
needed for this phase — it uses your existing WhatsApp Business App. The code contains
**no data and no secrets**; applicant data lives in Cloudflare, not in this repo.

---

## One-time setup (about 15 minutes)

You need [Node.js](https://nodejs.org) installed. All commands are run from this
`intake-worker/` folder. `npx wrangler` downloads Cloudflare's CLI on first use.

### 1. Sign in to Cloudflare
Create a free account at https://dash.cloudflare.com, then:
```bash
npx wrangler login
```

### 2. Create the database (D1) and load the schema
```bash
npx wrangler d1 create quickserve-intake
```
Copy the `database_id` it prints into **wrangler.toml** (replace `REPLACE_WITH_YOUR_D1_DATABASE_ID`), then:
```bash
npx wrangler d1 execute quickserve-intake --remote --file=./schema.sql
```

### 3. Create the document store (R2)
```bash
npx wrangler r2 bucket create quickserve-docs
```
> R2 requires activating R2 in the dashboard once (Storage → R2 → enable). It stays free within the generous free tier.

### 4. Set your owner password (the inbox login)
Pick a long random string (e.g. from a password manager) and set it as a secret:
```bash
npx wrangler secret put OWNER_TOKEN
```
Paste the string when prompted. **This is what you'll type to open inbox.html.** Keep it private.

### 5. Deploy
```bash
npx wrangler deploy
```
It prints your Worker URL, e.g. `https://quickserve-intake.<your-subdomain>.workers.dev`.

### 6. Wire up the two pages
In the repo root:
- **apply.html** — set `ENDPOINT` to `"<your-worker-url>/applications"`.
- **inbox.html** — set `WORKER_BASE` to `"<your-worker-url>"`.

Commit and push so GitHub Pages serves them. Your pages will be at
`https://erastusm.github.io/quickserve-cashloan-ledger/apply.html` and `/inbox.html`.

### 7. Lock CORS to your site
In **wrangler.toml**, set `ALLOWED_ORIGIN` to your Pages origin
(`https://erastusm.github.io`) if it isn't already, then `npx wrangler deploy` again.

### 8. Turn on the WhatsApp auto-reply
In the **WhatsApp Business app** on your phone: **Settings → Business tools → Greeting
message** → turn on and set something like:

> Thanks for contacting QuickServe Cashloan! To apply for a loan, please complete this
> short form: https://erastusm.github.io/quickserve-cashloan-ledger/apply.html

That's it — new applications now flow into **inbox.html**.

---

## Day-to-day use

- Open **inbox.html**, enter your owner password once (stored on that device only).
- New requests appear under **New**. Open one to see the details and **view the ID,
  bank statement and payslip**.
- Tap **Approve** or **Decline** — you get a one-tap **WhatsApp reply** to the applicant
  and a **Copy for loan book** button to paste the details into the ledger app when you
  issue the loan.

## Local testing (optional)
```bash
npx wrangler dev
```
Runs the Worker locally; point `ENDPOINT`/`WORKER_BASE` at the printed localhost URL to try it.

## Notes on data
- Applicant documents (ID, bank statement, payslip) are stored **privately** in R2 and are
  only reachable through the password-protected Worker — there are no public file links.
- Consider how long you retain documents, and cover intake/retention in your NAMFISA and
  data-protection compliance. You can delete an application's files from R2 at any time.

## What's next (phase 2)
This same Worker + D1 + R2 becomes the backend for full **in-chat** automation via the
WhatsApp Cloud API — add a `/webhook` route and an in-chat form (WhatsApp Flows) later,
with no change to the storage or the inbox.
