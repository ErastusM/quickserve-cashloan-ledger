// 004 can be rolled back cleanly and applied again; the rollback refuses to
// delete applications unless explicitly confirmed; order guards hold.

"use strict";

const path = require("path");
const assert = require("assert");

module.exports = {
  run({ pg, db }) {
    const mig = (f) => path.join(pg.MIGRATIONS, f);
    const objects = () => pg.psqlJson(db, `
      select jsonb_build_object(
        'functions', (select jsonb_agg(n.nspname || '.' || p.proname order by n.nspname, p.proname)
                      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private')),
        'tables', (select jsonb_agg(schemaname || '.' || tablename order by schemaname, tablename)
                   from pg_tables where schemaname in ('public', 'private')),
        'versions', (select jsonb_agg(version order by version) from private.schema_migrations));`);

    // Something to lose: one application.
    pg.psql(db, "select tests.submit_app(tests.intake_key());");
    const auditBefore = Number(pg.psql(db, "select count(*) from public.audit_log;").trim());

    let r = pg.psqlFile(db, mig("004_credit.down.sql"));
    assert.notStrictEqual(r.code, 0, "004.down refuses while applications exist");
    assert.ok(r.stderr.includes("1 application(s) would be deleted"), r.stderr);
    assert.strictEqual(pg.psql(db, "select count(*) from public.applications;").trim(), "1", "nothing deleted");

    // Confirmed rollback.
    r = pg.psqlRaw(db, ["-c", "set qs.confirm = 'drop-credit-data';", "-f", mig("004_credit.down.sql")]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.deepStrictEqual(objects(), {
      functions: ["private.audit", "private.audit_log_immutable", "private.ledger_audit", "private.ledger_count",
        "private.seed_owner", "public.is_owner", "public.is_staff", "public.staff_role"],
      tables: ["private.schema_migrations", "public.audit_log", "public.ledger", "public.staff"],
      versions: ["001", "002", "003"]
    }, "004.down removes exactly what 004 created");
    assert.strictEqual(Number(pg.psql(db, "select count(*) from public.audit_log;").trim()), auditBefore, "the audit trail is kept");
    assert.ok(pg.psqlRaw(db, ["-f", mig("004_credit.down.sql")]).stderr.includes("not applied"), "004.down twice refuses");

    // The ledger lockdown is unaffected.
    assert.strictEqual(pg.psql(db, "select tests.as_user('stranger@quickserve.test'); select count(*) from public.ledger;").trim().split("\n").pop(), "0");

    // 004 applies again from scratch, with the same exposure.
    r = pg.psqlFile(db, mig("004_credit.sql"));
    assert.strictEqual(r.code, 0, r.stderr);
    assert.deepStrictEqual(objects().versions, ["001", "002", "003", "004"]);
    assert.strictEqual(pg.psql(db, `select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute');`).trim(), "intake_import_legacy,intake_submit");
    const again = pg.psqlFile(db, mig("004_credit.sql"));
    assert.ok(again.code !== 0 && again.stderr.includes("already been applied"), "004 twice refuses");
  }
};
