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
