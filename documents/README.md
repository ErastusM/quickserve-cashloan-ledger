# QuickServe Cashloan — client document pack

A complete set of microlending documents for **Quickserve Financial Services CC**
(trading as QuickServe Cashloan), drafted around Namibian law — chiefly the
**Microlending Act 7 of 2018** and NAMFISA's rules for registered microlenders.

Each document is provided in two formats:

- **`docx/`** — editable Microsoft Word files. Fill these in and adjust them.
- **`pdf/`** — print-ready A4 PDFs with the letterhead, page numbers, and the same
  content. These are what a client receives.

`pack.json` is the single source both formats are generated from (see *Regenerating*
below).

> **Read `00-read-me-first` before anything else.** It is the compliance and action
> list: what you must confirm, fix, or decide before any document here is used with a
> real borrower. The short version is on this page under *Before you use these*.

## The documents

| # | Document | When it is used |
|---|---|---|
| 00 | Read Me First — Compliance & Action List | Before everything — the owner's checklist |
| 01 | Loan Application Form | Client applies |
| 02 | Pre-Agreement Statement & Quotation | Cost disclosure given *before* signing |
| 03 | Affordability Assessment Worksheet | Internal — proves the loan was affordable |
| 04 | Microloan Agreement | The contract the client signs |
| 05 | Schedule of Fees & Charges (Annexure A) | Attaches to the agreement |
| 06 | Payment Receipt | Issued for every payment received |
| 07 | Paid-Up Letter / Settlement Confirmation | "To whom it may concern" — loan settled in full |
| 08 | Final Letter of Demand | Formal pre-litigation demand |
| 09 | Acknowledgement of Debt & Payment Arrangement | Client admits the debt and agrees a plan |
| 10 | Consent & Privacy Notice | How client data is handled |
| 11 | Debit Order / Payment Authority Mandate | Authority to collect an instalment |

This is a focused, professional set. Some optional or internal-only forms — a statement
of account, an early-settlement quotation, a first-reminder letter, a write-off notice,
and a client-rights charter — were intentionally left out to keep the pack lean, and can
be restored at any time. No rollover / loan-extension form is included on purpose: until
the rollover pricing is confirmed lawful (see the compliance sheet), issuing paperwork
for it would encourage a practice that is likely unlawful.

## Before you use these — the essentials

These four points are covered in full in `00-read-me-first`; they are here because
they matter most:

1. **NAMFISA registration comes first.** Operating as a microlender without
   registration is the offence; no document cures it.
2. **30% is a once-off cap on _total_ finance charges**, and a service fee counts
   **inside** it, not on top. Interest + service fee together must never exceed 30% of
   the principal.
3. **Rollovers are the highest legal risk.** Charging another full interest cycle on an
   extension is very likely unlawful. Resolve the mechanism with your attorney and
   NAMFISA before using document 09.
4. **A Namibian attorney must review the pack before first use.** The research behind it
   could not open the primary statute text directly (the sources were network-blocked),
   so section numbers and figures are drafted conservatively and flagged for
   confirmation, not stated as settled.

Already filled in for you: the registered legal name (**Quickserve Financial Services
CC**), the CC number (**CC/2026/01904**), and the phone/WhatsApp number
(**+264 81 264 6222**). Everything still in **[HIGHLIGHTED SQUARE BRACKETS]** is a
deliberate fill-in — most importantly the NAMFISA registration number, physical
address, and email.

## Regenerating

Edit `pack.json` (or the generators in `../tools/`) and rebuild both formats:

```bash
cd ../tools
npm install        # first time only
node md2docx.js ../documents/pack.json ../documents/docx
node md2pdf.js  ../documents/pack.json ../documents/pdf
```

The documents are set in a formal serif (Georgia in the Word files, PT Serif — bundled
in `../tools/fonts/` — in the PDFs) and are entirely greyscale: the only colour anywhere
is the logo in the letterhead. Both formats share the same letterhead, which reads the
company identity from the top of each generator — change it in one place there if the
registered details ever change.
