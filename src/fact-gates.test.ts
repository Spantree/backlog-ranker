/**
 * Fact gates at the library facades: rules on facts code counted, which
 * hold or sink a ticket without asking the model. In-memory tickets and
 * a stub engine that records every state it is sent.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calibrateBacklog, rankBacklog } from "./api.js";
import { type AnswerCache, openCache } from "./cache.js";
import type { DecisionAnswer, DecisionEngine } from "./engine.js";
import { parseRubric, type Rubric } from "./rubric.js";
import type { Ticket } from "./ticket.js";

const NOW = new Date("2026-10-15T00:00:00Z");
const FIXTURE = readFileSync(join(import.meta.dirname, "fixtures", "rubric.yaml"), "utf8");

/** The two gates the brief agreed, as the shipped rubric declares them. */
const BRIEF_GATES = `fact_gates:
  - id: blocked
    fact: open_blockers
    at_least: 1
    action: sink
  - id: in_progress
    fact: open_closing_prs
    at_least: 1
    action: hold
`;

/** The fixture rubric (security pin, judgeable hold) plus `factGates`. */
export const rubricWith = (factGates = BRIEF_GATES): Rubric =>
  parseRubric(`${FIXTURE}${factGates}`, "fact-gates.yaml");

/** What the stub engine answers about each ticket, keyed by title.
 * Composites under the fixture's roi rubric: (1 + impact) / (1 + effort). */
const TRUTH: Record<string, { impact: number; effort: number; security?: number; judgeable?: number }> = {
  "big win": { impact: 4, effort: 0 }, // 5
  "cheap small": { impact: 1, effort: 0 }, // 2
  middling: { impact: 2, effort: 2 }, // 1
  "token in a log": { impact: 1, effort: 3, security: 0.9 }, // 0.5, pinned
  "vague leak": { impact: 2, effort: 0, security: 0.9, judgeable: 0.2 }, // 3, pinned and model-held
  "something vague": { impact: 4, effort: 0, judgeable: 0.2 }, // 5, model-held
};

/** Tie-break preference: the stub always picks the ticket listed later
 * here, so a pair across groups would lift a sunk row or drop a pin. */
const PREFERENCE = ["token in a log", "vague leak", "cheap small", "middling", "big win"];

export function stubEngine(): DecisionEngine & { calls: number; states: unknown[] } {
  const engine = {
    id: "stub",
    model: "stub-1",
    calls: 0,
    states: [] as unknown[],
    async decide(state: unknown, questions: Parameters<DecisionEngine["decide"]>[1]) {
      engine.calls++;
      engine.states.push(state);
      const answers: Record<string, DecisionAnswer> = {};
      for (const [id, q] of Object.entries(questions)) {
        if (q.kind === "choice") {
          const pair = state as { first: { title: string }; second: { title: string } };
          const firstWins = PREFERENCE.indexOf(pair.first.title) > PREFERENCE.indexOf(pair.second.title);
          answers[id] = {
            kind: "choice",
            choice: firstWins ? "first" : "second",
            probabilities: firstWins ? { first: 0.9, second: 0.1 } : { first: 0.1, second: 0.9 },
            confidence: 0.9,
          };
          continue;
        }
        const truth = TRUTH[(state as { title: string }).title];
        if (truth === undefined) throw new Error("stub engine asked about an unknown ticket");
        if (q.kind === "score") {
          const value = id === "impact" ? truth.impact : truth.effort;
          answers[id] = { kind: "score", value, probabilities: [], confidence: 0.9 };
        } else {
          const p = id === "security" ? (truth.security ?? 0.1) : (truth.judgeable ?? 0.9);
          answers[id] = { kind: "noul", probability: p };
        }
      }
      return { servedModel: "stub-1-20261015", answers };
    },
  };
  return engine;
}

