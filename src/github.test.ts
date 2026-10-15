import { describe, expect, test } from "bun:test";
import { isRefusal } from "./errors.js";
import { replayFetch } from "./fixtures/replay.js";
import { parseSource } from "./source.js";
import { GITHUB_GRAPHQL_ENDPOINT, githubTracker } from "./trackers/github.js";
import { trackerFor } from "./trackers/index.js";

type Body = { query: string; variables: Record<string, unknown> };

const ref = (typename: string, id = `${typename}-x`) => ({ __typename: typename, id });

/** A cross-reference as GitHub lists it: the anchor names the kind of item
 * that made the reference. */
let refs = 0;
const crossRef = (kind: "issue" | "pullrequest") => ({
  __typename: "CrossReferencedEvent",
  resourcePath: `/o/r/issues/1#ref-${kind}-${++refs}`,
});

const issue = (n: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: `I_${n}`,
  number: n,
  title: `t ${n}`,
  body: "",
  url: `https://github.com/o/r/issues/${n}`,
  createdAt: "2026-10-01T00:00:00Z",
  labels: { nodes: [{ name: "Bug" }] },
  reactions: { totalCount: 4 },
  assignees: { totalCount: 2 },
  timelineItems: {
    nodes: [
      crossRef("issue"),
      { __typename: "ConnectedEvent", source: ref("Issue", `I_${n}`), subject: ref("Issue") },
      { __typename: "MarkedAsDuplicateEvent" },
      crossRef("issue"),
    ],
  },
  subIssues: { totalCount: 2 },
  parent: { number: 1 },
  issueDependenciesSummary: { blockedBy: 2 },
  closedByPullRequestsReferences: {
    nodes: [
      { state: "OPEN", isDraft: false },
      { state: "OPEN", isDraft: true },
      { state: "CLOSED", isDraft: false },
      { state: "MERGED", isDraft: false },
    ],
  },
  ...extra,
});

/** A fake GitHub: records every request body and answers from `reply`. */
function fakeGitHub(reply: (body: Body) => Response) {
  const bodies: Body[] = [];
  const headers: Record<string, string>[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(GITHUB_GRAPHQL_ENDPOINT);
    headers.push(init?.headers as Record<string, string>);
    const body = JSON.parse(init?.body as string) as Body;
    bodies.push(body);
    return reply(body);
  };
  return { fetch: fetch as typeof globalThis.fetch, bodies, headers };
}

async function caught(p: Promise<unknown>): Promise<Error> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isRefusal(err)).toBe(true);
  return err as Error;
}

