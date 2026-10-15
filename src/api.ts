/**
 * The library facades: rank and calibrate a backlog without the CLI.
 * Each takes a rubric (object or YAML path), a decision engine, an open
 * answer cache and either a ticket list or a tracker, and returns what
 * the CLI renders. Both flush the cache before they return or throw.
 */

import { readFileSync } from "node:fs";
import type { AnswerCache } from "./cache.js";
import { type Ranking, rank, type Scored } from "./compose.js";
import type { DecisionEngine } from "./engine.js";
import { RefusalError } from "./errors.js";
import { type Calibration, kendallTau } from "./kendall.js";
import { parseRubric, type Rubric, withWeights } from "./rubric.js";
import { type ScoreStats, scoreTickets } from "./score.js";
import type { TicketState } from "./state.js";
import type { Ticket } from "./ticket.js";
import { MAX_TIEBREAK, type TiebreakStats, tiebreak } from "./tiebreak.js";
import type { Tracker } from "./trackers/tracker.js";

export interface BacklogOptions {
  /** A parsed rubric, or the path of a rubric YAML file. */
  rubric: Rubric | string;
  /** The tickets to rank. Exactly one of `tickets` and `tracker`. */
  tickets?: readonly Ticket[];
  /** The tracker to read tickets from. Exactly one of `tickets` and `tracker`. */
  tracker?: Tracker;
  engine: DecisionEngine;
  /** An open answer cache for `engine`; flushed before the call returns. */
  cache: AnswerCache;
  /** The clock that buckets ticket ages. Defaults to the system clock. */
  now?: () => Date;
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

function resolveRubric(opts: BacklogOptions): Rubric {
  const rubric =
    typeof opts.rubric === "string"
      ? parseRubric(readFileSync(opts.rubric, "utf8"), opts.rubric)
      : opts.rubric;
  return opts.weights === undefined ? rubric : withWeights(rubric, opts.weights);
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
  const rubric = resolveRubric(opts);
  const now = opts.now ?? (() => new Date());
  const concurrency = opts.concurrency === undefined ? {} : { concurrency: opts.concurrency };
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
  } finally {
    opts.cache.flush();
  }
}

export async function calibrateBacklog(opts: CalibrateOptions): Promise<CalibrateResult> {
  const hand = [...opts.hand];
  if (new Set(hand).size !== hand.length) throw new RefusalError("the hand ranking lists a key twice");
  if (hand.length < 2) throw new RefusalError("the hand ranking needs at least two issue keys, best first");
  const rubric = resolveRubric(opts);
  const now = opts.now ?? (() => new Date());
  try {
    const tickets = await readTickets(opts, (tracker) => tracker.issues(hand));
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
    return { rubric, calibration: kendallTau(hand, tool), tool, scored, ranking, stats };
  } finally {
    opts.cache.flush();
  }
}
