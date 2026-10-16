/**
 * Fact gates at the library facades: rules on facts code counted, which
 * hold or sink a ticket without asking the model. In-memory tickets and
 * a stub engine that records every state it is sent.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calibrateBacklog, explainTicket, rankBacklog } from "./api.js";
import { type AnswerCache, openCache } from "./cache.js";
import type { DecisionEngine } from "./engine.js";
import { FACT_GATE_FIXTURE, NOW, rubricWith, stubEngine, ticket } from "./fixtures/fact-gates.js";
import { parseRubric, type Rubric } from "./rubric.js";
import type { Ticket } from "./ticket.js";

const cacheFor = (engine: DecisionEngine): AnswerCache =>
  openCache(mkdtempSync(join(tmpdir(), "backlog-fact-gates-")), engine.id, engine.model);

const keys = (rows: readonly { key: string }[]): string[] => rows.map((r) => r.key);

async function rankOf(tickets: Ticket[], rubric = rubricWith(), tiebreak?: number) {
  const engine = stubEngine();
  const result = await rankBacklog({
    rubric,
    tickets,
    engine,
    cache: cacheFor(engine),
    now: () => NOW,
    ...(tiebreak === undefined ? {} : { tiebreak }),
  });
  return { ...result, engine };
}

describe("fact gates in rankBacklog", () => {
  test("a blocked ticket sinks below every normal row, flagged by its gate", async () => {
    const { ranking } = await rankOf([
      ticket(1, "big win", { openBlockers: 2 }),
      ticket(2, "middling"),
      ticket(3, "cheap small"),
      ticket(4, "token in a log"),
    ]);
    expect(keys(ranking.ranked)).toEqual(["kit/kit#4", "kit/kit#3", "kit/kit#2", "kit/kit#1"]);
    expect(ranking.ranked.map((r) => r.sunkBy)).toEqual([[], [], [], ["blocked"]]);
    expect(ranking.held).toEqual([]);
  });

  test("sunk rows keep their composite order among themselves", async () => {
    const { ranking } = await rankOf([
      ticket(1, "middling", { openBlockers: 1 }),
      ticket(2, "big win", { openBlockers: 1 }),
      ticket(3, "cheap small"),
    ]);
    expect(keys(ranking.ranked)).toEqual(["kit/kit#3", "kit/kit#2", "kit/kit#1"]);
  });

  test("a ticket with an open closing pull request is held, flagged by its gate", async () => {
    const { ranking } = await rankOf([ticket(1, "big win", { openClosingPrs: 1 }), ticket(2, "middling")]);
    expect(keys(ranking.ranked)).toEqual(["kit/kit#2"]);
    expect(ranking.held.map((r) => [r.key, r.heldBy])).toEqual([["kit/kit#1", ["in_progress"]]]);
  });

  test("a fact-gate hold wins over a pin", async () => {
    const { ranking } = await rankOf([
      ticket(1, "token in a log", { openClosingPrs: 1 }),
      ticket(2, "middling"),
    ]);
    expect(keys(ranking.ranked)).toEqual(["kit/kit#2"]);
    expect(ranking.held.map((r) => [r.key, r.pinnedBy, r.heldBy])).toEqual([
      ["kit/kit#1", ["security"], ["in_progress"]],
    ]);
  });

  test("a pin wins over a fact-gate sink: the pinned row stays on top and is not sunk", async () => {
    const { ranking } = await rankOf([
      ticket(1, "big win"),
      ticket(2, "token in a log", { openBlockers: 1 }),
    ]);
    expect(keys(ranking.ranked)).toEqual(["kit/kit#2", "kit/kit#1"]);
    expect(ranking.ranked[0]).toMatchObject({ pinnedBy: ["security"], sunkBy: [] });
  });

  test("a pin still wins over a model-gate hold", async () => {
    const { ranking } = await rankOf([ticket(1, "big win"), ticket(2, "vague leak")]);
    expect(keys(ranking.ranked)).toEqual(["kit/kit#2", "kit/kit#1"]);
    expect(ranking.ranked[0]).toMatchObject({ pinnedBy: ["security"], heldBy: ["judgeable"] });
  });

  test("a model-held ticket with an open blocker stays in the held block", async () => {
    const { ranking } = await rankOf([
      ticket(1, "something vague", { openBlockers: 1 }),
      ticket(2, "middling"),
    ]);
    expect(keys(ranking.ranked)).toEqual(["kit/kit#2"]);
    expect(ranking.held.map((r) => [r.key, r.heldBy, r.sunkBy])).toEqual([["kit/kit#1", ["judgeable"], []]]);
  });

  test("a held row carries no sunk flag, whichever gate held it", async () => {
    const { ranking } = await rankOf([
      ticket(1, "big win", { openBlockers: 1, openClosingPrs: 1 }),
      ticket(2, "something vague", { openBlockers: 1 }),
      ticket(3, "middling"),
    ]);
    expect(keys(ranking.ranked)).toEqual(["kit/kit#3"]);
    expect(ranking.held.map((r) => [r.key, r.heldBy, r.sunkBy])).toEqual([
      ["kit/kit#1", ["in_progress"], []],
      ["kit/kit#2", ["judgeable"], []],
    ]);
  });

  test("a gate on assignees holds an assigned ticket; without it the same ticket ranks as before", async () => {
    const tickets = [ticket(1, "big win", { assignees: 1 }), ticket(2, "middling")];
    const assigned = rubricWith(
      "fact_gates:\n  - id: assigned\n    fact: assignees\n    at_least: 1\n    action: hold\n",
    );
    const gated = await rankOf(tickets, assigned);
    expect(keys(gated.ranking.ranked)).toEqual(["kit/kit#2"]);
    expect(gated.ranking.held.map((r) => [r.key, r.heldBy])).toEqual([["kit/kit#1", ["assigned"]]]);
    const plain = await rankOf(tickets, parseRubric(FACT_GATE_FIXTURE, "fixture"));
    expect(keys(plain.ranking.ranked)).toEqual(["kit/kit#1", "kit/kit#2"]);
    expect(plain.ranking.held).toEqual([]);
  });

  test("a fact under at_least does not fire, and a tracker that omits the new facts counts them as 0", async () => {
    const twice = rubricWith(
      "fact_gates:\n  - id: popular\n    fact: reactions\n    at_least: 3\n    action: sink\n",
    );
    const { ranking } = await rankOf(
      [ticket(1, "big win", { reactions: 2 }), ticket(2, "middling", { reactions: 3 })],
      twice,
    );
    expect(ranking.ranked.map((r) => [r.key, r.sunkBy])).toEqual([
      ["kit/kit#1", []],
      ["kit/kit#2", ["popular"]],
    ]);
  });

  test("editing only fact_gates re-ranks from the cache with zero model requests", async () => {
    const engine = stubEngine();
    const cache = cacheFor(engine);
    const tickets = [
      ticket(1, "big win", { openBlockers: 1, openClosingPrs: 1, assignees: 1 }),
      ticket(2, "middling"),
    ];
    const run = (rubric: Rubric) => rankBacklog({ rubric, tickets, engine, cache, now: () => NOW });
    await run(parseRubric(FACT_GATE_FIXTURE, "fixture"));
    const asked = engine.calls;
    expect(asked).toBe(2);
    const sunk = await run(
      rubricWith(
        "fact_gates:\n  - id: blocked\n    fact: open_blockers\n    at_least: 1\n    action: sink\n",
      ),
    );
    const held = await run(rubricWith());
    expect(engine.calls).toBe(asked);
    expect(sunk.stats.requests).toBe(0);
    expect(held.stats.requests).toBe(0);
    expect(keys(sunk.ranking.ranked)).toEqual(["kit/kit#2", "kit/kit#1"]);
    expect(keys(held.ranking.held)).toEqual(["kit/kit#1"]);
  });

  test("the state sent to the model carries none of the three fact-gate-only facts", async () => {
    const { engine, states } = await rankOf([
      ticket(1, "big win", { openBlockers: 3, openClosingPrs: 2, assignees: 1, reactions: 4 }),
    ]);
    expect(engine.states).toHaveLength(1);
    const sent = engine.states[0] as { facts: Record<string, unknown> };
    expect(Object.keys(sent.facts).sort()).toEqual(["age", "duplicates", "linked_issues", "reactions"]);
    expect(JSON.stringify(engine.states)).not.toMatch(/blocker|closing|assignee/i);
    expect(states.get("kit/kit#1")).toEqual(sent as never);
  });
});

describe("fact gates with the tie-break and calibration", () => {
  test("--tiebreak pairs rows only within the pinned, normal and sunk groups", async () => {
    // The stub prefers the sunk "big win" over everything and every row
    // over the pinned "token in a log": cross-group pairs would invert
    // the groups.
    const { ranking, tiebreak } = await rankOf(
      [
        ticket(1, "big win", { openBlockers: 1 }),
        ticket(2, "middling"),
        ticket(3, "cheap small"),
        ticket(4, "token in a log"),
        ticket(5, "vague leak"),
      ],
      rubricWith(),
      10,
    );
    // Pinned: #5 over #4, by composite and by the stub alike. Normal: the
    // stub lifts "middling" (#2) over the higher-composite #3. Sunk: #1
    // stays last although the stub prefers it to every other row.
    expect(keys(ranking.ranked)).toEqual(["kit/kit#5", "kit/kit#4", "kit/kit#2", "kit/kit#3", "kit/kit#1"]);
    // One pair per two-row group, none across groups.
    expect(tiebreak?.pairs).toBe(2);
  });

  test("calibration's tool order is pinned, normal, sunk, then held rows", async () => {
    const engine = stubEngine();
    const tickets = [
      ticket(1, "big win", { openBlockers: 1 }),
      ticket(2, "middling"),
      ticket(3, "cheap small", { openClosingPrs: 1 }),
      ticket(4, "token in a log"),
    ];
    const result = await calibrateBacklog({
      rubric: rubricWith(),
      tickets,
      hand: keys(tickets),
      engine,
      cache: cacheFor(engine),
      now: () => NOW,
    });
    expect(result.tool).toEqual(["kit/kit#4", "kit/kit#2", "kit/kit#1", "kit/kit#3"]);
  });
});

describe("fact gates in explainTicket", () => {
  const explain = async (t: Ticket, rubric = rubricWith()) => {
    const engine = stubEngine();
    return explainTicket({ rubric, ticket: t, engine, cache: cacheFor(engine), now: () => NOW });
  };

  test("carries the ticket's facts and each fact gate's value, at_least and outcome", async () => {
    const result = await explain(
      ticket(1, "big win", { reactions: 2, linkedIssues: 1, openBlockers: 2, assignees: 1 }),
    );
    expect(result.facts).toEqual({
      age: "under a month",
      reactions: 2,
      linked_issues: 1,
      duplicates: 0,
      open_blockers: 2,
      open_closing_prs: 0,
      assignees: 1,
    });
    expect(result.factGates).toEqual([
      {
        id: "blocked",
        fact: "open_blockers",
        action: "sink",
        atLeast: 1,
        value: 2,
        fired: true,
        outcome: "sunk",
      },
      {
        id: "in_progress",
        fact: "open_closing_prs",
        action: "hold",
        atLeast: 1,
        value: 0,
        fired: false,
        outcome: "none",
      },
    ]);
    expect(result.flags).toMatchObject({ sunkBy: ["blocked"], heldBy: [] });
  });

  test("a fact-held ticket's fired pin and sink are overridden by the hold", async () => {
    const pinnedBlocked = await explain(ticket(1, "token in a log", { openBlockers: 1, openClosingPrs: 1 }));
    expect(pinnedBlocked.gates.map((g) => [g.id, g.triggered, g.outcome])).toEqual([
      ["security", true, "overridden by hold"],
      ["judgeable", false, "none"],
    ]);
    expect(pinnedBlocked.factGates.map((g) => [g.id, g.fired, g.outcome])).toEqual([
      ["blocked", true, "overridden by hold"],
      ["in_progress", true, "held"],
    ]);
    expect(pinnedBlocked.flags).toMatchObject({
      pinnedBy: ["security"],
      heldBy: ["in_progress"],
      sunkBy: [],
    });
  });

  test("a pinned ticket's fired sink and model-gate hold are overridden by the pin", async () => {
    const result = await explain(ticket(1, "vague leak", { openBlockers: 1 }));
    expect(result.gates.map((g) => [g.id, g.triggered, g.outcome])).toEqual([
      ["security", true, "pinned"],
      ["judgeable", true, "overridden by pin"],
    ]);
    expect(result.factGates.map((g) => [g.id, g.fired, g.outcome])).toEqual([
      ["blocked", true, "overridden by pin"],
      ["in_progress", false, "none"],
    ]);
  });

  test("a model-held ticket's fired sink is overridden by the hold", async () => {
    const result = await explain(ticket(1, "something vague", { openBlockers: 1 }));
    expect(result.gates.map((g) => [g.id, g.outcome])).toEqual([
      ["security", "none"],
      ["judgeable", "held"],
    ]);
    expect(result.factGates.map((g) => [g.id, g.outcome])).toEqual([
      ["blocked", "overridden by hold"],
      ["in_progress", "none"],
    ]);
    expect(result.flags).toMatchObject({ heldBy: ["judgeable"], sunkBy: [] });
  });
});
