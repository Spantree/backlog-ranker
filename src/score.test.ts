import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCache } from "./cache.js";
import type { DecisionAnswer, DecisionEngine } from "./engine.js";
import { isRefusal, RefusalError } from "./errors.js";
import { parseRubric } from "./rubric.js";
import { pool, scoreTickets } from "./score.js";
import { stateHash, toState } from "./state.js";
import type { Ticket } from "./ticket.js";

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

const tmp = (): string => mkdtempSync(join(tmpdir(), "backlog-score-"));

describe("scoreTickets", () => {
  test("one request per ticket with every question; a second run sends nothing", async () => {
    const root = tmp();
    const engine = fakeEngine();
    const first1 = ticket("K-1");
    const tickets = [first1, ticket("K-2"), ticket("K-3")];
    const first = await scoreTickets({
      tickets,
      rubric: RUBRIC,
      engine,
      cache: openCache(root, engine.id, engine.model),
      now: NOW,
    });
    expect(engine.calls).toHaveLength(3);
    expect(engine.calls[0]?.ids).toEqual(["impact", "urgent"]);
    expect(first.stats).toMatchObject({ tickets: 3, requests: 3, cachedAnswers: 0, askedAnswers: 6 });
    expect(first.scored.map((s) => s.key)).toEqual(["K-1", "K-2", "K-3"]);

    const cache = openCache(root, engine.id, engine.model);
    // Nothing was flushed yet, so a fresh open sees a cold cache…
    expect(
      cache.get(stateHash(toState(first1, NOW).state), { kind: "noul", instructions: "Is it urgent?" }),
    ).toBeUndefined();
  });

  test("a flushed cache answers re-runs; only a new question is asked", async () => {
    const root = tmp();
    const engine = fakeEngine();
    const tickets = [ticket("K-1"), ticket("K-2")];
    const c1 = openCache(root, engine.id, engine.model);
    await scoreTickets({ tickets, rubric: RUBRIC, engine, cache: c1, now: NOW });
    c1.flush();

    const again = await scoreTickets({
      tickets,
      rubric: RUBRIC,
      engine,
      cache: openCache(root, engine.id, engine.model),
      now: NOW,
    });
    expect(again.stats).toMatchObject({ requests: 0, cachedAnswers: 4, askedAnswers: 0 });
    expect(engine.calls).toHaveLength(2);

    const grown = {
      ...RUBRIC,
      gates: [
        ...RUBRIC.gates,
        { id: "blocked", question: "Is it blocked?", action: "pin_top" as const, threshold: 0.5 },
      ],
    };
    const third = await scoreTickets({
      tickets,
      rubric: grown,
      engine,
      cache: openCache(root, engine.id, engine.model),
      now: NOW,
    });
    expect(third.stats).toMatchObject({ requests: 2, cachedAnswers: 4, askedAnswers: 2 });
    expect(engine.calls.at(-1)?.ids).toEqual(["blocked"]);
  });

  test("an edited ticket is re-asked; another engine or model never reads this cache", async () => {
    const root = tmp();
    const engine = fakeEngine();
    const c = openCache(root, engine.id, engine.model);
    await scoreTickets({ tickets: [ticket("K-1")], rubric: RUBRIC, engine, cache: c, now: NOW });
    c.flush();

    const edited = await scoreTickets({
      tickets: [ticket("K-1", "a changed body")],
      rubric: RUBRIC,
      engine,
      cache: openCache(root, engine.id, engine.model),
      now: NOW,
    });
    expect(edited.stats.requests).toBe(1);

    for (const other of [fakeEngine("other", "m-1"), fakeEngine("fake", "m-2")]) {
      const r = await scoreTickets({
        tickets: [ticket("K-1")],
        rubric: RUBRIC,
        engine: other,
        cache: openCache(root, other.id, other.model),
        now: NOW,
      });
      expect(r.stats.requests).toBe(1);
    }
  });

  test("a failed decision names the ticket's key, keeping the error's class and brand", async () => {
    const engine = fakeEngine();
    const failing: DecisionEngine = {
      ...engine,
      async decide(state, questions) {
        if (JSON.stringify(state).includes("poison")) throw new RefusalError("the backend answered HTTP 500");
        return engine.decide(state, questions);
      },
    };
    const err = await scoreTickets({
      tickets: [ticket("K-1"), ticket("K-2", "poison body")],
      rubric: RUBRIC,
      engine: failing,
      cache: openCache(tmp(), engine.id, engine.model),
      now: NOW,
      concurrency: 1,
    }).catch((e: unknown) => e);
    expect(isRefusal(err)).toBe(true);
    expect(err).toBeInstanceOf(RefusalError);
    expect((err as Error).message).toBe("K-2: the backend answered HTTP 500");
  });
});

describe("pool", () => {
  test("the first failure stops new work and every started item settles before it rethrows", async () => {
    const started: number[] = [];
    let settled = 0;
    const run = pool([1, 2, 3, 4, 5, 6], 2, async (n) => {
      started.push(n);
      await Promise.resolve();
      if (n === 1) throw new Error("boom");
      await Promise.resolve();
      settled++;
    });
    await expect(run).rejects.toThrow("boom");
    expect(started.length).toBeLessThan(6);
    expect(settled).toBe(started.length - 1);
  });
});
