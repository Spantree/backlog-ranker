/**
 * GitHub as a backlog source: every OPEN issue of one repository. The
 * `issues` connection never includes pull requests, so none are filtered.
 * Facts are computed here, by code, so the decision model never counts.
 */

import { GraphqlResponseError, graphql } from "@octokit/graphql";
import { RefusalError } from "../errors.js";
import { SourceError, type SourceRef } from "../source.js";
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

const ISSUE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) { ${ISSUE_FIELDS} } }
}`;

const KEY_RE = /^([\w.-]+)\/([\w.-]+)#([1-9]\d*)$/;

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

interface IssueLookup {
  repository: { issue: IssueNode | null } | null;
}

/** GitHub answers a missing issue number with null data and only
 * a NOT_FOUND error at `repository.issue`; that is a missing issue, not
 * a failed request. A missing repository still refuses as an error. */
function notFound(err: GraphqlResponseError<IssueLookup>): IssueLookup | undefined {
  const onlyNotFound =
    err.errors?.every((e) => {
      const { type, path } = e as { type?: unknown; path?: unknown };
      return type === "NOT_FOUND" && Array.isArray(path) && path.join(".") === "repository.issue";
    }) ?? false;
  return onlyNotFound ? { repository: null } : undefined;
}

interface PendingPage {
  repository: {
    issues: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: IssueNode[] };
  };
}

/** A tracker failure. Value-free: it names the operation and the HTTP
 * status, never the token or any text from GitHub's reply. */
export class GitHubTrackerError extends RefusalError {
  constructor(message: string) {
    super(message);
    this.name = "GitHubTrackerError";
  }
}

/** How to mint a token, named after the variable it is read from. */
export function tokenHint(tokenEnvVar: string): string {
  return (
    `Set ${tokenEnvVar} to a token that can read the repository; with the gh CLI: ` +
    `gh auth login, then export ${tokenEnvVar}=$(gh auth token)`
  );
}

/** Translates whatever octokit threw into a value-free refusal. */
function refusalFor(err: unknown, operation: string, tokenEnvVar: string): GitHubTrackerError {
  if (err instanceof GraphqlResponseError) {
    return new GitHubTrackerError(`GitHub answered HTTP 200 with GraphQL errors while ${operation}`);
  }
  const e = err as { name?: unknown; status?: unknown; response?: unknown } | null;
  if (e?.name === "HttpError" && typeof e.status === "number") {
    // octokit reports a network failure as status 500 with no response.
    if (e.response === undefined) return new GitHubTrackerError(`could not reach GitHub while ${operation}`);
    if (e.status === 401 || e.status === 403) {
      return new GitHubTrackerError(
        `GitHub refused the token while ${operation} (HTTP ${e.status}). ` +
          tokenHint(tokenEnvVar),
      );
    }
    return new GitHubTrackerError(`GitHub answered HTTP ${e.status} while ${operation}`);
  }
  return new GitHubTrackerError(`could not reach GitHub while ${operation}`);
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
  const tokenEnvVar = opts.tokenEnvVar ?? "GITHUB_TOKEN";
  const gh = graphql.defaults({
    headers: { authorization: `token ${opts.token}` },
    ...(opts.fetch ? { request: { fetch: opts.fetch } } : {}),
  });

  /** Runs one query. `partial` may accept a GraphQL-error reply's partial
   * data instead of refusing (a missing issue arrives as NOT_FOUND). */
  async function call<T>(
    operation: string,
    query: string,
    variables: Record<string, unknown>,
    partial?: (err: GraphqlResponseError<T>) => T | undefined,
  ): Promise<T> {
    try {
      return await gh<T>(query, variables);
    } catch (err) {
      const accepted = partial && err instanceof GraphqlResponseError ? partial(err) : undefined;
      if (accepted !== undefined) return accepted;
      throw refusalFor(err, operation, tokenEnvVar);
    }
  }

  return {
    source: `github:${owner}/${repo}`.toLowerCase(),
    async pending() {
      const tickets: Ticket[] = [];
      let after: string | null = null;
      for (;;) {
        const page: PendingPage = await call<PendingPage>(
          `listing ${owner}/${repo}'s open issues`,
          PENDING_QUERY,
          { owner, name: repo, after },
        );
        const { nodes, pageInfo } = page.repository.issues;
        tickets.push(...nodes.map((n) => toTicket(owner, repo, n)));
        if (!pageInfo.hasNextPage || pageInfo.endCursor === null) break;
        after = pageInfo.endCursor;
      }
      return tickets;
    },
    async issues(keys) {
      const repoName = `${owner}/${repo}`.toLowerCase();
      const numbers: number[] = [];
      const foreign: string[] = [];
      for (const key of keys) {
        const m = KEY_RE.exec(key);
        if (m && `${m[1]}/${m[2]}`.toLowerCase() === repoName) numbers.push(Number(m[3]));
        else foreign.push(key);
      }
      if (foreign.length > 0) {
        throw new GitHubTrackerError(
          `${foreign.join(", ")} not in ${owner}/${repo}, the repository this source reads ` +
            `(keys look like ${owner}/${repo}#123)`,
        );
      }
      const tickets: Ticket[] = [];
      for (const number of numbers) {
        const key = `${owner}/${repo}#${number}`;
        const data = await call<IssueLookup>(
          `reading ${key}`,
          ISSUE_QUERY,
          { owner, name: repo, number },
          notFound,
        );
        if (data.repository?.issue == null) throw new GitHubTrackerError(`GitHub has no issue ${key}`);
        tickets.push(toTicket(owner, repo, data.repository.issue));
      }
      return tickets;
    },
  };
}

/** The tracker for a parsed source. GitHub is the one adapter today; a
 * `linear:` source parses but refuses as a planned adapter. */
export function trackerFor(source: SourceRef, opts: Omit<GitHubTrackerOptions, "owner" | "repo">): Tracker {
  if (source.kind === "linear") {
    throw new SourceError(
      `${source.spec} is a Linear source, and the Linear adapter is planned but not built yet; ` +
        "backlog-decisions reads github:<owner>/<repo> sources today",
    );
  }
  return githubTracker({ ...opts, owner: source.owner, repo: source.repo });
}
