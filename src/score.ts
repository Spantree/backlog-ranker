/**
 * Scoring a set of tickets: one request per ticket
 * carrying every criterion and gate the cache cannot answer, requests in
 * parallel up to a bound. Cost grows linearly with the backlog; a run
 * whose questions and tickets are unchanged sends nothing.
 */

import type { AnswerCache } from "./cache.js";
import { rubricQuestions, type Scored } from "./compose.js";
import type { DecisionAnswer, DecisionEngine, DecisionQuestion } from "./engine.js";
import type { Rubric } from "./rubric.js";
import { byCodePoint, stateHash, type TicketState, toState, utf8Bytes } from "./state.js";
import type { Ticket } from "./ticket.js";

export const DEFAULT_CONCURRENCY = 8;

/** The serialized size of the largest question, which the prompt cap
 * counts beside the state. */
export function longestQuestionBytes(questions: Readonly<Record<string, DecisionQuestion>>): number {
  return Math.max(0, ...Object.values(questions).map((q) => utf8Bytes(JSON.stringify(q))));
}

export interface ScoreStats {
  tickets: number;
  /** Requests sent to the engine. */
  requests: number;
  /** Answers served from the cache / asked of the engine. */
  cachedAnswers: number;
  askedAnswers: number;
  /** Tickets whose body code truncated to fit the prompt cap. */
  truncated: string[];
}

/** Runs `work` over `items`, at most `limit` at a time. The first
 * failure stops new items from starting, and the pool settles every
 * in-flight item before it rethrows, so no request outlives the caller's
 * cache flush. */
export async function pool<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | undefined;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (failure === undefined && next < items.length) {
      const item = items[next++]!;
      try {
        await work(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  });
  await Promise.all(runners);
  if (failure !== undefined) throw failure.error;
}

export async function scoreTickets(opts: {
  tickets: readonly Ticket[];
  rubric: Rubric;
  engine: DecisionEngine;
  cache: AnswerCache;
  now: Date;
  concurrency?: number;
}): Promise<{ scored: Scored[]; states: Map<string, TicketState>; stats: ScoreStats }> {
  const questions = rubricQuestions(opts.rubric);
  const stats: ScoreStats = {
    tickets: opts.tickets.length,
    requests: 0,
    cachedAnswers: 0,
    askedAnswers: 0,
    truncated: [],
  };
  const states = new Map<string, TicketState>();
  const scored = new Map<string, Scored>();
  // Every ticket's state is fitted against the rubric's longest question,
  // whether or not that question is asked this run, so the state (and
  // its cache key) does not depend on what the cache already holds.
  const reserved = longestQuestionBytes(questions);

  await pool(opts.tickets, opts.concurrency ?? DEFAULT_CONCURRENCY, async (ticket) => {
    const { state, truncated } = toState(ticket, opts.now, reserved);
    if (truncated) stats.truncated.push(ticket.key);
    states.set(ticket.key, state);
    const hash = stateHash(state);
    const answers: Record<string, DecisionAnswer> = {};
    const missing: [string, (typeof questions)[string]][] = [];
    for (const [id, q] of Object.entries(questions)) {
      const hit = opts.cache.get(hash, q);
      if (hit === undefined) missing.push([id, q]);
      else answers[id] = hit;
    }
    stats.cachedAnswers += Object.keys(questions).length - missing.length;
    if (missing.length > 0) {
      stats.requests++;
      stats.askedAnswers += missing.length;
      const fresh = await opts.engine.decide(state, Object.fromEntries(missing));
      for (const [id, q] of missing) {
        answers[id] = fresh.answers[id]!;
        opts.cache.put(hash, q, fresh.answers[id]!, fresh.servedModel);
      }
    }
    scored.set(ticket.key, { key: ticket.key, title: ticket.title, url: ticket.url, truncated, answers });
  });

  stats.truncated.sort(byCodePoint);
  // Input order, not completion order, so output never depends on timing.
  return { scored: opts.tickets.map((t) => scored.get(t.key)!), states, stats };
}
