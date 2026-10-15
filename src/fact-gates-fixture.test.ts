/**
 * Fact gates end to end over the real GitHub fixture page (#2): the
 * fixture rubric plus the two fact gates the shipped rubric uses, ranked
 * through the CLI over the offline network. Fact gates add no questions,
 * so the existing recorded decision-model answers replay unchanged.
 *
 * The fixture's gate-only counts (src/fixtures/github-issues.json):
 * #1 (pinned by the security gate) has an open blocker and an open closing
 * pull request, #3 has an open blocker, #6 has an open closing pull request.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./cli.js";
import { type CapturedIo, captureIo, fixtureProject, fixtureRoot, removeRoot } from "./fixtures/project.js";
import { FIXTURE_NOW, type RequestCounts } from "./fixtures/replay.js";
import type { Project } from "./loader.js";
import { RUBRIC_DIR } from "./rubric.js";

const FACT_GATES = `
fact_gates:
  - id: blocked
    fact: open_blockers
    at_least: 1
    action: sink
  - id: in_progress
    fact: open_closing_prs
    at_least: 1
    action: hold
`;

interface Row {
  key: string;
  pinnedBy: string[];
  heldBy: string[];
  sunkBy: string[];
}

let root: string;
let cap: CapturedIo;
let counts: RequestCounts;
let project: Project;

beforeEach(() => {
  root = fixtureRoot("fact-gates-fixture");
  appendFileSync(join(root, RUBRIC_DIR, "fixture.yaml"), FACT_GATES);
  const fixture = fixtureProject(root);
  project = fixture.project;
  counts = fixture.counts;
  cap = captureIo();
});

afterEach(() => {
  removeRoot(root);
});

const rankJson = async (): Promise<{ ranked: Row[]; held: Row[] }> => {
  const code = await run(["rank", "-r", "fixture", "-s", "github:kit/kit", "--json"], cap.io, {
    resolve: () => project,
    cwd: () => root,
    now: () => FIXTURE_NOW,
  });
  expect(code).toBe(0);
  return JSON.parse(cap.stdout()) as { ranked: Row[]; held: Row[] };
};

describe("fact gates over the GitHub fixture page", () => {
  test("replay the existing recordings: one request per ticket, none unrecorded", async () => {
    await rankJson();
    expect(counts).toEqual({ github: 1, linear: 0, jev: 6, other: 0 });
  });

  test("an open closing pull request holds the ticket, even the pinned one", async () => {
    const { ranked, held } = await rankJson();
    const heldKeys = held.map((r) => r.key);
    expect(heldKeys).toContain("kit/kit#1");
    expect(heldKeys).toContain("kit/kit#6");
    expect(held.find((r) => r.key === "kit/kit#1")?.heldBy).toContain("in_progress");
    expect(ranked.map((r) => r.key)).not.toContain("kit/kit#1");
  });

  test("an open blocker sinks an unpinned ticket below every normal one", async () => {
    const { ranked } = await rankJson();
    const keys = ranked.map((r) => r.key);
    expect(ranked.find((r) => r.key === "kit/kit#3")?.sunkBy).toEqual(["blocked"]);
    expect(keys.at(-1)).toBe("kit/kit#3");
    for (const row of ranked.filter((r) => r.key !== "kit/kit#3")) expect(row.sunkBy).toEqual([]);
  });

  test("the text table flags each outcome", async () => {
    const code = await run(["rank", "-r", "fixture", "-s", "github:kit/kit"], cap.io, {
      resolve: () => project,
      cwd: () => root,
      now: () => FIXTURE_NOW,
    });
    expect(code).toBe(0);
    const out = cap.stdout();
    const row = (key: string): string => out.split("\n").find((l) => l.includes(` ${key} `)) ?? "";
    expect(row("kit/kit#1")).toContain("held:in_progress");
    expect(row("kit/kit#3")).toContain("sunk:blocked");
    expect(row("kit/kit#6")).toContain("held:in_progress");
  });
});
