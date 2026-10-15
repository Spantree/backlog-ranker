/**
 * Checks a Jev response past what its shape alone can say. The SDK does
 * no runtime validation of answers (its types are compile-time only), so
 * the response is parsed here: a Score must carry a probability for every
 * requested level and a value inside the level range; a Choice must carry
 * every requested option and pick one of them; both distributions must
 * sum to one within rounding. An incomplete distribution is refused,
 * never filled with zeros, so it cannot pass as a confident answer.
 */

import { z } from "zod";
import type { DecisionQuestion } from "../engine.js";

const probability = z.number().min(0).max(1);

const scoreAnswerSchema = z.object({
  type: z.literal("score"),
  /** Probability-weighted level index; can land between levels. */
  score: z.number(),
  /** Level index (as a string) to probability. */
  probabilities: z.record(z.string(), probability),
  confidence: probability,
});

const choiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), probability),
  confidence: probability,
});

const noulAnswerSchema = z.object({
  type: z.literal("noul"),
  /** Probability the answer is yes. */
  noul: probability,
});

const answerSchema = z.discriminatedUnion("type", [scoreAnswerSchema, choiceAnswerSchema, noulAnswerSchema]);

export const jevResultSchema = z.object({
  /** The versioned model that answered, as the backend reports it. */
  model: z.string(),
  answers: z.record(z.string(), answerSchema),
});

export type JevAnswer = z.infer<typeof answerSchema>;
export type JevResult = z.infer<typeof jevResultSchema>;

/** Backends round each probability to two places, so a distribution's
 * sum can miss one by up to half a hundredth per key (three options at
 * 0.33 sum to 0.99; ten levels can miss by 0.05). */
export const PROBABILITY_ROUNDING_PER_KEY = 0.005;

function sumsToOne(probabilities: Readonly<Record<string, number>>): boolean {
  const values = Object.values(probabilities);
  const total = values.reduce((s, p) => s + p, 0);
  return Math.abs(total - 1) <= PROBABILITY_ROUNDING_PER_KEY * values.length + 1e-9;
}

function sameKeys(probabilities: Readonly<Record<string, number>>, expected: readonly string[]): boolean {
  const keys = Object.keys(probabilities);
  return keys.length === expected.length && expected.every((k) => Object.hasOwn(probabilities, k));
}

/** Why `answer` does not answer `question`, or null when it does. */
export function answerProblem(question: DecisionQuestion, answer: JevAnswer): string | null {
  if (answer.type !== question.kind) return `was answered as ${answer.type}, not ${question.kind}`;
  if (question.kind === "score" && answer.type === "score") {
    const levels = question.levels.map((_, i) => String(i));
    const top = levels.length - 1;
    if (!sameKeys(answer.probabilities, levels))
      return `carries probabilities for levels other than 0..${top}`;
    if (!sumsToOne(answer.probabilities)) return "carries level probabilities that do not sum to one";
    if (answer.score < 0 || answer.score > top) return `scored ${answer.score}, outside 0..${top}`;
  }
  if (question.kind === "choice" && answer.type === "choice") {
    const options = question.options.map((o) => o.name);
    if (!sameKeys(answer.probabilities, options))
      return "carries probabilities for options other than the ones asked";
    if (!sumsToOne(answer.probabilities)) return "carries option probabilities that do not sum to one";
    if (!options.includes(answer.choice)) return `chose "${answer.choice}", which was not an option`;
  }
  return null;
}

/** The pinned version answered when the reported model is one of the
 * backend's spellings of it, optionally followed by a dated snapshot
 * suffix (`typesafe/jev-1.14-20261014`). Any other version, another patch
 * spelling included, is refused before its answers can reach the cache. */
export function servesPinnedModel(spellings: readonly string[], served: string): boolean {
  return spellings.some(
    (pinned) =>
      served === pinned || (served.startsWith(pinned) && /^-\d{8}$/.test(served.slice(pinned.length))),
  );
}
