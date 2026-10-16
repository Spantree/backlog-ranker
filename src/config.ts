/**
 * The project's committed policy: `.backlog-ranker/config.yaml`. It
 * names the sources whose tickets may leave the machine (the allowlist),
 * the backend and Jev version that receive them, the environment
 * variables that carry each key, and which Linear workflow states count
 * as pending. No secret is ever written here.
 *
 * A gitignored `config.local.yaml` replaces the committed file outright,
 * and the run says which file it read. The sources it lists that the
 * committed file does not are reported, so the CLI can say so whenever
 * one is used.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { RefusalError } from "./errors.js";
import { BACKEND_NAMES, JEV_MODELS } from "./jev/backends.js";
import { DEFAULT_KEY_VARS } from "./keys.js";
import { parseSource } from "./source.js";
import { yamlSyntaxRefusal } from "./yaml-error.js";

export const CONFIG_DIR = ".backlog-ranker";
export const CONFIG_PATH = join(CONFIG_DIR, "config.yaml");
export const LOCAL_CONFIG_PATH = join(CONFIG_DIR, "config.local.yaml");

export { DEFAULT_KEY_VARS };

const envVar = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "an environment variable NAME, never the key itself");

const sourceSpec = z.string().refine(
  (spec) => {
    try {
      parseSource(spec);
      return true;
    } catch {
      return false;
    }
  },
  { message: "a source is github:<owner>/<repo> or linear:<TEAM>" },
);

export const configSchema = z
  .object({
    /** The allowlist: the only sources whose tickets may be sent to the engine. */
    sources: z.array(sourceSpec),
    backend: z.enum(BACKEND_NAMES),
    model: z.enum(JEV_MODELS).optional(),
    keys: z
      .object({
        github: envVar.default(DEFAULT_KEY_VARS.github),
        linear: envVar.default(DEFAULT_KEY_VARS.linear),
        typesafe: envVar.default(DEFAULT_KEY_VARS.typesafe),
        openrouter: envVar.default(DEFAULT_KEY_VARS.openrouter),
      })
      .strict()
      .default(DEFAULT_KEY_VARS),
    /** Linear sources only: which workflow states are ranked. */
    linear: z
      .object({
        /** State names or types, case-insensitive; `[backlog, unstarted]`
         * (Backlog and Todo on Linear's default workflow) when absent. */
        states: z
          .array(z.string().trim().min(1, "a workflow state name or type"))
          .min(1, "list at least one workflow state name or type")
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;

export const CONFIG_EXAMPLE = `sources:
  - github:octocat/hello-world
backend: typesafe   # or openrouter
model: jev-1.14`;

export class ConfigError extends RefusalError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** What marks a project root inside `.backlog-ranker/`: a config file or
 * the rubrics directory. A cache directory alone is not one, so the cache
 * a first `--allow-once` run writes outside any project never makes its
 * working directory a root for later runs. */
const ROOT_MARKERS = [CONFIG_PATH, LOCAL_CONFIG_PATH, join(CONFIG_DIR, "rubrics")];

/** The nearest ancestor of `start` holding `.backlog-ranker/config.yaml`,
 * `config.local.yaml` or `rubrics/`, or `.git`, all markers checked per
 * directory; `start` itself if none. */
export function findProjectRoot(start: string): string {
  const origin = resolve(start);
  let dir = origin;
  for (;;) {
    const marked = ROOT_MARKERS.some((marker) => existsSync(join(dir, marker)));
    if (marked || existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return origin;
    dir = parent;
  }
}

export function parseConfig(text: string, origin: string): Config {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new ConfigError(yamlSyntaxRefusal(origin, err));
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ConfigError(`${origin} is not a valid config:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

export interface LoadedConfig {
  config: Config;
  /** Project-relative path of the file that was read. */
  path: string;
  local: boolean;
  /** With `local`: the sources the local file lists that the committed
   * `config.yaml` does not (all of them when there is none), as
   * canonical specs. Those were never reviewed; empty otherwise. */
  unreviewedSources: string[];
}

/** The canonical specs a committed `config.yaml` lists, read leniently:
 * an absent or invalid file admits nothing, so every local source counts
 * as unreviewed. The committed file is not otherwise used. */
function committedSources(projectRoot: string): Set<string> {
  const abs = join(projectRoot, CONFIG_PATH);
  if (!existsSync(abs)) return new Set();
  try {
    return new Set(
      parseConfig(readFileSync(abs, "utf8"), CONFIG_PATH).sources.map((s) => parseSource(s).spec),
    );
  } catch {
    return new Set();
  }
}

/** Read the project's config, the local file first; `undefined` when
 * neither file exists. */
export function readConfig(projectRoot: string): LoadedConfig | undefined {
  for (const [path, local] of [
    [LOCAL_CONFIG_PATH, true],
    [CONFIG_PATH, false],
  ] as const) {
    const abs = join(projectRoot, path);
    if (!existsSync(abs)) continue;
    const config = parseConfig(readFileSync(abs, "utf8"), path);
    let unreviewedSources: string[] = [];
    if (local) {
      const committed = committedSources(projectRoot);
      const specs = config.sources.map((s) => parseSource(s).spec);
      unreviewedSources = [...new Set(specs)].filter((spec) => !committed.has(spec));
    }
    return { config, path, local, unreviewedSources };
  }
  return undefined;
}

/** Read the project's config, the local file first; refuses when none exists. */
export function loadConfig(projectRoot: string): LoadedConfig {
  const found = readConfig(projectRoot);
  if (found !== undefined) return found;
  throw new ConfigError(
    `no config: expected ${join(projectRoot, CONFIG_PATH)} (or ${LOCAL_CONFIG_PATH} beside it). ` +
      `A minimal one:\n\n${CONFIG_EXAMPLE}\n`,
  );
}
