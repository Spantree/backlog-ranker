/**
 * GitHub as a backlog source: every OPEN issue of one repository. The
 * `issues` connection never includes pull requests, so none are filtered.
 * Facts are computed here, by code, so the decision model never counts.
 */

import { GraphqlResponseError, graphql } from "@octokit/graphql";
import { RefusalError } from "../errors.js";
import { DEFAULT_KEY_VARS } from "../keys.js";
import { issueNumberIn } from "../source.js";
import type { Ticket } from "../ticket.js";
import type { FetchFn, Tracker } from "./tracker.js";

export const GITHUB_GRAPHQL_ENDPOINT = "https://api.github.com/graphql";
/** Issues per page. Busy repositories (thousands of open issues, each
 * with dozens of timeline events) push a page past GitHub's resource
 * limits or its gateway timeout, so a refused page is asked again at half
 * the size, down to the smallest, and paging goes on at the size that
 * worked. */
const PAGE_SIZE = 50;
const MIN_PAGE_SIZE = 12;
const DEFAULT_TIMEOUT_MS = 30_000;
/** A 502, 503 or 504 is asked again this many times, after 1 s, then 2 s. */
const RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1000;

export interface GitHubTrackerOptions {
  owner: string;
  repo: string;
  token: string;
  /** Replaces the global fetch, for tests. */
  fetch?: FetchFn;
  /** The environment variable the token came from, named in auth refusals. */
  tokenEnvVar?: string;
  /** Per-request timeout; 30 seconds by default. */
  timeoutMs?: number;
  /** The first wait before asking again after a gateway error; it doubles
   * on each retry. 1 second by default. */
  retryDelayMs?: number;
}

/** Linked issues count cross-references and connections whose other end
 * is an issue, plus sub-issues; pull requests and the parent do not count.
 * A cross-reference is told apart by its path, whose anchor names the
 * kind of item that made it (`#ref-issue-…`, `#ref-pullrequest-…`):
 * resolving each reference's source is what pushes a busy repository's
 * page past GitHub's resource limits. Open blockers come counted from the
 * dependency summary; closing pull requests are filtered to open ones in
 * code, since closing references can be MERGED. Drafts are OPEN, so they
 * count. */
const ISSUE_FIELDS = `id number title body url createdAt
  labels(first: 100) { nodes { name } }
  reactions { totalCount }
  assignees { totalCount }
  timelineItems(itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT, MARKED_AS_DUPLICATE_EVENT], first: 100) {
    nodes {
      __typename
      ... on CrossReferencedEvent { resourcePath }
      ... on ConnectedEvent { source { __typename ... on Node { id } } subject { __typename ... on Node { id } } }
    }
  }
  subIssues { totalCount }
  issueDependenciesSummary { blockedBy }
  closedByPullRequestsReferences(first: 10, includeClosedPrs: false) { nodes { state } }`;

const PENDING_QUERY = `query($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ISSUE_FIELDS} }
    }
  }
}`;

