// Database tests: the Supabase migrations on a real, throwaway Postgres.
//
//   node tests/sql/run.js            run every tests/sql/t_*.sql and t_*.js
//   node tests/sql/run.js grants     only files whose name contains "grants"
//
// Each test gets a fresh database copied from a template (see pg.js):
//   * t_*.sql run with psql -v ON_ERROR_STOP=1; any error fails the test.
//     A first line "-- template: base" picks the template without 003/004.
//   * t_*.js export { template?, run({ pg, db }) } and throw to fail.
// Exits non-zero if anything failed. The cluster is always removed.

"use strict";

const fs = require("fs");
const path = require("path");
const pg = require("./pg.js");

async function main() {
  const filter = process.argv[2] || "";
  const files = fs.readdirSync(__dirname)
    .filter((f) => /^t_.+\.(sql|js)$/.test(f) && f.includes(filter))
    .sort();
  if (!files.length) {
    console.error("No tests match.");
    return 1;
  }

  const started = Date.now();
  pg.startCluster();
  try {
    pg.buildTemplates();
  } catch (e) {
    console.error("FAIL  building the test templates\n" + e.message);
    return 1;
  }
  console.log(`templates built in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  let failed = 0;
  for (const [i, file] of files.entries()) {
    const full = path.join(__dirname, file);
    const t0 = Date.now();
    let error = null;
    let db = null;
    try {
      if (file.endsWith(".sql")) {
        const head = fs.readFileSync(full, "utf8").split("\n", 1)[0];
        const template = /--\s*template:\s*base/.test(head) ? "base" : "full";
        db = pg.createDb(`t${i}`, template);
        const r = pg.psqlFile(db, full);
        if (r.code !== 0) error = r.stderr.trim() || `psql exited with ${r.code}`;
      } else {
        const test = require(full);
        db = pg.createDb(`t${i}`, test.template === "base" ? "base" : "full");
        await test.run({ pg, db });
      }
    } catch (e) {
      error = (e && e.stack) || String(e);
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (error) {
      failed += 1;
      console.log(`FAIL  ${file} (${secs}s)`);
      console.log(error.split("\n").slice(-40).map((l) => "      " + l).join("\n"));
    } else {
      console.log(`ok    ${file} (${secs}s)`);
    }
    if (db) {
      try { pg.dropDb(db); } catch (e) { /* the cluster goes away anyway */ }
    }
  }

  console.log(`\n${files.length - failed} passed, ${failed} failed (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  return failed ? 1 : 0;
}

main()
  .then((code) => { pg.stop(); process.exit(code); })
  .catch((e) => { console.error(e); pg.stop(); process.exit(1); });
