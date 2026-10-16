import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DecisionQuestion } from "../engine.js";
import { isRefusal } from "../errors.js";
import { neutralizeImageReferences } from "./engine.js";
import { createJevEngine, JevError, type JevFetch } from "./index.js";

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
    // TypeSafe's own API only knows the patch spelling: a live request for
    // `jev-1.14` answers 400 "Unknown model: jev-1.14".
    expect(calls[0]?.body.model).toBe("jev-1.14.0");
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

  test("openrouter: bare model id, OpenRouter base URL and key, dated snapshot accepted", async () => {
    const { fetch, calls } = replay([json(fixture("openrouter-response.json"))]);
    const engine = createJevEngine({ backend: "openrouter", apiKey: "or-test", fetch });
    const decision = await engine.decide(STATE, QUESTIONS);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/systemone");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer or-test");
    expect(calls[0]?.body.model).toBe("jev-1.14");
    expect(decision.servedModel).toBe("typesafe/jev-1.14-20261014");
    expect(decision.answers.team).toEqual({
      kind: "choice",
      choice: "payments",
      probabilities: { payments: 0.81, frontend: 0.19 },
      confidence: 0.62,
    });
  });

  for (const backend of ["typesafe", "openrouter"] as const) {
    test(`${backend}: a pinned jev-1.13 is sent and accepted when served`, async () => {
      const { fetch, calls } = replay([json(fixture(`${backend}-response-1.13.json`))]);
      const engine = createJevEngine({ backend, apiKey: "k", fetch, model: "jev-1.13" });
      const decision = await engine.decide(STATE, QUESTIONS);
      expect(engine.model).toBe("jev-1.13");
      expect(calls[0]?.body.model).toBe(backend === "typesafe" ? "jev-1.13.0" : "jev-1.13");
      expect(decision.servedModel).toContain("jev-1.13");
    });

    test(`${backend}: pinned to jev-1.13, a jev-1.14 answer is refused`, async () => {
      const { fetch } = replay([json(fixture(`${backend}-response.json`))]);
      const engine = createJevEngine({ backend, apiKey: "k", fetch, model: "jev-1.13" });
      const err = await engine.decide(STATE, QUESTIONS).catch((e: unknown) => e);
      expect(isRefusal(err)).toBe(true);
      expect((err as Error).message).toContain("not the pinned jev-1.13");
    });
  }

  test("an unknown model refuses before any request", () => {
    const { fetch, calls } = replay([]);
    expect(() => createJevEngine({ backend: "typesafe", apiKey: "k", fetch, model: "jev-latest" })).toThrow(
      'unknown Jev model "jev-latest"',
    );
    expect(calls).toHaveLength(0);
  });
});

describe("image-reference tokens in issue text", () => {
  const token = `<image:${"0123456789abcdef".repeat(2)}>`;

  test("are broken in the state and questions, so the SDK sends the request", async () => {
    const { fetch, calls } = replay([json(fixture("typesafe-response.json"))]);
    const engine = createJevEngine({ backend: "typesafe", apiKey: "k", fetch });
    const state = { ticket: `See ${token} for the trace`, labels: [token], [token]: 1 };
    const questions: Record<string, DecisionQuestion> = {
      ...QUESTIONS,
      is_bug: { kind: "noul", instructions: `Is ${token} a defect?` },
    };
    await engine.decide(state, questions);
    const broken = `<image: ${"0123456789abcdef".repeat(2)}>`;
    expect(calls[0]?.body.state).toEqual({
      ticket: `See ${broken} for the trace`,
      labels: [broken],
      [broken]: 1,
    });
    expect(JSON.stringify(calls[0]?.body)).not.toContain("<image:0");
    expect(calls[0]?.body.questions).toMatchObject({ is_bug: { instructions: `Is ${broken} a defect?` } });
  });

  test("leave a state without one exactly as it was", () => {
    const state = { ticket: "an <image:abc> and <image:XYZ> stay", n: 1, ok: true, none: null, list: ["a"] };
    expect(neutralizeImageReferences(state)).toEqual(state);
    expect(JSON.stringify(neutralizeImageReferences(state))).toBe(JSON.stringify(state));
  });
});