describe("githubTracker pending()", () => {
  test("pages through open issues with the cursor and keys them owner/repo#N", async () => {
    const pages = [
      { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [issue(1), issue(2)] },
      { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [issue(7)] },
    ];
    const gh = fakeGitHub(() => Response.json({ data: { repository: { issues: pages.shift() } } }));
    const tracker = githubTracker({ owner: "o", repo: "r", token: "ghp_test", fetch: gh.fetch });

    const tickets = await tracker.pending();

    expect(tracker.source).toBe("github:o/r");
    expect(tickets.map((t) => t.key)).toEqual(["o/r#1", "o/r#2", "o/r#7"]);
    expect(gh.bodies).toHaveLength(2);
    expect(gh.bodies[0]?.variables).toEqual({ owner: "o", name: "r", first: 50, after: null });
    expect(gh.bodies[1]?.variables).toEqual({ owner: "o", name: "r", first: 50, after: "c1" });
    expect(gh.headers[0]?.authorization).toBe("token ghp_test");
  });

  test("reads open issues only, from the issues connection that excludes pull requests", async () => {
    const gh = fakeGitHub(() =>
      Response.json({
        data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } },
      }),
    );
    await githubTracker({ owner: "o", repo: "r", token: "t", fetch: gh.fetch }).pending();
    const query = gh.bodies[0]?.query.replace(/\s+/g, " ") ?? "";
    expect(query).toContain("issues(states: OPEN, first: $first, after: $after)");
    expect(query).not.toContain("pullRequests");
  });

  test("maps facts: reactions, linked issues, duplicates and the gate-only counts; null body becomes empty", async () => {
    const gh = fakeGitHub(() =>
      Response.json({
        data: {
          repository: {
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [issue(3, { body: null }), issue(4, { parent: null, subIssues: { totalCount: 0 } })],
            },
          },
        },
      }),
    );
    const [a, b] = await githubTracker({ owner: "o", repo: "r", token: "t", fetch: gh.fetch }).pending();
    // 2 issue cross-references + 1 issue connection + 2 sub-issues; the parent does not count.
    expect(a).toEqual({
      key: "o/r#3",
      title: "t 3",
      body: "",
      labels: ["Bug"],
      url: "https://github.com/o/r/issues/3",
      createdAt: "2026-10-01T00:00:00Z",
      reactions: 4,
      linkedIssues: 5,
      duplicates: 1,
      openBlockers: 2,
      openClosingPrs: 2,
      assignees: 2,
    });
    expect(b).toMatchObject({ key: "o/r#4", linkedIssues: 3, duplicates: 1 });
  });

  test("linked issues count only references and connections from issues, never pull requests", async () => {
    const node = issue(5, {
      subIssues: { totalCount: 0 },
      timelineItems: {
        nodes: [
          crossRef("pullrequest"),
          crossRef("issue"),
          { __typename: "CrossReferencedEvent", resourcePath: "/o/r/issues/5#ref-commit-1" },
          { __typename: "ConnectedEvent", source: ref("Issue", "I_5"), subject: ref("PullRequest") },
          { __typename: "ConnectedEvent", source: ref("PullRequest"), subject: ref("Issue", "I_5") },
          { __typename: "ConnectedEvent", source: ref("Issue"), subject: ref("Issue", "I_5") },
          null,
        ],
      },
    });
    const gh = fakeGitHub(() =>
      Response.json({
        data: {
          repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node] } },
        },
      }),
    );
    const [t] = await githubTracker({ owner: "o", repo: "r", token: "t", fetch: gh.fetch }).pending();
    expect(t).toMatchObject({ linkedIssues: 2, duplicates: 0 });
  });

  test("gate-only counts are zero when nothing blocks, closes or is assigned", async () => {
    const node = issue(6, {
      assignees: { totalCount: 0 },
      issueDependenciesSummary: { blockedBy: 0 },
      closedByPullRequestsReferences: { nodes: [{ state: "MERGED", isDraft: false }] },
    });
    const gh = fakeGitHub(() =>
      Response.json({
        data: {
          repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node] } },
        },
      }),
    );
    const [t] = await githubTracker({ owner: "o", repo: "r", token: "t", fetch: gh.fetch }).pending();
    expect(t).toMatchObject({ openBlockers: 0, openClosingPrs: 0, assignees: 0 });
  });

  test("asks for open closing pull requests, the open blocker count, and the assignee count", async () => {
    const gh = fakeGitHub(() =>
      Response.json({
        data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } },
      }),
    );
    await githubTracker({ owner: "o", repo: "r", token: "t", fetch: gh.fetch }).pending();
    const query = gh.bodies[0]?.query.replace(/\s+/g, " ") ?? "";
    expect(query).toContain("closedByPullRequestsReferences(first: 10, includeClosedPrs: false)");
    expect(query).toContain("issueDependenciesSummary { blockedBy }");
    expect(query).toContain("assignees { totalCount }");
    expect(query).not.toContain("parent");
  });
});

