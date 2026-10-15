/**
 * `rank` end to end at the CLI seam: run(argv, io) with an injected
 * project resolver whose engine and tracker run over the offline fixture
 * network (the recorded GitHub page and Jev answers). Ported from
 * evie-kit's backlog CLI suite.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CACHE_DIR } from "./cache.js";
import { type CliIo, run } from "./cli.js";
import { FIXTURE_DIR, FIXTURE_NOW, type RequestCounts, replayFetch } from "./fixtures/replay.js";
import { createJevEngine } from "./jev/index.js";
import type { Project } from "./loader.js";
import { RUBRIC_DIR, rubricHash } from "./rubric.js";
import { githubTracker } from "./trackers/github.js";

let root: string;
let counts: RequestCounts;
let resolve: () => Project;
let out: string[];
let err: string[];

const io: CliIo = {
  stdout: (text) => {
    out.push(text);
  },
  stderr: (text) => {
    err.push(text);
  },
  env: {},
};

const FIXTURE_HASH = rubricHash(readFileSync(join(FIXTURE_DIR, "rubric.yaml"), "utf8"));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "backlog-decisions-rank-"));
  mkdirSync(join(root, RUBRIC_DIR), { recursive: true });
  copyFileSync(join(FIXTURE_DIR, "rubric.yaml"), join(root, RUBRIC_DIR, "fixture.yaml"));
  out = [];
  err = [];
  const net = replayFetch();
  counts = net.counts;
  resolve = () => ({
    projectRoot: root,
    configPath: ".backlog-decisions/config.yaml",
    config: { sources: ["github:kit/kit"], backend: "openrouter", keys: {} },
    sources: ["github:kit/kit"],
    allowlistKey: "sources in .backlog-decisions/config.yaml",
    backend: "openrouter",
    engine: () => createJevEngine({ backend: "openrouter", apiKey: "k-test", fetch: net.fetch, retry: { maxRetries: 0 } }),
    tracker: (source) => {
      if (source.kind !== "github") throw new Error("fixture tracker is GitHub only");
      return githubTracker({ owner: source.owner, repo: source.repo, token: "t", fetch: net.fetch });
    },
  });
});

const rank = (...argv: string[]): Promise<number> =>
  run(["rank", ...argv], io, { resolve: () => resolve(), cwd: () => root, now: () => FIXTURE_NOW });
const stdout = (): string => out.join("");
const stderr = (): string => err.join("");

describe("rank", () => {
  test("prints a ranked table from recorded fixtures, with no live network", async () => {
    expect(await rank("--rubric", "fixture", "--source", "github:kit/kit")).toBe(0);
    expect(stderr()).toBe("");
    expect(counts).toEqual({ github: 1, jev: 6, other: 0 });
    const table = stdout();
    const lines = table.split("\n");
    const row = (key: string): string => lines.find((l) => l.includes(` ${key} `)) ?? "";
    expect(lines[0]).toContain("backlog-decisions rank: rubric fixture-roi");
    expect(lines[0]).toContain(`(sha ${FIXTURE_HASH})`);
    expect(lines[0]).toContain("source github:kit/kit");
    expect(table).toContain("engine typesafe/jev-1.14 via openrouter");
    expect(table).toContain(".backlog-decisions/config.yaml");
    // The security gate pins the leaked-key ticket above every other.
    expect(lines.find((l) => /^1\s/.test(l))).toContain("kit/kit#1");
    expect(row("kit/kit#1")).toContain("pinned:security");
    expect(row("kit/kit#1")).toMatch(/\d\.\d\d≥\d\.\d\d/);
    // Thin tickets are held for a human rather than ranked mid-table.
    expect(table).toMatch(/Held for a human[^\n]*: 2/);
    expect(row("kit/kit#5")).toContain("held:judgeable");
    expect(row("kit/kit#5")).toMatch(/\d\.\d\d<\d\.\d\d/);
    expect(row("kit/kit#4")).toContain("held:judgeable");
    // Every criterion shows a score and its confidence.
    expect(row("kit/kit#3")).toMatch(/\d\.\d\d c\d\.\d\d/);
    expect(table).toContain("Engine: 6 tickets, 6 requests; answers from cache 0, asked 24.");
  });

  test("a re-run with changed weights asks nothing: every answer comes from the cache", async () => {
    await rank("--rubric", "fixture", "--source", "github:kit/kit");
    const before = { ...counts };
    out.length = 0;
    expect(
      await rank("-r", "fixture", "-s", "github:kit/kit", "--weight", "impact=3", "-w", "effort=0.5"),
    ).toBe(0);
    expect(counts.jev).toBe(before.jev);
    expect(stdout()).toContain("6 tickets, 0 requests");
    expect(stdout()).toContain("answers from cache 24, asked 0");
    expect(stdout()).toContain("weights impact=3, effort=0.5 (cost)");
    expect(readdirSync(join(root, CACHE_DIR))).toEqual(["typesafe--jev-1.14.json"]);
  });

  test("a source absent from the allowlist refuses with zero requests and no cache", async () => {
    expect(await rank("--rubric", "fixture", "--source", "github:other/repo")).toBe(1);
    expect(stdout()).toBe("");
    expect(stderr()).toContain("github:other/repo is not on the backlog source allowlist");
    expect(stderr()).toContain("sources in .backlog-decisions/config.yaml");
    expect(stderr()).toContain("No request was sent");
    expect(counts).toEqual({ github: 0, jev: 0, other: 0 });
    expect(existsSync(join(root, CACHE_DIR))).toBe(false);
  });

  test("the allowlist is checked before the rubric is read", async () => {
    expect(await rank("--rubric", "no-such-rubric", "--source", "github:other/repo")).toBe(1);
    expect(stderr()).toContain("allowlist");
    expect(stderr()).not.toContain("no rubric");
  });

  test("an allowlisted source matches whatever case the flag uses", async () => {
    expect(await rank("--rubric", "fixture", "--source", "github:Kit/KIT")).toBe(0);
    expect(counts.github).toBe(1);
  });

  test("--json carries the per-criterion answers, the run stats and the rubric hash", async () => {
    expect(await rank("--rubric", "fixture", "--source", "github:kit/kit", "-j")).toBe(0);
    const json = JSON.parse(stdout()) as {
      rubric: string;
      rubricPath: string;
      rubricHash: string;
      configPath: string;
      source: string;
      engine: string;
      model: string;
      ranked: { position: number; key: string; answers: Record<string, { kind: string; confidence?: number }> }[];
      held: { position: null; key: string }[];
      stats: { requests: number };
    };
    expect(json).toMatchObject({
      rubric: "fixture-roi",
      rubricPath: join(RUBRIC_DIR, "fixture.yaml"),
      rubricHash: FIXTURE_HASH,
      configPath: ".backlog-decisions/config.yaml",
      source: "github:kit/kit",
      engine: "typesafe",
      model: "jev-1.14",
    });
    expect(json.ranked[0]).toMatchObject({ position: 1, key: "kit/kit#1" });
    expect(json.ranked[0]?.answers.impact?.kind).toBe("score");
    expect(typeof json.ranked[0]?.answers.impact?.confidence).toBe("number");
    expect(json.held.map((h) => h.key).sort()).toEqual(["kit/kit#4", "kit/kit#5"]);
    expect(json.stats.requests).toBe(6);
  });

  test("--tiebreak re-orders the top slice from recorded pairwise answers", async () => {
    expect(await rank("--rubric", "fixture", "--source", "github:kit/kit", "-t", "10")).toBe(0);
    const table = stdout();
    expect(table).toMatch(/Tie-break over the top 4: 3 pairs, 3 requests, 0 pairs from cache, 0 pairs cut/);
    const order = table
      .split("\n")
      .filter((l) => /^\d\s/.test(l))
      .map((l) => l.split(/\s+/)[1]);
    // The pin holds; the recorded pairwise answers put the crash above the typo.
    expect(order).toEqual(["kit/kit#1", "kit/kit#3", "kit/kit#2", "kit/kit#6"]);
    expect(counts).toEqual({ github: 1, jev: 9, other: 0 });
  });

  test("--concurrency bounds requests and still ranks", async () => {
    expect(await rank("--rubric", "fixture", "--source", "github:kit/kit", "--concurrency", "1")).toBe(0);
    expect(counts.jev).toBe(6);
  });

  test.each([
    [["--source", "github:kit/kit"], "--rubric is required"],
    [["--rubric", "fixture"], "--source is required"],
    [["--rubric", "fixture", "--source", "jira:X"], "--source takes"],
    [["--bogus"], "--bogus"],
    [["--rubric", "fixture", "--source", "github:kit/kit", "stray"], "unexpected argument stray"],
    [["--rubric", "fixture", "--source", "github:kit/kit", "--tiebreak", "11"], "--tiebreak takes"],
    [["--rubric", "fixture", "--source", "github:kit/kit", "--tiebreak", "0"], "--tiebreak takes"],
    [["--rubric", "fixture", "--source", "github:kit/kit", "--concurrency", "x"], "--concurrency takes"],
    [["--rubric", "fixture", "--source", "github:kit/kit", "--weight", "impact"], "--weight takes"],
    [["--rubric", "fixture", "--source", "github:kit/kit", "--weight", "nope=2"], "not a criterion"],
  ])("usage error %j refuses naming the problem, sending nothing", async (argv, message) => {
    expect(await rank(...argv)).toBe(1);
    // A refusal: message first, no stack frames.
    expect(stderr()).toMatch(/^\w*Error: /);
    expect(stderr()).not.toMatch(/^\s+at /m);
    expect(stderr()).toContain(message);
    expect(counts).toEqual({ github: 0, jev: 0, other: 0 });
  });

  test("--help prints the verb's usage on stdout and sends nothing", async () => {
    expect(await rank("--help")).toBe(0);
    expect(stdout()).toContain("backlog-decisions rank");
    expect(stderr()).toBe("");
    expect(counts).toEqual({ github: 0, jev: 0, other: 0 });
  });
});
