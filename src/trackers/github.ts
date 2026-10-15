/**
 * GitHub as a backlog source: every OPEN issue of one repository. The
 * `issues` connection never includes pull requests, so none are filtered.
 * Facts are computed here, by code, so the decision model never counts.
 */

import { graphql } from "@octokit/graphql";
import type { Ticket } from "../ticket.js";
import type { Tracker } from "./tracker.js";

export const GITHUB_GRAPHQL_ENDPOINT = "https://api.github.com/graphql";
const PAGE_SIZE = 100;

export type FetchFn = typeof globalThis.fetch;

export interface GitHubTrackerOptions {
  owner: string;
  repo: string;
  token: string;
  /** Replaces the global fetch, for tests. */
  fetch?: FetchFn;
  /** The environment variable the token came from, named in auth refusals. */
  tokenEnvVar?: string;
}

const ISSUE_FIELDS = `number title body url createdAt
  labels(first: 100) { nodes { name } }
  reactions { totalCount }
  timelineItems(itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT, MARKED_AS_DUPLICATE_EVENT], first: 100) {
    nodes { __typename }
  }
  subIssues { totalCount }
  parent { number }`;

const PENDING_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: ${PAGE_SIZE}, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ISSUE_FIELDS} }
    }
  }
}`;

interface IssueNode {
  number: number;
  title: string;
  body: string | null;
  url: string;
  createdAt: string;
  labels: { nodes: { name: string }[] };
  reactions: { totalCount: number };
  timelineItems: { nodes: ({ __typename: string } | null)[] };
  subIssues: { totalCount: number };
  parent: { number: number } | null;
}

interface PendingPage {
  repository: {
    issues: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: IssueNode[] };
  };
}

function toTicket(owner: string, repo: string, node: IssueNode): Ticket {
  const events = node.timelineItems.nodes.map((n) => n?.__typename);
  const count = (...types: string[]) => events.filter((t) => t !== undefined && types.includes(t)).length;
  return {
    key: `${owner}/${repo}#${node.number}`,
    title: node.title,
    body: node.body ?? "",
    labels: node.labels.nodes.map((l) => l.name),
    url: node.url,
    createdAt: node.createdAt,
    reactions: node.reactions.totalCount,
    linkedIssues:
      count("CrossReferencedEvent", "ConnectedEvent") + node.subIssues.totalCount + (node.parent ? 1 : 0),
    duplicates: count("MarkedAsDuplicateEvent"),
  };
}

export function githubTracker(opts: GitHubTrackerOptions): Tracker {
  const { owner, repo } = opts;
  const gh = graphql.defaults({
    headers: { authorization: `token ${opts.token}` },
    ...(opts.fetch ? { request: { fetch: opts.fetch } } : {}),
  });

  return {
    source: `github:${owner}/${repo}`.toLowerCase(),
    async pending() {
      const tickets: Ticket[] = [];
      let after: string | null = null;
      for (;;) {
        const page: PendingPage = await gh<PendingPage>(PENDING_QUERY, { owner, name: repo, after });
        const { nodes, pageInfo } = page.repository.issues;
        tickets.push(...nodes.map((n) => toTicket(owner, repo, n)));
        if (!pageInfo.hasNextPage || pageInfo.endCursor === null) break;
        after = pageInfo.endCursor;
      }
      return tickets;
    },
    async issues() {
      throw new Error("not yet");
    },
  };
}
