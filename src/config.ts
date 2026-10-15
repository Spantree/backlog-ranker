/**
 * The project's committed policy: `.backlog-decisions/config.yaml`. It
 * names the sources whose tickets may leave the machine (the allowlist),
 * the backend and Jev version that receive them, and the environment
 * variables that carry each key. No secret is ever written here.
 *
 * A gitignored `config.local.yaml` replaces the committed file outright,
 * and the run says which file it read.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { RefusalError } from "./errors.js";
import { BACKEND_NAMES, JEV_MODELS } from "./jev/backends.js";
import { DEFAULT_KEY_VARS } from "./keys.js";
import { parseSource } from "./source.js";

export const CONFIG_DIR = ".backlog-decisions";
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
        typesafe: envVar.default(DEFAULT_KEY_VARS.typesafe),
        openrouter: envVar.default(DEFAULT_KEY_VARS.openrouter),
      })
      .strict()
      .default(DEFAULT_KEY_VARS),
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

/** The nearest ancestor of `start` holding `.backlog-decisions/` or
 * `.git`, both markers checked per directory; `start` itself if none. */
export function findProjectRoot(start: string): string {
  const origin = resolve(start);
  let dir = origin;
  for (;;) {
    if (existsSync(join(dir, CONFIG_DIR)) || existsSync(join(dir, ".git"))) return dir;
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
    throw new ConfigError(`${origin} is not valid YAML: ${(err as Error).message}`);
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
}

/** Read the project's config, the local file first. */
export function loadConfig(projectRoot: string): LoadedConfig {
  for (const [path, local] of [
    [LOCAL_CONFIG_PATH, true],
    [CONFIG_PATH, false],
  ] as const) {
    const abs = join(projectRoot, path);
    if (existsSync(abs)) return { config: parseConfig(readFileSync(abs, "utf8"), path), path, local };
  }
  throw new ConfigError(
    `no config: expected ${join(projectRoot, CONFIG_PATH)} (or ${LOCAL_CONFIG_PATH} beside it). ` +
      `A minimal one:\n\n${CONFIG_EXAMPLE}\n`,
  );
}
