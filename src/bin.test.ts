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
  outDir = mkdtempSync(join(tmpdir(), "backlog-ranker-bin-"));
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
    expect(r.stdout).toContain("backlog-ranker <verb>");
    expect(r.stderr).toBe("");
  });

  test("a bad flag refuses on stderr with exit 1 and the debug hint", () => {
    const r = runBin(["rank", "--bogus"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toStartWith("Unknown option '--bogus'");
    expect(r.stderr).not.toMatch(/^\s+at /m);
    expect(r.stderr).toContain("BACKLOG_RANKER_DEBUG=1");
  });

  test("BACKLOG_RANKER_DEBUG restores the frames", () => {
    const r = runBin(["rank", "--bogus"], { BACKLOG_RANKER_DEBUG: "1" });
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
    project = mkdtempSync(join(tmpdir(), "backlog-ranker-project-"));
    mkdirSync(join(project, ".backlog-ranker", "rubrics"), { recursive: true });
    writeFileSync(
      join(project, ".backlog-ranker", "config.yaml"),
      "sources:\n  - github:kit/kit\nbackend: openrouter\n",
    );
    copyFileSync(
      join(root, "src", "fixtures", "rubric.yaml"),
      join(project, ".backlog-ranker", "rubrics", "fixture.yaml"),
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
    expect(r.stderr).toStartWith("github:other/repo is not on the backlog source allowlist");
    expect(r.stderr).toContain("No request was sent");
    expect(existsSync(join(project, ".backlog-ranker", "cache"))).toBe(false);
  });

  test("an allowed source with no token refuses naming the variable and the gh commands", () => {
    const r = runBin(["rank", "-r", "fixture", "-s", "github:kit/kit"], { GITHUB_TOKEN: "" }, project);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("GITHUB_TOKEN is not set");
    expect(r.stderr).toContain("gh auth token");
    expect(existsSync(join(project, ".backlog-ranker", "cache"))).toBe(false);
  });

  test("rank --help answers without a project", () => {
    const r = runBin(["rank", "--help"], {}, tmpdir());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("backlog-ranker rank");
  });
});

/** Piped output is written asynchronously on macOS: exiting the moment
 * the run returns cut it at the pipe's buffer (64 KiB under node). A
 * config with tens of thousands of bad sources makes a refusal of more
 * than a megabyte, one line per entry, all of which must arrive. */
describe("built bin: large piped output drains before exit", () => {
  const entries = 20_000;
  let project: string;

  beforeAll(() => {
    project = mkdtempSync(join(tmpdir(), "backlog-ranker-drain-"));
    mkdirSync(join(project, ".backlog-ranker"), { recursive: true });
    const lines = Array.from({ length: entries }, (_, i) => `  - not-a-source-${i}`);
    writeFileSync(
      join(project, ".backlog-ranker", "config.yaml"),
      `sources:\n${lines.join("\n")}\nbackend: openrouter\n`,
    );
  });

  afterAll(() => {
    rmSync(project, { recursive: true, force: true });
  });

  for (const runtime of ["node", "bun"]) {
    test(`under ${runtime}, every byte of a >1 MB refusal arrives`, () => {
      const proc = Bun.spawnSync([runtime, bin, "rank", "-r", "x", "-s", "github:a/b"], {
        cwd: project,
        env: { ...process.env },
      });
      const stderr = proc.stderr.toString();
      expect(proc.exitCode).toBe(1);
      // Booleans, so a failure does not print a megabyte.
      expect(stderr.length > 1_000_000).toBe(true);
      expect(stderr.includes(`sources.${entries - 1}: a source is`)).toBe(true);
      expect(stderr.trimEnd().endsWith("(BACKLOG_RANKER_DEBUG=1 for a stack)")).toBe(true);
    });
  }

  /** A reader that stops early (`| head`) closes the pipe while the run
   * still writes: the next write fails with EPIPE, which must end the run
   * quietly with exit 0, not crash with an unhandled 'error' event. */
  for (const runtime of ["node", "bun"]) {
    test(`under ${runtime}, a reader closing the pipe early exits 0 without a stack`, () => {
      const script =
        `"$0" "$1" rank -r x -s github:a/b 2>&1 >/dev/null | head -c 64 >/dev/null; ` +
        `echo "status=\${PIPESTATUS[0]}"`;
      const proc = Bun.spawnSync(["bash", "-c", script, runtime, bin], {
        cwd: project,
        env: { ...process.env },
      });
      expect(proc.stdout.toString().trim()).toBe("status=0");
      expect(proc.stderr.toString()).toBe("");
    });
  }
});
