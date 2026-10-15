/**
 * The ENGINE-NEUTRAL decision interface the ranker depends on. An
 * engine is the decision model that answers; nothing in rubric,
 * composition or cache code knows which one. A second decision model is
 * a new adapter, not a rewrite.
 */

export type DecisionQuestion =
  | { kind: "score"; instructions: string; levels: readonly string[] }
  /** Options in the order they are offered: order is part of the
   * question, so the same options in two orders are two questions. */
  | { kind: "choice"; instructions: string; options: readonly { name: string; description: string }[] }
  | { kind: "noul"; instructions: string };

export type DecisionAnswer =
  | {
      kind: "score";
      /** Probability-weighted level index, 0 = the first level. */
      value: number;
      /** Level index to probability. */
      probabilities: readonly number[];
      confidence: number;
    }
  | { kind: "choice"; choice: string; probabilities: Readonly<Record<string, number>>; confidence: number }
  | { kind: "noul"; probability: number };

export interface Decision {
  /** The exact snapshot that answered, as the provider reported it. */
  servedModel: string;
  answers: Record<string, DecisionAnswer>;
}

export interface DecisionEngine {
  /** Names the decision model family; part of every cache key. */
  readonly id: string;
  /** The PINNED model version; part of every cache key, never an alias. */
  readonly model: string;
  /** Ask every question about one state in a single request. The
   * adapter refuses an answer from any version but the pinned one. */
  decide(state: unknown, questions: Readonly<Record<string, DecisionQuestion>>): Promise<Decision>;
}
