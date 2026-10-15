import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The shipped surface: tsc's output run by plain `node`, the way an
 * npm install runs it. Compiled into a temp dir so the test owns its
 * build and never depends on a stale `dist/`. */
const root = join(import.meta.dir, "..");
let outDir: string;
let bin: string;

function runBin(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(["node", bin, ...args], { cwd: root, env: { ...process.env, ...env } });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), "backlog-decisions-bin-"));
  const build = Bun.spawnSync(["bunx", "tsc", "-p", "tsconfig.build.json", "--outDir", outDir], {
    cwd: root,
  });
  if (build.exitCode !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);
  bin = join(outDir, "bin.js");
});

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe("built bin under node", () => {
  test("--help prints usage on stdout and exits 0", () => {
    const r = runBin(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("backlog-decisions <verb>");
    expect(r.stderr).toBe("");
  });

  test("a bad flag refuses on stderr with exit 1 and the debug hint", () => {
    const r = runBin(["rank", "--bogus"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toStartWith("RefusalError: Unknown option '--bogus'");
    expect(r.stderr).not.toMatch(/^\s+at /m);
    expect(r.stderr).toContain("BACKLOG_DECISIONS_DEBUG=1");
  });

  test("BACKLOG_DECISIONS_DEBUG restores the frames", () => {
    const r = runBin(["rank", "--bogus"], { BACKLOG_DECISIONS_DEBUG: "1" });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^\s+at /m);
  });
});
