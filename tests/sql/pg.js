// Throwaway PostgreSQL for tests — no dependencies, just the PG binaries.
//
// Starts a private cluster in a temp dir (unix socket only, no TCP), builds
// the test templates (Supabase stub → supabase/schema.sql → 002 → 003 → 004 →
// fixtures) and hands out fresh databases copied from them. Everything is
// removed again on stop() (also on exit / Ctrl-C).
//
// Works as root (this container: the server runs as the "postgres" OS user
// via runuser) and as a normal user (GitHub Actions ubuntu-latest). Binaries
// come from $PG_BIN, else the newest /usr/lib/postgresql/<n>/bin, else
// `pg_config --bindir`.
//
// Use from another test file:
//
//   const pg = require("./sql/pg.js");        // path relative to your test
//   pg.startCluster();
//   const db = pg.createDb("my_test");          // copy of the full template
//   pg.psqlJson(db, "select private.assessment_compute(" + pg.jsonLit(ws) + ", ...)");
//   pg.psqlJson(db, "select tests.as_user('owner@quickserve.test'); select public.whoami()");
//   pg.stop();
//
// psqlJson() runs the SQL as the postgres superuser (use tests.as_user() /
// tests.as_anon() inside the SQL to act as a login) and returns the LAST
// output line parsed as JSON. See tests/sql/helpers.sql for the helpers and
// tests/sql/fixtures_base.sql for the fixture logins and ledger.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const SQL_DIR = __dirname;
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");

// Files that build each template, in order.
const BASE_FILES = [
  path.join(SQL_DIR, "00_supabase_stub.sql"),
  path.join(ROOT, "supabase", "schema.sql"),
  path.join(MIGRATIONS, "002_staff_audit.sql"),
  path.join(SQL_DIR, "helpers.sql"),
  path.join(SQL_DIR, "fixtures_base.sql")
];
const FULL_FILES = [
  path.join(MIGRATIONS, "003_ledger_lockdown.sql"),
  path.join(MIGRATIONS, "004_credit.sql"),
  path.join(SQL_DIR, "fixtures_full.sql")
];
const SEED_OWNER = "select private.seed_owner('owner@quickserve.test', 'Erastus Owner');";

let cluster = null;
let templates = false;

function findBinDir() {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  const base = "/usr/lib/postgresql";
  if (fs.existsSync(base)) {
    const versions = fs.readdirSync(base)
      .filter((v) => /^\d+$/.test(v) && fs.existsSync(path.join(base, v, "bin", "initdb")))
      .sort((a, b) => Number(b) - Number(a));
    if (versions.length) return path.join(base, versions[0], "bin");
  }
  const r = spawnSync("pg_config", ["--bindir"], { encoding: "utf8" });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  throw new Error("PostgreSQL binaries not found. Install PostgreSQL 15+ or set PG_BIN=/path/to/bin.");
}

// Run a server-side binary (initdb, pg_ctl) as a non-root user.
function runServer(c, cmd, args) {
  const full = path.join(c.bin, cmd);
  const r = c.asRoot
    ? spawnSync("runuser", ["-u", "postgres", "--", full, ...args], { cwd: c.dir, encoding: "utf8" })
    : spawnSync(full, args, { cwd: c.dir, encoding: "utf8" });
  if (r.error) throw r.error;
  return r;
}

function startCluster() {
  if (cluster) return cluster;
  const bin = findBinDir();
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
  // Short path: a unix socket path must stay under ~100 bytes.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qspg-"));
  const c = { bin, dir, data: path.join(dir, "data"), log: path.join(dir, "server.log"),
    port: 20000 + Math.floor(Math.random() * 30000), asRoot };
  cluster = c;

  process.once("exit", stop);
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.once(sig, () => { stop(); process.exit(130); });
  }

  if (asRoot) {
    const who = spawnSync("id", ["-u", "postgres"], { encoding: "utf8" });
    if (who.status !== 0) {
      stop();
      throw new Error('Running as root needs a "postgres" OS user to run the server (useradd postgres).');
    }
    fs.chmodSync(dir, 0o755);
    spawnSync("chown", ["postgres", dir]);
  }

  let r = runServer(c, "initdb", ["-D", c.data, "-U", "postgres", "-A", "trust", "-E", "UTF8", "--locale=C", "--no-sync"]);
  if (r.status !== 0) { stop(); throw new Error("initdb failed:\n" + r.stdout + r.stderr); }

  const opts = `-k ${dir} -p ${c.port} -c listen_addresses='' -c fsync=off -c synchronous_commit=off `
    + "-c full_page_writes=off -c timezone=UTC -c max_connections=20";
  r = runServer(c, "pg_ctl", ["-D", c.data, "-l", c.log, "-w", "-t", "60", "-o", opts, "start"]);
  if (r.status !== 0) {
    const log = fs.existsSync(c.log) ? fs.readFileSync(c.log, "utf8") : "";
    stop();
    throw new Error("pg_ctl start failed:\n" + r.stdout + r.stderr + log);
  }
  c.running = true;
  return c;
}

