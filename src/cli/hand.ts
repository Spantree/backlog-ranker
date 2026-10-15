/**
 * `calibrate --hand`: the hand ranking as typed, expanded to the keys
 * the tracker spells. Duplicate and too-short lists are the library's
 * refusals ({@link calibrateBacklog}); this module only reads keys.
 */

import { issueKeyIn, type SourceRef } from "../source.js";
import { usageError } from "./flags.js";

/**
 * `--hand`, best first: `owner/repo#N` for a GitHub source, `TEAM-N` for
 * a Linear one, or a bare `#N` or `N`, each expanded to the source so it
 * matches the tracker's keys exactly. Refuses another repository's or
 * team's keys before any request leaves the machine.
 */
export function parseHand(raw: string, source: SourceRef): string[] {
  const items = raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k !== "");
  const keys: string[] = [];
  const foreign: string[] = [];
  for (const item of items) {
    const key = issueKeyIn(item, source, { bare: true });
    if (key === undefined) foreign.push(item);
    else keys.push(key);
  }
  if (foreign.length > 0) {
    const [where, example] =
      source.kind === "github"
        ? [`${source.owner}/${source.repo}, the repository`, `${source.owner}/${source.repo}#123`]
        : [`the ${source.team} team`, `${source.team}-123`];
    throw usageError(
      "calibrate",
      `--hand: ${foreign.join(", ")} not in ${where} this source reads ` +
        `(keys look like ${example}, #123 or 123). No request was sent.`,
    );
  }
  return keys;
}
