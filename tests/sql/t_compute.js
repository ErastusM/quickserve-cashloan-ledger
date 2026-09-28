// Worksheet maths: every case in tests/fixtures/credit-cases.json through
// private.assessment_compute must equal the hand-checked expected values
// exactly (the JS QSCredit.compute parity test uses the same file).

"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

module.exports = {
  run({ pg, db }) {
    const file = path.join(pg.ROOT, "tests", "fixtures", "credit-cases.json");
    const cases = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(cases.length >= 14, "at least 14 fixture cases");

    const got = pg.psqlJson(db, `
      select jsonb_agg(private.assessment_compute(c -> 'worksheet', c -> 'terms', c -> 'application', c -> 'policy') order by n)
      from jsonb_array_elements(${pg.jsonLit(cases)}) with ordinality as x(c, n);`);

    cases.forEach((c, i) => {
      assert.deepStrictEqual(got[i], c.expected, `fixture "${c.name}" differs`);
    });

    // The live policy row carries the contract values the fixtures assume.
    const policy = pg.psqlJson(db, "select private.policy_json();");
    const base = cases[0].policy;
    for (const key of Object.keys(base)) {
      assert.strictEqual(policy[key], base[key], `credit_policy.${key} seeded as ${base[key]}`);
    }
  }
};
