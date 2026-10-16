import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calibrateBacklog, explainTicket, rankBacklog } from "./api.js";
import { openCache } from "./cache.js";
import type { DecisionAnswer, DecisionEngine } from "./engine.js";
import { isRefusal } from "./errors.js";
import { parseRubric, RubricError } from "./rubric.js";
import { scoreTickets } from "./score.js";
import type { Ticket } from "./ticket.js";
import type { Tracker } from "./trackers/tracker.js";

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
  "costly big": { impact: 4, effort: 4 },
  "cheap small": { impact: 1, effort: 0 },
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
      const answers: Record<string, DecisionAnswer> = {};
      for (const [id, q] of Object.entries(questions)) {
        if (q.kind === "choice") {
          // A tie-break pair: always prefer the ticket in `second`, in
          // either option order.
          answers[id] = {
            kind: "choice",
            choice: "second",
            probabilities: { first: 0.2, second: 0.8 },
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

  test("a re-weighted second call against the same cache asks the engine nothing", async () => {
    const rubric = parseRubric(
      `name: sum
compose: weighted_sum
criteria:
  - id: impact
    direction: benefit
    question: How much?
    levels: [a, b, c, d, e]
  - id: effort
    direction: cost
    question: How hard?
    levels: [a, b, c, d, e]
`,
      "sum",
    );
    const pair = [ticket(5, "costly big"), ticket(6, "cheap small")];
    const engine = stubEngine();
    const cache = openCache(tmp(), engine.id, engine.model);
    const first = await rankBacklog({ rubric, tickets: pair, engine, cache, now: () => NOW });
    expect(first.ranking.ranked.map((r) => r.key)).toEqual(["acme/app#6", "acme/app#5"]);
    expect(engine.calls).toBe(2);

    const again = await rankBacklog({
      rubric,
      tickets: pair,
      engine,
      cache,
      now: () => NOW,
      weights: { impact: 2 },
    });
    expect(engine.calls).toBe(2);
    expect(again.stats).toMatchObject({ requests: 0, cachedAnswers: 4, askedAnswers: 0 });
    expect(again.rubric.criteria[0]?.weight).toBe(2);
    expect(again.ranking.ranked.map((r) => r.key)).toEqual(["acme/app#5", "acme/app#6"]);
  });

  test("a re-weighted tie-break with the default pair question asks the engine nothing", async () => {
    // No tiebreak_question: the pair question is built from the criteria,
    // and must not depend on their weights, zero included. The overrides
    // keep the top-two order, so the pair is the same state as before.
    const rubric = parseRubric(
      `name: sum
compose: weighted_sum
criteria:
  - id: impact
    direction: benefit
    question: How much?
    levels: [a, b, c, d, e]
  - id: effort
    direction: cost
    question: How hard?
    levels: [a, b, c, d, e]
`,
      "sum",
    );
    const pair = [ticket(5, "costly big"), ticket(6, "cheap small")];
    const engine = stubEngine();
    const cache = openCache(tmp(), engine.id, engine.model);
    const base = { rubric, tickets: pair, engine, cache, now: () => NOW, tiebreak: 2 };
    const first = await rankBacklog(base);
    expect(first.tiebreak?.requests).toBe(1);
    const asked = engine.calls;

    for (const weights of [{ effort: 2 }, { impact: 0 }]) {
      const again = await rankBacklog({ ...base, weights });
      expect(again.ranking.ranked.map((r) => r.key)).toEqual(first.ranking.ranked.map((r) => r.key));
      expect(again.stats.requests).toBe(0);
      expect(again.tiebreak).toMatchObject({ requests: 0, cacheHits: 1 });
    }
    expect(engine.calls).toBe(asked);
  });

  test("reads a tracker's pending tickets and flushes the cache for the next run", async () => {
    const root = tmp();
    const engine = stubEngine();
    const tracker: Tracker = {
      source: "github:acme/app",
      pending: async () => TICKETS,
      issues: async () => {
        throw new Error("rank never looks issues up by key");
      },
    };
    await rankBacklog({
      rubric: RUBRIC_PATH,
      tracker,
      engine,
      cache: openCache(root, engine.id, engine.model),
      now: () => NOW,
    });
    expect(engine.calls).toBe(4);
    const warm = await rankBacklog({
      rubric: RUBRIC_PATH,
      tracker,
      engine,
      cache: openCache(root, engine.id, engine.model),
      now: () => NOW,
    });
    expect(engine.calls).toBe(4);
    expect(warm.stats.requests).toBe(0);
  });

  test("a tie-break reorders the top unpinned rows and reports its own stats", async () => {
    const engine = stubEngine();
    const cache = openCache(tmp(), engine.id, engine.model);
    const result = await rankBacklog({
      rubric: RUBRIC_PATH,
      tickets: TICKETS,
      engine,
      cache,
      now: () => NOW,
      tiebreak: 3,
    });
    // #3 is pinned and stays first; the one unpinned pair (#1, #2) goes to
    // the ticket sent as `second`, #2.
    expect(result.ranking.ranked.map((r) => r.key)).toEqual(["acme/app#3", "acme/app#2", "acme/app#1"]);
    expect(result.tiebreak).toEqual({ pairs: 1, requests: 1, cacheHits: 0, truncatedPairs: 0, top: 3 });
    expect(engine.calls).toBe(5);
  });

  test("refuses both or neither of tickets and tracker, and a tie-break depth out of range", async () => {
    const engine = stubEngine();
    const cache = openCache(tmp(), engine.id, engine.model);
    const tracker: Tracker = {
      source: "github:acme/app",
      pending: async () => TICKETS,
      issues: async () => TICKETS,
    };
    const base = { rubric: RUBRIC_PATH, engine, cache };
    for (const run of [
      rankBacklog(base),
      rankBacklog({ ...base, tickets: TICKETS, tracker }),
      rankBacklog({ ...base, tickets: TICKETS, tiebreak: 11 }),
      rankBacklog({ ...base, tickets: TICKETS, tiebreak: 0 }),
    ]) {
      const err = await run.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(isRefusal(err)).toBe(true);
    }
    expect(engine.calls).toBe(0);
  });

  test("a missing rubric file is a RubricError refusal, as the CLI words it", async () => {
    const engine = stubEngine();
    const cache = openCache(tmp(), engine.id, engine.model);
    const missing = join(tmp(), "nope.yaml");
    for (const run of [
      () => rankBacklog({ rubric: missing, tickets: TICKETS, engine, cache }),
      () =>
        calibrateBacklog({
          rubric: missing,
          tickets: TICKETS,
          hand: ["acme/app#1", "acme/app#2"],
          engine,
          cache,
        }),
      () => explainTicket({ rubric: missing, ticket: TICKETS[0] as Ticket, engine, cache }),
    ]) {
      const err = await run().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(isRefusal(err)).toBe(true);
      expect(err).toBeInstanceOf(RubricError);
      expect((err as Error).message).toBe(`no rubric file ${missing}`);
    }
    expect(engine.calls).toBe(0);
  });
});

describe("concurrency", () => {
  test("a concurrency that is not a whole number of at least 1 is refused before anything is read", async () => {
    const engine = stubEngine();
    const cache = openCache(tmp(), engine.id, engine.model);
    let reads = 0;
    const tracker: Tracker = {
      source: "github:acme/app",
      pending: async () => {
        reads++;
        return TICKETS;
      },
      issues: async () => {
        reads++;
        return TICKETS;
      },
    };
    const base = { rubric: RUBRIC_PATH, engine, cache, tracker };
    const rubric = parseRubric(readFileSync(RUBRIC_PATH, "utf8"), RUBRIC_PATH);
    for (const concurrency of [0, -1, 1.5, Number.NaN]) {
      for (const run of [
        () => rankBacklog({ ...base, concurrency }),
        () => calibrateBacklog({ ...base, concurrency, hand: ["acme/app#1", "acme/app#2"] }),
        () => scoreTickets({ tickets: TICKETS, rubric, engine, cache, now: NOW, concurrency }),
      ]) {
        const err = await run().then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(isRefusal(err)).toBe(true);
        expect((err as Error).message).toContain("concurrency is a whole number of at least 1");
      }
    }
    expect(reads).toBe(0);
    expect(engine.calls).toBe(0);
  });
});

describe("calibrateBacklog", () => {
  test("Kendall's tau of a hand ranking against the tool order, held rows last, issues read by key", async () => {
    const engine = stubEngine();
    const asked: string[][] = [];
    const tracker: Tracker = {
      source: "github:acme/app",
      pending: async () => {
        throw new Error("calibrate never reads the whole backlog");
      },
      issues: async (keys) => {
        asked.push([...keys]);
        return TICKETS.filter((t) => keys.includes(t.key));
      },
    };
    const hand = ["acme/app#1", "acme/app#2", "acme/app#3", "acme/app#4"];
    const result = await calibrateBacklog({
      rubric: RUBRIC_PATH,
      tracker,
      hand,
      engine,
      cache: openCache(tmp(), engine.id, engine.model),
      now: () => NOW,
    });
    expect(asked).toEqual([hand]);
    expect(result.tool).toEqual(["acme/app#3", "acme/app#1", "acme/app#2", "acme/app#4"]);
    // 4 of 6 pairs agree: tau = (4 - 2) / 6.
    expect(result.calibration).toMatchObject({ n: 4, concordant: 4, discordant: 2, trusted: false });
    expect(result.calibration.tau).toBeCloseTo(1 / 3);
    expect(result.calibration.disagreements).toEqual([
      { above: "acme/app#1", below: "acme/app#3" },
      { above: "acme/app#2", below: "acme/app#3" },
    ]);
    expect(result.scored.map((s) => s.key)).toEqual(hand);
    expect(result.ranking.held.map((r) => r.key)).toEqual(["acme/app#4"]);
    expect(result.stats.requests).toBe(4);
    expect(result.rubric.name).toBe("fixture-roi");
  });

  test("refuses a hand list with a key twice or fewer than two keys", async () => {
    const engine = stubEngine();
    const cache = openCache(tmp(), engine.id, engine.model);
    for (const hand of [["acme/app#1", "acme/app#1"], ["acme/app#1", "ACME/App#1"], ["acme/app#1"]]) {
      const err = await calibrateBacklog({ rubric: RUBRIC_PATH, tickets: TICKETS, hand, engine, cache }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(isRefusal(err)).toBe(true);
    }
    expect(engine.calls).toBe(0);
  });

  test("hand keys count whatever their case, under the tracker's spelling", async () => {
    const engine = stubEngine();
    const tracker: Tracker = {
      source: "github:acme/app",
      pending: async () => {
        throw new Error("calibrate never reads the whole backlog");
      },
      // As the GitHub tracker does: keys in any case, returned as it spells them.
      issues: async (keys) =>
        keys.map((k) => {
          const found = TICKETS.find((t) => t.key.toLowerCase() === k.toLowerCase());
          if (found === undefined) throw new Error(`no issue ${k}`);
          return found;
        }),
    };
    const result = await calibrateBacklog({
      rubric: RUBRIC_PATH,
      tracker,
      hand: ["ACME/app#1", "Acme/App#2", "acme/app#3", "acme/APP#4"],
      engine,
      cache: openCache(tmp(), engine.id, engine.model),
      now: () => NOW,
    });
    expect(result.calibration).toMatchObject({ n: 4, concordant: 4, discordant: 2 });
    expect(result.calibration.disagreements).toEqual([
      { above: "acme/app#1", below: "acme/app#3" },
      { above: "acme/app#2", below: "acme/app#3" },
    ]);
  });
});

describe("explainTicket", () => {
  test("after a rank against the same cache, explains a ticket asking the engine nothing", async () => {
    const root = tmp();
    const engine = stubEngine();
    const ranked = await rankBacklog({
      rubric: RUBRIC_PATH,
      tickets: TICKETS,
      engine,
      cache: openCache(root, engine.id, engine.model),
      now: () => NOW,
    });
    expect(engine.calls).toBe(4);
    const tracker: Tracker = {
      source: "github:acme/app",
      pending: async () => {
        throw new Error("explain never lists the backlog");
      },
      issues: async (keys) => TICKETS.filter((t) => keys.includes(t.key)),
    };
    const result = await explainTicket({
      rubric: RUBRIC_PATH,
      tracker,
      key: "acme/app#3",
      engine,
      cache: openCache(root, engine.id, engine.model),
      now: () => NOW,
    });
    expect(engine.calls).toBe(4);
    expect(result.stats).toMatchObject({ tickets: 1, requests: 0, cachedAnswers: 4, askedAnswers: 0 });
    expect(result.composite).toBe(ranked.ranking.ranked[0]?.composite ?? Number.NaN);
    expect(result).toMatchObject({
      key: "acme/app#3",
      title: "token in a log",
      flags: { pinnedBy: ["security"], heldBy: [], lowConfidence: [], truncated: false },
    });
    expect(result.criteria.map((c) => [c.id, c.score, c.confidence, c.levels.length])).toEqual([
      ["impact", 1, 0.9, 5],
      ["effort", 3, 0.9, 5],
    ]);
    expect(result.gates.map((g) => [g.id, g.probability, g.triggered])).toEqual([
      ["security", 0.9, true],
      ["judgeable", 0.9, false],
    ]);
  });

  test("explains a held ticket passed directly, and refuses an ambiguous input", async () => {
    const engine = stubEngine();
    const cache = openCache(tmp(), engine.id, engine.model);
    const held = await explainTicket({
      rubric: RUBRIC_PATH,
      ticket: ticket(4, "something vague"),
      engine,
      cache,
      now: () => NOW,
    });
    expect(held.flags.heldBy).toEqual(["judgeable"]);
    expect(held.gates.find((g) => g.id === "judgeable")).toMatchObject({ probability: 0.2, triggered: true });
    expect(engine.calls).toBe(1);
    const tracker: Tracker = { source: "github:acme/app", pending: async () => [], issues: async () => [] };
    for (const opts of [{}, { ticket: ticket(1, "big win"), tracker, key: "acme/app#1" }, { tracker }]) {
      const err = await explainTicket({ rubric: RUBRIC_PATH, engine, cache, ...opts }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(isRefusal(err)).toBe(true);
    }
    expect(engine.calls).toBe(1);
  });
});