function stop() {
  const c = cluster;
  if (!c) return;
  cluster = null;
  templates = false;
  try {
    if (c.running) runServer(c, "pg_ctl", ["-D", c.data, "-m", "immediate", "-w", "stop"]);
  } catch (e) { /* best effort */ }
  try { fs.rmSync(c.dir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}

function need() {
  if (!cluster) throw new Error("Call startCluster() first.");
  return cluster;
}

// Raw psql. args: extra psql arguments; input: text on stdin.
// Returns { code, stdout, stderr } and never throws on SQL errors.
function psqlRaw(db, args, input) {
  const c = need();
  const r = spawnSync(path.join(c.bin, "psql"),
    ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", c.dir, "-p", String(c.port), "-U", "postgres", "-d", db, ...args],
    { input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PGTZ: "UTC", PGOPTIONS: "-c client_min_messages=warning", PGPASSWORD: "" } });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

// Run a .sql file. vars: { name: value } → psql -v name=value.
function psqlFile(db, file, vars) {
  const args = [];
  for (const [k, v] of Object.entries(vars || {})) args.push("-v", `${k}=${v}`);
  args.push("-f", file);
  return psqlRaw(db, args);
}

function psql(db, sql) {
  const r = psqlRaw(db, ["-A", "-t"], sql);
  if (r.code !== 0) throw new Error(`psql failed on ${db}:\n${r.stderr}`);
  return r.stdout;
}

// Last non-empty output line of the SQL, parsed as JSON.
function psqlJson(db, sql) {
  const lines = psql(db, sql).split("\n").filter((l) => l.trim() !== "");
  if (!lines.length) return null;
  return JSON.parse(lines[lines.length - 1]);
}

// SQL literals.
function lit(value) {
  return value == null ? "null" : "'" + String(value).replace(/'/g, "''") + "'";
}
function jsonLit(value) {
  return lit(JSON.stringify(value)) + "::jsonb";
}

function applyFiles(db, files) {
  for (const f of files) {
    const r = psqlFile(db, f);
    if (r.code !== 0) throw new Error(`Building ${db}: ${path.relative(ROOT, f)} failed:\n${r.stderr}`);
  }
}

// qs_base: stub + schema.sql + 002 + helpers + fixtures (no owner seeded, 003 not run).
// qs_full: qs_base + seeded owner + 003 + 004 + analysts.
function buildTemplates() {
  need();
  if (templates) return;
  psql("postgres", "create database qs_base;");
  applyFiles("qs_base", BASE_FILES);
  psql("postgres", "create database qs_full template qs_base;");
  psql("qs_full", SEED_OWNER);
  applyFiles("qs_full", FULL_FILES);
  templates = true;
}

// A fresh database copied from a template ("full" by default, or "base").
function createDb(name, template) {
  buildTemplates();
  const tpl = template === "base" ? "qs_base" : "qs_full";
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error("Database names: a-z, 0-9 and _ only.");
  psql("postgres", `drop database if exists ${name}; create database ${name} template ${tpl};`);
  return name;
}

function dropDb(name) {
  psql("postgres", `drop database if exists ${name};`);
}

module.exports = {
  ROOT, SQL_DIR, MIGRATIONS,
  startCluster, stop, buildTemplates, createDb, dropDb,
  psql, psqlRaw, psqlFile, psqlJson, lit, jsonLit
};
