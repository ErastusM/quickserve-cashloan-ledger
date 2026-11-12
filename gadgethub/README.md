# GadgetHub invoices

GadgetHub is a separate business from QuickServe. Nothing in this folder is
built or deployed by the QuickServe workflow.

- `invoice-template.html`: the GadgetHub invoice layout, copied from invoice
  GH-2026-0831 (logo, address, terms and conditions, footer).
- `render-invoice.js`: fills the template from a JSON file and writes a PDF.
- `invoices/<number>.json`: one file per invoice (number, dates, items). The PDF
  is written next to it.
- `invoices/<number>.client.json`: the client's name, address, phone and email.
  **Git ignores this file and the PDFs**, because this repository is public.
  Keep client details only there, never in the main JSON.

## Make or update an invoice

1. Copy an existing file in `invoices/`, or edit one. Numbers follow
   `GH-<year>-<MMDD of issue>`.
2. Any client field or item condition left as `null` prints as a highlighted
   "[… to be confirmed]" placeholder, so a draft can't pass for a final invoice.
3. Render:

```bash
node gadgethub/render-invoice.js gadgethub/invoices/GH-2026-1110.json
```

## Invoices

| Invoice | Item | Amount | Still needed |
|---|---|---|---|
| GH-2026-1110 | Samsung Galaxy S25 Ultra, Titanium Black, 256 GB, serial R5CY10CHX1H | N$ 23,000.00 | Nothing. Final; issued 10 Nov 2026 (condition: New). Client details kept out of git. |
