import { describe, expect, test } from "bun:test";
import { kendallTau } from "./kendall.js";

describe("kendallTau", () => {
  test("identical, reversed and partly agreeing orders", () => {
    const keys = Array.from({ length: 12 }, (_, i) => `K${i}`);
    expect(kendallTau(keys, keys)).toMatchObject({ tau: 1, n: 12, trusted: true, disagreements: [] });
    expect(kendallTau(keys, [...keys].reverse())).toMatchObject({ tau: -1, trusted: false });
    const swapped = kendallTau(["A", "B", "C", "D"], ["B", "A", "C", "D"]);
    expect(swapped.tau).toBeCloseTo((5 - 1) / 6);
    expect(swapped.disagreements).toEqual([{ above: "A", below: "B" }]);
  });

  test("trust needs both tau >= 0.4 and at least 12 tickets", () => {
    expect(kendallTau(["A", "B", "C"], ["A", "B", "C"]).trusted).toBe(false);
    const keys = Array.from({ length: 12 }, (_, i) => `K${i}`);
    // Swapping 13 of 66 pairs leaves tau = (53 - 13) / 66 ≈ 0.606.
    const tool = [...keys];
    for (let i = 0; i + 1 < tool.length; i += 1)
      if (i % 2 === 0) [tool[i], tool[i + 1]] = [tool[i + 1]!, tool[i]!];
    const result = kendallTau(keys, tool);
    expect(result.tau).toBeGreaterThanOrEqual(0.4);
    expect(result.trusted).toBe(true);
  });

  test("only keys in both rankings count", () => {
    expect(kendallTau(["A", "B", "X"], ["B", "A"])).toMatchObject({ n: 2, tau: -1 });
  });
});