describe("served model check", () => {
  const served = async (backend: "typesafe" | "openrouter", model: string): Promise<unknown> => {
    const body = fixture(`${backend}-response.json`);
    body.model = model;
    const { fetch } = replay([json(body)]);
    return createJevEngine({ backend, apiKey: "k", fetch })
      .decide(STATE, QUESTIONS)
      .then((d) => d.servedModel)
      .catch((e: unknown) => e);
  };

  test("typesafe accepts the bare id, the .0 patch spelling and a dated snapshot", async () => {
    for (const m of ["jev-1.14", "jev-1.14.0", "jev-1.14-20261014", "jev-1.14.0-20261014"]) {
      expect(await served("typesafe", m)).toBe(m);
    }
  });

  test("openrouter accepts the bare and provider-prefixed ids, each with a dated snapshot", async () => {
    for (const m of ["jev-1.14", "typesafe/jev-1.14", "jev-1.14-20261014", "typesafe/jev-1.14-20261014"]) {
      expect(await served("openrouter", m)).toBe(m);
    }
  });

  test("another version, another patch or a malformed suffix is refused", async () => {
    for (const [backend, m] of [
      ["typesafe", "jev-1.13.0"],
      ["typesafe", "jev-1.14.1"],
      ["typesafe", "jev-1.14-latest"],
      ["openrouter", "typesafe/jev-1.13-20260917"],
      ["openrouter", "typesafe/jev-1.14.5"],
      ["openrouter", "other/jev-1.14"],
    ] as const) {
      const err = await served(backend, m);
      expect(err).toBeInstanceOf(JevError);
      expect((err as Error).message).toContain(`answered with model "${m}", not the pinned jev-1.14`);
    }
  });
});

describe("answer validation", () => {
  type Body = { answers: Record<string, Record<string, unknown>> };
  const body = (): Body => fixture("typesafe-response.json") as unknown as Body;
  const decideWith = async (b: unknown, questions = QUESTIONS): Promise<unknown> => {
    const { fetch } = replay([json(b)]);
    return createJevEngine({ backend: "typesafe", apiKey: "k", fetch })
      .decide(STATE, questions)
      .catch((e: unknown) => e);
  };
  const message = async (b: unknown): Promise<string> => {
    const err = await decideWith(b);
    expect(err).toBeInstanceOf(JevError);
    return (err as Error).message;
  };

  test("refuses a response missing a question's answer", async () => {
    const b = body();
    delete b.answers.team;
    expect(await message(b)).toContain('no answer for "team"');
  });

  test("refuses a Score missing a level key, with a bad sum, or out of range", async () => {
    const missing = body();
    missing.answers.urgency = { ...missing.answers.urgency, probabilities: { "0": 0.5, "1": 0.5 } };
    expect(await message(missing)).toContain('"urgency" carries probabilities for levels other than 0..2');
    const short = body();
    short.answers.urgency = { ...short.answers.urgency, probabilities: { "0": 0.5, "1": 0.2, "2": 0.1 } };
    expect(await message(short)).toContain("level probabilities that do not sum to one");
    const high = body();
    high.answers.urgency = { ...high.answers.urgency, score: 99 };
    expect(await message(high)).toContain("scored 99, outside 0..2");
  });

  test("accepts a ten-level distribution that rounding left 0.05 short of one", async () => {
    const b = body();
    const levels = Array.from({ length: 10 }, (_, i) => `l${i}`);
    b.answers.urgency = {
      type: "score",
      score: 4.5,
      confidence: 0.5,
      probabilities: Object.fromEntries(levels.map((_, i) => [String(i), 0.095])),
    };
    const decision = await decideWith(b, {
      ...QUESTIONS,
      urgency: { kind: "score", instructions: "x", levels },
    });
    expect(decision).not.toBeInstanceOf(Error);
  });

  test("refuses a Choice that drops an option, misses the sum, or picks one not asked", async () => {
    const dropped = body();
    dropped.answers.team = { ...dropped.answers.team, probabilities: { payments: 1 } };
    expect(await message(dropped)).toContain("options other than the ones asked");
    const sum = body();
    sum.answers.team = { ...sum.answers.team, probabilities: { payments: 0.5, frontend: 0.3 } };
    expect(await message(sum)).toContain("option probabilities that do not sum to one");
    const stray = body();
    stray.answers.team = { ...stray.answers.team, choice: "sales" };
    expect(await message(stray)).toContain('chose "sales", which was not an option');
  });

  test("refuses an answer of the wrong type", async () => {
    const b = body();
    b.answers.is_bug = { type: "choice", choice: "payments", confidence: 1, probabilities: { payments: 1 } };
    expect(await message(b)).toContain('"is_bug" was answered as choice, not noul');
  });

  test("refuses a Score answer without confidence", async () => {
    const b = body();
    delete b.answers.urgency?.confidence;
    expect(await message(b)).toContain("unexpected shape (at answers.urgency");
  });
});

