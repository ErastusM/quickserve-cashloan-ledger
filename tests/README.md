# Tests

Every suite here runs in CI (`.github/workflows/pages.yml`) and **gates the
deploy**: if any of them fails, the site is not published. All of them run
from the repository root with plain Node 22. There is no build step, and
nothing gets installed into the repo.

| Suite | Command | What it checks | Needs |
|---|---|---|---|
| Money maths | `node tests/money.test.js` | The phone app's balances, allocation, rollovers, write-offs, float and projections (loads the real `app.js` in a VM) | Node |
| Database | `node tests/sql/run.js` | The Supabase migrations on a real, throwaway Postgres: RLS, grants, the state machine, intake, the worksheet maths, booking into the ledger, audit | Node + PostgreSQL server binaries |
| Parity | `node tests/parity.test.js` | The credit desk against the phone app's own code (details below) | Node + PostgreSQL server binaries |
| Intake Worker | `node --test tests/worker/` | `intake-worker/src/index.js` with in-memory R2, D1 and a stand-in for Supabase; no network | Node |
| Browser | `node tests/ui/<name>.test.js` | `apply.html` and `admin/index.html` in Chromium, with Supabase and the Worker stood in by `page.route` | Node + Playwright + Chromium |

Run everything, as CI does:

```bash
node tests/money.test.js
node tests/sql/run.js
node tests/parity.test.js
node --test tests/worker/
for f in tests/ui/*.test.js; do NODE_PATH=/path/to/node_modules node "$f"; done
```

Every runner prints one line per test and exits non-zero on any failure.

## Database and parity tests: PostgreSQL

`tests/sql/pg.js` starts a private cluster in a temp directory. It uses a
unix socket only and never listens on TCP. It applies the Supabase stand-in
(`tests/sql/00_supabase_stub.sql`), then `supabase/schema.sql` and the
migrations, and removes everything again on exit, including after Ctrl-C.
It never touches a real Supabase project.

- **Binaries.** It needs the PostgreSQL 15+ *server* binaries (`initdb`,
  `pg_ctl`, `psql`). It uses the newest `/usr/lib/postgresql/<n>/bin`, falls
  back to `pg_config --bindir`, and `PG_BIN=/path/to/bin` overrides both.
  Nothing has to be running: on Debian/Ubuntu, installing the `postgresql`
  package is enough. GitHub's `ubuntu-latest` runner already has version 16
  installed and not started.
- **As root** (this dev container): Postgres refuses to run as root, so the
  harness starts the server as the `postgres` OS user through `runuser`, and
  that user must exist. To check the non-root path CI takes, run for example:

  ```bash
  runuser -u postgres -- env HOME=/tmp PATH=/opt/node22/bin:/usr/bin:/bin node tests/sql/run.js
  ```

- **As a normal user** (a laptop, CI): the server runs as you. No setup is
  needed.
- `node tests/sql/run.js grants` runs only the `tests/sql/t_*` files whose
  name contains `grants`. How to write a new one is described at the top of
  `tests/sql/run.js`, and the helpers (`tests.as_user(email)`, `tests.expect_qs(...)`
  and the builders) are in `tests/sql/helpers.sql`.

## What the parity test proves

`tests/parity.test.js` uses the same harness, with the full template. It
seeds its own owner (`private.seed_owner`) and analyst (`staff_add`). The
owner's phone then pushes a realistic book through RLS, with a rev guard like
`cloud.js`. The book has:

- clients with and without refs, and gaps in the numbers;
- a legacy client with ref-less loans;
- rollovers, and part and full payments with cents;
- written-off loans;
- a phone-only lookalike, a passport holder;
- unknown top-level keys.

Two applications then go end to end through the RPCs as the right people:
`intake_submit` → `app_claim` → `assessment_save` → `assessment_submit` →
`app_decide` → `app_disburse`. One is a returning client booked onto their
existing record. The other is a new client above the D5 limit: the analyst
motivates it and the owner overrides with a note.

Then it loads the **real** `app.js` in a VM, as `money.test.js` does, and
checks that:

- the booked clients and loans have exactly the app.js shape;
- `normalizeState` and a phone boot keep every SQL-written id, ref and field,
  and the unknown top-level keys;
