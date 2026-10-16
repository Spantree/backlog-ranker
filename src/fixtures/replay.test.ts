import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCache } from "../cache.js";
import { createJevEngine } from "../jev/engine.js";
import { parseRubric } from "../rubric.js";
import { scoreTickets } from "../score.js";
import { githubTracker } from "../trackers/github.js";
import { FIXTURE_DIR, FIXTURE_NOW, replayFetch, requestedJevModel, servedJevModel } from "./replay.js";

const rubric = parseRubric(readFileSync(join(FIXTURE_DIR, "rubric.yaml"), "utf8"), "rubric.yaml");

async function scoreOn(backend: "typesafe" | "openrouter", model: "jev-1.13" | "jev-1.14") {
  const net = replayFetch();
  const tickets = await githubTracker({ owner: "kit", repo: "kit", token: "t", fetch: net.fetch }).pending();
  const engine = createJevEngine({ backend, apiKey: "k", model, fetch: net.fetch, retry: { maxRetries: 0 } });
  const cache = openCache(mkdtempSync(join(tmpdir(), "backlog-replay-")), engine.id, engine.model);
  return scoreTickets({ tickets: tickets.slice(0, 1), rubric, engine, cache, now: FIXTURE_NOW });
}

describe("replayed Jev recordings", () => {
  test("map request and served spellings onto one Jev version", () => {
    expect(requestedJevModel("jev-1.14")).toBe("jev-1.14");
    expect(requestedJevModel("jev-1.14.0")).toBe("jev-1.14");
    expect(requestedJevModel("jev-1.13")).toBe("jev-1.13");
    expect(requestedJevModel("jev-latest")).toBeUndefined();
    expect(servedJevModel("typesafe/jev-1.14-20261014")).toBe("jev-1.14");
    expect(servedJevModel("jev-1.14.0")).toBe("jev-1.14");
    expect(servedJevModel("jev-1.13.0-20261001")).toBe("jev-1.13");
    expect(servedJevModel("jev-1.15")).toBeUndefined();
  });

  test("replay a recording made on the version asked for", async () => {
    // The recordings were made through OpenRouter, whose served spelling
    // only the openrouter backend accepts.
    const { stats } = await scoreOn("openrouter", "jev-1.14");
    expect(stats.requests).toBe(1);
  });

  for (const backend of ["typesafe", "openrouter"] as const) {
    test(`${backend}: answer 404 when asked for another version than the recording's`, async () => {
      const err = await scoreOn(backend, "jev-1.13").catch((e: unknown) => e);
      expect((err as Error).message).toMatch(/^kit\/kit#\d+: the \w+ backend answered HTTP 404$/);
    });
  }
});
