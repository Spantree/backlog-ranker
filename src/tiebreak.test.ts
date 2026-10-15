import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCache } from "./cache.js";
import { rank } from "./compose.js";
import type { DecisionAnswer, DecisionEngine } from "./engine.js";
import { parseRubric } from "./rubric.js";
import { scoreTickets } from "./score.js";
import { PROMPT_BYTE_BUDGET, stateBytes, utf8Bytes } from "./state.js";
import type { Ticket } from "./ticket.js";
import { tiebreak } from "./tiebreak.js";

const NOW = new Date("2026-10-13T00:00:00Z");
const RUBRIC = parseRubric(
  `name: t
compose: weighted_sum
criteria:
  - id: impact
    direction: benefit
    question: How much?
    levels: [low, mid, high]
gates:
  - id: urgent
    question: Is it urgent?
    action: pin_top
`,
  "t",
);

const ticket = (key: string, body = "a body"): Ticket => ({
  key,
  title: `title ${key}`,
  body,
  labels: ["b", "a"],
  url: "",
  createdAt: "2026-10-03T00:00:00Z",
  reactions: 1,
  linkedIssues: 2,
  duplicates: 0,
});

function fakeEngine(
  id = "fake",
  model = "m-1",
): DecisionEngine & { calls: { state: unknown; ids: string[] }[] } {
  const calls: { state: unknown; ids: string[] }[] = [];
  return {
    id,
    model,
    calls,
    async decide(state, questions) {
      calls.push({ state, ids: Object.keys(questions) });
      const out: Record<string, DecisionAnswer> = {};
      for (const [qid, q] of Object.entries(questions)) {
        out[qid] =
          q.kind === "score"
            ? { kind: "score", value: 1, probabilities: [0, 1, 0], confidence: 0.9 }
            : q.kind === "noul"
              ? { kind: "noul", probability: 0.2 }
              : {
                  kind: "choice",
                  choice: q.options[0]?.name ?? "",
                  probabilities: Object.fromEntries(q.options.map((o, i) => [o.name, i === 0 ? 0.7 : 0.3])),
                  confidence: 0.4,
                };
      }
      return { servedModel: `${model}-snapshot`, answers: out };
    },
  };
}

const tmp = (): string => mkdtempSync(join(tmpdir(), "backlog-tiebreak-"));

