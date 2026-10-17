/**
 * The library facades: rank, calibrate and explain without the CLI.
 * Each takes a rubric (object or YAML path), a decision engine, an open
 * answer cache and its tickets (a list, or a tracker to read them from),
 * and returns what the CLI renders. Each flushes the cache before it
 * returns or throws; a flush failing beside a failed run never replaces
 * the run's error.
 */

import { readFileSync } from "node:fs";
import type { AnswerCache } from "./cache.js";
import {
  composeRow,
  type ExplainedFactGate,
  type ExplainedGate,
  type Ranking,
  rank,
  type Scored,
} from "./compose.js";
import type { DecisionEngine } from "./engine.js";
import { RefusalError } from "./errors.js";
import { type Calibration, kendallTau } from "./kendall.js";
import { parseRubric, type Rubric, RubricError, withWeights } from "./rubric.js";
import { assertConcurrency, type ScoreStats, scoreTickets } from "./score.js";
import type { AgeBucket, TicketState } from "./state.js";
import { type Ticket, type TicketFacts, ticketFacts } from "./ticket.js";
import { MAX_TIEBREAK, type TiebreakStats, tiebreak } from "./tiebreak.js";
import type { Tracker } from "./trackers/tracker.js";

export type { ExplainedFactGate, ExplainedGate } from "./compose.js";

/** What every facade takes: the rubric, the engine, its cache and the clock. */
export interface DecisionRunOptions {
  /** A parsed rubric, or the path of a rubric YAML file. */
  rubric: Rubric | string;
  engine: DecisionEngine;
  /** An open answer cache for `engine`; flushed before the call returns. */
  cache: AnswerCache;
  /** The clock that buckets ticket ages. Defaults to the system clock. */
  now?: () => Date;
}

export interface BacklogOptions extends DecisionRunOptions {
  /** The tickets to rank. Exactly one of `tickets` and `tracker`. */
  tickets?: readonly Ticket[];
  /** The tracker to read tickets from. Exactly one of `tickets` and `tracker`. */
  tracker?: Tracker;
  /** Criterion weight overrides; never change a question or a cache key. */
  weights?: Readonly<Record<string, number>>;
  /** Engine requests in flight at once. */
  concurrency?: number;
}

export interface RankOptions extends BacklogOptions {
  /** Reorder the top N rows (1 to {@link MAX_TIEBREAK}) by pairwise questions. */
  tiebreak?: number;
}

export interface RankResult {
  /** The rubric as applied, weight overrides included. */
  rubric: Rubric;
  ranking: Ranking;
  /** Each ticket's state as sent, by key. */
  states: Map<string, TicketState>;
  stats: ScoreStats;
  tiebreak?: TiebreakStats & { top: number };
}

export interface CalibrateOptions extends BacklogOptions {
  /** Issue keys, best first, as a human ranked them. */
  hand: readonly string[];
}

export interface CalibrateResult {
  rubric: Rubric;
  calibration: Calibration;
  /** The tool's order of the same tickets: kept rows, then held rows. */
  tool: string[];
  scored: Scored[];
  ranking: Ranking;
  stats: ScoreStats;
}

/** A rubric file's text. A relative path resolves against the working
 * directory; a missing file is a refusal worded as the CLI's. */
function readRubricFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new RubricError(`no rubric file ${path}`);
    throw err;
  }
}

function resolveRubric(opts: DecisionRunOptions & Pick<BacklogOptions, "weights">): Rubric {
  const rubric =
    typeof opts.rubric === "string" ? parseRubric(readRubricFile(opts.rubric), opts.rubric) : opts.rubric;
  return opts.weights === undefined ? rubric : withWeights(rubric, opts.weights);
}

/** Flush after a failed run without hiding why it failed: the run's
 * error is what the caller sees, and a flush that fails too is attached
 * to it as a non-enumerable `flushError`. A flush that fails after a
 * successful run throws as is. */
function flushAfterFailure(cache: AnswerCache, err: unknown): void {
  try {
    cache.flush();
  } catch (flushError) {
    try {
      if (typeof err === "object" && err !== null)
        Object.defineProperty(err, "flushError", { value: flushError, configurable: true });
    } catch {
      // A frozen error keeps its own story; the flush failure is lost.
    }
  }
}

