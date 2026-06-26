// QuickServe Cashloan Ledger — historical seed data.
//
// This file is intentionally empty in the public/hosted build so that NO real
// client names, ID numbers, or loan amounts are committed to a public repo or
// served to anyone who opens the app URL.
//
// To load your own loan book on a device:
//   1. Open the app on your phone.
//   2. Go to Reports > Restore and pick your backup .json file.
// Your data stays in that phone's browser only. Use Reports > Backup regularly.
//
// (If you ever want a device to auto-seed historical rows, you can push entries
// into the array below following this shape — but do NOT commit real data to a
// public repository.)
//   { loanId, month, monthNumber, client, principal, toReturn, returned,
//     paymentStatus, returnDataStatus, note, interestRate }
window.quickserveHistoricalRows = [];
