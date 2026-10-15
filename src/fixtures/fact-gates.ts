/**
 * The fact-gate suites' shared setup: in-memory tickets, the fixture
 * rubric with fact gates appended, and a stub engine that answers from a
 * table and records every state it is sent. Nothing here touches the
 * fixture network.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DecisionAnswer, DecisionEngine } from "../engine.js";
import { parseRubric, type Rubric } from "../rubric.js";
import type { Ticket } from "../ticket.js";
import { FIXTURE_DIR } from "./replay.js";

/** The clock the in-memory tickets' ages are bucketed under. */
export const NOW = new Date("2026-10-15T00:00:00Z");
/** The fixture rubric's text: impact over effort, a security pin, a judgeable hold. */
export const FACT_GATE_FIXTURE = readFileSync(join(FIXTURE_DIR, "rubric.yaml"), "utf8");

/** The two gates the brief agreed, as the shipped rubric declares them. */
export const BRIEF_GATES = `fact_gates:
  - id: blocked
    fact: open_blockers
    at_least: 1
    action: sink
  - id: in_progress
    fact: open_closing_prs
    at_least: 1
    action: hold
`;

/** The fixture rubric (security pin, judgeable hold) plus `factGates`. */
export const rubricWith = (factGates = BRIEF_GATES): Rubric =>
  parseRubric(`${FACT_GATE_FIXTURE}${factGates}`, "fact-gates.yaml");

/** What the stub engine answers about each ticket, keyed by title.
 * Composites under the fixture's roi rubric: (1 + impact) / (1 + effort). */
const TRUTH: Record<string, { impact: number; effort: number; security?: number; judgeable?: number }> = {
  "big win": { impact: 4, effort: 0 }, // 5
  "cheap small": { impact: 1, effort: 0 }, // 2
  middling: { impact: 2, effort: 2 }, // 1
  "token in a log": { impact: 1, effort: 3, security: 0.9 }, // 0.5, pinned
  "vague leak": { impact: 2, effort: 0, security: 0.9, judgeable: 0.2 }, // 3, pinned and model-held
  "something vague": { impact: 4, effort: 0, judgeable: 0.2 }, // 5, model-held
};

/** Tie-break preference: the stub always picks the ticket listed later
 * here, so a pair across groups would lift a sunk row or drop a pin. */
const PREFERENCE = ["token in a log", "vague leak", "cheap small", "middling", "big win"];

/** A stub engine answering from {@link TRUTH} and {@link PREFERENCE}, counting
 * its requests and recording every state it is sent. */
export function stubEngine(): DecisionEngine & { calls: number; states: unknown[] } {
  const engine = {
    id: "stub",
    model: "stub-1",
    calls: 0,
    states: [] as unknown[],
    async decide(state: unknown, questions: Parameters<DecisionEngine["decide"]>[1]) {
      engine.calls++;
      engine.states.push(state);
      const answers: Record<string, DecisionAnswer> = {};
      for (const [id, q] of Object.entries(questions)) {
        if (q.kind === "choice") {
          const pair = state as { first: { title: string }; second: { title: string } };
          const firstWins = PREFERENCE.indexOf(pair.first.title) > PREFERENCE.indexOf(pair.second.title);
          answers[id] = {
            kind: "choice",
            choice: firstWins ? "first" : "second",
            probabilities: firstWins ? { first: 0.9, second: 0.1 } : { first: 0.1, second: 0.9 },
            confidence: 0.9,
          };
          continue;
        }
        const truth = TRUTH[(state as { title: string }).title];
        if (truth === undefined) throw new Error("stub engine asked about an unknown ticket");
        if (q.kind === "score") {
          const value = id === "impact" ? truth.impact : truth.effort;
          answers[id] = { kind: "score", value, probabilities: [], confidence: 0.9 };
        } else {
          const p = id === "security" ? (truth.security ?? 0.1) : (truth.judgeable ?? 0.9);
          answers[id] = { kind: "noul", probability: p };
        }
      }
      return { servedModel: "stub-1-20261015", answers };
    },
  };
  return engine;
}

/** An in-memory ticket in kit/kit; `facts` overrides any field. */
export const ticket = (n: number, title: string, facts: Partial<Ticket> = {}): Ticket => ({
  key: `kit/kit#${n}`,
  title,
  body: `about ${title}`,
  labels: [],
  url: `https://github.com/kit/kit/issues/${n}`,
  createdAt: "2026-10-01T00:00:00Z",
  reactions: 0,
  linkedIssues: 0,
  duplicates: 0,
  ...facts,
});
