/**
 * The Linear tracker at its seam: `pending()` and `issues(keys)` over the
 * offline fixture network, or over a fake fetch where a test needs a
 * reply the network does not give.
 */

import { describe, expect, test } from "bun:test";
import { isRefusal } from "./errors.js";
import { replayFetch } from "./fixtures/replay.js";
import { LINEAR_GRAPHQL_ENDPOINT, linearTracker } from "./trackers/linear.js";

type Fetch = typeof globalThis.fetch;

interface Sent {
  url: string;
  headers: Record<string, string>;
  query: string;
  variables: Record<string, unknown>;
}

const STATES = {
  data: {
    workflowStates: {
      nodes: [
        { id: "s-backlog", name: "Backlog", type: "backlog" },
        { id: "s-todo", name: "Todo", type: "unstarted" },
        { id: "s-doing", name: "In Progress", type: "started" },
      ],
    },
  },
};

const node = (identifier: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  identifier,
  title: `title of ${identifier}`,
  description: null,
  url: `https://linear.example/${identifier}`,
  createdAt: "2026-10-01T00:00:00.000Z",
  labels: { nodes: [{ name: "Bug" }] },
  reactions: [{ id: "r" }],
  relations: { nodes: [{ type: "duplicate" }, { type: "related" }] },
  inverseRelations: { nodes: [{ type: "blocks" }] },
  ...extra,
});

/** A fake Linear: answers the workflow-states query, then each reply in
 * turn, recording what was sent. */
function fakeLinear(...replies: (() => Response)[]): { fetch: Fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    sent.push({ url: String(input), headers: init?.headers as Record<string, string>, ...body });
    if (body.query.includes("workflowStates")) return Response.json(STATES);
    const next = replies.shift();
    if (next === undefined) throw new Error("no reply left");
    return next();
  }) as Fetch;
  return { fetch, sent };
}

async function refusalOf(promise: Promise<unknown>): Promise<Error> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isRefusal(err)).toBe(true);
  return err as Error;
}

