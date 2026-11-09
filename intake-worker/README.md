# QuickServe application service

The Cloudflare Worker behind online loan applications. It runs at
**https://api.quickserve.group** on the QuickServe Cloudflare account
(quickservegroup1@gmail.com).

```
website (quickserve.group) ──► api.quickserve.group ──► D1  quickserve-intake  (application details)
admin console (admin.…)    ──►        (Worker)       ──► R2  quickserve-docs    (ID, payslip, statements; private)
```

- **Applicants** create a draft, upload their documents one at a time, then hand it in. They get a reference (`AP-7KD4MP`) and a private tracking link.
- **Staff** use their normal admin-console login (Supabase). The service checks that login with Supabase on each request, so there is no separate password to share.
- **Loan rules** are set in `wrangler.toml`: payday loans only, 30% interest, and N$ 500–5 000 (the maximum is a placeholder until confirmed).
- **Clean-up** runs every night. Drafts never handed in are deleted after 7 days. Documents of declined or withdrawn applications are deleted after `RETENTION_DAYS` (180).

The full list of routes is at the top of `src/index.js`.

## Tests

```bash
node --test intake-worker/tests/worker.test.mjs
```

These tests need Node 22 or later. They run the whole flow against an in-memory database: apply, upload, hand in, review, request info, upload again, approve and convert. They also check bad files, wrong tokens, CORS and rate limits.

## Deploying

From `intake-worker/`, with a Cloudflare API token in `CLOUDFLARE_API_TOKEN`:

```bash
npx wrangler d1 migrations apply quickserve-intake --remote   # only when migrations/ changes
npx wrangler deploy
```

Secrets are never committed. Set them with `npx wrangler secret put <NAME>`:

- `TURNSTILE_SECRET`: switches on the bot check for new applications and tracking. **Set this before the website goes public.**
- `OWNER_TOKEN` (optional): a fallback password for the Applications tab if staff login is ever unavailable.
