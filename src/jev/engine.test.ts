import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DecisionQuestion } from "../engine.js";
import { createJevEngine, type JevFetch } from "./index.js";

const FIXTURES = join(import.meta.dir, "fixtures");
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Record<string, unknown>;

/** The recorded request, as engine-neutral questions. */
const STATE = { ticket: "My checkout page shows a blank screen after I click Pay." };
const QUESTIONS: Record<string, DecisionQuestion> = {
  urgency: {
    kind: "score",
    instructions: "How urgent is this ticket?",
    levels: ["Can wait", "This week", "Blocking revenue now"],
  },
  is_bug: { kind: "noul", instructions: "Is this a software defect report?" },
  team: {
    kind: "choice",
    instructions: "Which team owns it?",
    options: [
      { name: "payments", description: "Checkout and billing" },
      { name: "frontend", description: "Rendering and layout" },
    ],
  },
};

interface Call {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function replay(responses: (() => Response)[]): { fetch: JevFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: JevFetch = async (url, init) => {
    calls.push({
      url,
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const next = responses.shift();
    if (next === undefined) throw new Error("no recorded response left");
    return next();
  };
  return { fetch, calls };
}

const json =
  (body: unknown, status = 200): (() => Response) =>
  () =>
    Response.json(body, { status });

describe("createJevEngine", () => {
  test("typesafe: one request per state, pinned model, mapped answers", async () => {
    const { fetch, calls } = replay([json(fixture("typesafe-response.json"))]);
    const engine = createJevEngine({ backend: "typesafe", apiKey: "k-test", fetch });
    const decision = await engine.decide(STATE, QUESTIONS);

    expect(engine.id).toBe("typesafe");
    expect(engine.model).toBe("jev-1.14");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer k-test");
    expect(calls[0]?.body.model).toBe("jev-1.14");
    expect(calls[0]?.body.state).toEqual(STATE);
    expect(calls[0]?.body.questions).toEqual(fixture("request.json").questions);

    expect(decision.servedModel).toBe("jev-1.14.0");
    expect(decision.answers).toEqual({
      urgency: { kind: "score", value: 2, probabilities: [0, 0, 1], confidence: 1 },
      is_bug: { kind: "noul", probability: 0.95 },
      team: {
        kind: "choice",
        choice: "payments",
        probabilities: { payments: 0.8, frontend: 0.2 },
        confidence: 0.6,
      },
    });
  });
});