describe("githubTracker on busy repositories", () => {
  const page = (nodes: unknown[], endCursor: string | null = null) =>
    Response.json({
      data: { repository: { issues: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes } } },
    });
  const resourceLimits = () =>
    Response.json({
      data: null,
      errors: [{ type: "RESOURCE_LIMITS_EXCEEDED", message: "Resource limits for this query exceeded." }],
    });
  const sizes = (bodies: Body[]) => bodies.map((b) => b.variables.first);
  const busy = (fetch: typeof globalThis.fetch) =>
    githubTracker({ owner: "o", repo: "r", token: "t", fetch, retryDelayMs: 0 });

  test("asks for cross-references by the path that names their source, never resolving the source", async () => {
    const gh = fakeGitHub(() => page([]));
    await busy(gh.fetch).pending();
    const query = gh.bodies[0]?.query.replace(/\s+/g, " ") ?? "";
    expect(query).toContain("... on CrossReferencedEvent { resourcePath }");
    expect(query).not.toContain("CrossReferencedEvent { source");
  });

  test("a page over GitHub's resource limits is asked again at half the size, and paging goes on at that size", async () => {
    const replies = [resourceLimits, () => page([issue(1)], "c1"), () => page([issue(2)])];
    const gh = fakeGitHub(() => (replies.shift() as () => Response)());
    const tickets = await busy(gh.fetch).pending();
    expect(tickets.map((t) => t.key)).toEqual(["o/r#1", "o/r#2"]);
    expect(sizes(gh.bodies)).toEqual([50, 25, 25]);
    expect(gh.bodies.map((b) => b.variables.after)).toEqual([null, null, "c1"]);
  });

  test("a page still over the resource limits at the smallest size refuses without echoing the reply", async () => {
    const gh = fakeGitHub(resourceLimits);
    const err = await caught(busy(gh.fetch).pending());
    expect(sizes(gh.bodies)).toEqual([50, 25, 12]);
    expect(err.message).toBe(
      "GitHub answered HTTP 200 with GraphQL errors (resource limits exceeded) while listing o/r's open issues",
    );
  });

  test("a page that runs out of time is asked again at half the size", async () => {
    const firsts: unknown[] = [];
    const fetch = ((_: unknown, init?: RequestInit) => {
      const { variables } = JSON.parse(init?.body as string) as Body;
      firsts.push(variables.first);
      if (variables.first === 50) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });
      }
      return Promise.resolve(page([issue(1)]));
    }) as unknown as typeof globalThis.fetch;
    const tracker = githubTracker({
      owner: "o",
      repo: "r",
      token: "t",
      fetch,
      timeoutMs: 20,
      retryDelayMs: 0,
    });
    expect((await tracker.pending()).map((t) => t.key)).toEqual(["o/r#1"]);
    expect(firsts).toEqual([50, 25]);
  });

  test("a 502, 503 or 504 is retried at the same size before the page gives up", async () => {
    const replies = [
      () => new Response("<html>", { status: 502 }),
      () => new Response("", { status: 503 }),
      () => page([issue(1)]),
    ];
    const gh = fakeGitHub(() => (replies.shift() as () => Response)());
    const tickets = await busy(gh.fetch).pending();
    expect(tickets.map((t) => t.key)).toEqual(["o/r#1"]);
    expect(sizes(gh.bodies)).toEqual([50, 50, 50]);
  });

  test("a gateway timeout that persists shrinks the page, then refuses naming the status", async () => {
    const gh = fakeGitHub(() => new Response("<html>", { status: 504 }));
    const err = await caught(busy(gh.fetch).pending());
    expect(sizes(gh.bodies)).toEqual([50, 50, 50, 25, 25, 25, 12, 12, 12]);
    expect(err.message).toBe("GitHub answered HTTP 504 while listing o/r's open issues");
  });

  test("a 503 that persists refuses without shrinking the page", async () => {
    const gh = fakeGitHub(() => new Response("", { status: 503 }));
    const err = await caught(busy(gh.fetch).pending());
    expect(sizes(gh.bodies)).toEqual([50, 50, 50]);
    expect(err.message).toBe("GitHub answered HTTP 503 while listing o/r's open issues");
  });

  test("an HTTP 200 without GraphQL data is retried like a gateway error", async () => {
    const replies = [() => new Response("<html>bad gateway</html>"), () => page([issue(1)])];
    const gh = fakeGitHub(() => (replies.shift() as () => Response)());
    expect((await busy(gh.fetch).pending()).map((t) => t.key)).toEqual(["o/r#1"]);
    expect(gh.bodies).toHaveLength(2);
  });

  test("retries wait longer each time", async () => {
    const waits: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const gh = fakeGitHub(() => new Response("", { status: 503 }));
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      waits.push(ms ?? 0);
      return realSetTimeout(fn, 0);
    }) as typeof globalThis.setTimeout;
    try {
      await caught(githubTracker({ owner: "o", repo: "r", token: "t", fetch: gh.fetch }).pending());
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(waits.filter((ms) => ms >= 1000)).toEqual([1000, 2000]);
  });
});

