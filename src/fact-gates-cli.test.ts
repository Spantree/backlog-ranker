/**
 * Fact gates at the CLI seam: `rank` and `explain` through run(argv, io)
 * with the fixture project's resolver, its engine replaced by the stub
 * and its tracker by in-memory tickets carrying the facts under test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./cli.js";
import { BRIEF_GATES, FACT_GATE_FIXTURE, NOW, stubEngine, ticket } from "./fixtures/fact-gates.js";
import { type CapturedIo, captureIo, fixtureProject, fixtureRoot, removeRoot } from "./fixtures/project.js";
import type { Project } from "./loader.js";
import { RUBRIC_DIR } from "./rubric.js";
import type { Ticket } from "./ticket.js";
import type { Tracker } from "./trackers/tracker.js";

let root: string;
let cap: CapturedIo;
let engine: ReturnType<typeof stubEngine>;

const TICKETS: Ticket[] = [
  ticket(1, "big win", { openBlockers: 1 }),
  ticket(2, "middling"),
  ticket(3, "cheap small", { openClosingPrs: 1, assignees: 2 }),
  ticket(4, "token in a log", { openClosingPrs: 1 }),
  ticket(5, "vague leak", { openBlockers: 2 }),
];

const writeRubric = (factGates: string): void => {
  writeFileSync(join(root, RUBRIC_DIR, "gated.yaml"), `${FACT_GATE_FIXTURE}${factGates}`);
};

beforeEach(() => {
  root = fixtureRoot("fact-gates");
  cap = captureIo();
  engine = stubEngine();
  writeRubric(BRIEF_GATES);
});

afterEach(() => {
  removeRoot(root);
});

const resolve = (): Project => {
  const { project } = fixtureProject(root);
  const tracker: Tracker = {
    source: "github:kit/kit",
    pending: async () => TICKETS,
    issues: async (keys) => TICKETS.filter((t) => keys.includes(t.key)),
  };
  return { ...project, engine: () => engine, tracker: () => tracker };
};
const verb = (name: string, ...argv: string[]): Promise<number> =>
  run([name, ...argv], cap.io, { resolve, cwd: () => root, now: () => NOW });
const rank = (...argv: string[]) => verb("rank", "-r", "gated", "-s", "github:kit/kit", ...argv);
const explain = (...argv: string[]) => verb("explain", "-r", "gated", ...argv);

/** The table's lines for ranked positions and held rows, as [position, key, flags]. */
function rows(table: string): string[][] {
  return table
    .split("\n")
    .filter((l) => /^(\d+|-)\s+kit\/kit#/.test(l))
    .map((l) => {
      const [position, key] = l.split(/\s+/);
      const flags = l.match(/(?:pinned|held|sunk|low-confidence):\S+/g) ?? [];
      return [position ?? "", key ?? "", flags.join(" ")];
    });
}

describe("rank with fact gates", () => {
  test("pinned, normal, sunk, then the held block, each flagged by its gate", async () => {
    expect(await rank()).toBe(0);
    expect(cap.stderr()).toBe("");
    const table = cap.stdout();
    // #5 is pinned (security) and blocked: the pin wins, it is not sunk.
    // #4 is pinned with an open closing pull request: the hold wins.
    expect(rows(table)).toEqual([
      ["1", "kit/kit#5", "pinned:security held:judgeable"],
      ["2", "kit/kit#2", ""],
      ["3", "kit/kit#1", "sunk:blocked"],
      ["-", "kit/kit#3", "held:in_progress"],
      ["-", "kit/kit#4", "pinned:security held:in_progress"],
    ]);
    expect(table).toMatch(/Held for a human[^\n]*: 2/);
    expect(table).toContain("Pinned: 1. Sunk: 1. Held: 2.");
  });

  test("--json carries sunkBy, heldBy and every row's facts", async () => {
    expect(await rank("--json")).toBe(0);
    const json = JSON.parse(cap.stdout()) as {
      ranked: { key: string; sunkBy: string[]; facts: Record<string, number> }[];
      held: { key: string; heldBy: string[]; facts: Record<string, number> }[];
    };
    expect(json.ranked.map((r) => [r.key, r.sunkBy])).toEqual([
      ["kit/kit#5", []],
      ["kit/kit#2", []],
      ["kit/kit#1", ["blocked"]],
    ]);
    expect(json.held.map((r) => [r.key, r.heldBy])).toEqual([
      ["kit/kit#3", ["in_progress"]],
      ["kit/kit#4", ["in_progress"]],
    ]);
    expect(json.held[0]?.facts).toEqual({
      reactions: 0,
      linked_issues: 0,
      duplicates: 0,
      open_blockers: 0,
      open_closing_prs: 1,
      assignees: 2,
    });
  });

  test("--tiebreak never lifts a sunk row above a normal one, or a normal row above a pinned one", async () => {
    // Only the sink gate: #5 and #4 pinned, #3 and #2 normal, #1 sunk.
    // The stub prefers "big win" (#1) to every row, "middling" (#2) to
    // "cheap small" (#3), and the pinned rows least.
    writeRubric("fact_gates:\n  - id: blocked\n    fact: open_blockers\n    at_least: 1\n    action: sink\n");
    expect(await rank("-t", "10")).toBe(0);
    expect(rows(cap.stdout()).map(([position, key]) => [position, key])).toEqual([
      ["1", "kit/kit#5"],
      ["2", "kit/kit#4"],
      ["3", "kit/kit#2"],
      ["4", "kit/kit#3"],
      ["5", "kit/kit#1"],
    ]);
    // Pairs within groups only: one pinned pair, one normal pair.
    expect(cap.stdout()).toMatch(/Tie-break over the top 5: 2 pairs/);
  });

  test("editing only fact_gates re-ranks with zero model requests", async () => {
    writeRubric("");
    expect(await rank()).toBe(0);
    const asked = engine.calls;
    expect(asked).toBe(5);
    expect(rows(cap.stdout()).some(([, , flags]) => flags?.includes("sunk:"))).toBe(false);
    cap.clear();
    writeRubric(BRIEF_GATES);
    expect(await rank()).toBe(0);
    expect(engine.calls).toBe(asked);
    expect(cap.stdout()).toContain("Engine: 5 tickets, 0 requests");
    expect(cap.stdout()).toContain("sunk:blocked");
  });

  test("the states sent carry none of the three fact-gate-only facts", async () => {
    expect(await rank()).toBe(0);
    expect(engine.states).toHaveLength(5);
    for (const state of engine.states) {
      expect(Object.keys((state as { facts: object }).facts).sort()).toEqual([
        "age",
        "duplicates",
        "linked_issues",
        "reactions",
      ]);
    }
    expect(JSON.stringify(engine.states)).not.toMatch(/blocker|closing|assignee/i);
  });
});

describe("explain with fact gates", () => {
  test("prints the ticket's facts and each fact gate's value against at_least and its outcome", async () => {
    expect(await explain("kit/kit#1")).toBe(0);
    const text = cap.stdout();
    expect(text).toContain(
      "facts: age under a month, reactions 0, linked_issues 0, duplicates 0, open_blockers 1, open_closing_prs 0, assignees 0",
    );
    expect(text).toContain("fact gate blocked (open_blockers, sink): 1 ≥ 1: sunk");
    expect(text).toContain("fact gate in_progress (open_closing_prs, hold): 0 < 1: no effect");
    expect(text).toContain("Flags: sunk:blocked.");
  });

  test("a pinned ticket's fired sink reads as overridden by the pin", async () => {
    expect(await explain("kit/kit#5")).toBe(0);
    expect(cap.stdout()).toContain("fact gate blocked (open_blockers, sink): 2 ≥ 1: no effect (pinned)");
  });

  test("--json carries facts and factGates", async () => {
    expect(await explain("kit/kit#4", "--json")).toBe(0);
    const json = JSON.parse(cap.stdout()) as {
      facts: Record<string, unknown>;
      factGates: unknown[];
      flags: Record<string, unknown>;
    };
    expect(json.facts).toMatchObject({ open_blockers: 0, open_closing_prs: 1, assignees: 0 });
    expect(json.factGates).toContainEqual({
      id: "in_progress",
      fact: "open_closing_prs",
      action: "hold",
      atLeast: 1,
      value: 1,
      fired: true,
      outcome: "held",
    });
    expect(json.flags).toMatchObject({ pinnedBy: ["security"], heldBy: ["in_progress"], sunkBy: [] });
  });
});
