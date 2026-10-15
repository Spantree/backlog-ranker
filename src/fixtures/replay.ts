/**
 * The offline network the suite runs against: one fetch that serves the
 * recorded GitHub issue page and the recorded Jev responses, and counts
 * every request by destination, so a test can assert that a refusal sent
 * nothing at all. Jev recordings are keyed by the first 16 hex digits of
 * the state hash; a state with no recording answers 404, so a changed
 * state fails loudly instead of replaying a stale answer.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKENDS } from "../jev/backends.js";
import { stateHash } from "../state.js";
import { GITHUB_GRAPHQL_ENDPOINT } from "../trackers/github.js";

export const FIXTURE_DIR = fileURLToPath(new URL(".", import.meta.url));
/** The clock the fixture states were captured under (their age facts). */
export const FIXTURE_NOW = new Date("2026-10-13T00:00:00.000Z");

/** One recorded response per distinct state sent. */
export function jevFixtureName(state: unknown): string {
  return `${stateHash(state).slice(0, 16)}.json`;
}

export interface RequestCounts {
  github: number;
  jev: number;
  other: number;
}

/** Shaped as the global fetch, so both the tracker and the engine take it. */
export type ReplayFetch = typeof globalThis.fetch;

interface IssueNode {
  number: number;
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
  const counts: RequestCounts = { github: 0, jev: 0, other: 0 };
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
      if (JEV_URLS.has(url)) {
        counts.jev++;
        if (options.jevStatus !== undefined) return json({ error: "replayed status" }, options.jevStatus);
        const { state } = (await bodyOf(init)) as { state: unknown };
        const file = join(FIXTURE_DIR, "jev", jevFixtureName(state));
        if (!existsSync(file)) return json({ error: "no recorded answer for this state" }, 404);
        return json(readFileSync(file, "utf8"));
      }
      counts.other++;
      throw new Error(`the fixture network has no route for ${url}`);
    }) as ReplayFetch,
  };
}
