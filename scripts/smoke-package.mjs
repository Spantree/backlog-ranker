// Packs the package, installs the tarball into a throwaway project and checks
// that the installed CLI runs and the library imports. Run before publishing:
// `node scripts/smoke-package.mjs` (it needs the npm registry for dependencies).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

const dir = mkdtempSync(join(tmpdir(), "backlog-ranker-smoke-"));
try {
  run("npm", ["pack", "--pack-destination", dir], process.cwd());
  const tarball = readdirSync(dir).find((f) => f.endsWith(".tgz"));
  if (!tarball) throw new Error("npm pack wrote no tarball");

  const consumer = join(dir, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "smoke", private: true, type: "module" }),
  );
  run("npm", ["install", "--no-audit", "--no-fund", join(dir, tarball)], consumer);

  const help = run(join(consumer, "node_modules", ".bin", "backlog-ranker"), ["--help"], consumer);
  if (!help.includes("usage: backlog-ranker <verb>"))
    throw new Error("the installed CLI's --help printed no usage line");

  const imported = run(
    "node",
    [
      "--input-type=module",
      "-e",
      'const m = await import("@feniix/backlog-ranker"); console.log(typeof m.rankBacklog);',
    ],
    consumer,
  );
  if (imported.trim() !== "function") throw new Error("the installed library does not export rankBacklog");

  console.log(`smoke: ${tarball} installs, its CLI runs and its library imports`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
