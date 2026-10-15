import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The shipped surface: tsc's output run by plain `node`, the way an
 * npm install runs it. Compiled into a temp dir so the test owns its
 * build and never depends on a stale `dist/`. */
const root = join(import.meta.dir, "..");
let outDir: string;
let bin: string;

function runBin(args: string[], env: Record<string, string> = {}, cwd = root) {
  const proc = Bun.spawnSync(["node", bin, ...args], { cwd, env: { ...process.env, ...env } });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), "backlog-decisions-bin-"));
  const build = Bun.spawnSync(["bunx", "tsc", "-p", "tsconfig.build.json", "--outDir", outDir], {
    cwd: root,
  });
  if (build.exitCode !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);
  bin = join(outDir, "bin.js");
  // The compiled modules import their runtime dependencies by name.
  symlinkSync(join(root, "node_modules"), join(outDir, "node_modules"));
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

/** A spawned process cannot be handed the fake network, so these runs
 * stop on paths that refuse BEFORE any request: the allowlist, and a
 * missing token for an allowed source. */
describe("built bin under node: rank in a temp project", () => {
  let project: string;

  beforeAll(() => {
    project = mkdtempSync(join(tmpdir(), "backlog-decisions-project-"));
    mkdirSync(join(project, ".backlog-decisions", "rubrics"), { recursive: true });
    writeFileSync(
      join(project, ".backlog-decisions", "config.yaml"),
      "sources:\n  - github:kit/kit\nbackend: openrouter\n",
    );
    copyFileSync(
      join(root, "src", "fixtures", "rubric.yaml"),
      join(project, ".backlog-decisions", "rubrics", "fixture.yaml"),
    );
    mkdirSync(join(project, "sub", "dir"), { recursive: true });
  });

  afterAll(() => {
    rmSync(project, { recursive: true, force: true });
  });

  test("an unlisted source refuses on stderr with exit 1 and writes no cache", () => {
    const r = runBin(["rank", "-r", "fixture", "-s", "github:other/repo"], {}, join(project, "sub", "dir"));
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toStartWith("SourceError: github:other/repo is not on the backlog source allowlist");
    expect(r.stderr).toContain("No request was sent");
    expect(existsSync(join(project, ".backlog-decisions", "cache"))).toBe(false);
  });

  test("an allowed source with no token refuses naming the variable and the gh commands", () => {
    const r = runBin(["rank", "-r", "fixture", "-s", "github:kit/kit"], { GITHUB_TOKEN: "" }, project);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("GITHUB_TOKEN is not set");
    expect(r.stderr).toContain("gh auth token");
    expect(existsSync(join(project, ".backlog-decisions", "cache"))).toBe(false);
  });

  test("rank --help answers without a project", () => {
    const r = runBin(["rank", "--help"], {}, tmpdir());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("backlog-decisions rank");
  });
});
