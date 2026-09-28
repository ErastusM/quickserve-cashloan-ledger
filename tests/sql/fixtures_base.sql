-- Test fixtures shared by every test database: logins and a small loan book
-- in the exact shape the phone app (app.js) writes. Dates are relative to
-- "today" in Windhoek so the statuses never drift.
--
-- Logins: owner@ (seeded as owner), analyst@ and analyst2@ (added as analysts
-- in the full template), stranger@ (a login with no staff row).
--
-- Clients (ledger):
--   QS-0001 Selma Nangolo   ID 89031200457   five loans: paid on time, paid
--           4 days late, active with an extension, overdue, written off
--   QS-0003 Aina Nangolo    different ID, SAME phone as Selma (possible match)
--   (no ref) Legacy Person  no ID, a written-off loan without a ref
--   QS-0007 / QS-0008       two clients sharing ID 77010100123 (ambiguous)
--   QS-0010 Passport Person ID "p-1234567", empty phone/employer/address/kin

select tests.create_user('owner@quickserve.test');
select tests.create_user('analyst@quickserve.test');
select tests.create_user('analyst2@quickserve.test');
select tests.create_user('stranger@quickserve.test');
select tests.create_user('owner2@quickserve.test');

do $$
declare
  t date := (now() at time zone 'Africa/Windhoek')::date;
  d jsonb;
