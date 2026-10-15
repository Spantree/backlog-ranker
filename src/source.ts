/**
 * `--source` grammar and the allowlist.
 *
 * A run reads only sources the project's committed config lists, and
 * refuses any other before a single request leaves the machine. Adding a
 * backlog is a committed config change, never a typed flag.
 */

import { RefusalError } from "./errors.js";

export type SourceRef =
  | { kind: "github"; owner: string; repo: string; spec: string }
  | { kind: "linear"; team: string; spec: string };

export class SourceError extends RefusalError {
  constructor(message: string) {
    super(message);
    this.name = "SourceError";
  }
}

const LINEAR_TEAM_RE = /^[A-Za-z][A-Za-z0-9]{0,9}$/;
const GITHUB_REPO_RE = /^([\w.-]+)\/([\w.-]+)$/;

/** Parses `github:owner/repo` or `linear:TEAM`. The canonical `spec` is
 * lowercased for GitHub (owner and repo names are case-insensitive there)
 * and uppercased for a Linear team key, so allowlist matching ignores case. */
export function parseSource(spec: string): SourceRef {
  const colon = spec.indexOf(":");
  const kind = colon === -1 ? "" : spec.slice(0, colon);
  const rest = colon === -1 ? "" : spec.slice(colon + 1);
  if (kind === "github") {
    const m = GITHUB_REPO_RE.exec(rest);
    if (m?.[1] !== undefined && m[2] !== undefined) {
      return { kind: "github", owner: m[1], repo: m[2], spec: `github:${rest.toLowerCase()}` };
    }
  }
  if (kind === "linear" && LINEAR_TEAM_RE.test(rest)) {
    const team = rest.toUpperCase();
    return { kind: "linear", team, spec: `linear:${team}` };
  }
  throw new SourceError(
    `--source takes github:<owner>/<repo> (for example github:octocat/hello-world) or linear:<TEAM>, not "${spec}"`,
  );
}

/** The allowlist check. Runs before any tracker or engine request.
 * `settingsKey` names where the allowlist lives, for the remediation. */
export function assertAllowed(source: SourceRef, allowlist: readonly string[], settingsKey: string): void {
  const allowed = new Set<string>();
  for (const entry of allowlist) {
    try {
      allowed.add(parseSource(entry).spec);
    } catch {
      // An unparseable entry allows nothing; the config schema refuses one
      // at load, so this only guards direct callers.
    }
  }
  if (allowed.has(source.spec)) return;
  const listed = allowed.size === 0 ? "it lists no sources" : `it lists ${[...allowed].join(", ")}`;
  throw new SourceError(
    `${source.spec} is not on the backlog source allowlist (${settingsKey}; ${listed}). ` +
      `No request was sent. To rank this backlog, add "${source.spec}" to ${settingsKey} ` +
      `in the project's committed settings, so the decision to send its tickets to the ` +
      `decision engine is reviewed like any other change.`,
  );
}

/**
 * The one issue-key grammar: `owner/repo#N`, or a bare `#N` or `N` that a
 * caller with a repository in hand may expand. N is a whole number from 1.
 */
const ISSUE_KEY_RE = /^(?:([\w.-]+)\/([\w.-]+)#|#)?([1-9]\d*)$/;

export interface IssueKeyMatch {
  /** Present only when the key names its repository. */
  repo?: { owner: string; name: string };
  number: number;
}

/** Match a key against the grammar; `undefined` when it is not a key. */
export function matchIssueKey(text: string): IssueKeyMatch | undefined {
  const m = ISSUE_KEY_RE.exec(text);
  if (m?.[3] === undefined) return undefined;
  const number = Number(m[3]);
  return m[1] === undefined || m[2] === undefined
    ? { number }
    : { repo: { owner: m[1], name: m[2] }, number };
}

/**
 * The issue number `text` names in `owner/repo`, or `undefined` when it is
 * not a key or names another repository (repository names ignore case).
 * A bare `#N` or `N` counts only when `bare` admits it.
 */
export function issueNumberIn(
  text: string,
  owner: string,
  repo: string,
  options: { bare: boolean },
): number | undefined {
  const match = matchIssueKey(text);
  if (match === undefined) return undefined;
  if (match.repo === undefined) return options.bare ? match.number : undefined;
  const named = `${match.repo.owner}/${match.repo.name}`.toLowerCase();
  return named === `${owner}/${repo}`.toLowerCase() ? match.number : undefined;
}

/** Parses an issue key `owner/repo#123` into its GitHub source and number. */
export function parseIssueKey(key: string): { source: SourceRef; number: number; key: string } {
  const match = matchIssueKey(key);
  if (match?.repo === undefined) {
    throw new SourceError(
      `an issue key looks like <owner>/<repo>#<number> (for example octocat/hello-world#1), not "${key}"`,
    );
  }
  return {
    source: parseSource(`github:${match.repo.owner}/${match.repo.name}`),
    number: match.number,
    key,
  };
}
