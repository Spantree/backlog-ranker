/**
 * A `linear:<TEAM>` source end to end at the CLI seam: `rank`,
 * `calibrate` and `explain` over the offline fixture network, whose
 * Linear team carries the same tickets as the GitHub page, so the
 * existing recorded Jev answers replay for both.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR } from "./cache.js";
import { run } from "./cli.js";
import {
  type CapturedIo,
  captureIo,
  type FixtureProjectOptions,
  fixtureProject,
  fixtureRoot,
  removeRoot,
} from "./fixtures/project.js";
import { FIXTURE_DIR, FIXTURE_NOW, type RequestCounts } from "./fixtures/replay.js";
import type { Project } from "./loader.js";

const LINEAR_ONLY = { sources: ["linear:KIT"] };
const JEV_RECORDINGS = readdirSync(join(FIXTURE_DIR, "jev")).sort();

let roots: string[];
let cap: CapturedIo;

beforeEach(() => {
  roots = [];
  cap = captureIo();
});

afterEach(() => {
  for (const root of roots) removeRoot(root);
});

interface Fixture {
  root: string;
  counts: RequestCounts;
  cli(...argv: string[]): Promise<number>;
}

/** A fresh project root over its own fixture network. */
function fixture(options: FixtureProjectOptions = LINEAR_ONLY): Fixture {
  const root = fixtureRoot("linear");
  roots.push(root);
  const { project, counts } = fixtureProject(root, options);
  const resolve = (): Project => project;
  return {
    root,
    counts,
    cli: (...argv) => run(argv, cap.io, { resolve, cwd: () => root, now: () => FIXTURE_NOW }),
  };
}

interface Row {
  position: number | null;
  key: string;
  composite: number;
  pinnedBy: unknown;
  heldBy: unknown;
}

function rows(json: string): Row[] {
  const report = JSON.parse(json) as { ranked: Row[]; held: Row[] };
  return [...report.ranked, ...report.held].map(({ position, key, composite, pinnedBy, heldBy }) => ({
    position,
    key,
    composite,
    pinnedBy,
    heldBy,
  }));
}

describe("rank -s linear:KIT", () => {
  test("ranks the Linear team from the existing Jev recordings, matching the GitHub run", async () => {
    const github = fixture({ sources: ["github:kit/kit"] });
    expect(await github.cli("rank", "-r", "fixture", "-s", "github:kit/kit", "-j")).toBe(0);
    const githubRows = rows(cap.stdout());
    cap.clear();

    const linear = fixture();
    expect(await linear.cli("rank", "-r", "fixture", "-s", "linear:kit", "-j")).toBe(0);
    expect(cap.stderr()).toBe("");
    const report = JSON.parse(cap.stdout()) as { source: string };
    expect(report.source).toBe("linear:KIT");
    // Every state hashed to an existing recording: none answered 404.
    expect(linear.counts).toEqual({ github: 0, linear: 2, jev: 6, other: 0 });
    expect(rows(cap.stdout())).toEqual(
      githubRows.map((r) => ({ ...r, key: r.key.replace("kit/kit#", "KIT-") })),
    );
    expect(rows(cap.stdout())[0]).toMatchObject({ position: 1, key: "KIT-1" });
    expect(readdirSync(join(FIXTURE_DIR, "jev")).sort()).toEqual(JEV_RECORDINGS);
  });

  test("the tie-break replays the recorded pairwise answers in the same order", async () => {
    const linear = fixture();
    expect(await linear.cli("rank", "-r", "fixture", "-s", "linear:KIT", "-t", "10")).toBe(0);
    const table = cap.stdout();
    expect(table).toMatch(/Tie-break over the top 4: 3 pairs, 3 requests/);
    const order = table
      .split("\n")
      .filter((l) => /^\d\s/.test(l))
      .map((l) => l.split(/\s+/)[1]);
    expect(order).toEqual(["KIT-1", "KIT-3", "KIT-2", "KIT-6"]);
    expect(linear.counts).toEqual({ github: 0, linear: 2, jev: 9, other: 0 });
  });

  test("an unlisted Linear team refuses with zero requests and no cache", async () => {
    const linear = fixture();
    expect(await linear.cli("rank", "-r", "fixture", "-s", "linear:EVA")).toBe(1);
    expect(cap.stdout()).toBe("");
    expect(cap.stderr()).toContain("linear:EVA is not on the backlog source allowlist");
    expect(cap.stderr()).toContain("No request was sent");
    expect(linear.counts).toEqual({ github: 0, linear: 0, jev: 0, other: 0 });
    expect(existsSync(join(linear.root, CACHE_DIR))).toBe(false);
  });

  test("a misspelt linear.states entry refuses naming it, before any issue or engine request", async () => {
    const linear = fixture({ ...LINEAR_ONLY, linearStates: ["Backlog", "Tod"] });
    expect(await linear.cli("rank", "-r", "fixture", "-s", "linear:KIT")).toBe(1);
    expect(cap.stderr()).toContain('linear.states "Tod" matches no workflow state of team KIT');
    expect(cap.stderr()).toContain("Todo (unstarted)");
    expect(linear.counts).toEqual({ github: 0, linear: 1, jev: 0, other: 0 });
  });
});

