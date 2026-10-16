import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { captureDir, FIXTURE_JEV_DIR } from "./capture.js";
import { FIXTURE_DIR } from "./replay.js";

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
