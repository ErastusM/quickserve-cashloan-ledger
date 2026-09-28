// Lets `node --test tests/worker/` work: Node resolves the directory to this
// file, which loads every *.test.mjs beside it (node:test runs their tests).
// `node --test tests/worker/*.test.mjs` works too, without this file.
(async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const dir = typeof __dirname === "string" ? __dirname : path.dirname(path.resolve(process.argv[1]));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).sort();
  for (const f of files) await import(pathToFileURL(path.join(dir, f)).href);
})().catch((err) => { console.error(err); process.exitCode = 1; });
