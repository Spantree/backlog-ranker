/**
 * `calibrate --hand`: the hand ranking as typed, expanded to the keys
 * the tracker spells. Duplicate and too-short lists are the library's
 * refusals ({@link calibrateBacklog}); this module only reads keys.
 */

import { issueNumberIn, type SourceRef } from "../source.js";
import { usageError } from "./flags.js";

/**
 * `--hand`, best first: `owner/repo#N`, `#N` or `N`, each expanded to
 * the source's repository so it matches the tracker's keys exactly.
 * Refuses another repository's keys before any request leaves the machine.
 */
export function parseHand(raw: string, source: SourceRef): string[] {
  const items = raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k !== "");
  if (source.kind !== "github") return items.map((k) => k.toUpperCase());
  const repoName = `${source.owner}/${source.repo}`;
  const keys: string[] = [];
  const foreign: string[] = [];
  for (const item of items) {
    const number = issueNumberIn(item, source.owner, source.repo, { bare: true });
    if (number === undefined) foreign.push(item);
    else keys.push(`${repoName}#${number}`);
  }
  if (foreign.length > 0) {
    throw usageError(
      "calibrate",
      `--hand: ${foreign.join(", ")} not in ${repoName}, the repository this source reads ` +
        `(keys look like ${repoName}#123, #123 or 123). No request was sent.`,
    );
  }
  return keys;
}
