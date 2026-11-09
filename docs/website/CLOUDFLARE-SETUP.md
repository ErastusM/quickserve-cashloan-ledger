# New Cloudflare account for quickserve.group

This sets up a fresh Cloudflare account, owned by **quickservegroup1@gmail.com**, for the website's application service: the API, application details (D1), documents (R2) and the bot check (Turnstile). It replaces the old Worker at `quickserve-intake.quickservefinance.workers.dev`.

Steps marked **(you)** need you, signed in to the new account. Steps marked **(Claude)** can be done from this session once you've created the API token in step 5.

---

## 1. Create the account (you, about 5 minutes)

1. Go to https://dash.cloudflare.com/sign-up and sign up with **quickservegroup1@gmail.com**.
2. Confirm the email Cloudflare sends.
3. Turn on two-factor login: **My Profile → Authentication → Two-Factor Authentication**. This account will hold ID documents and bank statements, so don't skip it. Save the recovery codes somewhere safe and offline.

## 2. Put quickserve.group on Cloudflare (you, about 15 minutes, recommended)

This gives the API a proper address, **api.quickserve.group**, instead of a `workers.dev` address. Some mobile networks block `workers.dev` addresses, the same way some blocked `github.io` for the admin console. The website and admin console stay on Hostinger.

1. In Cloudflare: **Add a domain → quickserve.group → Free plan**.
2. Cloudflare scans your current DNS records. Before continuing, check that the list includes:
   - the record for `quickserve.group` (the root) pointing at Hostinger,
   - the record for `admin` pointing at Hostinger,
   - any **MX** and **TXT** records, if you use email on the domain.

   Compare with Hostinger: **Domains → quickserve.group → DNS / Nameservers**. Add any record that's missing.
3. Set the Hostinger records (root and `admin`) to **DNS only** (grey cloud) for now. Hostinger issues its own SSL certificates and works most reliably that way.
4. Cloudflare shows two nameservers. In Hostinger: **Domains → quickserve.group → Nameservers → Change nameservers**, then enter the two Cloudflare names.
5. Wait for Cloudflare to email that the domain is active (usually under an hour, at most 24 hours). Then check https://admin.quickserve.group still opens.

## 3. Turn on R2 (you, 2 minutes)

**R2 Object Storage → Purchase / Enable R2.** Cloudflare may ask for a payment card even on the free tier. You aren't charged while you stay inside the free allowance (10 GB). Old application files are deleted on a schedule to stay under it.

## 4. Create the Turnstile widget (you, 2 minutes)

**Turnstile → Add widget**
- Name: `quickserve-apply`
- Hostnames: `quickserve.group`
- Mode: **Managed**

Keep the **site key** (public, goes in the website). The **secret key** goes into the Worker in step 6, never into the repo.

## 5. Create an API token so Claude can deploy (you, 3 minutes)

**My Profile → API Tokens → Create Token → Create Custom Token**

- Name: `quickserve-deploy`
- Permissions:
  - Account · **Workers Scripts** · Edit
  - Account · **D1** · Edit
  - Account · **Workers R2 Storage** · Edit
  - Account · **Account Settings** · Read
  - Zone · **Workers Routes** · Edit (zone: quickserve.group)
  - Zone · **DNS** · Edit (zone: quickserve.group)
- Account resources: the QuickServe account only.
- TTL: set an end date a few weeks out. You can delete the token any time.

Don't paste the token into chat. When you're ready, Claude asks for it through a secure form that stores it on this session's environment. Claude never sees the value.

## 6. Build and deploy the service (Claude)

With the token in place, from `intake-worker/`:

1. Create the database and bucket: `wrangler d1 create quickserve-intake`, `wrangler r2 bucket create quickserve-docs`.
2. Put the new `database_id` and the account id into `wrangler.toml`, then apply the schema and migrations.
3. Set `ALLOWED_ORIGIN` to `https://quickserve.group,https://admin.quickserve.group`.
4. Attach the Worker to **api.quickserve.group** (custom domain).
5. Deploy, then check `https://api.quickserve.group` answers.
6. Point the admin console's `WORKER_BASE` at the new address.

Two secrets go into the Worker. You type them yourself with `npx wrangler secret put`, or Claude asks for them through the secure form:

- `OWNER_TOKEN`: a new long random password for the Applications inbox, used until staff sign in with their console logins.
- `TURNSTILE_SECRET`: the secret key from step 4.

## 7. Applications already in the old account

The old Worker at `quickservefinance.workers.dev` may hold real applications and documents. Choose one:

- **Move them:** export the old D1 database (`wrangler d1 export`) and copy the R2 files across. This needs a token for the old account too, used once and then deleted.
- **Start fresh:** keep the old account read-only until every open application there is dealt with, then delete it.

Either way, don't delete the old account until the new one has taken its first real application.
