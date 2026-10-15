import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rankBacklog } from "./api.js";
import { openCache } from "./cache.js";
import type { DecisionAnswer, DecisionEngine } from "./engine.js";
import type { Ticket } from "./ticket.js";

const NOW = new Date("2026-10-15T00:00:00Z");
const RUBRIC_PATH = join(import.meta.dirname, "fixtures", "rubric.yaml");
const tmp = (): string => mkdtempSync(join(tmpdir(), "backlog-api-"));

/** What the stub engine answers about each ticket, keyed by title. */
interface Truth {
  impact: number;
  effort: number;
  security?: number;
  judgeable?: number;
}

const TRUTH: Record<string, Truth> = {
  "big win": { impact: 4, effort: 0 },
  middling: { impact: 2, effort: 2 },
  "token in a log": { impact: 1, effort: 3, security: 0.9 },
  "something vague": { impact: 4, effort: 0, judgeable: 0.2 },
};

const ticket = (n: number, title: string): Ticket => ({
  key: `acme/app#${n}`,
  title,
  body: `about ${title}`,
  labels: [],
  url: `https://github.com/acme/app/issues/${n}`,
  createdAt: "2026-10-01T00:00:00Z",
  reactions: 0,
  linkedIssues: 0,
  duplicates: 0,
});

const TICKETS = [
  ticket(1, "big win"),
  ticket(2, "middling"),
  ticket(3, "token in a log"),
  ticket(4, "something vague"),
];

function stubEngine(): DecisionEngine & { calls: number } {
  const engine = {
    id: "stub",
    model: "stub-1",
    calls: 0,
    async decide(state: unknown, questions: Parameters<DecisionEngine["decide"]>[1]) {
      engine.calls++;
      const truth = TRUTH[(state as { title: string }).title];
      if (truth === undefined) throw new Error("stub engine asked about an unknown ticket");
      const answers: Record<string, DecisionAnswer> = {};
      for (const [id, q] of Object.entries(questions)) {
        if (q.kind === "score") {
          const value = id === "impact" ? truth.impact : truth.effort;
          answers[id] = { kind: "score", value, probabilities: [], confidence: 0.9 };
        } else if (q.kind === "noul") {
          const p = id === "security" ? (truth.security ?? 0.1) : (truth.judgeable ?? 0.9);
          answers[id] = { kind: "noul", probability: p };
        } else throw new Error("stub engine asked a choice");
      }
      return { servedModel: "stub-1-20261015", answers };
    },
  };
  return engine;
}

describe("rankBacklog", () => {
  test("ranks hand-built tickets from a rubric file: pins first, holds apart, composites from the answers", async () => {
    const engine = stubEngine();
    const cache = openCache(tmp(), engine.id, engine.model);
    const result = await rankBacklog({
      rubric: RUBRIC_PATH,
      tickets: TICKETS,
      engine,
      cache,
      now: () => NOW,
    });
    expect(result.rubric.name).toBe("fixture-roi");
    expect(result.ranking.ranked.map((r) => [r.key, r.composite, r.pinnedBy])).toEqual([
      ["acme/app#3", 0.5, ["security"]],
      ["acme/app#1", 5, []],
      ["acme/app#2", 1, []],
    ]);
    expect(result.ranking.held.map((r) => [r.key, r.heldBy])).toEqual([["acme/app#4", ["judgeable"]]]);
    expect(result.stats).toMatchObject({ tickets: 4, requests: 4, cachedAnswers: 0, askedAnswers: 16 });
    expect(engine.calls).toBe(4);
    expect(result.states.get("acme/app#1")?.title).toBe("big win");
    expect(result.tiebreak).toBeUndefined();
  });
});
