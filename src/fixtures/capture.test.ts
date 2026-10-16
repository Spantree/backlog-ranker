import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJevEngine } from "../jev/engine.js";
import { captureDir, FIXTURE_JEV_DIR, recorder } from "./capture.js";
import { FIXTURE_DIR, jevFixtureName } from "./replay.js";

const response = (name: string): string =>
  readFileSync(join(FIXTURE_DIR, "..", "jev", "fixtures", name), "utf8");
const STATE = { title: "Checkout shows a blank screen" };
const QUESTIONS = { is_bug: { kind: "noul", instructions: "Is this a defect?" } } as const;

describe("recorder", () => {
  test("keeps responses in memory and writes them, id removed, only when saved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "backlog-capture-test-"));
    const body = { ...JSON.parse(response("openrouter-response.json")), id: "gen-1" };
    const rec = recorder(async () => Response.json(body));
    const engine = createJevEngine({ backend: "openrouter", apiKey: "k", fetch: rec.fetch });
    await engine.decide(STATE, { ...QUESTIONS });
    expect(readdirSync(dir)).toEqual([]);

    expect(rec.save(dir)).toBe(1);
    const file = join(dir, jevFixtureName(STATE));
    const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(saved.id).toBeUndefined();
    expect(saved.model).toBe("typesafe/jev-1.14-20261014");
  });

  test("a response the engine refuses is never written: the failed run does not save", async () => {
    const dir = mkdtempSync(join(tmpdir(), "backlog-capture-test-"));
    const rec = recorder(async () => new Response(response("openrouter-response-1.13.json")));
    const engine = createJevEngine({ backend: "openrouter", apiKey: "k", fetch: rec.fetch });
    const run = async (): Promise<void> => {
      await engine.decide(STATE, { ...QUESTIONS });
      rec.save(dir);
    };
    await expect(run()).rejects.toThrow("not the pinned jev-1.14");
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("captureDir", () => {
  test("the default model records into the suite's folder, or wherever --out says", () => {
    expect(captureDir("jev-1.14", undefined)).toBe(FIXTURE_JEV_DIR);
    expect(captureDir("jev-1.14", "elsewhere")).toBe(resolve("elsewhere"));
  });

  test("another model refuses the suite's folder, however it is spelled", () => {
    expect(() => captureDir("jev-1.13", undefined)).toThrow("pass --out <dir>");
    expect(() => captureDir("jev-1.13", join(FIXTURE_DIR, "jev"))).toThrow("pass --out <dir>");
    expect(() => captureDir("jev-1.13", join(FIXTURE_DIR, "jev/"))).toThrow("pass --out <dir>");
    expect(captureDir("jev-1.13", "recordings-1.13")).toBe(resolve("recordings-1.13"));
  });
});
