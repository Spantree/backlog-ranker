/**
 * `explain` end to end at the CLI seam, over the offline fixture network:
 * one ticket's composite, per-criterion level distribution, gates and
 * flags, answered from the cache after a `rank`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR } from "./cache.js";
import { run } from "./cli.js";
import {
  type CapturedIo,
  captureIo,
  FIXTURE_HASH,
  fixtureProject,
  fixtureRoot,
  removeRoot,
} from "./fixtures/project.js";
import { FIXTURE_NOW, type RequestCounts } from "./fixtures/replay.js";
import type { Project } from "./loader.js";
import { RUBRIC_DIR } from "./rubric.js";

let root: string;
let counts: RequestCounts;
let resolve: () => Project;
let cap: CapturedIo;

beforeEach(() => {
  root = fixtureRoot("explain");
  cap = captureIo();
  const fixture = fixtureProject(root);
  counts = fixture.counts;
  resolve = () => fixture.project;
});

afterEach(() => {
  removeRoot(root);
});

const opts = () => ({ resolve: () => resolve(), cwd: () => root, now: () => FIXTURE_NOW });
const explain = (...argv: string[]): Promise<number> => run(["explain", ...argv], cap.io, opts());
const rank = (...argv: string[]): Promise<number> => run(["rank", ...argv], cap.io, opts());
const stdout = (): string => cap.stdout();
const stderr = (): string => cap.stderr();

describe("explain", () => {
  test("cold, prints one ticket's reasoning after exactly one engine request", async () => {
    expect(await explain("--rubric", "fixture", "kit/kit#1")).toBe(0);
    expect(stderr()).toBe("");
    expect(counts).toEqual({ github: 1, jev: 1, other: 0 });
    const text = stdout();
    expect(text.split("\n")[0]).toContain(`(sha ${FIXTURE_HASH}), source github:kit/kit`);
    expect(text).toContain("engine typesafe/jev-1.14 via openrouter");
    expect(text).toContain("kit/kit#1");
    expect(text).toContain("Executor launches print the API key into the pane");
    expect(text).toMatch(/composite \d+\.\d{3}/);
    // Every level of every criterion is printed with its wording and probability.
    expect(text).toContain("Prevents a leaked secret, lost work, or silently wrong results");
    expect(text).toContain("A new subsystem that needs its own design decisions");
    expect(text).toMatch(/security[^\n]*\d\.\d\d ≥ 0\.50[^\n]*pinned/);
    expect(text).toContain("pinned:security");
  });

  test("after a rank, answers every question from the cache and sends no engine request", async () => {
    expect(await rank("--rubric", "fixture", "--source", "github:kit/kit")).toBe(0);
    const before = { ...counts };
    cap.clear();
    expect(await explain("-r", "fixture", "kit/kit#3")).toBe(0);
    expect(stderr()).toBe("");
    expect(counts.jev).toBe(before.jev);
    // The ticket itself is still read from GitHub: one lookup.
    expect(counts.github - before.github).toBe(1);
    expect(stdout()).toContain("Engine: 0 requests; answers from cache 4, asked 0.");
  });

  test("--rubric takes a file path, resolved against the project root", async () => {
    const path = join(RUBRIC_DIR, "fixture.yaml");
    expect(await explain("-r", path, "kit/kit#1", "--json")).toBe(0);
    expect(JSON.parse(stdout())).toMatchObject({ rubricPath: path, rubricHash: FIXTURE_HASH });
  });

  test("a held ticket shows the gate under its threshold and the hold", async () => {
    expect(await explain("-r", "fixture", "kit/kit#5")).toBe(0);
    expect(stdout()).toMatch(/gate judgeable[^\n]*\d\.\d\d < 0\.50: held/);
    expect(stdout()).toContain("held:judgeable");
  });

  test("each criterion's level probabilities read as a distribution summing to one", async () => {
    expect(await explain("-r", "fixture", "kit/kit#2")).toBe(0);
    const blocks = stdout()
      .split(/\n(?=\w+ \((?:benefit|cost))/)
      .slice(1);
    expect(blocks.length).toBe(2);
    for (const block of blocks) {
      const probs = [...block.matchAll(/^ {2}\d {2}(\d\.\d\d) {2}/gm)].map((m) => Number(m[1]));
      expect(probs.length).toBe(5);
      expect(Math.abs(probs.reduce((a, b) => a + b, 0) - 1)).toBeLessThanOrEqual(0.03);
    }
  });

  test("--json carries the facade result with the run header", async () => {
    expect(await explain("--rubric", "fixture", "kit/kit#1", "-j")).toBe(0);
    const json = JSON.parse(stdout()) as {
      criteria: { id: string; levels: { index: number; text: string; probability: number }[] }[];
      gates: { id: string; triggered: boolean }[];
      flags: { pinnedBy: string[] };
      stats: { requests: number };
    };
    expect(json).toMatchObject({
      rubric: "fixture-roi",
      rubricPath: join(RUBRIC_DIR, "fixture.yaml"),
      rubricHash: FIXTURE_HASH,
      source: "github:kit/kit",
      engine: "typesafe",
      model: "jev-1.14",
      backend: "openrouter",
      key: "kit/kit#1",
      title: "Executor launches print the API key into the pane",
      url: "https://github.com/kit/kit/issues/1",
      flags: { pinnedBy: ["security"], heldBy: [], lowConfidence: [], truncated: false },
    });
    // Truncation is a flag only, not repeated at the top level.
    expect(json).not.toHaveProperty("truncated");
    expect(typeof (json as unknown as { composite: number }).composite).toBe("number");
    expect(json.criteria.map((c) => c.id)).toEqual(["impact", "effort"]);
    expect(json.criteria[0]?.levels[4]).toMatchObject({
      index: 4,
      text: "Prevents a leaked secret, lost work, or silently wrong results",
    });
    for (const c of json.criteria) {
      expect(Math.abs(c.levels.reduce((s, l) => s + l.probability, 0) - 1)).toBeLessThan(1e-6);
    }
    expect(json.gates).toMatchObject([
      { id: "security", action: "pin_top", threshold: 0.5, triggered: true },
      { id: "judgeable", action: "flag_if_below", threshold: 0.5, triggered: false },
    ]);
    expect(json.stats.requests).toBe(1);
  });

  test.each([["kit/kit"], ["kit#1"], ["github:kit/kit#1"], ["kit/kit#0"]])(
    "a malformed key %s refuses with zero requests",
    async (key) => {
      expect(await explain("--rubric", "fixture", key)).toBe(1);
      // A refusal prints its message first, with no class-name prefix.
      expect(stderr()).toStartWith("an issue key looks like");
      expect(stderr()).toContain("<owner>/<repo>#<number>");
      expect(counts).toEqual({ github: 0, jev: 0, other: 0 });
    },
  );

  test("a key whose repository is not allowlisted refuses before the rubric, with zero requests", async () => {
    expect(await explain("--rubric", "no-such-rubric", "other/repo#1")).toBe(1);
    expect(stdout()).toBe("");
    expect(stderr()).toContain("github:other/repo is not on the backlog source allowlist");
    expect(stderr()).toContain("No request was sent");
    expect(counts).toEqual({ github: 0, jev: 0, other: 0 });
    expect(existsSync(join(root, CACHE_DIR))).toBe(false);
  });

  test("a key's repository matches the allowlist whatever its case", async () => {
    expect(await explain("--rubric", "fixture", "Kit/KIT#1")).toBe(0);
    expect(counts).toEqual({ github: 1, jev: 1, other: 0 });
  });

  test.each([
    [["kit/kit#1"], "--rubric is required"],
    [["--rubric", "fixture"], "exactly one issue key"],
    [["--rubric", "fixture", "kit/kit#1", "kit/kit#2"], "exactly one issue key"],
  ])("usage error %j refuses, sending nothing", async (argv, message) => {
    expect(await explain(...argv)).toBe(1);
    expect(stderr()).toContain(message);
    expect(counts).toEqual({ github: 0, jev: 0, other: 0 });
  });
});
