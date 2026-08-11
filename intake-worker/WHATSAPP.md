# Automatic WhatsApp notifications (Meta Cloud API)

When this is set up, **approving or declining** an application in `inbox.html`
sends the applicant a WhatsApp message automatically — no tapping. Until it's
set up, nothing changes: the inbox still shows the manual one-tap WhatsApp reply.

Dedicated number for automation: **+264 81 281 9840**
(keep +264 81 264 6222 in the normal WhatsApp Business app for chatting).

> A number can only be in one place at a time. To use +264 81 281 9840 on the
> Cloud API you register it there, which **removes it from the WhatsApp Business
> app**. That's expected for a dedicated automation number.

---

## Start here: the free test number (no real number moved)

You can prove the whole thing works without touching any real number. Every new
Meta app comes with a **test sender number** that can message a few **allowed
recipient numbers** you add yourself.

1. Do step 1 below to create the app + add the WhatsApp product.
2. Under **WhatsApp → API Setup**, find the **"To"** field and **add your own
   phone number** as an allowed recipient (Meta texts it a code to confirm).
   Test numbers can *only* message recipients you've added this way.
3. Create and submit the two templates (step 2) and wait for approval.
4. Point the Worker at the **test number's Phone Number ID** and the temporary
   token (step 4). The temp token lasts ~24 hours — fine for a test.
5. Submit a test application using **your own phone number**, then approve it in
   the inbox — your phone gets the WhatsApp message.

When that works, register the real number **+264 81 281 9840** the same way and
swap in a long-lived token (step 3). Your chat number **+264 81 264 6222 is
never touched** — it stays in the WhatsApp Business app for talking to clients.

---

## 1. Create the Meta pieces (once)

1. Go to **https://developers.facebook.com** → log in → **My Apps** → **Create App** → type **Business**.
2. In the app, add the **WhatsApp** product. This creates a **WhatsApp Business Account (WABA)** and gives you a test area with:
   - a temporary **access token**,
   - a **Phone Number ID**,
   - and a free **test number** you can message yourself from to try it.
3. Under **WhatsApp → API Setup**, add and verify your real number **+264 81 281 9840** as the "From" number (Meta texts it a code). This moves it onto the Cloud API.
4. Complete **Business Verification** (Meta Business Settings → Security Centre). Testing works before this; verification is needed to message beyond a small test list and to raise limits.

## 2. Submit the two message templates

Business-initiated messages must use **pre-approved templates**. In **WhatsApp Manager → Message templates → Create**, make two, category **Utility**, language **English**:

**Name:** `loan_approved`
> Hi {{1}}, good news — your QuickServe Cashloan request ({{2}}) has been approved. We'll be in touch shortly with the details. Thank you!

**Name:** `loan_declined`
> Hi {{1}}, thank you for your QuickServe Cashloan application ({{2}}). Unfortunately we can't approve it at this time. You're welcome to apply again in future.

`{{1}}` is the applicant's first name, `{{2}}` is their reference — the Worker fills these in. Approval usually takes a few hours to a couple of days.

## 3. Get a long-lived token (for production)

The test token expires in ~24 hours. For a token that lasts, create a **System User** in **Business Settings → Users → System Users** (Admin), assign it your app/WABA, and **Generate token** with the `whatsapp_business_messaging` permission. Copy it — you won't see it again.

## 4. Point the Worker at it

From the `intake-worker/` folder:

```bash
# your Phone Number ID from step 1 (a long number, NOT the phone number itself)
# edit wrangler.toml → WHATSAPP_PHONE_ID = "<that id>"

npx wrangler secret put WHATSAPP_TOKEN     # paste the token from step 3
npx wrangler deploy
```

That's it — the next approve/decline auto-sends. The inbox shows **"✓ Sent on WhatsApp automatically"**, or a reason if it couldn't, with the manual button as a fallback.

## Notes
- **Cost:** utility conversations are very cheap and Meta includes a free monthly allowance; you pay per conversation beyond that.
- **The 24-hour window:** you can only send *free-form* text within 24 hours of the client's last message. That's why approve/decline use templates — they work any time.
- To turn auto-send **off**, blank out `WHATSAPP_PHONE_ID` in wrangler.toml and redeploy; the manual reply stays.
