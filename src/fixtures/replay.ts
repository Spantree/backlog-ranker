/**
 * The offline network the suite runs against: one fetch that serves the
 * recorded GitHub issue page, the Linear team's issues and workflow
 * states, and the recorded Jev responses, and counts
 * every request by destination, so a test can assert that a refusal sent
 * nothing at all. Jev recordings are keyed by the first 16 hex digits of
 * the state hash; a state with no recording answers 404, so a changed
 * state fails loudly instead of replaying a stale answer. So does a
 * request for another Jev version than the recording's served model, so
 * a run pinned to jev-1.13 never replays a jev-1.14 answer as its own.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKENDS, JEV_MODELS, type JevModel } from "../jev/backends.js";
import { servesPinnedModel } from "../jev/validate.js";
import { stateHash } from "../state.js";
import { GITHUB_GRAPHQL_ENDPOINT } from "../trackers/github.js";
import { LINEAR_GRAPHQL_ENDPOINT } from "../trackers/linear.js";

export const FIXTURE_DIR = fileURLToPath(new URL(".", import.meta.url));
/** The clock the fixture states were captured under (their age facts). */
export const FIXTURE_NOW = new Date("2026-10-13T00:00:00.000Z");

/** One recorded response per distinct state sent. */
export function jevFixtureName(state: unknown): string {
  return `${stateHash(state).slice(0, 16)}.json`;
}

export interface RequestCounts {
  github: number;
  linear: number;
  jev: number;
  other: number;
}

/** Shaped as the global fetch, so both the tracker and the engine take it. */
export type ReplayFetch = typeof globalThis.fetch;

interface IssueNode {
  number: number;
}

/** The Linear team every fixture issue belongs to. */
export const FIXTURE_LINEAR_TEAM = "KIT";

interface LinearNode {
  identifier: string;
  state: { id: string };
}

interface LinearVariables {
  id?: string;
  team?: string;
  states?: string[];
}

/** Serves Linear the way its API answers the tracker's three queries:
 * a team's workflow states, a page of issues in the named states, and
 * one issue by identifier in any state. */
function linearReply(query: string, variables: LinearVariables): Response {
  const nodes = (
    JSON.parse(readFileSync(join(FIXTURE_DIR, "linear-issues.json"), "utf8")) as {
      data: { issues: { nodes: LinearNode[] } };
    }
  ).data.issues.nodes;
  if (variables.id !== undefined) {
    const issue = nodes.find((n) => n.identifier === variables.id);
    if (issue !== undefined) return json({ data: { issue } });
    return json({ data: null, errors: [{ message: "Entity not found: Issue" }] });
  }
  const ours = variables.team === FIXTURE_LINEAR_TEAM;
  if (query.includes("workflowStates")) {
    if (ours) return json(readFileSync(join(FIXTURE_DIR, "linear-workflow-states.json"), "utf8"));
    return json({ data: { workflowStates: { nodes: [] } } });
  }
  const wanted = new Set(variables.states ?? []);
  return json({
    data: {
      issues: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: ours ? nodes.filter((n) => wanted.has(n.state.id)) : [],
      },
    },
  });
}

/** The Jev version a request names, in any backend's request spelling
 * (`jev-1.14` or `jev-1.14.0`). */
export function requestedJevModel(spelling: string): JevModel | undefined {
  return JEV_MODELS.find((m) => Object.values(BACKENDS).some((b) => b.requestSpelling(m) === spelling));
}

/** The Jev version a response reports, by the engine's own pinned-model
 * check over every backend's spellings (`typesafe/jev-1.14-20261014`). */
export function servedJevModel(served: string): JevModel | undefined {
  return JEV_MODELS.find((m) =>
    Object.values(BACKENDS).some((b) => servesPinnedModel(b.servedSpellings(m), served)),
  );
}

const JEV_URLS = new Set(Object.values(BACKENDS).map((b) => `${b.baseURL}/v1/systemone`));

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

async function bodyOf(init: RequestInit | undefined): Promise<unknown> {
  return JSON.parse(await new Response(init?.body ?? null).text());
}

const json = (body: unknown, status = 200): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export interface ReplayOptions {
  /** Answer every Jev request with this HTTP status instead of a recording. */
  jevStatus?: number;
}

export function replayFetch(options: ReplayOptions = {}): { fetch: ReplayFetch; counts: RequestCounts } {
  const counts: RequestCounts = { github: 0, linear: 0, jev: 0, other: 0 };
  const page = readFileSync(join(FIXTURE_DIR, "github-issues.json"), "utf8");
  const nodes = (JSON.parse(page) as { data: { repository: { issues: { nodes: IssueNode[] } } } }).data
    .repository.issues.nodes;
  return {
    counts,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      if (url === GITHUB_GRAPHQL_ENDPOINT) {
        counts.github++;
        const { variables } = (await bodyOf(init)) as { variables: { number?: number } };
        if (variables.number === undefined) return json(page);
        const issue = nodes.find((n) => n.number === variables.number) ?? null;
        if (issue !== null) return json({ data: { repository: { issue } } });
        return json({
          data: { repository: { issue: null } },
          errors: [{ type: "NOT_FOUND", path: ["repository", "issue"], message: "not found" }],
        });
      }
      if (url === LINEAR_GRAPHQL_ENDPOINT) {
        counts.linear++;
        const { query, variables } = (await bodyOf(init)) as { query: string; variables: LinearVariables };
        return linearReply(query, variables);
      }
      if (JEV_URLS.has(url)) {
        counts.jev++;
        if (options.jevStatus !== undefined) return json({ error: "replayed status" }, options.jevStatus);
        const { state, model } = (await bodyOf(init)) as { state: unknown; model: unknown };
        const file = join(FIXTURE_DIR, "jev", jevFixtureName(state));
        if (!existsSync(file)) return json({ error: "no recorded answer for this state" }, 404);
        const recorded = readFileSync(file, "utf8");
        const served = (JSON.parse(recorded) as { model?: unknown }).model;
        const asked = typeof model === "string" ? requestedJevModel(model) : undefined;
        if (asked === undefined || typeof served !== "string" || servedJevModel(served) !== asked) {
          return json({ error: "the recorded answer for this state is from another model" }, 404);
        }
        return json(recorded);
      }
      counts.other++;
      throw new Error(`the fixture network has no route for ${url}`);
    }) as ReplayFetch,
  };
}