describe("tiebreak", () => {
  test("asks each pair in both option orders, caches them apart, and keeps pins on top", async () => {
    const root = tmp();
    const engine = fakeEngine();
    const cache = openCache(root, engine.id, engine.model);
    const tickets = [ticket("K-1"), ticket("K-2"), ticket("K-3")];
    const { scored, states } = await scoreTickets({ tickets, rubric: RUBRIC, engine, cache, now: NOW });
    const ranking = rank(RUBRIC, scored);
    engine.calls.length = 0;

    const result = await tiebreak({ rubric: RUBRIC, rows: ranking.ranked, states, top: 3, engine, cache });
    expect(result.stats).toEqual({ pairs: 3, requests: 3, cacheHits: 0, truncatedPairs: 0 });
    expect(engine.calls.every((c) => c.ids.join() === "first_listed_first,second_listed_first")).toBe(true);
    // The fake always prefers the option listed first, so both orders
    // cancel out to 0.5 and the composite order (key order here) stands.
    expect(result.rows.map((r) => r.key)).toEqual(["K-1", "K-2", "K-3"]);

    const again = await tiebreak({ rubric: RUBRIC, rows: ranking.ranked, states, top: 3, engine, cache });
    expect(again.stats).toEqual({ pairs: 3, requests: 0, cacheHits: 3, truncatedPairs: 0 });
  });

  test("the default pair question carries each criterion's wording, so rewording re-asks", async () => {
    const engine = fakeEngine();
    const cache = openCache(tmp(), engine.id, engine.model);
    const tickets = [ticket("K-1"), ticket("K-2")];
    const { scored, states } = await scoreTickets({ tickets, rubric: RUBRIC, engine, cache, now: NOW });
    const asked: string[] = [];
    const spy: DecisionEngine = {
      ...engine,
      decide: (state, qs) => {
        asked.push(...Object.values(qs).map((q) => q.instructions));
        return engine.decide(state, qs);
      },
    };
    await tiebreak({ rubric: RUBRIC, rows: rank(RUBRIC, scored).ranked, states, top: 2, engine: spy, cache });
    expect(asked[0]).toContain("How much? Levels, lowest first: low | mid | high");
    const reworded = { ...RUBRIC, criteria: RUBRIC.criteria.map((c) => ({ ...c, question: "How cheap?" })) };
    const r = await tiebreak({
      rubric: reworded,
      rows: rank(RUBRIC, scored).ranked,
      states,
      top: 2,
      engine: spy,
      cache,
    });
    expect(r.stats.requests).toBe(1);
  });

  test("a pair that fits alone but not together is cut to share one prompt", async () => {
    const engine = fakeEngine();
    const cache = openCache(tmp(), engine.id, engine.model);
    const big = "word ".repeat(5_000);
    const { scored, states } = await scoreTickets({
      tickets: [ticket("K-1", big), ticket("K-2", big)],
      rubric: RUBRIC,
      engine,
      cache,
      now: NOW,
    });
    expect(scored.every((s) => !s.truncated)).toBe(true);
    let sent = 0;
    const spy: DecisionEngine = {
      ...engine,
      decide: (state, qs) => {
        sent = stateBytes(state);
        return engine.decide(state, qs);
      },
    };
    const r = await tiebreak({
      rubric: RUBRIC,
      rows: rank(RUBRIC, scored).ranked,
      states,
      top: 2,
      engine: spy,
      cache,
    });
    expect(r.stats.truncatedPairs).toBe(1);
    expect(sent).toBeLessThanOrEqual(PROMPT_BYTE_BUDGET);
    expect(utf8Bytes(big)).toBeGreaterThan(PROMPT_BYTE_BUDGET / 2);
  });

  test("reorders by pairwise wins within the unpinned group only, so a pin holds", async () => {
    const engine = fakeEngine();
    const prefer = "title K-3";
    const judge: DecisionEngine = {
      ...engine,
      async decide(state, qs) {
        const s = state as { title?: string; first?: { title: string }; second?: { title: string } };
        const answers: Record<string, DecisionAnswer> = {};
        for (const [id, q] of Object.entries(qs)) {
          if (q.kind === "noul")
            answers[id] = { kind: "noul", probability: s.title === "title K-1" ? 0.9 : 0.2 };
          else if (q.kind === "score")
            answers[id] = { kind: "score", value: 1, probabilities: [0, 1, 0], confidence: 0.9 };
          else {
            const pFirst = s.first?.title === prefer ? 0.9 : s.second?.title === prefer ? 0.1 : 0.5;
            answers[id] = {
              kind: "choice",
              choice: "first",
              probabilities: { first: pFirst, second: 1 - pFirst },
              confidence: 0.9,
            };
          }
        }
        return { servedModel: "m-1", answers };
      },
    };
    const cache = openCache(tmp(), judge.id, judge.model);
    const tickets = [ticket("K-1"), ticket("K-2"), ticket("K-3")];
    const { scored, states } = await scoreTickets({
      tickets,
      rubric: RUBRIC,
      engine: judge,
      cache,
      now: NOW,
    });
    const ranked = rank(RUBRIC, scored).ranked;
    expect(ranked.map((r) => r.key)).toEqual(["K-1", "K-2", "K-3"]);
    const result = await tiebreak({ rubric: RUBRIC, rows: ranked, states, top: 3, engine: judge, cache });
    // K-1 is pinned and is never paired with the unpinned rows.
    expect(result.stats.pairs).toBe(1);
    expect(result.rows.map((r) => r.key)).toEqual(["K-1", "K-3", "K-2"]);
  });
});
