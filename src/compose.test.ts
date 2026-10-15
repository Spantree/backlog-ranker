import { describe, expect, test } from "bun:test";
import { compositeOf, rank, type Scored } from "./compose.js";
import type { DecisionAnswer } from "./engine.js";
import { parseRubric } from "./rubric.js";

const rubric = (compose: "roi" | "weighted_sum", gates = ""): ReturnType<typeof parseRubric> =>
  parseRubric(
    `name: t
compose: ${compose}
confidence_floor: 0.6
criteria:
  - id: impact
    direction: benefit
    weight: 2
    question: q
    levels: [a, b, c, d, e]
  - id: effort
    direction: cost
    question: q
    levels: [a, b, c, d, e]
${gates}`,
    "t",
  );

const score = (value: number, confidence = 0.9): DecisionAnswer => ({
  kind: "score",
  value,
  probabilities: [],
  confidence,
});
const noul = (probability: number): DecisionAnswer => ({ kind: "noul", probability });
const row = (key: string, answers: Record<string, DecisionAnswer>): Scored => ({
  key,
  title: key,
  url: "",
  truncated: false,
  answers,
});

describe("compositeOf", () => {
  test("weighted_sum normalizes each level and flips cost", () => {
    // impact 4/4 = 1 with weight 2, effort 2/4 = 0.5 flipped to 0.5.
    expect(compositeOf(rubric("weighted_sum"), row("A", { impact: score(4), effort: score(2) }))).toBeCloseTo(
      (2 * 1 + 0.5) / 3,
    );
  });

  test("roi divides benefit by cost on a 1-based level scale", () => {
    expect(compositeOf(rubric("roi"), row("A", { impact: score(3), effort: score(1) }))).toBeCloseTo(4 / 2);
    expect(compositeOf(rubric("roi"), row("A", { impact: score(3), effort: score(0) }))).toBeCloseTo(4);
  });
});

describe("rank", () => {
  const gates = `gates:
  - id: security
    question: q
    action: pin_top
    threshold: 0.7
  - id: judgeable
    question: q
    action: flag_if_below
    threshold: 0.5`;

  test("pins, holds and flags, then orders by composite", () => {
    const r = rubric("roi", gates);
    const ranking = rank(r, [
      row("HIGH", { impact: score(4), effort: score(0), security: noul(0.1), judgeable: noul(0.9) }),
      row("PINNED", { impact: score(1), effort: score(4), security: noul(0.7), judgeable: noul(0.9) }),
      row("THIN", { impact: score(4), effort: score(0), security: noul(0.1), judgeable: noul(0.49) }),
      row("UNSURE", { impact: score(2, 0.59), effort: score(2), security: noul(0.1), judgeable: noul(0.9) }),
    ]);
    expect(ranking.ranked.map((x) => x.key)).toEqual(["PINNED", "HIGH", "UNSURE"]);
    expect(ranking.ranked[0]?.pinnedBy).toEqual(["security"]);
    expect(ranking.held.map((x) => x.key)).toEqual(["THIN"]);
    expect(ranking.held[0]?.heldBy).toEqual(["judgeable"]);
    // Low confidence is flagged for a human, never scored lower.
    const unsure = ranking.ranked.find((x) => x.key === "UNSURE");
    expect(unsure?.lowConfidence).toEqual(["impact"]);
    expect(unsure?.composite).toBeCloseTo(3 / 3);
  });

  test("a pin wins over a hold: a thin security ticket stays on top, flagged", () => {
    const r = rubric("roi", gates);
    const ranking = rank(r, [
      row("THIN-LEAK", { impact: score(1), effort: score(1), security: noul(0.9), judgeable: noul(0.1) }),
      row("OTHER", { impact: score(4), effort: score(0), security: noul(0.1), judgeable: noul(0.9) }),
    ]);
    expect(ranking.ranked.map((x) => x.key)).toEqual(["THIN-LEAK", "OTHER"]);
    expect(ranking.ranked[0]?.heldBy).toEqual(["judgeable"]);
    expect(ranking.held).toEqual([]);
  });

  test("changing a weight re-orders without new answers", () => {
    const rows = [
      row("BIG", { impact: score(4), effort: score(4) }),
      row("CHEAP", { impact: score(1), effort: score(0) }),
    ];
    const r = rubric("weighted_sum");
    expect(rank(r, rows).ranked.map((x) => x.key)).toEqual(["BIG", "CHEAP"]);
    const effortHeavy = {
      ...r,
      criteria: r.criteria.map((c) => (c.id === "effort" ? { ...c, weight: 10 } : c)),
    };
    expect(rank(effortHeavy, rows).ranked.map((x) => x.key)).toEqual(["CHEAP", "BIG"]);
  });

  test("equal composites fall back to key order, so output is stable", () => {
    const same = { impact: score(2), effort: score(2) };
    expect(rank(rubric("roi"), [row("B", same), row("A", same)]).ranked.map((x) => x.key)).toEqual([
      "A",
      "B",
    ]);
  });
});
