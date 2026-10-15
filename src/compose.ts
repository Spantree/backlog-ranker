/**
 * Composition in code: the engine answers narrow
 * questions about one ticket; weighting, ROI arithmetic, gates and flags
 * happen here, so changing any of them never re-runs inference.
 */

import type { DecisionAnswer, DecisionQuestion } from "./engine.js";
import type { Criterion, Rubric } from "./rubric.js";
import { byCodePoint } from "./state.js";

/** The questions a rubric asks about every ticket, keyed by id. */
export function rubricQuestions(rubric: Rubric): Record<string, DecisionQuestion> {
  const out: Record<string, DecisionQuestion> = {};
  for (const c of rubric.criteria) out[c.id] = { kind: "score", instructions: c.question, levels: c.levels };
  for (const g of rubric.gates) out[g.id] = { kind: "noul", instructions: g.question };
  return out;
}

export interface Scored {
  key: string;
  title: string;
  url: string;
  truncated: boolean;
  answers: Readonly<Record<string, DecisionAnswer>>;
}

export interface RankedRow extends Scored {
  composite: number;
  /** Gates whose yes lifted this ticket above the unpinned ones. */
  pinnedBy: string[];
  /** Gates whose probability fell under their threshold. */
  heldBy: string[];
  /** Criteria answered below the rubric's confidence floor. */
  lowConfidence: string[];
}

export interface Ranking {
  /** Pinned rows first, then the rest, each by composite descending. */
  ranked: RankedRow[];
  /** Rows a `flag_if_below` gate held out for a human. */
  held: RankedRow[];
}

function scoreOf(row: Scored, c: Criterion): { value: number; confidence: number } {
  const a = row.answers[c.id];
  if (a?.kind !== "score") throw new Error(`${row.key} has no score answer for criterion "${c.id}"`);
  return { value: a.value, confidence: a.confidence };
}

function weightedMean(
  row: Scored,
  criteria: readonly Criterion[],
  f: (value: number, c: Criterion) => number,
): number {
  const total = criteria.reduce((s, c) => s + c.weight, 0);
  if (total === 0) return 0;
  return criteria.reduce((s, c) => s + c.weight * f(scoreOf(row, c).value, c), 0) / total;
}

export function compositeOf(rubric: Rubric, row: Scored): number {
  const norm = (value: number, c: Criterion): number => value / (c.levels.length - 1);
  if (rubric.compose === "weighted_sum") {
    return weightedMean(row, rubric.criteria, (v, c) =>
      c.direction === "benefit" ? norm(v, c) : 1 - norm(v, c),
    );
  }
  // roi: both sides on a 1-based level scale, so the lowest cost level
  // divides by 1 rather than by zero.
  const benefit = weightedMean(
    row,
    rubric.criteria.filter((c) => c.direction === "benefit"),
    (v) => 1 + v,
  );
  const cost = weightedMean(
    row,
    rubric.criteria.filter((c) => c.direction === "cost"),
    (v) => 1 + v,
  );
  return benefit / cost;
}

function byComposite(a: RankedRow, b: RankedRow): number {
  return b.composite - a.composite || byCodePoint(a.key, b.key);
}

export function rank(rubric: Rubric, rows: readonly Scored[]): Ranking {
  const out: RankedRow[] = rows.map((row) => {
    const pinnedBy: string[] = [];
    const heldBy: string[] = [];
    for (const g of rubric.gates) {
      const a = row.answers[g.id];
      if (a?.kind !== "noul") throw new Error(`${row.key} has no noul answer for gate "${g.id}"`);
      if (g.action === "pin_top" && a.probability >= g.threshold) pinnedBy.push(g.id);
      if (g.action === "flag_if_below" && a.probability < g.threshold) heldBy.push(g.id);
    }
    const lowConfidence = rubric.criteria
      .filter((c) => scoreOf(row, c).confidence < rubric.confidence_floor)
      .map((c) => c.id);
    return { ...row, composite: compositeOf(rubric, row), pinnedBy, heldBy, lowConfidence };
  });
  // A pin wins over a hold: "any security issue jumps the queue" holds
  // even for a thin ticket, which stays on top carrying its held flag.
  const isHeld = (r: RankedRow): boolean => r.heldBy.length > 0 && r.pinnedBy.length === 0;
  const held = out.filter(isHeld).sort(byComposite);
  const kept = out.filter((r) => !isHeld(r));
  const pinned = kept.filter((r) => r.pinnedBy.length > 0).sort(byComposite);
  const rest = kept.filter((r) => r.pinnedBy.length === 0).sort(byComposite);
  return { ranked: [...pinned, ...rest], held };
}