describe("pending()", () => {
  test("reads the Backlog and Todo issues of the fixture team by default", async () => {
    const net = replayFetch();
    const tickets = await linearTracker({ team: "KIT", apiKey: "lin-key", fetch: net.fetch }).pending();
    expect(tickets.map((t) => t.key)).toEqual(["KIT-1", "KIT-2", "KIT-3", "KIT-4", "KIT-5", "KIT-6"]);
    // One workflow-states query, one page of issues.
    expect(net.counts).toEqual({ github: 0, linear: 2, jev: 0, other: 0 });
  });

  test("maps the reference page's facts: reactions, linked issues and duplicates", async () => {
    const net = replayFetch();
    const tickets = await linearTracker({ team: "KIT", apiKey: "k", fetch: net.fetch }).pending();
    expect(tickets.find((t) => t.key === "KIT-1")).toEqual({
      key: "KIT-1",
      title: "Executor launches print the API key into the pane",
      body: expect.stringMatching(/^Every executor launch exports/),
      labels: ["Bug", "security"],
      url: "https://linear.example/KIT-1",
      createdAt: "2026-09-01T12:00:00.000Z",
      reactions: 2,
      linkedIssues: 1,
      duplicates: 0,
    });
    expect(tickets.find((t) => t.key === "KIT-3")).toMatchObject({
      reactions: 1,
      linkedIssues: 1,
      duplicates: 1,
    });
    expect(tickets.find((t) => t.key === "KIT-2")).toMatchObject({
      reactions: 0,
      linkedIssues: 0,
      duplicates: 0,
    });
  });

  test("pages with the cursor, filters on the matched states and sends the raw key", async () => {
    const linear = fakeLinear(
      () =>
        Response.json({
          data: { issues: { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [node("EVA-1")] } },
        }),
      () =>
        Response.json({
          data: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node("EVA-2")] } },
        }),
    );
    const tickets = await linearTracker({ team: "EVA", apiKey: "lin-key", fetch: linear.fetch }).pending();
    expect(tickets.map((t) => t.key)).toEqual(["EVA-1", "EVA-2"]);
    expect(tickets[0]).toMatchObject({
      body: "",
      labels: ["Bug"],
      reactions: 1,
      linkedIssues: 3,
      duplicates: 1,
    });
    expect(linear.sent).toHaveLength(3);
    for (const s of linear.sent) {
      expect(s.url).toBe(LINEAR_GRAPHQL_ENDPOINT);
      expect(s.headers.authorization).toBe("lin-key");
    }
    expect(linear.sent[0]?.variables).toEqual({ team: "EVA" });
    expect(linear.sent[1]?.variables).toEqual({ team: "EVA", states: ["s-backlog", "s-todo"], after: null });
    expect(linear.sent[2]?.variables).toEqual({ team: "EVA", states: ["s-backlog", "s-todo"], after: "c1" });
  });

  test("states: [Todo] reads only Todo issues", async () => {
    const net = replayFetch();
    const tickets = await linearTracker({
      team: "KIT",
      apiKey: "k",
      states: ["Todo"],
      fetch: net.fetch,
    }).pending();
    expect(tickets.map((t) => t.key)).toEqual(["KIT-1", "KIT-3", "KIT-6"]);
  });

  test("states: [started] reads the In Progress and In Review issues", async () => {
    const net = replayFetch();
    const tickets = await linearTracker({
      team: "KIT",
      apiKey: "k",
      states: ["started"],
      fetch: net.fetch,
    }).pending();
    expect(tickets.map((t) => t.key)).toEqual(["KIT-7", "KIT-8"]);
  });

  test("names and types mix and ignore case", async () => {
    const net = replayFetch();
    const tickets = await linearTracker({
      team: "KIT",
      apiKey: "k",
      states: ["in review", "TRIAGE", "completed"],
      fetch: net.fetch,
    }).pending();
    expect(tickets.map((t) => t.key)).toEqual(["KIT-8", "KIT-9", "KIT-10"]);
  });

  test("a misspelt state is refused naming it and the team's states, before any issue request", async () => {
    const net = replayFetch();
    const tracker = linearTracker({ team: "KIT", apiKey: "k", states: ["Backlog", "Tod"], fetch: net.fetch });
    const err = await refusalOf(tracker.pending());
    expect(err.message).toContain('"Tod"');
    expect(err.message).not.toContain('"Backlog"');
    expect(err.message).toContain(
      "Triage (triage), Backlog (backlog), Todo (unstarted), In Progress (started), " +
        "In Review (started), Done (completed), Canceled (canceled)",
    );
    expect(net.counts.linear).toBe(1);
  });

  test("an empty states list is refused with no request", async () => {
    const net = replayFetch();
    const err = await refusalOf(
      linearTracker({ team: "KIT", apiKey: "k", states: [], fetch: net.fetch }).pending(),
    );
    expect(err.message).toContain("linear.states");
    expect(net.counts.linear).toBe(0);
  });

  test("a team Linear shows no workflow states for is refused before any issue request", async () => {
    const net = replayFetch();
    const err = await refusalOf(linearTracker({ team: "NOPE", apiKey: "k", fetch: net.fetch }).pending());
    expect(err.message).toContain("NOPE");
    expect(net.counts.linear).toBe(1);
  });
});

describe("issues(keys)", () => {
  test("reads named issues in any state, one lookup each", async () => {
    const net = replayFetch();
    const tickets = await linearTracker({ team: "KIT", apiKey: "k", fetch: net.fetch }).issues([
      "KIT-3",
      "kit-9",
    ]);
    expect(tickets.map((t) => t.key)).toEqual(["KIT-3", "KIT-9"]);
    expect(tickets[0]).toMatchObject({ reactions: 1, linkedIssues: 1, duplicates: 1 });
    expect(net.counts.linear).toBe(2);
  });

  test("refuses keys from another team, naming them, with no request", async () => {
    const net = replayFetch();
    const tracker = linearTracker({ team: "KIT", apiKey: "k", fetch: net.fetch });
    const err = await refusalOf(tracker.issues(["KIT-1", "EVA-2", "kit/kit#3"]));
    expect(err.message).toContain("EVA-2, kit/kit#3 not in the KIT team");
    expect(err.message).not.toContain("KIT-1,");
    expect(net.counts.linear).toBe(0);
  });

  test("refuses a key Linear does not know", async () => {
    const net = replayFetch();
    const err = await refusalOf(
      linearTracker({ team: "KIT", apiKey: "k", fetch: net.fetch }).issues(["KIT-99"]),
    );
    expect(err.message).toBe("Linear has no issue KIT-99");
  });

  test("a null issue is also unknown", async () => {
    const linear = fakeLinear(() => Response.json({ data: { issue: null } }));
    const err = await refusalOf(
      linearTracker({ team: "KIT", apiKey: "k", fetch: linear.fetch }).issues(["KIT-5"]),
    );
    expect(err.message).toBe("Linear has no issue KIT-5");
  });
});

