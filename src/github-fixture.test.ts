/**
 * The GitHub fixture page and the Linear fixture team's pending issues
 * must make the same tickets, keys and urls aside: the same titles,
 * bodies, labels, createdAt and model-visible fact counts. The facts kept
 * from the model (open blockers, open closing PRs, assignees) are each
 * tracker's own and left out here. The recorded decision-model
 * answers are keyed by a state hash that excludes the key, so both
 * sources replay the same recordings.
 */
import { expect, test } from "bun:test";
import { replayFetch } from "./fixtures/replay.js";
import type { Ticket } from "./ticket.js";
import { githubTracker } from "./trackers/github.js";
import { linearTracker } from "./trackers/linear.js";

const sansKey = ({
  key: _key,
  url: _url,
  openBlockers: _blockers,
  openClosingPrs: _prs,
  assignees: _assignees,
  ...rest
}: Ticket) => rest;

test("the GitHub fixture page and the Linear fixture team make the same tickets", async () => {
  const net = replayFetch();
  const github = await githubTracker({ owner: "kit", repo: "kit", token: "t", fetch: net.fetch }).pending();
  const linear = await linearTracker({ team: "KIT", apiKey: "k", fetch: net.fetch }).pending();

  expect(net.counts).toEqual({ github: 1, linear: 2, jev: 0, other: 0 });
  expect(github).toHaveLength(6);
  expect(linear.map((t) => t.key)).toEqual(github.map((t) => t.key.replace("kit/kit#", "KIT-")));
  expect(linear.map(sansKey)).toEqual(github.map(sansKey));
  // The facts are not all zero, so the parity above exercises the mapping.
  expect(github.find((t) => t.key === "kit/kit#1")).toMatchObject({ reactions: 2, linkedIssues: 1 });
  expect(github.find((t) => t.key === "kit/kit#3")).toMatchObject({ linkedIssues: 1, duplicates: 1 });
});
