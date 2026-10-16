/**
 * Composition in code: the engine answers narrow
 * questions about one ticket; weighting, ROI arithmetic, gates, fact
 * gates and flags happen here, so changing any of them never re-runs
 * inference.
 */

import type { DecisionAnswer, DecisionQuestion } from "./engine.js";
import type { Criterion, FactGate, Rubric } from "./rubric.js";
import { byCodePoint } from "./state.js";
import type { TicketFacts } from "./ticket.js";

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
  /** The ticket's numeric facts, for fact gates; an absent fact is 0. */
  facts?: Readonly<Partial<TicketFacts>>;
}

export interface RankedRow extends Scored {
  composite: number;
  /** Gates whose yes lifted this ticket above the unpinned ones. */
  pinnedBy: string[];
  /** Gates whose probability fell under their threshold, and hold
   * fact gates that fired. */
  heldBy: string[];
  /** Sink fact gates that fired on this row, when it is neither pinned
   * nor held. */
  sunkBy: string[];
  /** Weighted criteria answered below the rubric's confidence floor. */
  lowConfidence: string[];
}

export interface Ranking {
  /** Pinned rows, then normal rows, then sunk rows, each by composite
   * descending. */
  ranked: RankedRow[];
  /** Rows a `flag_if_below` gate or a hold fact gate held out for a human. */
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

/** Whether a fact gate fires on a row: its fact is at least `at_least`. */
export function factGateFires(gate: FactGate, row: Scored): boolean {
  return (row.facts?.[gate.fact] ?? 0) >= gate.at_least;
}

/** A ranked row's group: 0 pinned, 1 normal, 2 sunk. The tie-break
 * reorders within a group only. */
export function rankGroup(row: RankedRow): 0 | 1 | 2 {
  if (row.pinnedBy.length > 0) return 0;
  return row.sunkBy.length > 0 ? 2 : 1;
}

function byComposite(a: RankedRow, b: RankedRow): number {
  return b.composite - a.composite || byCodePoint(a.key, b.key);
}

export function rank(rubric: Rubric, rows: readonly Scored[]): Ranking {
  // Precedence: a fact-gate hold wins over a pin (an open closing pull
  // request means someone is on it), a pin wins over a model-gate hold
  // ("any security issue jumps the queue" holds even for a thin ticket,
  // which stays on top carrying its held flag) and over a sink, and a
  // sink applies only to rows neither pinned nor held.
  const heldKeys = new Set<string>();
  const out: RankedRow[] = rows.map((row) => {
    const pinnedBy: string[] = [];
    const heldBy: string[] = [];
    const sunkBy: string[] = [];
    for (const g of rubric.gates) {
      const a = row.answers[g.id];
      if (a?.kind !== "noul") throw new Error(`${row.key} has no noul answer for gate "${g.id}"`);
      if (g.action === "pin_top" && a.probability >= g.threshold) pinnedBy.push(g.id);
      if (g.action === "flag_if_below" && a.probability < g.threshold) heldBy.push(g.id);
    }
    const fired = rubric.fact_gates.filter((g) => factGateFires(g, row));
    const factHolds = fired.filter((g) => g.action === "hold").map((g) => g.id);
    heldBy.push(...factHolds);
    if (factHolds.length > 0 || (heldBy.length > 0 && pinnedBy.length === 0)) heldKeys.add(row.key);
    else if (pinnedBy.length === 0) sunkBy.push(...fired.filter((g) => g.action === "sink").map((g) => g.id));
    // A zero-weight criterion adds nothing to the composite, so its
    // confidence has nothing to warn about.
    const lowConfidence = rubric.criteria
      .filter((c) => c.weight > 0 && scoreOf(row, c).confidence < rubric.confidence_floor)
      .map((c) => c.id);
    return { ...row, composite: compositeOf(rubric, row), pinnedBy, heldBy, sunkBy, lowConfidence };
  });
  const held = out.filter((r) => heldKeys.has(r.key)).sort(byComposite);
  const kept = out.filter((r) => !heldKeys.has(r.key));
  const group = (g: number): RankedRow[] => kept.filter((r) => rankGroup(r) === g).sort(byComposite);
  return { ranked: [...group(0), ...group(1), ...group(2)], held };
}