describe("refusals are value-free", () => {
  const SECRET = "lin_api_SECRET";
  const TEXT = "issue text that must not leak";

  test("401 names the configured key variable and where to create a key, never the key", async () => {
    const fetch = (async () =>
      new Response(`{"error":"${SECRET} ${TEXT}"}`, { status: 401 })) as unknown as Fetch;
    const tracker = linearTracker({ team: "KIT", apiKey: SECRET, apiKeyVar: "KIT_LINEAR_KEY", fetch });
    const err = await refusalOf(tracker.pending());
    expect(err.message).toContain("Linear refused the API key");
    expect(err.message).toContain("HTTP 401");
    expect(err.message).toContain("KIT_LINEAR_KEY");
    expect(err.message).toContain("https://linear.app/settings/account/security");
    expect(err.message).not.toContain(SECRET);
  });

  test("an HTTP 200 authentication error refuses the same way", async () => {
    const fetch = (async () =>
      Response.json({
        data: null,
        errors: [{ message: `bad ${SECRET}`, extensions: { code: "AUTHENTICATION_ERROR" } }],
      })) as unknown as Fetch;
    const err = await refusalOf(linearTracker({ team: "KIT", apiKey: SECRET, fetch }).pending());
    expect(err.message).toContain("Linear refused the API key");
    expect(err.message).toContain("LINEAR_API_KEY");
    expect(err.message).not.toContain(SECRET);
  });

  test("GraphQL errors and other statuses name the operation and status only", async () => {
    const linear = fakeLinear(() =>
      Response.json({ errors: [{ message: `${TEXT} ${SECRET}` }] }, { status: 400 }),
    );
    const err = await refusalOf(
      linearTracker({ team: "KIT", apiKey: SECRET, fetch: linear.fetch }).pending(),
    );
    expect(err.message).toBe(
      "Linear answered HTTP 400 with GraphQL errors while listing KIT's pending issues",
    );
    const down = fakeLinear(() => new Response(TEXT, { status: 502 }));
    const err2 = await refusalOf(linearTracker({ team: "KIT", apiKey: SECRET, fetch: down.fetch }).pending());
    expect(err2.message).toBe("Linear answered HTTP 502 while listing KIT's pending issues");
  });

  test("a network failure says Linear could not be reached", async () => {
    const fetch = (async () => {
      throw new TypeError(`connect failed ${SECRET}`);
    }) as unknown as Fetch;
    const err = await refusalOf(linearTracker({ team: "KIT", apiKey: SECRET, fetch }).issues(["KIT-1"]));
    expect(err.message).toBe("could not reach Linear while reading KIT-1");
  });

  test("a reply missing a field refuses naming the operation and the field path, no issue text", async () => {
    const { identifier: _dropped, ...broken } = node("KIT-1", { title: TEXT });
    const linear = fakeLinear(() =>
      Response.json({
        data: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [broken] } },
      }),
    );
    const err = await refusalOf(linearTracker({ team: "KIT", apiKey: "k", fetch: linear.fetch }).pending());
    expect(err.message).toBe(
      "Linear's reply did not have the expected shape while listing KIT's pending issues (at issues.nodes.0.identifier)",
    );
    expect(err.message).not.toContain(TEXT);
  });

  test("a reply with extra unknown fields still parses", async () => {
    const linear = fakeLinear(() =>
      Response.json({
        data: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null, startCursor: "x" },
            nodes: [node("KIT-1", { priority: 2, labels: { nodes: [{ name: "Bug", color: "#f00" }] } })],
          },
          extra: true,
        },
      }),
    );
    const tickets = await linearTracker({ team: "KIT", apiKey: "k", fetch: linear.fetch }).pending();
    expect(tickets.map((t) => [t.key, t.labels])).toEqual([["KIT-1", ["Bug"]]]);
  });
});
