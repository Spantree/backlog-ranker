/**
 * The GitHub fixture page and the Linear fixture team's pending issues
 * must make the same tickets, keys and urls aside: the same titles,
 * bodies, labels, createdAt and model-visible fact counts. The recorded
 * decision-model answers are keyed by a state hash that excludes the key,
 * so both sources replay the same recordings. The gate-only counts (open
 * blockers, open closing pull requests, assignees) never reach the model,
 * so they stay out of the comparison.
 */
import { expect, test } from "bun:test";
import { replayFetch } from "./fixtures/replay.js";
import type { Ticket } from "./ticket.js";
import { githubTracker } from "./trackers/github.js";
import { linearTracker } from "./trackers/linear.js";

const modelVisible = ({ title, body, labels, createdAt, reactions, linkedIssues, duplicates }: Ticket) => ({
  title,
  body,
  labels,
  createdAt,
  reactions,
  linkedIssues,
  duplicates,
});

test("the GitHub fixture page and the Linear fixture team make the same tickets", async () => {
  const net = replayFetch();
  const github = await githubTracker({ owner: "kit", repo: "kit", token: "t", fetch: net.fetch }).pending();
  const linear = await linearTracker({ team: "KIT", apiKey: "k", fetch: net.fetch }).pending();

  expect(net.counts).toEqual({ github: 1, linear: 2, jev: 0, other: 0 });
  expect(github).toHaveLength(6);
  expect(linear.map((t) => t.key)).toEqual(github.map((t) => t.key.replace("kit/kit#", "KIT-")));
  expect(linear.map(modelVisible)).toEqual(github.map(modelVisible));
  // The facts are not all zero, so the parity above exercises the mapping.
  expect(github.find((t) => t.key === "kit/kit#1")).toMatchObject({ reactions: 2, linkedIssues: 1 });
  expect(github.find((t) => t.key === "kit/kit#3")).toMatchObject({ linkedIssues: 1, duplicates: 1 });
});

test("the GitHub fixture page gives some tickets open blockers, open closing pull requests and assignees", async () => {
  const net = replayFetch();
  const github = await githubTracker({ owner: "kit", repo: "kit", token: "t", fetch: net.fetch }).pending();
  const gateOnly = ({ key, openBlockers, openClosingPrs, assignees }: Ticket) => ({
    key,
    openBlockers,
    openClosingPrs,
    assignees,
  });
  // A closed blocker on #3 and a merged pull request on #6 do not count.
  expect(github.map(gateOnly)).toEqual([
    { key: "kit/kit#1", openBlockers: 1, openClosingPrs: 1, assignees: 0 },
    { key: "kit/kit#2", openBlockers: 0, openClosingPrs: 0, assignees: 1 },
    { key: "kit/kit#3", openBlockers: 1, openClosingPrs: 0, assignees: 0 },
    { key: "kit/kit#4", openBlockers: 0, openClosingPrs: 0, assignees: 0 },
    { key: "kit/kit#5", openBlockers: 0, openClosingPrs: 0, assignees: 0 },
    { key: "kit/kit#6", openBlockers: 0, openClosingPrs: 1, assignees: 2 },
  ]);
});
