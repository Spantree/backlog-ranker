/**
 * Linear as a backlog source: one team's issues in the workflow states
 * the config names (`linear.states`), by default every state whose TYPE
 * is `backlog` or `unstarted` (Backlog and Todo on Linear's default
 * workflow), so a team's renamed or extra states still count. Facts are
 * computed here, by code, so the decision model never counts.
 *
 * Plain fetch against the GraphQL endpoint, and every reply is checked
 * against a zod schema before use; the response types come from those
 * schemas. Errors are value-free: they name the operation, the HTTP
 * status or a field path, never the API key or any text from Linear.
 */

import { z } from "zod";
import { RefusalError } from "../errors.js";
import { DEFAULT_KEY_VARS } from "../keys.js";
import { issueKeyIn, parseSource } from "../source.js";
import type { Ticket } from "../ticket.js";
import type { FetchFn, Tracker } from "./tracker.js";

export const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
/** Where a personal API key is created, named in auth refusals. */
export const LINEAR_KEY_URL = "https://linear.app/settings/account/security";
/** The pending states when the config names none: matched by type. */
export const DEFAULT_LINEAR_STATES = ["backlog", "unstarted"] as const;
const PAGE_SIZE = 100;
/** Workflow state types that close an issue, so it blocks nothing. */
const CLOSED_STATE_TYPES = new Set(["completed", "canceled", "duplicate"]);
const DEFAULT_TIMEOUT_MS = 30_000;
/** Relation types that link issues. `similar` is left out: Linear's AI
 * suggests it, so it says nothing a person decided. */
const LINKED_RELATION_TYPES = new Set(["blocks", "duplicate", "related"]);

export interface LinearTrackerOptions {
  /** The team key, as in `linear:<TEAM>`. */
  team: string;
  /** A personal API key, sent as the raw `authorization` header. */
  apiKey: string;
  /** The environment variable the key came from, named in auth refusals. */
  apiKeyVar?: string;
  /** Workflow state names or types to rank, case-insensitive;
   * {@link DEFAULT_LINEAR_STATES} when absent. */
  states?: readonly string[];
  /** Replaces the global fetch, for tests. */
  fetch?: FetchFn;
  /** Per-request timeout; 30 seconds by default. */
  timeoutMs?: number;
}

/** The nested connections an issue's facts are counted from, read 100 at
 * a time. Each carries its page info, so a count never stops at the first
 * page: an issue whose connection has more is read on with a follow-up
 * query. Page info adds next to nothing to a query's complexity, so the
 * pending page stays under Linear's limit. */
const NESTED = {
  labels: "nodes { name }",
  relations: "nodes { type }",
  inverseRelations: "nodes { type issue { state { type } } }",
} as const;
type NestedName = keyof typeof NESTED;
const NESTED_NAMES = Object.keys(NESTED) as NestedName[];
const NESTED_SIZE = 100;

function nested(name: NestedName, after = false): string {
  const args = after ? `first: ${NESTED_SIZE}, after: $after` : `first: ${NESTED_SIZE}`;
  return `${name}(${args}) { pageInfo { hasNextPage endCursor } ${NESTED[name]} }`;
}

const ISSUE_FIELDS = `identifier title description url createdAt
  ${nested("labels")}
  reactions { id }
  ${nested("relations")}
  ${nested("inverseRelations")}
  assignee { id }`;

/** The rest of one nested connection, by issue key and cursor. */
const REST_QUERIES = Object.fromEntries(
  NESTED_NAMES.map((name) => [
    name,
    `query($id: String!, $after: String) { issue(id: $id) { ${nested(name, true)} } }`,
  ]),
) as Record<NestedName, string>;

const STATES_QUERY = `query($team: String!) {
  workflowStates(first: 250, filter: { team: { key: { eq: $team } } }) { nodes { id name type } }
}`;

const PENDING_QUERY = `query($team: String!, $states: [ID!]!, $after: String) {
  issues(first: ${PAGE_SIZE}, after: $after, filter: { team: { key: { eq: $team } }, state: { id: { in: $states } } }) {
    pageInfo { hasNextPage endCursor }
    nodes { ${ISSUE_FIELDS} }
  }
}`;

const ISSUE_QUERY = `query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`;

const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });

/** A nested connection; without page info it reads as complete. */
const connection = <N extends z.ZodType>(node: N) =>
  z.object({ pageInfo: pageInfoSchema.optional(), nodes: z.array(node) });

const nestedSchemas = {
  labels: connection(z.object({ name: z.string() })),
  relations: connection(z.object({ type: z.string() })),
  /** Relations other issues hold to this one: on "A blocks B", B sees the
   * relation here with A as its `issue`. */
  inverseRelations: connection(
    z.object({ type: z.string(), issue: z.object({ state: z.object({ type: z.string() }) }) }),
  ),
};