/** The given tickets, or the tracker's: exactly one source. */
async function readTickets(
  opts: BacklogOptions,
  fromTracker: (tracker: Tracker) => Promise<Ticket[]>,
): Promise<readonly Ticket[]> {
  if (opts.tickets !== undefined && opts.tracker === undefined) return opts.tickets;
  if (opts.tracker !== undefined && opts.tickets === undefined) return fromTracker(opts.tracker);
  throw new RefusalError("pass exactly one of tickets and tracker");
}

export async function rankBacklog(opts: RankOptions): Promise<RankResult> {
  const top = opts.tiebreak;
  if (top !== undefined && !(Number.isInteger(top) && top >= 1 && top <= MAX_TIEBREAK)) {
    throw new RefusalError(`tiebreak is a whole number from 1 to ${MAX_TIEBREAK} (pairs grow quadratically)`);
  }
  if (opts.concurrency !== undefined) assertConcurrency(opts.concurrency);
  const rubric = resolveRubric(opts);
  const now = opts.now ?? (() => new Date());
  const concurrency = opts.concurrency === undefined ? {} : { concurrency: opts.concurrency };
  let failed = false;
  try {
    const tickets = await readTickets(opts, (tracker) => tracker.pending());
    const { scored, states, stats } = await scoreTickets({
      tickets,
      rubric,
      engine: opts.engine,
      cache: opts.cache,
      now: now(),
      ...concurrency,
    });
    const ranking = rank(rubric, scored);
    if (top === undefined) return { rubric, ranking, states, stats };
    const result = await tiebreak({
      rubric,
      rows: ranking.ranked,
      states,
      top,
      engine: opts.engine,
      cache: opts.cache,
      ...concurrency,
    });
    return {
      rubric,
      ranking: { ...ranking, ranked: result.rows },
      states,
      stats,
      tiebreak: { ...result.stats, top: Math.min(top, result.rows.length) },
    };
  } catch (err) {
    failed = true;
    flushAfterFailure(opts.cache, err);
    throw err;
  } finally {
    if (!failed) opts.cache.flush();
  }
}

export async function calibrateBacklog(opts: CalibrateOptions): Promise<CalibrateResult> {
  const hand = [...opts.hand];
  // Trackers read keys case-insensitively, so two spellings of one key are one key.
  if (new Set(hand.map((k) => k.toLowerCase())).size !== hand.length) {
    throw new RefusalError("the hand ranking lists a key twice");
  }
  if (hand.length < 2) throw new RefusalError("the hand ranking needs at least two issue keys, best first");
  if (opts.concurrency !== undefined) assertConcurrency(opts.concurrency);
  const rubric = resolveRubric(opts);
  const now = opts.now ?? (() => new Date());
  let failed = false;
  try {
    const tickets = await readTickets(opts, (tracker) => tracker.issues(hand));
    // A hand key no ticket answers would silently drop out of tau's n:
    // refused, as explain refuses a key the tracker did not return.
    const read = new Set(tickets.map((t) => t.key.toLowerCase()));
    const missing = hand.filter((k) => !read.has(k.toLowerCase()));
    if (missing.length > 0) {
      const from = opts.tracker === undefined ? "the tickets include" : "the tracker returned";
      throw new RefusalError(`${from} no issue ${missing.join(", ")}`);
    }
    const { scored, stats } = await scoreTickets({
      tickets,
      rubric,
      engine: opts.engine,
      cache: opts.cache,
      now: now(),
      ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
    });
    const ranking = rank(rubric, scored);
    // Held rows rank after every kept row: the tool would not put them mid-ranking.
    const tool = [...ranking.ranked, ...ranking.held].map((r) => r.key);
    // Each hand key as the tracker spells it (`ACME/app#12` is `acme/app#12`),
    // so a key in another case still counts toward tau.
    const spelled = new Map(tickets.map((t) => [t.key.toLowerCase(), t.key]));
    const handKeys = hand.map((k) => spelled.get(k.toLowerCase()) ?? k);
    return { rubric, calibration: kendallTau(handKeys, tool), tool, scored, ranking, stats };
  } catch (err) {
    failed = true;
    flushAfterFailure(opts.cache, err);
    throw err;
  } finally {
    if (!failed) opts.cache.flush();
  }
}