describe("transport failures", () => {
  test("a 401 refuses naming the backend, the status and the key variable, never the key", async () => {
    const { fetch } = replay([json({ error: "bad key sk-secret" }, 401)]);
    const engine = createJevEngine({
      backend: "openrouter",
      apiKey: "sk-secret",
      fetch,
      retry: { maxRetries: 0 },
    });
    const err = await engine.decide(STATE, QUESTIONS).catch((e: unknown) => e);
    expect(isRefusal(err)).toBe(true);
    expect((err as JevError).status).toBe(401);
    expect((err as Error).message).toBe("the openrouter backend answered HTTP 401; check OPENROUTER_API_KEY");
  });

  test("a retryable status is retried through the SDK, then succeeds", async () => {
    const { fetch, calls } = replay([
      json({ error: "overloaded" }, 529),
      json({ error: "slow down" }, 429),
      json(fixture("typesafe-response.json")),
    ]);
    const engine = createJevEngine({
      backend: "typesafe",
      apiKey: "k",
      fetch,
      retry: { maxRetries: 2, backoffInitialMs: 1, backoffMaxMs: 1 },
    });
    const decision = await engine.decide(STATE, QUESTIONS);
    expect(calls).toHaveLength(3);
    expect(decision.servedModel).toBe("jev-1.14.0");
  });

  test("gives up after the retry budget, naming the status but not the body or state", async () => {
    const { fetch, calls } = replay([json({ error: "busy" }, 503), json({ error: "busy" }, 503)]);
    const engine = createJevEngine({
      backend: "typesafe",
      apiKey: "k",
      fetch,
      retry: { maxRetries: 1, backoffInitialMs: 1, backoffMaxMs: 1 },
    });
    const err = await engine.decide(STATE, QUESTIONS).catch((e: unknown) => e);
    expect(calls).toHaveLength(2);
    expect((err as Error).message).toBe("the typesafe backend answered HTTP 503");
  });

  test("a network failure is value-free", async () => {
    const fetch: JevFetch = async () => {
      throw new TypeError("connect ECONNREFUSED echoing My checkout page");
    };
    const engine = createJevEngine({ backend: "typesafe", apiKey: "k", fetch, retry: { maxRetries: 0 } });
    const err = await engine.decide(STATE, QUESTIONS).catch((e: unknown) => e);
    expect(isRefusal(err)).toBe(true);
    expect((err as Error).message).toBe("could not reach the typesafe backend (network error)");
  });

  test("an empty key refuses naming the variable, instead of falling back to the environment", () => {
    expect(() => createJevEngine({ backend: "openrouter", apiKey: " " })).toThrow("set OPENROUTER_API_KEY");
  });
});

describe("Bun runtime", () => {
  // @typesafe-ai/sdk 0.7.0 throws "Body already used" on Bun without the
  // adapter's fetch wrapper (typesafe-ai/typesafe-sdk-js#20); this proves a
  // canned Response parses here.
  test("a canned Response from an injected fetch parses under bun test", async () => {
    expect(typeof Bun).toBe("object");
    const fetch: JevFetch = async () => new Response(JSON.stringify(fixture("typesafe-response.json")));
    const decision = await createJevEngine({ backend: "typesafe", apiKey: "k", fetch }).decide(
      STATE,
      QUESTIONS,
    );
    expect(decision.answers.is_bug).toEqual({ kind: "noul", probability: 0.95 });
  });

  test("the wrapper keeps status and headers, so error mapping still sees a 401", async () => {
    const fetch: JevFetch = async () =>
      new Response(JSON.stringify({ error: "nope" }), {
        status: 401,
        statusText: "Unauthorized",
        headers: { "content-type": "application/json", "x-request-id": "req-1" },
      });
    const err = await createJevEngine({ backend: "openrouter", apiKey: "k", fetch, retry: { maxRetries: 0 } })
      .decide(STATE, QUESTIONS)
      .catch((e: unknown) => e);
    expect(isRefusal(err)).toBe(true);
    expect((err as Error).message).toContain("HTTP 401");
    expect((err as Error).message).toContain("OPENROUTER_API_KEY");
  });

  test("a body delivered in several chunks is reassembled before the SDK reads it", async () => {
    const text = JSON.stringify(fixture("typesafe-response.json"));
    const encoder = new TextEncoder();
    const fetch: JevFetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const half = Math.floor(text.length / 2);
            controller.enqueue(encoder.encode(text.slice(0, half)));
            controller.enqueue(encoder.encode(text.slice(half)));
            controller.close();
          },
        }),
      );
    const decision = await createJevEngine({ backend: "typesafe", apiKey: "k", fetch }).decide(
      STATE,
      QUESTIONS,
    );
    expect(decision.answers.is_bug).toEqual({ kind: "noul", probability: 0.95 });
  });
});