const ISSUE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) { ${ISSUE_FIELDS} } }
}`;

/** The issue or pull request at one end of a timeline reference. */
interface Subject {
  __typename: string;
  id?: string;
}

interface TimelineNode {
  __typename: string;
  resourcePath?: string;
  source?: Subject | null;
  subject?: Subject | null;
}

interface IssueNode {
  id: string;
  number: number;
  title: string;
  body: string | null;
  url: string;
  createdAt: string;
  labels: { nodes: { name: string }[] };
  reactions: { totalCount: number };
  assignees: { totalCount: number };
  timelineItems: { nodes: (TimelineNode | null)[] };
  subIssues: { totalCount: number };
  issueDependenciesSummary: { blockedBy: number };
  closedByPullRequestsReferences: { nodes: ({ state: string } | null)[] };
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

/** What may still get a refused request through: asking again as it is
 * (a gateway error), or asking for a smaller page (a page too heavy for
 * GitHub's resource limits or its gateway timeout). */
interface Recovery {
  retry?: boolean;
  smaller?: boolean;
}

/** A tracker failure. Value-free: it names the operation and the HTTP
 * status, never the token or any text from GitHub's reply. */
export class GitHubTrackerError extends RefusalError {
  readonly retry: boolean;
  readonly smaller: boolean;
  constructor(message: string, recovery: Recovery = {}) {
    super(message);
    this.name = "GitHubTrackerError";
    this.retry = recovery.retry ?? false;
    this.smaller = recovery.smaller ?? false;
  }
}

/** How to mint a token, named after the variable it is read from. */
export function tokenHint(tokenEnvVar: string): string {
  return `Set ${tokenEnvVar} to a token that can read the repository; with the gh CLI: gh auth login, then export ${tokenEnvVar}=$(gh auth token)`;
}

interface HttpReply {
  headers?: Record<string, string | undefined>;
  data?: unknown;
}

/** GitHub's primary and secondary rate limits answer 429, or 403 with a
 * `retry-after` header, no requests remaining, or a message naming the
 * rate limit; any other 403 is the token. */
function rateLimited(status: number, reply: HttpReply): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  const headers = reply.headers ?? {};
  if (headers["retry-after"] !== undefined || headers["x-ratelimit-remaining"] === "0") return true;
  const message = (reply.data as { message?: unknown } | null | undefined)?.message ?? reply.data;
  return typeof message === "string" && /rate limit/i.test(message);
}

const rateLimitRefusal = (operation: string) =>
  new GitHubTrackerError(`GitHub rate-limited the request while ${operation}; retry later`);

const duration = (ms: number) => (ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000} seconds` : `${ms} ms`);

/** An aborted fetch rejects with the signal's TimeoutError; octokit wraps
 * it as the cause of a status-500 error, or lets it through when the body
 * read is what timed out. */
function timedOut(err: unknown): boolean {
  const e = err as { name?: unknown; cause?: { name?: unknown } } | null;
  return e?.name === "TimeoutError" || e?.cause?.name === "TimeoutError";
}

/** Translates whatever octokit threw into a value-free refusal. */
function refusalFor(
  err: unknown,
  operation: string,
  tokenEnvVar: string,
  timeoutMs: number,
): GitHubTrackerError {
  if (timedOut(err)) {
    return new GitHubTrackerError(`GitHub did not answer within ${duration(timeoutMs)} while ${operation}`, {
      smaller: true,
    });
  }
  if (err instanceof GraphqlResponseError) {
    const types = (err.errors ?? []).map((e) => (e as { type?: unknown }).type);
    if (types.includes("RATE_LIMITED")) return rateLimitRefusal(operation);
    if (types.includes("RESOURCE_LIMITS_EXCEEDED")) {
      return new GitHubTrackerError(
        `GitHub answered HTTP 200 with GraphQL errors (resource limits exceeded) while ${operation}`,
        { smaller: true },
      );
    }
    return new GitHubTrackerError(`GitHub answered HTTP 200 with GraphQL errors while ${operation}`);
  }
  const e = err as { name?: unknown; status?: unknown; response?: HttpReply } | null;
  if (e?.name === "HttpError" && typeof e.status === "number") {
    // octokit reports a network failure as status 500 with no response.
    if (e.response === undefined) return new GitHubTrackerError(`could not reach GitHub while ${operation}`);
    if (rateLimited(e.status, e.response)) return rateLimitRefusal(operation);
    if (e.status === 401 || e.status === 403) {
      return new GitHubTrackerError(
        `GitHub refused the token while ${operation} (HTTP ${e.status}). ${tokenHint(tokenEnvVar)}`,
      );
    }
    // 502 and 504 are GitHub's gateway giving up on a slow query.
    return new GitHubTrackerError(`GitHub answered HTTP ${e.status} while ${operation}`, {
      retry: e.status === 502 || e.status === 503 || e.status === 504,
      smaller: e.status === 502 || e.status === 504,
    });
  }
  return new GitHubTrackerError(`could not reach GitHub while ${operation}`);
}

/** A 200 whose body is not GraphQL (an HTML error page): octokit hands
 * back no data. Treated like a gateway error. */
const noData = (operation: string) =>
  new GitHubTrackerError(`GitHub answered HTTP 200 without data while ${operation}`, {
    retry: true,
    smaller: true,
  });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The anchor of a cross-reference's path names what made it. */
const fromAnIssue = (event: TimelineNode) => /#ref-issue-/.test(event.resourcePath ?? "");