export interface ExplainOptions extends DecisionRunOptions {
  /** The ticket to explain. Exactly one of `ticket` and `tracker` with `key`. */
  ticket?: Ticket;
  /** The tracker to read the ticket from, by `key`. */
  tracker?: Tracker;
  key?: string;
}

export interface ExplainedLevel {
  index: number;
  text: string;
  probability: number;
}

export interface ExplainedCriterion {
  id: string;
  direction: "benefit" | "cost";
  weight: number;
  /** Probability-weighted level index, 0 = the first level. */
  score: number;
  confidence: number;
  lowConfidence: boolean;
  levels: ExplainedLevel[];
}

export interface ExplainResult {
  rubric: Rubric;
  key: string;
  title: string;
  url: string;
  composite: number;
  /** Every fact code counted: the age bucket and the numeric facts,
   * including those only fact gates read and the model never sees. */
  facts: { age: AgeBucket } & TicketFacts;
  criteria: ExplainedCriterion[];
  gates: ExplainedGate[];
  factGates: ExplainedFactGate[];
  /** `truncated`: the body was cut to fit the prompt budget. */
  flags: {
    pinnedBy: string[];
    heldBy: string[];
    sunkBy: string[];
    lowConfidence: string[];
    truncated: boolean;
  };
  stats: ScoreStats;
}

/** One ticket's reasoning: scored exactly as a rank scores it, so the
 * same cache entries answer both. */
export async function explainTicket(opts: ExplainOptions): Promise<ExplainResult> {
  const rubric = resolveRubric(opts);
  const now = opts.now ?? (() => new Date());
  let failed = false;
  try {
    let ticket: Ticket;
    if (opts.ticket !== undefined && opts.tracker === undefined && opts.key === undefined) {
      ticket = opts.ticket;
    } else if (opts.ticket === undefined && opts.tracker !== undefined && opts.key !== undefined) {
      const found = await opts.tracker.issues([opts.key]);
      if (found[0] === undefined) throw new RefusalError(`the tracker returned no issue ${opts.key}`);
      ticket = found[0];
    } else {
      throw new RefusalError("pass either a ticket, or a tracker and a key");
    }
    const { scored, states, stats } = await scoreTickets({
      tickets: [ticket],
      rubric,
      engine: opts.engine,
      cache: opts.cache,
      now: now(),
    });
    const scoredRow = scored[0];
    if (scoredRow === undefined) throw new Error(`${ticket.key} was scored but not ranked`);
    const { row, gates, factGates } = composeRow(rubric, scoredRow);
    const criteria = rubric.criteria.map((c): ExplainedCriterion => {
      const a = row.answers[c.id];
      if (a?.kind !== "score") throw new Error(`${row.key} has no score answer for criterion "${c.id}"`);
      return {
        id: c.id,
        direction: c.direction,
        weight: c.weight,
        score: a.value,
        confidence: a.confidence,
        lowConfidence: row.lowConfidence.includes(c.id),
        levels: c.levels.map((text, index) => ({ index, text, probability: a.probabilities[index] ?? 0 })),
      };
    });
    const facts = ticketFacts(ticket);
    const age = states.get(ticket.key)?.facts.age;
    if (age === undefined) throw new Error(`${ticket.key} was scored without a state`);
    return {
      rubric,
      key: row.key,
      title: row.title,
      url: row.url,
      composite: row.composite,
      facts: { age, ...facts },
      criteria,
      gates,
      factGates,
      flags: {
        pinnedBy: row.pinnedBy,
        heldBy: row.heldBy,
        sunkBy: row.sunkBy,
        lowConfidence: row.lowConfidence,
        truncated: row.truncated,
      },
      stats,
    };
  } catch (err) {
    failed = true;
    flushAfterFailure(opts.cache, err);
    throw err;
  } finally {
    if (!failed) opts.cache.flush();
  }
}
