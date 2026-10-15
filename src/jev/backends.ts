/**
 * Where Jev is served. A BACKEND is a transport: the same Jev model
 * answers the same request whether it arrives at TypeSafe's own API or
 * through OpenRouter. Both take the model id verbatim (`jev-1.14`); they
 * differ in how they REPORT the model that answered, which is what the
 * pinned-version check needs. No custom base URL in this iteration.
 */

/** The Jev versions a caller may pin. Never a floating alias such as
 * `jev-latest`: cached answers are comparable only within one model
 * version. A new release is one more entry, once both backends serve it. */
export const JEV_MODELS = ["jev-1.13", "jev-1.14"] as const;
export type JevModel = (typeof JEV_MODELS)[number];

/** The version used when a caller pins none. */
export const DEFAULT_JEV_MODEL: JevModel = "jev-1.14";

export function isJevModel(value: string): value is JevModel {
  return (JEV_MODELS as readonly string[]).includes(value);
}

export const BACKEND_NAMES = ["typesafe", "openrouter"] as const;
export type BackendName = (typeof BACKEND_NAMES)[number];

export function isBackendName(value: string): value is BackendName {
  return (BACKEND_NAMES as readonly string[]).includes(value);
}

export interface Backend {
  readonly name: BackendName;
  /** The SDK's API root; the SDK appends `/v1/systemone`. */
  readonly baseURL: string;
  /** Every spelling under which this backend reports `model` as the one
   * that answered. A dated snapshot suffix on any of them is accepted
   * separately (see `servesPinnedModel`). */
  servedSpellings(model: JevModel): readonly string[];
}

export const BACKENDS: Readonly<Record<BackendName, Backend>> = {
  typesafe: {
    name: "typesafe",
    baseURL: "https://api.typesafe.ai",
    // Recorded: `jev-1.14.0`, the release's `.0` patch spelling.
    servedSpellings: (model) => [model, `${model}.0`],
  },
  openrouter: {
    name: "openrouter",
    baseURL: "https://openrouter.ai/api",
    // Recorded: `typesafe/jev-1.14-20261014`, provider-prefixed and dated.
    servedSpellings: (model) => [model, `typesafe/${model}`],
  },
};