describe("githubTracker errors", () => {
  test("401 refuses naming the operation, status, token variable and gh commands, never the token", async () => {
    const gh = fakeGitHub(() => Response.json({ message: "Bad credentials ghp_secret" }, { status: 401 }));
    const err = await caught(
      githubTracker({ owner: "o", repo: "r", token: "ghp_secret", fetch: gh.fetch }).pending(),
    );
    expect(err.message).toBe(
      "GitHub refused the token while listing o/r's open issues (HTTP 401). " +
        "Set GITHUB_TOKEN to a token that can read the repository; with the gh CLI: " +
        "gh auth login, then export GITHUB_TOKEN=$(gh auth token)",
    );
    expect(err.message).not.toContain("ghp_secret");
  });

  test("403 names a custom token variable", async () => {
    const gh = fakeGitHub(() => new Response("", { status: 403 }));
    const tracker = githubTracker({
      owner: "o",
      repo: "r",
      token: "t",
      fetch: gh.fetch,
      tokenEnvVar: "KIT_GH",
    });
    const err = await caught(tracker.pending());
    expect(err.message).toContain("(HTTP 403). Set KIT_GH to a token");
    expect(err.message).toContain("export KIT_GH=$(gh auth token)");
  });

  test.each([
    ["HTTP 429", () => new Response("", { status: 429 })],
    [
      "HTTP 403 with retry-after",
      () => Response.json({ message: "slow down" }, { status: 403, headers: { "retry-after": "60" } }),
    ],
    [
      "HTTP 403 with no requests remaining",
      () => Response.json({ message: "x" }, { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
    ],
    [
      "HTTP 403 naming a secondary rate limit",
      () =>
        Response.json({ message: "You have exceeded a secondary rate limit. secret-text" }, { status: 403 }),
    ],
    [
      "a RATE_LIMITED GraphQL error",
      () =>
        Response.json({
          data: null,
          errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded secret-text" }],
        }),
    ],
  ])("%s refuses as a rate limit, not a bad token", async (_, reply) => {
    const gh = fakeGitHub(reply);
    const err = await caught(
      githubTracker({ owner: "o", repo: "r", token: "ghp_secret", fetch: gh.fetch }).pending(),
    );
    expect(err.message).toBe("GitHub rate-limited the request while listing o/r's open issues; retry later");
  });

  test("other HTTP failures name the operation and status only", async () => {
    const gh = fakeGitHub(() => Response.json({ message: "boom with secret detail" }, { status: 500 }));
    const err = await caught(githubTracker({ owner: "o", repo: "r", token: "t", fetch: gh.fetch }).pending());
    expect(err.message).toBe("GitHub answered HTTP 500 while listing o/r's open issues");
    expect(gh.bodies).toHaveLength(1);
  });

  test("GraphQL errors refuse without echoing the reply", async () => {
    const gh = fakeGitHub(() =>
      Response.json({ data: null, errors: [{ message: "Could not resolve to a Repository secret-text" }] }),
    );
    const err = await caught(githubTracker({ owner: "o", repo: "r", token: "t", fetch: gh.fetch }).pending());
    expect(err.message).toBe("GitHub answered HTTP 200 with GraphQL errors while listing o/r's open issues");
    expect(err.message).not.toContain("secret-text");
  });

  test("a request GitHub does not answer in time is aborted and refuses naming the operation", async () => {
    let signal: AbortSignal | undefined;
    const fetch = ((_: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    }) as unknown as typeof globalThis.fetch;
    const tracker = githubTracker({ owner: "o", repo: "r", token: "t", fetch, timeoutMs: 20 });
    const err = await caught(tracker.issues(["o/r#1"]));
    expect(signal?.aborted).toBe(true);
    expect(err.message).toBe("GitHub did not answer within 20 ms while reading o/r#1");
  });

  test("an unreachable GitHub refuses naming the operation", async () => {
    const fetch = (async () => {
      throw new TypeError("connect ECONNREFUSED secret-host");
    }) as unknown as typeof globalThis.fetch;
    const err = await caught(githubTracker({ owner: "o", repo: "r", token: "t", fetch }).pending());
    expect(err.message).toBe("could not reach GitHub while listing o/r's open issues");
  });
});

describe("githubTracker issues()", () => {
  const lookup = () =>
    fakeGitHub((body) => {
      const n = body.variables.number as number;
      return Response.json({ data: { repository: { issue: n === 404 ? null : issue(n) } } });
    });

  test("reads each named issue with one lookup, matching owner/repo case-insensitively", async () => {
    const gh = lookup();
    const tracker = githubTracker({ owner: "Kit", repo: "Kit", token: "t", fetch: gh.fetch });
    const tickets = await tracker.issues(["kit/kit#3", "KIT/Kit#12"]);
    expect(tickets.map((t) => t.key)).toEqual(["Kit/Kit#3", "Kit/Kit#12"]);
    expect(gh.bodies.map((b) => b.variables)).toEqual([
      { owner: "Kit", name: "Kit", number: 3 },
      { owner: "Kit", name: "Kit", number: 12 },
    ]);
    expect(gh.bodies[0]?.query.replace(/\s+/g, " ")).toContain(
      "repository(owner: $owner, name: $name) { issue(number: $number)",
    );
  });

  test("refuses keys from another repository or not shaped owner/repo#N, before any request", async () => {
    const gh = lookup();
    const tracker = githubTracker({ owner: "kit", repo: "kit", token: "t", fetch: gh.fetch });
    const err = await caught(tracker.issues(["kit/kit#1", "acme/app#2", "42"]));
    expect(err.message).toBe(
      "acme/app#2, 42 not in kit/kit, the repository this source reads (keys look like kit/kit#123)",
    );
    expect(gh.bodies).toHaveLength(0);
  });

  test("refuses a missing issue", async () => {
    const gh = lookup();
    const err = await caught(
      githubTracker({ owner: "kit", repo: "kit", token: "t", fetch: gh.fetch }).issues(["kit/kit#404"]),
    );
    expect(err.message).toBe("GitHub has no issue kit/kit#404");
  });

  test("refuses a missing issue the way GitHub reports it: null data with a NOT_FOUND error", async () => {
    const gh = fakeGitHub(() =>
      Response.json({
        data: { repository: { issue: null } },
        errors: [
          { type: "NOT_FOUND", path: ["repository", "issue"], message: "Could not resolve to an Issue" },
        ],
      }),
    );
    const err = await caught(
      githubTracker({ owner: "kit", repo: "kit", token: "t", fetch: gh.fetch }).issues(["kit/kit#5"]),
    );
    expect(err.message).toBe("GitHub has no issue kit/kit#5");
  });

  test("lookup errors name the key being read", async () => {
    const gh = fakeGitHub(() => new Response("", { status: 500 }));
    const err = await caught(
      githubTracker({ owner: "kit", repo: "kit", token: "t", fetch: gh.fetch }).issues(["kit/kit#9"]),
    );
    expect(err.message).toBe("GitHub answered HTTP 500 while reading kit/kit#9");
  });
});

describe("trackerFor", () => {
  test("builds the GitHub tracker for a github source", async () => {
    const gh = fakeGitHub(() =>
      Response.json({
        data: {
          repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [issue(1)] } },
        },
      }),
    );
    const tracker = trackerFor(parseSource("github:Kit/Kit"), { token: "t", fetch: gh.fetch });
    expect(tracker.source).toBe("github:kit/kit");
    expect((await tracker.pending()).map((t) => t.key)).toEqual(["Kit/Kit#1"]);
  });

  test("builds the Linear tracker for a linear source, with its states", async () => {
    const net = replayFetch();
    const tracker = trackerFor(parseSource("linear:kit"), {
      token: "k",
      linearStates: ["started"],
      fetch: net.fetch,
    });
    expect(tracker.source).toBe("linear:KIT");
    expect((await tracker.pending()).map((t) => t.key)).toEqual(["KIT-7", "KIT-8"]);
  });
});
