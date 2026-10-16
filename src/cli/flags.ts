/**
 * The verbs' usage text and flags, and the helpers that turn a verb's
 * parsed flags into checked values. Every malformed value is a refusal
 * that names the flag and repeats the verb's usage.
 */

import { type ParseArgsConfig, parseArgs } from "node:util";
import { HelpRequest, RefusalError } from "../errors.js";
import { BACKEND_NAMES, type BackendName, isBackendName } from "../jev/backends.js";
import type { LoadOptions } from "../loader.js";
import type { SourceRef } from "../source.js";

export const VERBS = ["rank", "calibrate", "explain"] as const;
export type Verb = (typeof VERBS)[number];

export function isVerb(word: string): word is Verb {
  return (VERBS as readonly string[]).includes(word);
}

export const USAGE = `usage: backlog-ranker <verb> [options]

verbs:
  rank       Rank a source's pending tickets against a rubric
  calibrate  Compare the tool's ranking with a hand ranking
  explain    Show one ticket's scores, gates and flags

Run \`backlog-ranker <verb> --help\` for a verb's options.`;

const RUBRIC_HELP = `  -r, --rubric <name>     Rubric under .backlog-ranker/rubrics/, or a YAML file path
                          (a relative path resolves against the project root)`;

export const VERB_USAGE: Record<Verb, string> = {
  rank: `usage: backlog-ranker rank --rubric <name|path> --source <spec> [options]

${RUBRIC_HELP}
  -s, --source <spec>     github:owner/repo or linear:TEAM
  -w, --weight <id=n>     Override a criterion weight; repeatable
  -t, --tiebreak <n>      Pairwise tie-break depth
      --concurrency <n>   Parallel engine requests
  -j, --json              Machine-readable output
      --allow-once        Admit this source for one run, never persisted
      --backend <name>    With --allow-once and no config: typesafe or openrouter
  -h, --help              This text

github:owner/repo ranks the repository's open issues, keyed owner/repo#123.
linear:TEAM ranks the team's issues in the states linear.states names (Backlog
and Todo by default), keyed TEAM-123, with the key in LINEAR_API_KEY by default.`,
  calibrate: `usage: backlog-ranker calibrate --rubric <name|path> --source <spec> --hand KEY,KEY,... [options]

${RUBRIC_HELP}
  -s, --source <spec>     github:owner/repo or linear:TEAM
      --hand <keys>       Hand ranking, best first, comma separated: owner/repo#123
                          or TEAM-123 keys, or bare 123 within the source
  -w, --weight <id=n>     Override a criterion weight; repeatable
  -j, --json              Machine-readable output
  -h, --help              This text

Exits 2 when the tool's ranking is not trusted.`,
  explain: `usage: backlog-ranker explain --rubric <name|path> <owner/repo#123|TEAM-123> [options]

${RUBRIC_HELP}
  -j, --json              Machine-readable output
  -h, --help              This text

The key names its source: owner/repo#123 is github:owner/repo, TEAM-123 is
linear:TEAM; either must be on the allowlist. Decision-model answers come from
the cache after a rank; one tracker lookup reads the issue, in any state.`,
};

