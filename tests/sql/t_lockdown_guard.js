// Migration 003's guard and its rollback, on a database where only 001 + 002
// have run (the "base" template: no owner seeded yet).
//
//  * 003 without an owner raises and changes nothing
//  * 003 when the ledger was last saved by a login that isn't an owner raises
//  * 004 before 003 refuses
//  * with the right owner seeded, 003 locks the ledger to owners
//  * 003.down refuses while an analyst login exists, then restores the
//    original "any signed-in login" policies exactly as in schema.sql

"use strict";

const path = require("path");
const assert = require("assert");

module.exports = {
  template: "base",
  run({ pg, db }) {
    const mig = (f) => path.join(pg.MIGRATIONS, f);
    const policies = () => pg.psqlJson(db, `
      select jsonb_agg(jsonb_build_object('name', policyname, 'cmd', cmd, 'roles', roles,
               'qual', qual, 'check', with_check) order by policyname)
      from pg_policies where schemaname = 'public' and tablename = 'ledger';`);
    const versions = () => pg.psql(db, "select string_agg(version, ',' order by version) from private.schema_migrations;").trim();
    const count = (who) => Number(pg.psql(db, `select tests.as_user('${who}'); select count(*) from public.ledger;`).trim().split("\n").pop());
    const expectFail = (file, text) => {
      const r = pg.psqlFile(db, mig(file));
      assert.notStrictEqual(r.code, 0, `${file} should refuse`);
      assert.ok(r.stderr.includes(text), `${file} should say "${text}", got:\n${r.stderr}`);
    };

    const original = policies();
    assert.deepStrictEqual(original.map((p) => p.name), ["members insert", "members read", "members update"]);
    assert.strictEqual(versions(), "001,002");
    assert.strictEqual(count("stranger@quickserve.test"), 1, "before 003 any login reads the ledger (the hole 003 closes)");

    // 1. No owner seeded yet.
    expectFail("003_ledger_lockdown.sql", "No active owner yet");
    assert.deepStrictEqual(policies(), original, "policies unchanged after the refused 003");
    assert.strictEqual(versions(), "001,002");

    // 2. 004 can't run before 003.
    expectFail("004_credit.sql", "Run migration 003");
    assert.strictEqual(pg.psql(db, "select to_regclass('public.applications') is null;").trim(), "t", "004 created nothing");

    // 3. seed_owner needs an existing login, and only postgres may call it.
    let out = pg.psqlRaw(db, ["-A", "-t"], "select private.seed_owner('nobody@quickserve.test', 'Nobody');");
    assert.ok(out.code !== 0 && out.stderr.includes("QS_NOT_FOUND: No Supabase login exists for nobody@quickserve.test"), out.stderr);
    out = pg.psqlRaw(db, ["-A", "-t"], "select tests.as_user('stranger@quickserve.test'); select private.seed_owner('stranger@quickserve.test', 'Me');");
    assert.ok(out.code !== 0 && out.stderr.includes("permission denied"), "authenticated can't seed an owner: " + out.stderr);

    // 4. An owner exists, but the ledger was last saved by someone else.
    pg.psql(db, "select private.seed_owner('owner2@quickserve.test', 'Other Owner');");
    expectFail("003_ledger_lockdown.sql", "last saved by owner@quickserve.test who is not an active owner");
    assert.deepStrictEqual(policies(), original, "policies unchanged");
    assert.strictEqual(versions(), "001,002");

    // 5. Seed the phone app's login (case-insensitive) → 003 runs.
    const seeded = pg.psqlJson(db, "select private.seed_owner('  Owner@QuickServe.test ', 'Erastus Owner');");
    assert.strictEqual(seeded.role, "owner");
    assert.strictEqual(seeded.email, "owner@quickserve.test");
    let r = pg.psqlFile(db, mig("003_ledger_lockdown.sql"));
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(versions(), "001,002,003");
    assert.deepStrictEqual(policies().map((p) => p.name), ["owners insert", "owners read", "owners update"]);
    assert.strictEqual(count("stranger@quickserve.test"), 0, "stranger locked out");
    assert.strictEqual(count("owner@quickserve.test"), 1, "owner still reads");
    assert.strictEqual(count("owner2@quickserve.test"), 1, "second owner reads");
    expectFail("003_ledger_lockdown.sql", "already been applied");
    expectFail("002_staff_audit.sql", "already been applied");

    // 6. 003.down refuses while an analyst login exists…
    pg.psql(db, "insert into public.staff (user_id, email, full_name, role) select id, email, 'Tuyeni', 'analyst' from auth.users where email = 'analyst@quickserve.test';");
    expectFail("003_ledger_lockdown.down.sql", "analyst login analyst@quickserve.test exists");
    assert.strictEqual(versions(), "001,002,003");
    assert.strictEqual(count("stranger@quickserve.test"), 0, "still locked");

    // … and runs once that login is deleted (its staff row goes with it).
    pg.psql(db, "delete from auth.users where email = 'analyst@quickserve.test';");
    r = pg.psqlFile(db, mig("003_ledger_lockdown.down.sql"));
    assert.strictEqual(r.code, 0, r.stderr);
    assert.deepStrictEqual(policies(), original, "003.down restores the original policies exactly");
    assert.strictEqual(versions(), "001,002");
    assert.strictEqual(count("stranger@quickserve.test"), 1, "any login reads again (as before 003)");
    expectFail("003_ledger_lockdown.down.sql", "not applied");

    // 7. And 003 can be applied again afterwards.
    r = pg.psqlFile(db, mig("003_ledger_lockdown.sql"));
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(count("stranger@quickserve.test"), 0);
  }
};
