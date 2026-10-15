import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CACHE_DIR, openCache } from "./cache.js";
import type { DecisionQuestion } from "./engine.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "backlog-cache-"));
const q: DecisionQuestion = { kind: "noul", instructions: "q" };

describe("openCache", () => {
  test("one file per engine and model under .backlog-ranker/cache, schema-tagged", () => {
    const root = tmp();
    const c = openCache(root, "jev", "typesafe/jev 1.14", () => new Date("2026-10-15T00:00:00Z"));
    expect(c.path).toBe(join(root, ".backlog-ranker", "cache", "jev--typesafe_jev_1.14.json"));
    expect(CACHE_DIR).toBe(join(".backlog-ranker", "cache"));
    c.put("h", q, { kind: "noul", probability: 0.3 }, "typesafe/jev-1.14-20261014");
    c.flush();
    const file = JSON.parse(readFileSync(c.path, "utf8"));
    expect(file).toMatchObject({ schema: 2, engine: "jev", model: "typesafe/jev 1.14" });
    expect(Object.values(file.entries)).toEqual([
      {
        answer: { kind: "noul", probability: 0.3 },
        served: "typesafe/jev-1.14-20261014",
        at: "2026-10-15T00:00:00.000Z",
      },
    ]);
  });

  test("another engine or model never reads this cache", () => {
    const root = tmp();
    const c = openCache(root, "e", "m-1");
    c.put("h", q, { kind: "noul", probability: 1 }, "m-1");
    c.flush();
    expect(openCache(root, "e", "m-1").get("h", q)).toEqual({ kind: "noul", probability: 1 });
    expect(openCache(root, "e", "m-2").get("h", q)).toBeUndefined();
    expect(openCache(root, "other", "m-1").get("h", q)).toBeUndefined();
  });

  test("a corrupt or foreign cache file is a cold cache, not a crash", () => {
    const root = tmp();
    const c = openCache(root, "fake", "m-1");
    c.put("h", q, { kind: "noul", probability: 1 }, "m-1");
    c.flush();
    writeFileSync(c.path, "{not json");
    expect(openCache(root, "fake", "m-1").get("h", q)).toBeUndefined();
    writeFileSync(c.path, JSON.stringify({ schema: 2, engine: "fake", model: "m-1", entries: null }));
    expect(openCache(root, "fake", "m-1").get("h", q)).toBeUndefined();
    writeFileSync(c.path, JSON.stringify({ schema: 1, engine: "x", model: "m-1", entries: { a: 1 } }));
    expect(openCache(root, "fake", "m-1").get("h", q)).toBeUndefined();
    expect(JSON.parse(readFileSync(c.path, "utf8")).engine).toBe("x");
  });

  test("flush merges with answers another run flushed since this one opened the file", () => {
    const root = tmp();
    const q1: DecisionQuestion = { kind: "noul", instructions: "one" };
    const q2: DecisionQuestion = { kind: "noul", instructions: "two" };
    const a = openCache(root, "e", "m");
    const b = openCache(root, "e", "m");
    a.put("h", q1, { kind: "noul", probability: 0.1 }, "m");
    a.flush();
    b.put("h", q2, { kind: "noul", probability: 0.2 }, "m");
    b.flush();
    const c = openCache(root, "e", "m");
    expect(c.get("h", q1)).toEqual({ kind: "noul", probability: 0.1 });
    expect(c.get("h", q2)).toEqual({ kind: "noul", probability: 0.2 });
  });

  test("the two option orders of a choice are two distinct cache entries", () => {
    const a: DecisionQuestion = {
      kind: "choice",
      instructions: "q",
      options: [
        { name: "first", description: "x" },
        { name: "second", description: "y" },
      ],
    };
    const b: DecisionQuestion = {
      kind: "choice",
      instructions: "q",
      options: [
        { name: "second", description: "y" },
        { name: "first", description: "x" },
      ],
    };
    const cache = openCache(tmp(), "e", "m");
    cache.put("h", a, { kind: "noul", probability: 1 }, "m");
    expect(cache.get("h", b)).toBeUndefined();
  });
});