/** Flags each verb accepts; anything else is refused as a usage error. */
const VERB_FLAGS: Record<Verb, ParseArgsConfig["options"]> = {
  rank: {
    rubric: { type: "string", short: "r" },
    source: { type: "string", short: "s" },
    weight: { type: "string", short: "w", multiple: true },
    tiebreak: { type: "string", short: "t" },
    concurrency: { type: "string" },
    json: { type: "boolean", short: "j" },
    "allow-once": { type: "boolean" },
    backend: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  calibrate: {
    rubric: { type: "string", short: "r" },
    source: { type: "string", short: "s" },
    hand: { type: "string" },
    weight: { type: "string", short: "w", multiple: true },
    json: { type: "boolean", short: "j" },
    help: { type: "boolean", short: "h" },
  },
  explain: {
    rubric: { type: "string", short: "r" },
    json: { type: "boolean", short: "j" },
    help: { type: "boolean", short: "h" },
  },
};

/** A usage error: the message, then the verb's usage. */
export function usageError(verb: Verb, message: string): RefusalError {
  return new RefusalError(`${message}\n\n${VERB_USAGE[verb]}`);
}

type Values = ReturnType<typeof parseArgs>["values"];

/** One verb's parsed flags, with the checks that read them. */
export class VerbFlags {
  constructor(
    readonly verb: Verb,
    readonly values: Values,
    readonly positionals: readonly string[],
  ) {}

  error(message: string): RefusalError {
    return usageError(this.verb, message);
  }

  get json(): boolean {
    return this.values.json === true;
  }

  required(name: string): string {
    const value = this.values[name];
    if (typeof value !== "string" || value === "") throw this.error(`--${name} is required`);
    return value;
  }

  noPositionals(): void {
    const extra = this.positionals;
    if (extra.length > 0) {
      throw this.error(`unexpected argument${extra.length > 1 ? "s" : ""} ${extra.join(" ")}`);
    }
  }

  /** A whole number from 1 to `max`, or absent. */
  boundedInt(name: string, max: number): number | undefined {
    const raw = this.values[name];
    if (raw === undefined) return undefined;
    const n = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!(Number.isSafeInteger(n) && n >= 1 && n <= max)) {
      const range =
        max === Number.MAX_SAFE_INTEGER ? "a whole number of at least 1" : `a whole number from 1 to ${max}`;
      throw this.error(`--${name} takes ${range}, not "${String(raw)}"`);
    }
    return n;
  }

  /** `--weight id=n`, repeatable; the last value for an id wins. */
  weights(): Record<string, number> | undefined {
    const raw = this.values.weight;
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    const out: Record<string, number> = {};
    for (const item of raw) {
      const m = typeof item === "string" ? /^([a-z][a-z0-9_]*)=(\d+(?:\.\d+)?|\.\d+)$/.exec(item) : null;
      if (m?.[1] === undefined || m[2] === undefined) {
        throw this.error(`--weight takes <criterion>=<number>, such as impact=2, not "${String(item)}"`);
      }
      out[m[1]] = Number(m[2]);
    }
    return out;
  }

  /** `--allow-once` and its `--backend`: refused before anything is read. */
  allowOnce(source: SourceRef): LoadOptions {
    const raw = this.values.backend;
    const allowOnce = this.values["allow-once"] === true;
    if (raw !== undefined && !allowOnce) {
      throw this.error("--backend is accepted only with --allow-once; the config file names the backend");
    }
    let backend: BackendName | undefined;
    if (raw !== undefined) {
      if (typeof raw !== "string" || !isBackendName(raw)) {
        throw this.error(`--backend takes ${BACKEND_NAMES.join(" or ")}, not "${String(raw)}"`);
      }
      backend = raw;
    }
    if (!allowOnce) return {};
    return { allowOnce: source, ...(backend === undefined ? {} : { backend }) };
  }
}

/** Whether the args ask for help, read leniently so an unknown or
 * malformed flag beside `--help` or `-h` cannot hide it. */
function asksForHelp(verb: Verb, args: readonly string[]): boolean {
  try {
    const lenient = parseArgs({
      args: [...args],
      options: VERB_FLAGS[verb],
      allowPositionals: true,
      strict: false,
    });
    return lenient.values.help === true;
  } catch {
    return false;
  }
}

/** Parse a verb's flags; a usage error is a refusal and `--help` a
 * help request, both thrown for the runner to render. */
export function parseVerbArgs(verb: Verb, args: readonly string[]): VerbFlags {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: [...args], options: VERB_FLAGS[verb], allowPositionals: true, strict: true });
  } catch (err) {
    // `--help` wins over any other flag, known or not: asking for the
    // usage is never itself a usage error.
    if (asksForHelp(verb, args)) throw new HelpRequest(VERB_USAGE[verb]);
    // A usage error is the refusal itself, not its cause: parseArgs's
    // TypeError and its frames would only point at the parser.
    const message = (err instanceof Error ? err.message : String(err)).replace(
      /\. To specify a positional.*$/s,
      ".",
    );
    throw usageError(verb, message);
  }
  if (parsed.values.help === true) throw new HelpRequest(VERB_USAGE[verb]);
  return new VerbFlags(verb, parsed.values, parsed.positionals);
}