/** Whether a cross-reference or connection links this issue to another
 * issue. A connection's own issue may sit at either end, so the other
 * end is the one that is not this issue. */
function linksAnIssue(event: TimelineNode, self: string): boolean {
  if (event.__typename === "CrossReferencedEvent") return fromAnIssue(event);
  const ends = [event.source, event.subject].filter((e): e is Subject => e != null && e.id !== self);
  return ends.length === 1 && ends[0]?.__typename === "Issue";
}

const openCount = (nodes: ({ state: string } | null)[]) => nodes.filter((n) => n?.state === "OPEN").length;

function toTicket(owner: string, repo: string, node: IssueNode): Ticket {
  const events = node.timelineItems.nodes.filter((n): n is TimelineNode => n !== null);
  const linked = events.filter(
    (e) =>
      (e.__typename === "CrossReferencedEvent" || e.__typename === "ConnectedEvent") &&
      linksAnIssue(e, node.id),
  ).length;
  return {
    key: `${owner}/${repo}#${node.number}`,
    title: node.title,
    body: node.body ?? "",
    labels: node.labels.nodes.map((l) => l.name),
    url: node.url,
    createdAt: node.createdAt,
    reactions: node.reactions.totalCount,
    linkedIssues: linked + node.subIssues.totalCount,
    duplicates: events.filter((e) => e.__typename === "MarkedAsDuplicateEvent").length,
    openBlockers: node.issueDependenciesSummary.blockedBy,
    openClosingPrs: openCount(node.closedByPullRequestsReferences.nodes),
    assignees: node.assignees.totalCount,
  };
}

export function githubTracker(opts: GitHubTrackerOptions): Tracker {
  const { owner, repo } = opts;
  const tokenEnvVar = opts.tokenEnvVar ?? DEFAULT_KEY_VARS.github;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  /** Every request gets its own deadline, covering the body read too. */
  const timed = (input: Parameters<FetchFn>[0], init?: RequestInit) =>
    (opts.fetch ?? globalThis.fetch)(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const gh = graphql.defaults({
    headers: { authorization: `token ${opts.token}` },
    request: { fetch: timed },
  });

  /** Runs one query. `partial` may accept a GraphQL-error reply's partial
   * data instead of refusing (a missing issue arrives as NOT_FOUND). */
  async function call<T>(
    operation: string,
    query: string,
    variables: Record<string, unknown>,
    partial?: (err: GraphqlResponseError<T>) => T | undefined,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let refusal: GitHubTrackerError;
      try {
        const data = await gh<T>(query, variables);
        if (data != null && typeof data === "object") return data;
        refusal = noData(operation);
      } catch (err) {
        const accepted = partial && err instanceof GraphqlResponseError ? partial(err) : undefined;
        if (accepted !== undefined) return accepted;
        refusal = refusalFor(err, operation, tokenEnvVar, timeoutMs);
      }
      if (!refusal.retry || attempt >= RETRIES) throw refusal;
      await sleep(retryDelayMs * 2 ** attempt);
    }
  }

  return {
    source: `github:${owner}/${repo}`.toLowerCase(),
    async pending() {
      const tickets: Ticket[] = [];
      let after: string | null = null;
      let first = PAGE_SIZE;
      for (;;) {
        let page: PendingPage;
        try {
          page = await call<PendingPage>(`listing ${owner}/${repo}'s open issues`, PENDING_QUERY, {
            owner,
            name: repo,
            first,
            after,
          });
        } catch (err) {
          if (!(err instanceof GitHubTrackerError && err.smaller) || first <= MIN_PAGE_SIZE) throw err;
          first = Math.max(MIN_PAGE_SIZE, Math.floor(first / 2));
          continue;
        }
        const { nodes, pageInfo } = page.repository.issues;
        tickets.push(...nodes.map((n) => toTicket(owner, repo, n)));
        if (!pageInfo.hasNextPage || pageInfo.endCursor === null) break;
        after = pageInfo.endCursor;
      }
      return tickets;
    },
    async issues(keys) {
      const numbers: number[] = [];
      const foreign: string[] = [];
      for (const key of keys) {
        const number = issueNumberIn(key, owner, repo, { bare: false });
        if (number === undefined) foreign.push(key);
        else numbers.push(number);
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
