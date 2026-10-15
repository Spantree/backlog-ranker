/**
 * A rubric: what a ranking run asks about each ticket and how code turns
 * the answers into an order.
 *
 * Rubrics live in `.backlog-decisions/rubrics/`: `<name>.yaml` is
 * committed ranking policy, `<name>.local.yaml` is a gitignored
 * experiment. When both exist the local file replaces the committed one
 * outright, and the run says which file it read.
 *
 * Each criterion is one Score question with ordered, concrete levels.
 * Impact and effort are asked separately and divided in code: no
 * question ever asks the engine for a ratio.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { RefusalError } from "./errors.js";
import { sha256 } from "./state.js";

const ID_RE = /^[a-z][a-z0-9_]{0,39}$/;
const id = z
  .string()
  .regex(ID_RE, "ids are lowercase snake_case, starting with a letter, at most 40 characters");

const criterionSchema = z
  .object({
    id,
    question: z.string().min(1),
    /** Ordered lowest to highest; 2 to 10 levels (Jev's Score bound). */
    levels: z.array(z.string().min(1)).min(2).max(10),
    weight: z.number().nonnegative().default(1),
    /** `benefit`: a higher level ranks the ticket higher. `cost`: lower. */
    direction: z.enum(["benefit", "cost"]),
  })
  .strict();

const gateSchema = z
  .object({
    id,
    question: z.string().min(1),
    /** `pin_top`: a yes at or above `threshold` lifts the ticket above
     * every unpinned one. `flag_if_below`: a probability under
     * `threshold` holds the ticket out of the ranking for a human. */
    action: z.enum(["pin_top", "flag_if_below"]),
    threshold: z.number().min(0).max(1).default(0.5),
  })
  .strict();

export const rubricSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    /** `weighted_sum`: compensating criteria, each normalized to 0..1 and
     * flipped for cost. `roi`: weighted benefit over weighted cost, both
     * on a 1-based level scale. */
    compose: z.enum(["weighted_sum", "roi"]),
    /** A Score answer below this confidence is flagged for a human; the
     * ticket keeps its place rather than being scored lower. */
    confidence_floor: z.number().min(0).max(1).default(0.5),
    criteria: z.array(criterionSchema).min(1),
    gates: z.array(gateSchema).default([]),
    /** The question the optional pairwise tie-break asks. */
    tiebreak_question: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((rubric, ctx) => {
    const seen = new Set<string>();
    for (const item of [...rubric.criteria, ...rubric.gates]) {
      if (seen.has(item.id)) ctx.addIssue({ code: "custom", message: `duplicate id "${item.id}"` });
      seen.add(item.id);
    }
    if (rubric.compose === "roi") {
      for (const direction of ["benefit", "cost"] as const) {
        if (!rubric.criteria.some((c) => c.direction === direction && c.weight > 0)) {
          ctx.addIssue({
            code: "custom",
            message: `compose: roi needs at least one weighted ${direction} criterion`,
          });
        }
      }
    }
    if (!rubric.criteria.some((c) => c.weight > 0)) {
      ctx.addIssue({ code: "custom", message: "at least one criterion needs a weight above 0" });
    }
  });

export type Rubric = z.infer<typeof rubricSchema>;
export type Criterion = Rubric["criteria"][number];
export type Gate = Rubric["gates"][number];

export const RUBRIC_DIR = join(".backlog-decisions", "rubrics");
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class RubricError extends RefusalError {
  constructor(message: string) {
    super(message);
    this.name = "RubricError";
  }
}

export function parseRubric(text: string, origin: string): Rubric {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new RubricError(`${origin} is not valid YAML: ${(err as Error).message}`);
  }
  const parsed = rubricSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new RubricError(`${origin} is not a valid rubric:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

/** A short content hash of a rubric's text: the first 12 hex digits of
 * its SHA-256, enough to tell two versions of a rubric apart in a
 * report header. */
export function rubricHash(text: string): string {
  return sha256(text).slice(0, 12);
}

export interface LoadedRubric {
  rubric: Rubric;
  /** {@link rubricHash} of the file's text. */
  hash: string;
  /** Project-relative path of the file that was read. */
  path: string;
  local: boolean;
}

/** Resolve `--rubric <name>` against `.backlog-decisions/rubrics/`, local first. */
export function loadRubric(projectRoot: string, name: string): LoadedRubric {
  if (!NAME_RE.test(name)) {
    throw new RubricError(
      `--rubric takes a rubric name such as "impact-roi" (lowercase, digits, dashes), not "${name}"`,
    );
  }
  for (const [file, local] of [
    [`${name}.local.yaml`, true],
    [`${name}.yaml`, false],
  ] as const) {
    const path = join(RUBRIC_DIR, file);
    const abs = join(projectRoot, path);
    if (existsSync(abs)) {
      const text = readFileSync(abs, "utf8");
      return { rubric: parseRubric(text, path), hash: rubricHash(text), path, local };
    }
  }
  const shared = join(RUBRIC_DIR, name + ".yaml");
  const local = join(RUBRIC_DIR, name + ".local.yaml");
  throw new RubricError(`no rubric "${name}": neither ${shared} nor ${local} exists`);
}

/** Apply `--weight id=value` overrides. Weights are composition inputs
 * only, so an override never changes a question or a cache key. */
export function withWeights(rubric: Rubric, overrides: Readonly<Record<string, number>>): Rubric {
  const known = new Set(rubric.criteria.map((c) => c.id));
  for (const key of Object.keys(overrides)) {
    if (!known.has(key) || !Object.hasOwn(overrides, key))
      throw new RubricError(`--weight names "${key}", which is not a criterion of ${rubric.name}`);
  }
  const next = {
    ...rubric,
    criteria: rubric.criteria.map((c) =>
      Object.hasOwn(overrides, c.id) ? { ...c, weight: overrides[c.id]! } : c,
    ),
  };
  const checked = rubricSchema.safeParse(next);
  if (!checked.success)
    throw new RubricError(
      `the --weight overrides leave an invalid rubric: ${checked.error.issues[0]!.message}`,
    );
  return checked.data;
}
