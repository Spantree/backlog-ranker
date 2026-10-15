/**
 * `calibrate` end to end at the CLI seam: run(argv, io) with an injected
 * project resolver whose engine and tracker run over the offline fixture
 * network. Ported from evie-kit's backlog CLI suite.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { run } from "./cli.js";
import type { DecisionAnswer, DecisionEngine } from "./engine.js";
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
import type { Ticket } from "./ticket.js";
import type { Tracker } from "./trackers/tracker.js";

const SIX = "kit/kit#1,kit/kit#3,kit/kit#6,kit/kit#2,kit/kit#4,kit/kit#5";

let root: string;
let counts: RequestCounts;
let resolve: () => Project;
let cap: CapturedIo;

beforeEach(() => {
  root = fixtureRoot("calibrate");
  cap = captureIo();
  const fixture = fixtureProject(root);
  counts = fixture.counts;
  resolve = () => fixture.project;
});

afterEach(() => {
  removeRoot(root);
});

const calibrate = (...argv: string[]): Promise<number> =>
  run(["calibrate", ...argv], cap.io, { resolve: () => resolve(), cwd: () => root, now: () => FIXTURE_NOW });
const stdout = (): string => cap.stdout();
const stderr = (): string => cap.stderr();

describe("calibrate", () => {
  test("six fixture tickets report tau and NOT TRUSTED, naming the engine, and exit 2", async () => {
    expect(await calibrate("--rubric", "fixture", "--source", "github:kit/kit", "--hand", SIX)).toBe(2);
    expect(stderr()).toBe("");
    expect(counts).toEqual({ github: 6, jev: 6, other: 0 });
    const text = stdout();
    expect(text).toContain("backlog-decisions calibrate: rubric fixture-roi");
    expect(text).toContain(`(sha ${FIXTURE_HASH})`);
    expect(text).toContain("6 tickets");
    expect(text).toContain("engine typesafe/jev-1.14 via openrouter");
    expect(text).toContain("Lint gate crashes on every goal that renames a file");
    expect(text).toMatch(/Kendall's tau -?\d\.\d{3} \(\d+ concordant, \d+ discordant pairs\)/);
    // Six tickets is under the twelve the trust rule needs, whatever tau is.
    expect(text).toContain("NOT TRUSTED: needs tau >= 0.4 on at least 12 tickets");
    expect(text).toContain("Engine: 6 tickets, 6 requests; answers from cache 0, asked 24.");
    expect(text).toContain("Pairs the rubric orders against the hand ranking");
    expect(text).toContain("kit/kit#3 over kit/kit#2");
  });

  test("--json carries the rubric, engine, both orders, stats and the calibration", async () => {
    expect(await calibrate("-r", "fixture", "-s", "github:kit/kit", "--hand", SIX, "-j")).toBe(2);
    const report = JSON.parse(stdout()) as Record<string, unknown>;
    expect(report).toMatchObject({
      rubric: "fixture-roi",
      rubricHash: FIXTURE_HASH,
      rubricPath: ".backlog-decisions/rubrics/fixture.yaml",
      engine: "typesafe",
      model: "jev-1.14",
      hand: SIX.split(","),
      n: 6,
      trusted: false,
    });
    expect(report.tool).toEqual([
      "kit/kit#1",
      "kit/kit#2",
      "kit/kit#3",
      "kit/kit#6",
      "kit/kit#5",
      "kit/kit#4",
    ]);
    expect(report.stats).toMatchObject({ tickets: 6, requests: 6 });
    expect(report).toMatchObject({ concordant: 12, discordant: 3, tau: 0.6 });
    expect(report.disagreements).toContainEqual({ above: "kit/kit#3", below: "kit/kit#2" });
  });

  test("bare #N and N keys expand to the source's repository, whatever the case", async () => {
    const hand = " #1, 3 ,KIT/Kit#6,kit/kit#2,#4,5";
    expect(await calibrate("-r", "fixture", "-s", "github:kit/kit", "--hand", hand, "--json")).toBe(2);
    expect((JSON.parse(stdout()) as { hand: string[] }).hand).toEqual(SIX.split(","));
  });

  test.each([
    ["a duplicate key", "kit/kit#1,#1", "lists a key twice"],
    ["a single key", "kit/kit#1", "at least two"],
    ["another repository's key", "kit/kit#1,other/repo#2", "other/repo#2 not in kit/kit"],
    ["a key that is not an issue", "kit/kit#1,KIT-2", "KIT-2 not in kit/kit"],
  ])("%s refuses with exit 1 and zero requests", async (_, hand, message) => {
    expect(await calibrate("-r", "fixture", "-s", "github:kit/kit", "--hand", hand)).toBe(1);
    expect(stdout()).toBe("");
    expect(stderr()).toContain(message);
    expect(counts).toEqual({ github: 0, jev: 0, other: 0 });
  });

  test("a source absent from the allowlist refuses before the rubric is read, with zero requests", async () => {
    expect(await calibrate("-r", "no-such-rubric", "-s", "github:other/repo", "--hand", "#1,#2")).toBe(1);
    expect(stderr()).toContain("github:other/repo is not on the backlog source allowlist");
    expect(stderr()).not.toContain("no rubric");
    expect(counts).toEqual({ github: 0, jev: 0, other: 0 });
  });

  test("--rubric takes a file path, resolved against the project root", async () => {
    const path = join(RUBRIC_DIR, "fixture.yaml");
    expect(await calibrate("-r", path, "-s", "github:kit/kit", "--hand", SIX, "--json")).toBe(2);
    expect(JSON.parse(stdout())).toMatchObject({ rubricPath: path, rubricHash: FIXTURE_HASH });
  });

  test("--hand is required", async () => {
    expect(await calibrate("-r", "fixture", "-s", "github:kit/kit")).toBe(1);
    expect(stderr()).toContain("--hand is required");
  });

  test("twelve tickets the rubric orders as the hand does are TRUSTED and exit 0", async () => {
    // A stub engine and tracker at the resolver seam: ticket N's impact
    // falls as N rises, so the tool's order is the hand's order.
    const tickets: Ticket[] = Array.from({ length: 12 }, (_, i) => ({
      key: `kit/kit#${i + 1}`,
      title: `ticket ${i + 1}`,
      body: "a concrete change",
      labels: [],
      url: `https://github.com/kit/kit/issues/${i + 1}`,
      createdAt: "2026-10-01T00:00:00Z",
      reactions: 0,
      linkedIssues: 0,
      duplicates: 0,
    }));
    const engine: DecisionEngine = {
      id: "stub",
      model: "stub-1",
      async decide(state, questions) {
        const n = Number((state as { title: string }).title.split(" ")[1]);
        const answers: Record<string, DecisionAnswer> = {};
        for (const [id, q] of Object.entries(questions)) {
          answers[id] =
            q.kind === "noul"
              ? { kind: "noul", probability: id === "security" ? 0.1 : 0.9 }
              : { kind: "score", value: id === "impact" ? 4 - n / 4 : 1, probabilities: [], confidence: 0.9 };
        }
        return { servedModel: "stub-1", answers };
      },
    };
    const tracker: Tracker = {
      source: "github:kit/kit",
      pending: async () => tickets,
      issues: async (keys) => tickets.filter((t) => keys.includes(t.key)),
    };
    const { project } = fixtureProject(root);
    resolve = () => ({ ...project, engine: () => engine, tracker: () => tracker });
    const hand = tickets.map((t) => t.key.replace("kit/kit", "")).join(",");
    expect(await calibrate("-r", "fixture", "-s", "github:kit/kit", "--hand", hand)).toBe(0);
    expect(stdout()).toContain("Kendall's tau 1.000 (66 concordant, 0 discordant pairs).");
    expect(stdout()).toContain("TRUSTED: tau >= 0.4 on at least 12 tickets.");
    expect(stdout()).not.toContain("NOT TRUSTED");
    expect(stdout()).not.toContain("Pairs the rubric orders against");
  });
});
