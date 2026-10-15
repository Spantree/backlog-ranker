/**
 * The tracker for a parsed source: GitHub for `github:<owner>/<repo>`,
 * Linear for `linear:<TEAM>`.
 */

import type { SourceRef } from "../source.js";
import { githubTracker } from "./github.js";
import { linearTracker } from "./linear.js";
import type { FetchFn, Tracker } from "./tracker.js";

export interface TrackerOptions {
  /** The source's credential: a GitHub token or a Linear API key. */
  token: string;
  /** The environment variable the credential came from, named in auth refusals. */
  tokenEnvVar?: string;
  /** Linear only: workflow state names or types to rank (`linear.states`). */
  linearStates?: readonly string[];
  /** Replaces the global fetch, for tests. */
  fetch?: FetchFn;
}

export function trackerFor(source: SourceRef, opts: TrackerOptions): Tracker {
  const fetchOpt = opts.fetch === undefined ? {} : { fetch: opts.fetch };
  if (source.kind === "linear") {
    return linearTracker({
      team: source.team,
      apiKey: opts.token,
      ...(opts.tokenEnvVar === undefined ? {} : { apiKeyVar: opts.tokenEnvVar }),
      ...(opts.linearStates === undefined ? {} : { states: opts.linearStates }),
      ...fetchOpt,
    });
  }
  return githubTracker({
    owner: source.owner,
    repo: source.repo,
    token: opts.token,
    ...(opts.tokenEnvVar === undefined ? {} : { tokenEnvVar: opts.tokenEnvVar }),
    ...fetchOpt,
  });
}