begin
  d := jsonb_build_object(
    'settings', jsonb_build_object('businessName', 'QuickServe Cashloan', 'currency', 'N$', 'startingCapital', 0),
    'imports', jsonb_build_array('cash_loan_clients_clean.xlsx'),
    'customTopLevelKey', jsonb_build_object('keep', 'me', 'n', 1),
    'updatedAt', '2026-01-01T00:00:00.000Z',
    'clients', jsonb_build_array(
      jsonb_build_object('id', 'client_a', 'ref', 'QS-0001', 'createdAt', '2026-01-02T08:00:00.000Z',
        'name', 'Selma Nangolo', 'phone', '081 234 5678', 'nationalId', '89031200457', 'employer', 'Rössing Uranium',
        'address', 'Mondesa, Swakopmund', 'nextOfKin', 'Martha Nangolo (085 612 3390)', 'notes', 'SECRET client note A'),
      jsonb_build_object('id', 'client_b', 'ref', 'QS-0003', 'createdAt', '2026-01-03T08:00:00.000Z',
        'name', 'Aina Nangolo', 'phone', '+264 81 234 5678', 'nationalId', '90010100999', 'employer', 'Shoprite',
        'address', 'Mondesa', 'nextOfKin', '', 'notes', 'SECRET client note B'),
      jsonb_build_object('id', 'client_c', 'createdAt', '2025-12-01T08:00:00.000Z',
        'name', 'Legacy Person', 'phone', '0811111111', 'nationalId', '', 'employer', '', 'address', '',
        'nextOfKin', '', 'notes', 'Imported from cash_loan_clients_clean.xlsx.'),
      jsonb_build_object('id', 'client_d', 'ref', 'QS-0007', 'createdAt', '2026-02-01T08:00:00.000Z',
        'name', 'Twin One', 'phone', '0812222222', 'nationalId', '770101 00123', 'employer', 'NamPower',
        'address', 'Walvis Bay', 'nextOfKin', '', 'notes', ''),
      jsonb_build_object('id', 'client_e', 'ref', 'QS-0008', 'createdAt', '2026-02-02T08:00:00.000Z',
        'name', 'Twin Two', 'phone', '0813333333', 'nationalId', '77010100123', 'employer', 'NamPower',
        'address', 'Walvis Bay', 'nextOfKin', '', 'notes', ''),
      jsonb_build_object('id', 'client_f', 'ref', 'QS-0010', 'createdAt', '2026-03-01T08:00:00.000Z',
        'name', 'Passport Person', 'phone', '', 'nationalId', 'p-1234567', 'employer', '', 'address', '',
        'nextOfKin', '', 'notes', 'keep this note')
    ),
    'loans', jsonb_build_array(
      -- paid on time
      jsonb_build_object('id', 'loan_a1', 'ref', 'QSL-0001', 'createdAt', '2026-01-02T09:00:00.000Z', 'status', 'active',
        'clientId', 'client_a', 'principal', 1000, 'interestRate', 30, 'serviceFee', 0,
        'issueDate', to_char(t - 120, 'YYYY-MM-DD'), 'dueDate', to_char(t - 90, 'YYYY-MM-DD'), 'purpose', 'Rent'),
      -- paid 4 days late, in two payments
      jsonb_build_object('id', 'loan_a2', 'ref', 'QSL-0002', 'createdAt', '2026-02-02T09:00:00.000Z', 'status', 'active',
        'clientId', 'client_a', 'principal', 2000, 'interestRate', 30, 'serviceFee', 50,
        'issueDate', to_char(t - 80, 'YYYY-MM-DD'), 'dueDate', to_char(t - 50, 'YYYY-MM-DD'), 'purpose', 'Food'),
      -- rolled over once (+900 interest), due in 20 days, part paid
      jsonb_build_object('id', 'loan_a3', 'ref', 'QSL-0005', 'createdAt', '2026-03-02T09:00:00.000Z', 'status', 'active',
        'clientId', 'client_a', 'principal', 3000, 'interestRate', 30, 'serviceFee', 0,
        'issueDate', to_char(t - 40, 'YYYY-MM-DD'), 'dueDate', to_char(t + 20, 'YYYY-MM-DD'), 'purpose', 'School',
        'extensions', jsonb_build_array(jsonb_build_object('id', 'ext_1', 'date', to_char(t - 10, 'YYYY-MM-DD'),
          'addedInterest', 900, 'previousDueDate', to_char(t - 10, 'YYYY-MM-DD'), 'newDueDate', to_char(t + 20, 'YYYY-MM-DD'),
          'note', 'SECRET extension note', 'createdAt', '2026-03-20T09:00:00.000Z'))),
      -- overdue by 3 days, nothing paid
      jsonb_build_object('id', 'loan_a4', 'ref', 'QSL-0006', 'createdAt', '2026-03-03T09:00:00.000Z', 'status', 'active',
        'clientId', 'client_a', 'principal', 400, 'interestRate', 30, 'serviceFee', 0,
        'issueDate', to_char(t - 33, 'YYYY-MM-DD'), 'dueDate', to_char(t - 3, 'YYYY-MM-DD'), 'purpose', 'Transport'),
      -- written off, 100 recovered
      jsonb_build_object('id', 'loan_a5', 'ref', 'QSL-0004', 'createdAt', '2025-11-03T09:00:00.000Z', 'status', 'written-off',
        'clientId', 'client_a', 'principal', 600, 'interestRate', 30, 'serviceFee', 0,
        'issueDate', to_char(t - 130, 'YYYY-MM-DD'), 'dueDate', to_char(t - 100, 'YYYY-MM-DD'), 'purpose', 'Other'),
      -- Aina (phone match only): overdue 30 days
      jsonb_build_object('id', 'loan_b1', 'ref', 'QSL-0007', 'createdAt', '2026-03-04T09:00:00.000Z', 'status', 'active',
        'clientId', 'client_b', 'principal', 1500, 'interestRate', 30, 'serviceFee', 0,
        'issueDate', to_char(t - 60, 'YYYY-MM-DD'), 'dueDate', to_char(t - 30, 'YYYY-MM-DD'), 'purpose', 'Aina private'),
      -- legacy loan without a ref
      jsonb_build_object('id', 'loan_c1', 'createdAt', '2025-12-01T09:00:00.000Z', 'status', 'active',
        'clientId', 'client_c', 'principal', 500, 'interestRate', 30, 'serviceFee', 0,
        'issueDate', to_char(t - 200, 'YYYY-MM-DD'), 'dueDate', to_char(t - 170, 'YYYY-MM-DD'), 'purpose', 'Legacy'),
      jsonb_build_object('id', 'loan_d1', 'ref', 'QSL-0009', 'createdAt', '2026-02-01T09:00:00.000Z', 'status', 'active',
        'clientId', 'client_d', 'principal', 800, 'interestRate', 30, 'serviceFee', 0,
        'issueDate', to_char(t - 90, 'YYYY-MM-DD'), 'dueDate', to_char(t - 60, 'YYYY-MM-DD'), 'purpose', 'Twin')
    ),
    'payments', jsonb_build_array(
      jsonb_build_object('id', 'payment_1', 'loanId', 'loan_a1', 'amount', 1300, 'date', to_char(t - 92, 'YYYY-MM-DD'),
        'method', 'Cash', 'reference', '', 'notes', 'SECRET payment note', 'createdAt', '2026-01-30T09:00:00.000Z'),
      jsonb_build_object('id', 'payment_2b', 'loanId', 'loan_a2', 'amount', 1650, 'date', to_char(t - 46, 'YYYY-MM-DD'),
        'method', 'Bank transfer', 'reference', 'FNB', 'notes', '', 'createdAt', '2026-02-20T09:00:00.000Z'),
      jsonb_build_object('id', 'payment_2a', 'loanId', 'loan_a2', 'amount', 1000, 'date', to_char(t - 55, 'YYYY-MM-DD'),
        'method', 'Cash', 'reference', '', 'notes', '', 'createdAt', '2026-02-10T09:00:00.000Z'),
      jsonb_build_object('id', 'payment_3', 'loanId', 'loan_a3', 'amount', 500, 'date', to_char(t - 5, 'YYYY-MM-DD'),
        'method', 'Cash', 'reference', '', 'notes', '', 'createdAt', '2026-03-25T09:00:00.000Z'),
      jsonb_build_object('id', 'payment_5', 'loanId', 'loan_a5', 'amount', 100, 'date', to_char(t - 90, 'YYYY-MM-DD'),
        'method', 'Cash', 'reference', '', 'notes', '', 'createdAt', '2025-12-10T09:00:00.000Z'),
      jsonb_build_object('id', 'payment_c', 'loanId', 'loan_c1', 'amount', 650, 'date', to_char(t - 168, 'YYYY-MM-DD'),
        'method', 'Historical', 'reference', '', 'notes', '', 'createdAt', '2025-12-01T09:00:00.000Z'),
      jsonb_build_object('id', 'payment_d', 'loanId', 'loan_d1', 'amount', 1040, 'date', to_char(t - 61, 'YYYY-MM-DD'),
        'method', 'Cash', 'reference', '', 'notes', '', 'createdAt', '2026-02-20T09:00:00.000Z')
    ),
    'expenses', jsonb_build_array(jsonb_build_object('id', 'expense_1', 'amount', 120, 'date', to_char(t - 3, 'YYYY-MM-DD'),
      'category', 'Airtime', 'note', 'SECRET expense', 'createdAt', '2026-03-01T09:00:00.000Z')),
    'capital', jsonb_build_array(jsonb_build_object('id', 'capital_1', 'direction', 'in', 'amount', 50000,
      'date', '2025-11-01', 'note', 'Opening float', 'createdAt', '2025-11-01T09:00:00.000Z'))
  );
  insert into public.ledger (id, data, rev, updated_at, updated_by)
  values ('main', d, 7, now(), 'owner@quickserve.test');
end $$;
