/**
 * The project loader: the one policy path the CLI and library callers
 * share. It finds the project root, reads the config, and hands back the
 * allowlist with an engine and a tracker that are built only on demand,
 * so a caller can check the allowlist before any credential is read or
 * any request leaves the machine.
 */

import { type Config, findProjectRoot, loadConfig } from "./config.js";
import type { DecisionEngine } from "./engine.js";
import { RefusalError } from "./errors.js";
import { createJevEngine } from "./jev/index.js";
import type { SourceRef } from "./source.js";
import { tokenHint, trackerFor } from "./trackers/github.js";
import type { Tracker } from "./trackers/tracker.js";

/** Where the allowlist lives, named in the refusal. */
export const ALLOWLIST_KEY = "sources in .backlog-decisions/config.yaml";

export interface Project {
  projectRoot: string;
  /** Project-relative path of the config file that was read. */
  configPath: string;
  config: Config;
  /** The allowlist as the config spells it. */
  sources: readonly string[];
  allowlistKey: string;
  /** Where the engine is served, for the run header. */
  backend: string;
  /** Built on first call; refuses when the backend's key variable is unset. */
  engine(): DecisionEngine;
  /** Refuses when the GitHub token variable is unset. */
  tracker(source: SourceRef): Tracker;
}

export class LoaderError extends RefusalError {
  constructor(message: string) {
    super(message);
    this.name = "LoaderError";
  }
}

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

export function loadProject(cwd: string, env: Readonly<Record<string, string | undefined>>): Project {
  const projectRoot = findProjectRoot(cwd);
  const { config, path } = loadConfig(projectRoot);
  let engine: DecisionEngine | undefined;
  return {
    projectRoot,
    configPath: path,
    config,
    sources: config.sources,
    allowlistKey: ALLOWLIST_KEY,
    backend: config.backend,
    engine() {
      if (engine !== undefined) return engine;
      const keyVar = config.keys[config.backend];
      const apiKey = env[keyVar];
      if (!present(apiKey)) {
        throw new LoaderError(`${keyVar} is not set: the ${config.backend} backend needs it to score tickets`);
      }
      engine = createJevEngine({
        backend: config.backend,
        apiKey,
        ...(config.model === undefined ? {} : { model: config.model }),
      });
      return engine;
    },
    tracker(source) {
      const tokenEnvVar = config.keys.github;
      if (source.kind === "linear") return trackerFor(source, { token: "", tokenEnvVar });
      const token = env[tokenEnvVar];
      if (!present(token)) throw new LoaderError(`${tokenEnvVar} is not set. ${tokenHint(tokenEnvVar)}`);
      return trackerFor(source, { token, tokenEnvVar });
    },
  };
}