const issueSchema = z.object({
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  url: z.string(),
  createdAt: z.string(),
  labels: nestedSchemas.labels,
  reactions: z.array(z.unknown()),
  relations: nestedSchemas.relations,
  inverseRelations: nestedSchemas.inverseRelations,
  assignee: z.object({ id: z.string() }).nullable(),
});

/** A follow-up page of one nested connection. */
const restSchema = z.object({
  issue: z
    .object({
      labels: nestedSchemas.labels.optional(),
      relations: nestedSchemas.relations.optional(),
      inverseRelations: nestedSchemas.inverseRelations.optional(),
    })
    .nullable(),
});

const statesSchema = z.object({
  workflowStates: z.object({
    nodes: z.array(z.object({ id: z.string(), name: z.string(), type: z.string() })),
  }),
});

const pageSchema = z.object({
  issues: z.object({
    pageInfo: pageInfoSchema,
    nodes: z.array(issueSchema),
  }),
});

const lookupSchema = z.object({ issue: issueSchema.nullable() });

/** The GraphQL envelope: only what the tracker reads of it. */
const envelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z
    .array(
      z.object({
        message: z.unknown().optional(),
        extensions: z.object({ code: z.unknown().optional() }).optional(),
      }),
    )
    .optional(),
});

type IssueNode = z.infer<typeof issueSchema>;
type WorkflowState = z.infer<typeof statesSchema>["workflowStates"]["nodes"][number];

/** A tracker failure. Value-free: it names the operation, the HTTP status
 * or a field path, never the key or any text from Linear's reply. */
export class LinearTrackerError extends RefusalError {
  constructor(message: string) {
    super(message);
    this.name = "LinearTrackerError";
  }
}

/** How to get a key, named after the variable it is read from. */
export function linearKeyHint(apiKeyVar: string): string {
  return `Set ${apiKeyVar} to a Linear personal API key; create one at ${LINEAR_KEY_URL}`;
}

/** Linear also reports a rejected key as a GraphQL error code. */
const AUTH_CODES = new Set(["AUTHENTICATION_ERROR", "FORBIDDEN"]);

function toTicket(node: IssueNode): Ticket {
  const linked = [...node.relations.nodes, ...node.inverseRelations.nodes].filter((r) =>
    LINKED_RELATION_TYPES.has(r.type),
  );
  return {
    key: node.identifier,
    title: node.title,
    body: node.description ?? "",
    labels: node.labels.nodes.map((l) => l.name),
    url: node.url,
    createdAt: node.createdAt,
    reactions: node.reactions.length,
    linkedIssues: linked.length,
    // A relation reads "issue <type> relatedIssue": on "A duplicate B", A
    // is the duplicate and B the canonical, so only B's inverse relations
    // count issues marked duplicates of it.
    duplicates: node.inverseRelations.nodes.filter((r) => r.type === "duplicate").length,
    openBlockers: node.inverseRelations.nodes.filter(
      (r) => r.type === "blocks" && !CLOSED_STATE_TYPES.has(r.issue.state.type),
    ).length,
    // Linear's attachments carry a pull request's URL but not its state
    // (open, merged, closed), so open closing PRs cannot be counted here.
    openClosingPrs: 0,
    // A Linear issue has at most one assignee.
    assignees: node.assignee === null ? 0 : 1,
  };
}

/** The team's states each `linear.states` entry names, by name or type;
 * refuses any entry that matches none, listing the team's states. */
function matchStates(team: string, wanted: readonly string[], states: readonly WorkflowState[]): string[] {
  if (states.length === 0) {
    throw new LinearTrackerError(
      `Linear shows no workflow states for team ${team}: the team does not exist or the key cannot read it`,
    );
  }
  const ids = new Set<string>();
  const unmatched: string[] = [];
  for (const entry of wanted) {
    const needle = entry.trim().toLowerCase();
    const hits = states.filter((s) => s.name.toLowerCase() === needle || s.type.toLowerCase() === needle);
    if (hits.length === 0) unmatched.push(entry);
    for (const s of hits) ids.add(s.id);
  }
  if (unmatched.length > 0) {
    const listed = states.map((s) => `${s.name} (${s.type})`).join(", ");
    throw new LinearTrackerError(
      `linear.states ${unmatched.map((e) => `"${e}"`).join(", ")} ` +
        `${unmatched.length === 1 ? "matches" : "match"} no workflow state of team ${team}; ` +
        `its states are ${listed}. No issue was read.`,
    );
  }
  return states.filter((s) => ids.has(s.id)).map((s) => s.id);
}

