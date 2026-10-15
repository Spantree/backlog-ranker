/**
 * The library facades: rank, calibrate and explain without the CLI.
 * Each takes a rubric (object or YAML path), a decision engine, an open
 * answer cache and its tickets (a list, or a tracker to read them from),
 * and returns what the CLI renders. Each flushes the cache before it
 * returns or throws.
 */

import { readFileSync } from "node:fs";
import type { AnswerCache } from "./cache.js";
import { type Ranking, rank, type Scored } from "./compose.js";
import type { DecisionEngine } from "./engine.js";
import { RefusalError } from "./errors.js";
import { type Calibration, kendallTau } from "./kendall.js";
import { type Gate, parseRubric, type Rubric, withWeights } from "./rubric.js";
import { type ScoreStats, scoreTickets } from "./score.js";
import type { TicketState } from "./state.js";
import type { Ticket } from "./ticket.js";
import { MAX_TIEBREAK, type TiebreakStats, tiebreak } from "./tiebreak.js";
import type { Tracker } from "./trackers/tracker.js";

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

function resolveRubric(opts: DecisionRunOptions & Pick<BacklogOptions, "weights">): Rubric {
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

export interface ExplainedGate {
  id: string;
  action: Gate["action"];
  threshold: number;
  probability: number;
  /** Whether the gate acted: a pin at or above, a hold under, its threshold. */
  triggered: boolean;
}

export interface ExplainResult {
  rubric: Rubric;
  key: string;
  title: string;
  url: string;
  composite: number;
  criteria: ExplainedCriterion[];
  gates: ExplainedGate[];
  /** `truncated`: the body was cut to fit the prompt budget. */
  flags: { pinnedBy: string[]; heldBy: string[]; lowConfidence: string[]; truncated: boolean };
  stats: ScoreStats;
}

/** One ticket's reasoning: scored exactly as a rank scores it, so the
 * same cache entries answer both. */
export async function explainTicket(opts: ExplainOptions): Promise<ExplainResult> {
  const rubric = resolveRubric(opts);
  const now = opts.now ?? (() => new Date());
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
    const { scored, stats } = await scoreTickets({
      tickets: [ticket],
      rubric,
      engine: opts.engine,
      cache: opts.cache,
      now: now(),
    });
    const ranking = rank(rubric, scored);
    const row = ranking.ranked[0] ?? ranking.held[0];
    if (row === undefined) throw new Error(`${ticket.key} was scored but not ranked`);
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
    const gates = rubric.gates.map((g): ExplainedGate => {
      const a = row.answers[g.id];
      if (a?.kind !== "noul") throw new Error(`${row.key} has no noul answer for gate "${g.id}"`);
      return {
        id: g.id,
        action: g.action,
        threshold: g.threshold,
        probability: a.probability,
        triggered: row.pinnedBy.includes(g.id) || row.heldBy.includes(g.id),
      };
    });
    return {
      rubric,
      key: row.key,
      title: row.title,
      url: row.url,
      composite: row.composite,
      criteria,
      gates,
      flags: {
        pinnedBy: row.pinnedBy,
        heldBy: row.heldBy,
        lowConfidence: row.lowConfidence,
        truncated: row.truncated,
      },
      stats,
    };
  } finally {
    opts.cache.flush();
  }
}
