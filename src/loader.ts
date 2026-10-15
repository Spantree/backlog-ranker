/**
 * The project loader: the one policy path the CLI and library callers
 * share. It finds the project root, reads the config, and hands back the
 * allowlist with an engine and a tracker that are built only on demand,
 * so a caller can check the allowlist before any credential is read or
 * any request leaves the machine.
 */

import { join, sep } from "node:path";
import {
  CONFIG_PATH,
  type Config,
  DEFAULT_KEY_VARS,
  findProjectRoot,
  type LoadedConfig,
  loadConfig,
  readConfig,
} from "./config.js";
import type { DecisionEngine } from "./engine.js";
import { RefusalError } from "./errors.js";
import type { BackendName } from "./jev/backends.js";
import { createJevEngine } from "./jev/index.js";
import { assertAllowed, type SourceRef } from "./source.js";
import { tokenHint } from "./trackers/github.js";
import { trackerFor } from "./trackers/index.js";
import { linearKeyHint } from "./trackers/linear.js";
import type { FetchFn, Tracker } from "./trackers/tracker.js";

/** Where the allowlist lives in the committed config, named in the refusal. */
export const ALLOWLIST_KEY = "sources in .backlog-ranker/config.yaml";

/** The allowlist key for the config file actually read: a
 * `config.local.yaml` replaces the committed file outright, so the
 * refusal must send the user there. A run with no file (`--allow-once`)
 * points at the committed file it would create. */
function allowlistKeyFor(configPath: string): string {
  return configPath === NO_CONFIG_PATH ? ALLOWLIST_KEY : `sources in ${configPath.split(sep).join("/")}`;
}

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
  /** Refuses a source off the allowlist (the `allowOnce` one is on it),
   * then an unset key variable for the source's tracker (GitHub or Linear). */
  tracker(source: SourceRef): Tracker;
}

/** What a run may change for itself, never persisted. */
export interface LoadOptions {
  /** `--allow-once`: admit this one source for this process. */
  allowOnce?: SourceRef;
  /** `--backend` (with `--allow-once`): the backend for this run when no
   * config file exists, and required then. Refused when a config exists. */
  backend?: BackendName;
  /** Replaces the global fetch for the engine and the tracker, for tests. */
  fetch?: FetchFn;
}

/** The header's config path when a run had no config file. */
export const NO_CONFIG_PATH = "(no config: --allow-once)";

export class LoaderError extends RefusalError {
  constructor(message: string) {
    super(message);
    this.name = "LoaderError";
  }
}

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

/** The config file, or with `--allow-once --backend` and no file an
 * ephemeral one admitting only that source. Nothing is ever written.
 * With a file, the committed config chooses the backend. */
function resolveConfig(projectRoot: string, options: LoadOptions): Pick<LoadedConfig, "config" | "path"> {
  const found = readConfig(projectRoot);
  if (found !== undefined) {
    if (options.backend !== undefined) {
      throw new LoaderError(
        `the committed config chooses the backend (${found.path} names ${found.config.backend}); ` +
          "--backend only applies with --allow-once when no config exists",
      );
    }
    return found;
  }
  if (options.allowOnce === undefined) return loadConfig(projectRoot);
  if (options.backend === undefined) {
    throw new LoaderError(
      `--backend is required with --allow-once when no config exists ` +
        `(no ${join(projectRoot, CONFIG_PATH)}); pass --backend typesafe or --backend openrouter`,
    );
  }
  return {
    config: { sources: [options.allowOnce.spec], backend: options.backend, keys: { ...DEFAULT_KEY_VARS } },
    path: NO_CONFIG_PATH,
  };
}

export function loadProject(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  options: LoadOptions = {},
): Project {
  const projectRoot = findProjectRoot(cwd);
  const loaded = resolveConfig(projectRoot, options);
  const { config } = loaded;
  const sources =
    options.allowOnce === undefined ? config.sources : [...config.sources, options.allowOnce.spec];
  const fetchOpt = options.fetch === undefined ? {} : { fetch: options.fetch };
  const allowlistKey = allowlistKeyFor(loaded.path);
  let engine: DecisionEngine | undefined;
  return {
    projectRoot,
    configPath: loaded.path,
    config,
    sources,
    allowlistKey,
    backend: config.backend,
    engine() {
      if (engine !== undefined) return engine;
      const keyVar = config.keys[config.backend];
      const apiKey = env[keyVar];
      if (!present(apiKey)) {
        throw new LoaderError(
          `${keyVar} is not set: the ${config.backend} backend needs it to score tickets`,
        );
      }
      engine = createJevEngine({
        backend: config.backend,
        apiKey,
        apiKeyVar: keyVar,
        ...fetchOpt,
        ...(config.model === undefined ? {} : { model: config.model }),
      });
      return engine;
    },
    tracker(source) {
      // Defence for library callers: the CLI checks first, so its refusal
      // precedes the rubric read; nothing is built for an unlisted source.
      assertAllowed(source, sources, allowlistKey);
      const tokenEnvVar = config.keys[source.kind];
      const token = env[tokenEnvVar];
      if (!present(token)) {
        const hint = source.kind === "linear" ? linearKeyHint(tokenEnvVar) : tokenHint(tokenEnvVar);
        throw new LoaderError(`${tokenEnvVar} is not set. ${hint}`);
      }
      const states = config.linear?.states;
      return trackerFor(source, {
        token,
        tokenEnvVar,
        ...fetchOpt,
        ...(states === undefined ? {} : { linearStates: states }),
      });
    },
  };
}