export function linearTracker(opts: LinearTrackerOptions): Tracker {
  const team = opts.team.toUpperCase();
  const source = parseSource(`linear:${team}`);
  const apiKeyVar = opts.apiKeyVar ?? DEFAULT_KEY_VARS.linear;
  const wanted = opts.states ?? DEFAULT_LINEAR_STATES;
  const fetchFn: FetchFn = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** Runs one query and checks its data against `schema`. `missing`
   * turns a not-found GraphQL error into data instead of a refusal. */
  async function call<S extends z.ZodType>(
    operation: string,
    query: string,
    variables: Record<string, unknown>,
    schema: S,
    missing?: z.infer<S>,
  ): Promise<z.infer<S>> {
    let res: Response;
    try {
      res = await fetchFn(LINEAR_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: { authorization: opts.apiKey, "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new LinearTrackerError(`could not reach Linear while ${operation}`);
    }
    const refused = () =>
      new LinearTrackerError(
        `Linear refused the API key while ${operation} (HTTP ${res.status}). ${linearKeyHint(apiKeyVar)}`,
      );
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      throw refused();
    }
    const raw: unknown = await res.json().catch(() => undefined);
    const envelope = envelopeSchema.safeParse(raw);
    const errors = envelope.success ? (envelope.data.errors ?? []) : [];
    if (errors.some((e) => typeof e.extensions?.code === "string" && AUTH_CODES.has(e.extensions.code))) {
      throw refused();
    }
    if (
      missing !== undefined &&
      errors.length > 0 &&
      errors.every((e) => typeof e.message === "string" && e.message.startsWith("Entity not found"))
    ) {
      return missing;
    }
    if (errors.length > 0) {
      throw new LinearTrackerError(
        `Linear answered HTTP ${res.status} with GraphQL errors while ${operation}`,
      );
    }
    if (!res.ok || !envelope.success || envelope.data.data == null) {
      throw new LinearTrackerError(`Linear answered HTTP ${res.status} while ${operation}`);
    }
    const parsed = schema.safeParse(envelope.data.data);
    if (!parsed.success) {
      const path = parsed.error.issues[0]?.path.map(String).join(".") || "(root)";
      throw new LinearTrackerError(
        `Linear's reply did not have the expected shape while ${operation} (at ${path})`,
      );
    }
    return parsed.data;
  }

  /** Reads the rest of every nested connection the first page cut short,
   * so no count stops at a page boundary. */
  async function complete(node: IssueNode): Promise<IssueNode> {
    for (const name of NESTED_NAMES) {
      const nodes: unknown[] = node[name].nodes;
      let info = node[name].pageInfo;
      while (info?.hasNextPage && info.endCursor !== null) {
        const data: z.infer<typeof restSchema> = await call(
          `reading ${node.identifier}'s ${name}`,
          REST_QUERIES[name],
          { id: node.identifier, after: info.endCursor },
          restSchema,
        );
        const rest = data.issue?.[name];
        if (rest === undefined) break;
        nodes.push(...rest.nodes);
        info = rest.pageInfo;
      }
    }
    return node;
  }

  return {
    source: source.spec,
    async pending() {
      if (wanted.length === 0) {
        throw new LinearTrackerError("linear.states lists no states, so there is nothing to rank");
      }
      const known = await call(`reading ${team}'s workflow states`, STATES_QUERY, { team }, statesSchema);
      const states = matchStates(team, wanted, known.workflowStates.nodes);
      const tickets: Ticket[] = [];
      let after: string | null = null;
      for (;;) {
        const page: z.infer<typeof pageSchema> = await call(
          `listing ${team}'s pending issues`,
          PENDING_QUERY,
          { team, states, after },
          pageSchema,
        );
        for (const n of page.issues.nodes) tickets.push(toTicket(await complete(n)));
        if (!page.issues.pageInfo.hasNextPage || page.issues.pageInfo.endCursor === null) break;
        after = page.issues.pageInfo.endCursor;
      }
      return tickets;
    },
    async issues(keys) {
      const named: string[] = [];
      const foreign: string[] = [];
      for (const key of keys) {
        const canonical = issueKeyIn(key, source, { bare: false });
        if (canonical === undefined) foreign.push(key);
        else named.push(canonical);
      }
      if (foreign.length > 0) {
        throw new LinearTrackerError(
          `${foreign.join(", ")} not in the ${team} team this source reads (keys look like ${team}-123)`,
        );
      }
      const tickets: Ticket[] = [];
      for (const key of named) {
        const data = await call(`reading ${key}`, ISSUE_QUERY, { id: key }, lookupSchema, { issue: null });
        if (data.issue === null) throw new LinearTrackerError(`Linear has no issue ${key}`);
        tickets.push(toTicket(await complete(data.issue)));
      }
      return tickets;
    },
  };
}
