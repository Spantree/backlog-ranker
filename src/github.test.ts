import { describe, expect, test } from "bun:test";
import { isRefusal } from "./errors.js";
import { GITHUB_GRAPHQL_ENDPOINT, githubTracker } from "./trackers/github.js";

type Body = { query: string; variables: Record<string, unknown> };

const issue = (n: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: n,
  title: `t ${n}`,
  body: "",
  url: `https://github.com/o/r/issues/${n}`,
  createdAt: "2026-10-01T00:00:00Z",
  labels: { nodes: [{ name: "Bug" }] },
  reactions: { totalCount: 4 },
  timelineItems: {
    nodes: [
      { __typename: "CrossReferencedEvent" },
      { __typename: "ConnectedEvent" },
      { __typename: "MarkedAsDuplicateEvent" },
      { __typename: "CrossReferencedEvent" },
    ],
  },
  subIssues: { totalCount: 2 },
  parent: { number: 1 },
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
    expect(gh.bodies[0]?.variables).toEqual({ owner: "o", name: "r", after: null });
    expect(gh.bodies[1]?.variables).toEqual({ owner: "o", name: "r", after: "c1" });
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
    expect(query).toContain("issues(states: OPEN, first: 100, after: $after)");
    expect(query).not.toContain("pullRequests");
  });

  test("maps facts: reactions total, linked issues, duplicates; null body becomes empty", async () => {
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
    // 2 cross-referenced + 1 connected + 2 sub-issues + 1 parent
    expect(a).toEqual({
      key: "o/r#3",
      title: "t 3",
      body: "",
      labels: ["Bug"],
      url: "https://github.com/o/r/issues/3",
      createdAt: "2026-10-01T00:00:00Z",
      reactions: 4,
      linkedIssues: 6,
      duplicates: 1,
    });
    expect(b).toMatchObject({ key: "o/r#4", linkedIssues: 3, duplicates: 1 });
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

  test("other HTTP failures name the operation and status only", async () => {
    const gh = fakeGitHub(() => Response.json({ message: "boom with secret detail" }, { status: 502 }));
    const err = await caught(githubTracker({ owner: "o", repo: "r", token: "t", fetch: gh.fetch }).pending());
    expect(err.message).toBe("GitHub answered HTTP 502 while listing o/r's open issues");
  });

  test("GraphQL errors refuse without echoing the reply", async () => {
    const gh = fakeGitHub(() =>
      Response.json({ data: null, errors: [{ message: "Could not resolve to a Repository secret-text" }] }),
    );
    const err = await caught(githubTracker({ owner: "o", repo: "r", token: "t", fetch: gh.fetch }).pending());
    expect(err.message).toBe("GitHub answered HTTP 200 with GraphQL errors while listing o/r's open issues");
    expect(err.message).not.toContain("secret-text");
  });

  test("an unreachable GitHub refuses naming the operation", async () => {
    const fetch = (async () => {
      throw new TypeError("connect ECONNREFUSED secret-host");
    }) as unknown as typeof globalThis.fetch;
    const err = await caught(githubTracker({ owner: "o", repo: "r", token: "t", fetch }).pending());
    expect(err.message).toBe("could not reach GitHub while listing o/r's open issues");
  });
});
