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
});
