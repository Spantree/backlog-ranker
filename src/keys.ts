/**
 * The one source of the default environment variable names each
 * service's key is read from. The config's `keys` defaults, the engine's
 * and the tracker's refusals all name these unless told otherwise.
 */
export const DEFAULT_KEY_VARS = {
  github: "GITHUB_TOKEN",
  typesafe: "TYPESAFE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
} as const;
