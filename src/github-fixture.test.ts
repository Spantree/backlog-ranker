/**
 * The GitHub fixture page must carry exactly the titles, bodies, labels,
 * createdAt and fact counts evie-kit's Linear tracker produced from its
 * fixture, so the recorded decision-model answers (keyed by a state hash
 * that excludes the ticket key) still match.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { githubTracker } from "./trackers/github.js";

const read = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

interface LinearNode {
  identifier: string;
  title: string;
  description: string | null;
  createdAt: string;
  labels: { nodes: { name: string }[] };
  reactions: unknown[];
  relations: { nodes: { type: string }[] };
  inverseRelations: { nodes: { type: string }[] };
}

/** What evie-kit's Linear tracker made of each node: every relation in
 * either direction is a linked issue; `duplicate` relations also count
 * as duplicates. */
function linearExpectation(node: LinearNode) {
  const relations = [...node.relations.nodes, ...node.inverseRelations.nodes];
  return {
    key: `kit/kit#${node.identifier.replace("KIT-", "")}`,
    title: node.title,
    body: node.description ?? "",
    labels: node.labels.nodes.map((l) => l.name),
    createdAt: node.createdAt,
    reactions: node.reactions.length,
    linkedIssues: relations.length,
    duplicates: relations.filter((r) => r.type === "duplicate").length,
  };
}

test("the GitHub fixture page maps to the same tickets the Linear fixture did", async () => {
  const linear = JSON.parse(read("linear-pending.reference.json")) as {
    data: { issues: { nodes: LinearNode[] } };
  };
  const page = read("github-issues.json");
  let requests = 0;
  const fetch = (async () => {
    requests++;
    return new Response(page, { headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;

  const tickets = await githubTracker({ owner: "kit", repo: "kit", token: "t", fetch }).pending();

  expect(requests).toBe(1);
  expect(tickets).toHaveLength(6);
  expect(tickets.map(({ url: _url, ...rest }) => rest)).toEqual(
    linear.data.issues.nodes.map(linearExpectation),
  );
  // The facts are not all zero, so the parity above exercises the mapping.
  expect(tickets.find((t) => t.key === "kit/kit#1")).toMatchObject({ reactions: 2, linkedIssues: 1 });
  expect(tickets.find((t) => t.key === "kit/kit#3")).toMatchObject({ linkedIssues: 1, duplicates: 1 });
});
