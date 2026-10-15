/**
 * `rank --allow-once` at the CLI seam, with the real project loader in a
 * temp directory and its engine and tracker over the offline fixture
 * network: a one-run admission that prints what leaves the machine and
 * never writes a config file.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliIo, run } from "./cli.js";
import { FIXTURE_DIR, FIXTURE_NOW, type RequestCounts, replayFetch } from "./fixtures/replay.js";
import { loadProject } from "./loader.js";

const RUBRIC_FILE = join(FIXTURE_DIR, "rubric.yaml");
const ENV = { GITHUB_TOKEN: "t", OPENROUTER_API_KEY: "k", TYPESAFE_API_KEY: "k" };

let root: string;
let counts: RequestCounts;
let rank: (...argv: string[]) => Promise<number>;
let out: string[];
let err: string[];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "backlog-decisions-allow-once-")));
  out = [];
  err = [];
  const net = replayFetch();
  counts = net.counts;
  const io: CliIo = {
    stdout: (text) => {
      out.push(text);
    },
    stderr: (text) => {
      err.push(text);
    },
    env: ENV,
  };
  rank = (...argv) =>
    run(["rank", ...argv], io, {
      resolve: (cwd, env, options) => loadProject(cwd, env, { ...options, fetch: net.fetch }),
      cwd: () => root,
      now: () => FIXTURE_NOW,
    });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const stdout = (): string => out.join("");
const stderr = (): string => err.join("");

function writeConfig(text: string): string {
  mkdirSync(join(root, ".backlog-decisions"), { recursive: true });
  const path = join(root, ".backlog-decisions", "config.yaml");
  writeFileSync(path, text);
  return path;
}

describe("rank --allow-once", () => {
  test("with no config and --backend, ranks, prints the notice, and writes only the cache", async () => {
    const code = await rank(
      "--rubric",
      RUBRIC_FILE,
      "--source",
      "github:kit/kit",
      "--allow-once",
      "--backend",
      "openrouter",
    );
    expect(stderr()).toBe(
      "the titles, bodies and labels of open issues in github:kit/kit will be sent to openrouter " +
        "for this run only; nothing is saved to config\n",
    );
    expect(code).toBe(0);
    expect(counts).toEqual({ github: 1, jev: 6, other: 0 });
    expect(stdout()).toContain("kit/kit#1");
    expect(readdirSync(root)).toEqual([".backlog-decisions"]);
    expect(readdirSync(join(root, ".backlog-decisions"))).toEqual(["cache"]);
  });

  test("with a config, admits an unlisted source for the run without touching config.yaml", async () => {
    const path = writeConfig("sources:\n  - github:other/repo\nbackend: openrouter\n");
    const before = readFileSync(path);
    expect(await rank("-r", RUBRIC_FILE, "-s", "github:kit/kit", "--allow-once")).toBe(0);
    expect(stderr()).toContain("open issues in github:kit/kit will be sent to openrouter for this run only");
    expect(counts.github).toBe(1);
    expect(stdout()).toContain(".backlog-decisions/config.yaml");
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readdirSync(join(root, ".backlog-decisions")).sort()).toEqual(["cache", "config.yaml"]);
  });

  test("with a config, --backend overrides its backend for the run only", async () => {
    const path = writeConfig("sources:\n  - github:kit/kit\nbackend: typesafe\n");
    const before = readFileSync(path);
    expect(
      await rank("-r", RUBRIC_FILE, "-s", "github:kit/kit", "--allow-once", "--backend", "openrouter"),
    ).toBe(0);
    expect(stderr()).toContain("will be sent to openrouter");
    expect(stdout()).toContain("via openrouter");
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  test("--backend without --allow-once refuses with zero requests", async () => {
    writeConfig("sources:\n  - github:kit/kit\nbackend: typesafe\n");
    expect(await rank("-r", RUBRIC_FILE, "-s", "github:kit/kit", "--backend", "openrouter")).toBe(1);
    expect(stderr()).toContain("--backend is accepted only with --allow-once");
    expect(stdout()).toBe("");
    expect(counts).toEqual({ github: 0, jev: 0, other: 0 });
  });

  test("an unknown --backend refuses naming both backends", async () => {
    expect(await rank("-r", RUBRIC_FILE, "-s", "github:kit/kit", "--allow-once", "--backend", "acme")).toBe(
      1,
    );
    expect(stderr()).toContain('--backend takes typesafe or openrouter, not "acme"');
    expect(counts).toEqual({ github: 0, jev: 0, other: 0 });
  });

  test("--allow-once with no config and no --backend refuses, writing nothing", async () => {
    expect(await rank("-r", RUBRIC_FILE, "-s", "github:kit/kit", "--allow-once")).toBe(1);
    expect(stderr()).toContain("--backend is required with --allow-once when no config exists");
    expect(counts).toEqual({ github: 0, jev: 0, other: 0 });
    expect(readdirSync(root)).toEqual([]);
  });

  test("a relative rubric file path resolves against the working directory", async () => {
    writeFileSync(join(root, "mine.yml"), readFileSync(RUBRIC_FILE));
    expect(
      await rank("-r", "mine.yml", "-s", "github:kit/kit", "--allow-once", "--backend", "openrouter"),
    ).toBe(0);
    expect(stdout()).toContain("mine.yml");
    expect(counts.jev).toBe(6);
  });

  test("a missing rubric file refuses naming it", async () => {
    expect(
      await rank("-r", "./nope.yaml", "-s", "github:kit/kit", "--allow-once", "--backend", "openrouter"),
    ).toBe(1);
    expect(stderr()).toContain("no rubric file ./nope.yaml");
    expect(counts).toEqual({ github: 0, jev: 0, other: 0 });
  });
});
