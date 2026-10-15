/**
 * The CLI suites' shared setup: a temp project root holding the fixture
 * rubric, a `Project` whose engine and tracker run over the offline
 * fixture network, and an io that captures what a run prints.
 */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliIo } from "../cli.js";
import { createJevEngine } from "../jev/index.js";
import { DEFAULT_KEY_VARS } from "../keys.js";
import { ALLOWLIST_KEY, type Project } from "../loader.js";
import { RUBRIC_DIR, rubricHash } from "../rubric.js";
import { githubTracker } from "../trackers/github.js";
import { FIXTURE_DIR, type RequestCounts, replayFetch } from "./replay.js";

/** {@link rubricHash} of the fixture rubric. */
export const FIXTURE_HASH = rubricHash(readFileSync(join(FIXTURE_DIR, "rubric.yaml"), "utf8"));

/** A temp project root with the fixture rubric at `.backlog-ranker/rubrics/fixture.yaml`. */
export function fixtureRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `backlog-ranker-${prefix}-`));
  mkdirSync(join(root, RUBRIC_DIR), { recursive: true });
  copyFileSync(join(FIXTURE_DIR, "rubric.yaml"), join(root, RUBRIC_DIR, "fixture.yaml"));
  return root;
}

export function removeRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/** A project at `root` allowing `github:kit/kit`, served by OpenRouter,
 * with a fresh fixture network whose request counts it hands back. */
export function fixtureProject(root: string): { project: Project; counts: RequestCounts } {
  const net = replayFetch();
  const project: Project = {
    projectRoot: root,
    configPath: ".backlog-ranker/config.yaml",
    config: { sources: ["github:kit/kit"], backend: "openrouter", keys: { ...DEFAULT_KEY_VARS } },
    sources: ["github:kit/kit"],
    allowlistKey: ALLOWLIST_KEY,
    backend: "openrouter",
    engine: () =>
      createJevEngine({
        backend: "openrouter",
        apiKey: "k-test",
        fetch: net.fetch,
        retry: { maxRetries: 0 },
      }),
    tracker: (source) => {
      if (source.kind !== "github") throw new Error("fixture tracker is GitHub only");
      return githubTracker({ owner: source.owner, repo: source.repo, token: "t", fetch: net.fetch });
    },
  };
  return { project, counts: net.counts };
}

export interface CapturedIo {
  io: CliIo;
  stdout(): string;
  stderr(): string;
  /** Forget what was printed so far. */
  clear(): void;
}

export function captureIo(env: CliIo["env"] = {}): CapturedIo {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (text) => {
        out.push(text);
      },
      stderr: (text) => {
        err.push(text);
      },
      env,
    },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    clear: () => {
      out.length = 0;
      err.length = 0;
    },
  };
}