describe("calibrate -s linear:KIT", () => {
  test("reads the hand ranking's keys, full or bare, from Linear", async () => {
    const linear = fixture();
    const hand = "KIT-1,kit-3,6,#2,KIT-4,5";
    expect(await linear.cli("calibrate", "-r", "fixture", "-s", "linear:KIT", "--hand", hand, "-j")).toBe(2);
    const report = JSON.parse(cap.stdout()) as { hand: string[]; tool: string[] };
    expect(report.hand).toEqual(["KIT-1", "KIT-3", "KIT-6", "KIT-2", "KIT-4", "KIT-5"]);
    expect([...report.tool].sort()).toEqual([...report.hand].sort());
    expect(linear.counts).toEqual({ github: 0, linear: 6, jev: 6, other: 0 });
  });

  test("a key from another team refuses with zero requests", async () => {
    const linear = fixture();
    expect(
      await linear.cli("calibrate", "-r", "fixture", "-s", "linear:KIT", "--hand", "KIT-1,EVA-2,kit/kit#3"),
    ).toBe(1);
    expect(cap.stderr()).toContain("--hand: EVA-2, kit/kit#3 not in the KIT team");
    expect(cap.stderr()).toContain("No request was sent");
    expect(linear.counts).toEqual({ github: 0, linear: 0, jev: 0, other: 0 });
  });

  test("an unlisted Linear team refuses with zero requests and no cache", async () => {
    const linear = fixture();
    expect(await linear.cli("calibrate", "-r", "fixture", "-s", "linear:EVA", "--hand", "EVA-1,EVA-2")).toBe(
      1,
    );
    expect(cap.stderr()).toContain("linear:EVA is not on the backlog source allowlist");
    expect(linear.counts).toEqual({ github: 0, linear: 0, jev: 0, other: 0 });
    expect(existsSync(join(linear.root, CACHE_DIR))).toBe(false);
  });
});

describe("explain TEAM-N", () => {
  test("derives linear:KIT and, after a rank, answers from the cache with one Linear lookup", async () => {
    const linear = fixture();
    expect(await linear.cli("rank", "-r", "fixture", "-s", "linear:KIT")).toBe(0);
    const before = { ...linear.counts };
    cap.clear();
    expect(await linear.cli("explain", "-r", "fixture", "kit-3")).toBe(0);
    expect(cap.stderr()).toBe("");
    expect(cap.stdout().split("\n")[0]).toContain("source linear:KIT");
    expect(cap.stdout()).toContain("KIT-3");
    expect(cap.stdout()).toContain("Engine: 0 requests; answers from cache 4, asked 0.");
    expect(linear.counts.linear - before.linear).toBe(1);
    expect(linear.counts.jev).toBe(before.jev);
  });

  test("a key whose team is not allowlisted refuses before the rubric, with zero requests", async () => {
    const linear = fixture();
    expect(await linear.cli("explain", "-r", "no-such-rubric", "EVA-12")).toBe(1);
    expect(cap.stderr()).toContain("linear:EVA is not on the backlog source allowlist");
    expect(linear.counts).toEqual({ github: 0, linear: 0, jev: 0, other: 0 });
    expect(existsSync(join(linear.root, CACHE_DIR))).toBe(false);
  });
});

describe("help", () => {
  test.each([["rank"], ["calibrate"]])("%s --help names both source kinds", async (verb) => {
    const linear = fixture();
    expect(await linear.cli(verb, "--help")).toBe(0);
    expect(cap.stdout()).toContain("github:owner/repo or linear:TEAM");
    expect(cap.stdout()).not.toContain("planned");
  });

  test("explain --help names both key spellings", async () => {
    const linear = fixture();
    expect(await linear.cli("explain", "--help")).toBe(0);
    expect(cap.stdout()).toContain("<owner/repo#123|TEAM-123>");
    expect(cap.stdout()).not.toContain("GitHub lookup");
  });
});
