/**
 * The optional top-slice tie-break: pairwise Choice
 * questions over the top N rows only, since pairs grow quadratically.
 *
 * Jev's Choice answers can lean on option order, so every pair is asked
 * in both orders in one request and the two probabilities are averaged.
 * Rows are then reordered by their summed win probability (a Copeland
 * score), within the pinned, normal and sunk groups separately so a
 * pin still holds and a sunk row never rises above a normal one. Ties
 * fall back to the composite order.
 */

import type { AnswerCache } from "./cache.js";
import { type RankedRow, rankGroup } from "./compose.js";
import type { DecisionEngine, DecisionQuestion } from "./engine.js";
import type { Rubric } from "./rubric.js";
import { DEFAULT_CONCURRENCY, longestQuestionBytes, pool } from "./score.js";
import { fitBodies, PromptBudgetError, stateBytes, stateHash, type TicketState } from "./state.js";

export const MAX_TIEBREAK = 10;

export interface TiebreakStats {
  pairs: number;
  requests: number;
  cacheHits: number;
  /** Pairs whose two bodies were cut further to share one prompt. */
  truncatedPairs: number;
}

/** The fallback pairwise question carries every criterion's own question
 * and levels, not just its id: the id is a name, the wording is the
 * policy, and a reworded criterion must re-ask (it changes this hash).
 * It names each criterion's direction but never its weight, and lists
 * every criterion whatever its weight: weights are composition inputs
 * only, so a `--weight` override never changes this question. */
function defaultAsk(rubric: Rubric): string {
  const criteria = rubric.criteria.map((c) => {
    const better = c.direction === "benefit" ? "a higher level is better" : "a lower level is better";
    return `- ${c.question} Levels, lowest first: ${c.levels.join(" | ")}. ${better}.`;
  });
  return ["Which ticket should be done first, judged by these criteria?", ...criteria].join("\n");
}

/** The pair as one state, both bodies cut to share the prompt budget. */
function pairState(
  a: TicketState,
  b: TicketState,
  reserved: number,
): { state: { first: TicketState; second: TicketState }; clipped: boolean } {
  const shell = stateBytes({ first: { ...a, body: "" }, second: { ...b, body: "" } });
  const fitted = fitBodies([a.body, b.body], shell, reserved);
  if (fitted === null) throw new PromptBudgetError("the tie-break pair", reserved);
  const [first, second] = fitted.bodies;
  if (first === undefined || second === undefined) throw new Error("fitBodies lost a body of the pair");
  return {
    state: { first: { ...a, body: first }, second: { ...b, body: second } },
    clipped: fitted.clipped.some(Boolean),
  };
}

function pairQuestions(rubric: Rubric): Record<string, DecisionQuestion> {
  const ask = rubric.tiebreak_question ?? defaultAsk(rubric);
  const first = "The ticket in `first`";
  const second = "The ticket in `second`";
  return {
    first_listed_first: {
      kind: "choice",
      instructions: ask,
      options: [
        { name: "first", description: first },
        { name: "second", description: second },
      ],
    },
    second_listed_first: {
      kind: "choice",
      instructions: ask,
      options: [
        { name: "second", description: second },
        { name: "first", description: first },
      ],
    },
  };
}

export async function tiebreak(opts: {
  rubric: Rubric;
  rows: readonly RankedRow[];
  states: ReadonlyMap<string, TicketState>;
  top: number;
  engine: DecisionEngine;
  cache: AnswerCache;
  concurrency?: number;
}): Promise<{ rows: RankedRow[]; stats: TiebreakStats }> {
  const n = Math.min(opts.top, MAX_TIEBREAK, opts.rows.length);
  const slice = opts.rows.slice(0, n);
  const questions = pairQuestions(opts.rubric);
  const wins = new Map(slice.map((r) => [r.key, 0]));
  const stats: TiebreakStats = { pairs: 0, requests: 0, cacheHits: 0, truncatedPairs: 0 };
  const reserved = longestQuestionBytes(questions);

  const settle = async (a: RankedRow, b: RankedRow): Promise<void> => {
    const stateA = opts.states.get(a.key);
    const stateB = opts.states.get(b.key);
    if (stateA === undefined || stateB === undefined) {
      throw new Error(`the tie-break has no scored state for ${stateA === undefined ? a.key : b.key}`);
    }
    const { state, clipped } = pairState(stateA, stateB, reserved);
    if (clipped) stats.truncatedPairs++;
    const hash = stateHash(state);
    const missing = Object.entries(questions).filter(([, q]) => opts.cache.get(hash, q) === undefined);
    if (missing.length === 0) stats.cacheHits++;
    else {
      stats.requests++;
      const fresh = await opts.engine.decide(state, Object.fromEntries(missing));
      for (const [id, q] of missing) {
        const answer = fresh.answers[id];
        if (answer === undefined)
          throw new Error(`the ${opts.engine.id} engine returned no answer for "${id}"`);
        opts.cache.put(hash, q, answer, fresh.servedModel);
      }
    }
    let pFirst = 0;
    for (const q of Object.values(questions)) {
      const answer = opts.cache.get(hash, q);
      if (answer === undefined) throw new Error("a tie-break answer was not cached");
      pFirst += answer.kind === "choice" ? (answer.probabilities.first ?? 0) : 0.5;
    }
    pFirst /= 2;
    // Every key in the slice starts at 0 wins.
    wins.set(a.key, (wins.get(a.key) ?? 0) + pFirst);
    wins.set(b.key, (wins.get(b.key) ?? 0) + (1 - pFirst));
  };

  const pairs: [RankedRow, RankedRow][] = [];
  for (const [i, a] of slice.entries()) {
    for (const b of slice.slice(i + 1)) {
      if (rankGroup(a) === rankGroup(b)) pairs.push([a, b]);
    }
  }
  stats.pairs = pairs.length;
  // The same bound scoring uses, so a top-10 tie-break sends at most
  // DEFAULT_CONCURRENCY requests at once rather than all 45.
  await pool(pairs, opts.concurrency ?? DEFAULT_CONCURRENCY, ([a, b]) => settle(a, b));

  const reordered = slice
    .map((row, order) => ({ row, order, wins: wins.get(row.key) ?? 0 }))
    .sort((x, y) => {
      return rankGroup(x.row) - rankGroup(y.row) || y.wins - x.wins || x.order - y.order;
    })
    .map((entry) => entry.row);
  return { rows: [...reordered, ...opts.rows.slice(n)], stats };
}