- the new refs are the next `QS-`/`QSL-` numbers `app.js` would pick;
- `analyzeLoan` equals the SQL loan maths for every loan;
- `borrower_history` (loans, summary, `qs_balance` = B8) equals `analyzeLoan`
  for every client with an ID.

Two checks are about single cents. `app.js` rounds money in binary floats
(`roundMoney`), and the worksheet rounds exact decimals (contract §4 `r2`):

- the SQL loan maths round like `app.js`, so on a half-cent interest such as
  N$500.05 at 30 % the history shows the phone's 150.01, not 150.015 → 150.02;
- the desk refuses terms whose interest isn't a whole number of cents when
  they become binding (`private.check_bookable_terms`). On every term it
  accepts, the desk's E7 equals the phone's total due. A sweep of over 10,000
  bookable terms confirms that.

It also checks the worksheet maths. Every case in `fixtures/credit-cases.json`
runs through the SQL `private.assessment_compute` **and** the console's
`QSCredit.compute`, taken from `admin/index.html`
`<script id="credit-calc">`. Both must equal `expected` to the cent, in rule
order. Then a seeded fuzz of 600 generated worksheets, ordinary and
deliberately odd, must give identical results on both sides.

- The test pins its own process to `TZ=Africa/Windhoek`, because `app.js`
  uses the device's date and the SQL uses Windhoek's. There is nothing to set.
- Vary the fuzz with `PARITY_SEED=<n>` and `PARITY_FUZZ=<count>`. A failure
  prints the first differing cases in full, input included, so they can be
  added to `credit-cases.json` as fixtures.
- `NOTE` lines in the output are reported, not failures. They list the edge
  terms the desk refuses.

## Browser tests: Playwright

The UI suites `require("playwright")` from CommonJS and launch Chromium.
Playwright is never a dependency of this repo, and there is no
`package.json` for it. Install it *outside* the repo and point `NODE_PATH` at
it:

- **This dev container:** Playwright is installed globally and its browsers
  are in `/opt/pw-browsers`, where `PLAYWRIGHT_BROWSERS_PATH` points already.
  Don't run `playwright install` here.

  ```bash
  NODE_PATH=/opt/node22/lib/node_modules node tests/ui/admin-core.test.js
  NODE_PATH=/opt/node22/lib/node_modules node tests/ui/admin-credit.test.js
  NODE_PATH=/opt/node22/lib/node_modules node tests/ui/apply.test.js
  ```

- **Elsewhere, as CI does:**

  ```bash
  mkdir -p /tmp/pw && cd /tmp/pw && npm init -y >/dev/null
  npm install --no-save --no-package-lock playwright@1.56.1
  npx playwright install --with-deps chromium    # --with-deps needs sudo on Linux
  cd - && NODE_PATH=/tmp/pw/node_modules node tests/ui/admin-core.test.js
  ```

Never commit `node_modules/`, a `package-lock.json` or browser downloads.

Each suite serves the repo root on a random localhost port and fixes the page
clock and time zone, so results don't depend on the day they run. The Supabase
and Worker stand-ins are in the test files. `admin-credit` also uses
`fixtures/rpc-mocks.json`, which holds the contract response shapes.

## Fixtures

- `fixtures/credit-cases.json`: the worksheet maths cases shared by the SQL
  (`tests/sql/t_compute.js`), the console (`tests/ui/admin-core.test.js`) and
  `tests/parity.test.js`. Each case is `{name, note, worksheet, terms,
  application, policy, expected}`, where `expected` is the contract §4
  `computed` object. A case added here is checked by all three.
- `fixtures/rpc-mocks.json`: realistic RPC responses for the console tests.
- `sql/fixtures_base.sql` and `sql/fixtures_full.sql`: the logins and loan
  book in every test database.

## CI

The `test` job in `.github/workflows/pages.yml` runs, in order:

1. money
2. database
3. parity
4. Worker
5. installs Playwright into the runner's temp dir
6. the browser suites

It runs on Node 22. Every step runs even if an earlier one failed, so one run
shows all failures, and the `deploy` job only starts when the whole `test` job
passed. The workflow runs on every push to `main`, and on demand from the
Actions tab ("Run workflow").