export const ticket = (n: number, title: string, facts: Partial<Ticket> = {}): Ticket => ({
  key: `acme/app#${n}`,
  title,
  body: `about ${title}`,
  labels: [],
  url: `https://github.com/acme/app/issues/${n}`,
  createdAt: "2026-10-01T00:00:00Z",
  reactions: 0,
  linkedIssues: 0,
  duplicates: 0,
  ...facts,
});

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
    expect(keys(ranking.ranked)).toEqual(["acme/app#4", "acme/app#3", "acme/app#2", "acme/app#1"]);
    expect(ranking.ranked.map((r) => r.sunkBy)).toEqual([[], [], [], ["blocked"]]);
    expect(ranking.held).toEqual([]);
  });

  test("sunk rows keep their composite order among themselves", async () => {
    const { ranking } = await rankOf([
      ticket(1, "middling", { openBlockers: 1 }),
      ticket(2, "big win", { openBlockers: 1 }),
      ticket(3, "cheap small"),
    ]);
    expect(keys(ranking.ranked)).toEqual(["acme/app#3", "acme/app#2", "acme/app#1"]);
  });

  test("a ticket with an open closing pull request is held, flagged by its gate", async () => {
    const { ranking } = await rankOf([ticket(1, "big win", { openClosingPrs: 1 }), ticket(2, "middling")]);
    expect(keys(ranking.ranked)).toEqual(["acme/app#2"]);
    expect(ranking.held.map((r) => [r.key, r.heldBy])).toEqual([["acme/app#1", ["in_progress"]]]);
  });

  test("a fact-gate hold wins over a pin", async () => {
    const { ranking } = await rankOf([
      ticket(1, "token in a log", { openClosingPrs: 1 }),
      ticket(2, "middling"),
    ]);
    expect(keys(ranking.ranked)).toEqual(["acme/app#2"]);
    expect(ranking.held.map((r) => [r.key, r.pinnedBy, r.heldBy])).toEqual([
      ["acme/app#1", ["security"], ["in_progress"]],
    ]);
  });

  test("a pin wins over a fact-gate sink: the pinned row stays on top and is not sunk", async () => {
    const { ranking } = await rankOf([
      ticket(1, "big win"),
      ticket(2, "token in a log", { openBlockers: 1 }),
    ]);
    expect(keys(ranking.ranked)).toEqual(["acme/app#2", "acme/app#1"]);
    expect(ranking.ranked[0]).toMatchObject({ pinnedBy: ["security"], sunkBy: [] });
  });

  test("a pin still wins over a model-gate hold", async () => {
    const { ranking } = await rankOf([ticket(1, "big win"), ticket(2, "vague leak")]);
    expect(keys(ranking.ranked)).toEqual(["acme/app#2", "acme/app#1"]);
    expect(ranking.ranked[0]).toMatchObject({ pinnedBy: ["security"], heldBy: ["judgeable"] });
  });

  test("a model-held ticket with an open blocker stays in the held block", async () => {
    const { ranking } = await rankOf([
      ticket(1, "something vague", { openBlockers: 1 }),
      ticket(2, "middling"),
    ]);
    expect(keys(ranking.ranked)).toEqual(["acme/app#2"]);
    expect(keys(ranking.held)).toEqual(["acme/app#1"]);
  });

  test("a gate on assignees holds an assigned ticket; without it the same ticket ranks as before", async () => {
    const tickets = [ticket(1, "big win", { assignees: 1 }), ticket(2, "middling")];
    const assigned = rubricWith(
      "fact_gates:\n  - id: assigned\n    fact: assignees\n    at_least: 1\n    action: hold\n",
    );
    const gated = await rankOf(tickets, assigned);
    expect(keys(gated.ranking.ranked)).toEqual(["acme/app#2"]);
    expect(gated.ranking.held.map((r) => [r.key, r.heldBy])).toEqual([["acme/app#1", ["assigned"]]]);
    const plain = await rankOf(tickets, parseRubric(FIXTURE, "fixture"));
    expect(keys(plain.ranking.ranked)).toEqual(["acme/app#1", "acme/app#2"]);
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
      ["acme/app#1", []],
      ["acme/app#2", ["popular"]],
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
    await run(parseRubric(FIXTURE, "fixture"));
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
    expect(keys(sunk.ranking.ranked)).toEqual(["acme/app#2", "acme/app#1"]);
    expect(keys(held.ranking.held)).toEqual(["acme/app#1"]);
  });

  test("the state sent to the model carries none of the three fact-gate-only facts", async () => {
    const { engine, states } = await rankOf([
      ticket(1, "big win", { openBlockers: 3, openClosingPrs: 2, assignees: 1, reactions: 4 }),
    ]);
    expect(engine.states).toHaveLength(1);
    const sent = engine.states[0] as { facts: Record<string, unknown> };
    expect(Object.keys(sent.facts).sort()).toEqual(["age", "duplicates", "linked_issues", "reactions"]);
    expect(JSON.stringify(engine.states)).not.toMatch(/blocker|closing|assignee/i);
    expect(states.get("acme/app#1")).toEqual(sent as never);
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
    expect(keys(ranking.ranked)).toEqual([
      "acme/app#5",
      "acme/app#4",
      "acme/app#2",
      "acme/app#3",
      "acme/app#1",
    ]);
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
    expect(result.tool).toEqual(["acme/app#4", "acme/app#2", "acme/app#1", "acme/app#3"]);
  });
});
