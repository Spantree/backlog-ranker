/**
 * The verb runner. `run(argv, io)` dispatches a verb, renders help and
 * failures through the injected writers and RETURNS the exit code: no
 * `process.exit` and no process streams in here, so the whole surface
 * is testable in-process. `bin.ts` is the only place that touches the
 * process.
 */

import { type ParseArgsConfig, parseArgs } from "node:util";
import { HelpRequest, isHelpRequest, isRefusal, RefusalError } from "./errors.js";

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Readonly<Record<string, string | undefined>>;
}

export type VerbHandler = (args: readonly string[], io: CliIo) => Promise<void> | void;

export const VERBS = ["rank", "calibrate", "explain"] as const;
export type Verb = (typeof VERBS)[number];

export interface RunOptions {
  /** Replace one or more verb handlers; the rest keep their defaults. */
  verbs?: Partial<Record<Verb, VerbHandler>>;
}

/** The hint printed when a refusal's frames were withheld: the
 * suppression must read as deliberate, and the hatch discoverable. */
export const DEBUG_HINT = "(BACKLOG_DECISIONS_DEBUG=1 for a stack)";

const USAGE = `usage: backlog-decisions <verb> [options]

verbs:
  rank       Rank a source's open tickets against a rubric
  calibrate  Compare the tool's ranking with a hand ranking
  explain    Show one ticket's scores, gates and flags

Run \`backlog-decisions <verb> --help\` for a verb's options.`;

const VERB_USAGE: Record<Verb, string> = {
  rank: `usage: backlog-decisions rank --rubric <name> --source <spec> [options]

  -r, --rubric <name>     Rubric under .backlog-decisions/rubrics/
  -s, --source <spec>     github:owner/repo (linear:TEAM is planned)
  -w, --weight <id=n>     Override a criterion weight; repeatable
  -t, --tiebreak <n>      Pairwise tie-break depth
      --concurrency <n>   Parallel engine requests
  -j, --json              Machine-readable output
      --allow-once        Admit this source for one run, never persisted
      --backend <name>    With --allow-once: typesafe or openrouter
  -h, --help              This text`,
  calibrate: `usage: backlog-decisions calibrate --rubric <name> --source <spec> --hand KEY,KEY,... [options]

  -r, --rubric <name>     Rubric under .backlog-decisions/rubrics/
  -s, --source <spec>     github:owner/repo (linear:TEAM is planned)
      --hand <keys>       Hand ranking, best first, comma separated
  -w, --weight <id=n>     Override a criterion weight; repeatable
  -j, --json              Machine-readable output
  -h, --help              This text

Exits 2 when the tool's ranking is not trusted.`,
  explain: `usage: backlog-decisions explain --rubric <name> <owner/repo#123> [options]

  -r, --rubric <name>     Rubric under .backlog-decisions/rubrics/
  -j, --json              Machine-readable output
  -h, --help              This text`,
};

/** Flags each verb accepts today. The stubs parse them so a bad flag is
 * refused and `--help` answered before "not implemented yet". */
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

/** Parse a verb's flags; a usage error is a refusal and `--help` a
 * help request, both thrown for the runner to render. */
export function parseVerbArgs(verb: Verb, args: readonly string[]): ReturnType<typeof parseArgs> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: [...args], options: VERB_FLAGS[verb], allowPositionals: true, strict: true });
  } catch (err) {
    // A usage error is the refusal itself, not its cause: parseArgs's
    // TypeError and its frames would only point at the parser.
    const message = (err instanceof Error ? err.message : String(err)).replace(
      /\. To specify a positional.*$/s,
      ".",
    );
    throw new RefusalError(`${message}\n\n${VERB_USAGE[verb]}`);
  }
  if (parsed.values.help === true) throw new HelpRequest(VERB_USAGE[verb]);
  return parsed;
}

function notImplemented(verb: Verb): VerbHandler {
  return (args) => {
    parseVerbArgs(verb, args);
    throw new RefusalError(`${verb} is not implemented yet`);
  };
}

const DEFAULT_VERBS: Record<Verb, VerbHandler> = {
  rank: notImplemented("rank"),
  calibrate: notImplemented("calibrate"),
  explain: notImplemented("explain"),
};

function isVerb(word: string): word is Verb {
  return (VERBS as readonly string[]).includes(word);
}

function dispatch(
  argv: readonly string[],
  io: CliIo,
  verbs: Record<Verb, VerbHandler>,
): Promise<void> | void {
  const [first, ...rest] = argv;
  if (first === undefined || first === "--help" || first === "-h") throw new HelpRequest(USAGE);
  if (!isVerb(first)) {
    throw new RefusalError(`unknown verb \`${first}\`; expected one of ${VERBS.join(", ")}\n\n${USAGE}`);
  }
  return verbs[first](rest, io);
}

export async function run(argv: readonly string[], io: CliIo, options: RunOptions = {}): Promise<number> {
  const verbs = { ...DEFAULT_VERBS, ...options.verbs };
  try {
    await dispatch(argv, io, verbs);
    return 0;
  } catch (err) {
    return renderFailure(err, io);
  }
}

/** A verb's `--help` arrives as a thrown help request: its text is the
 * answer, on stdout, and asking is success. Everything else is a
 * failure on stderr. */
function renderFailure(err: unknown, io: CliIo): number {
  if (isHelpRequest(err)) {
    io.stdout(`${err.message}\n`);
    return 0;
  }
  io.stderr(`${renderError(err, { debug: debugFromEnv(io.env.BACKLOG_DECISIONS_DEBUG) })}\n`);
  return 1;
}

/** The debug hatch is any non-empty value. */
export function debugFromEnv(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

/** `cause` chains are authored shallow; a longer one is a cycle or a
 * bug, and the cap keeps rendering total either way. */
const CAUSE_DEPTH_LIMIT = 8;

/** Read a property that may be a hostile getter: a renderer inside the
 * failure path must never itself throw. */
function safeRead(read: () => unknown): unknown {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** `name: message` from the object's PROPERTIES, never from the stack
 * string: Bun materializes that string lazily and it can come back
 * headerless. */
function headerOf(err: object): string {
  const name = asNonEmptyString(safeRead(() => (err as Error).name)) ?? "Error";
  const message = asNonEmptyString(safeRead(() => (err as Error).message));
  return message === undefined ? name : `${name}: ${message}`;
}

/** The stack's FRAME lines only, from the first `at ...` line on. */
function framesOf(err: object): string[] {
  const stack = safeRead(() => (err as Error).stack);
  if (typeof stack !== "string" || stack === "") return [];
  const lines = stack.split("\n");
  const first = lines.findIndex((line) => /^\s+at /.test(line));
  return first === -1 ? [] : lines.slice(first);
}

/**
 * Render one error and its cause chain. Refusals print message-only,
 * PER CHAIN LINK: a refusal's message is the whole remediation story
 * and frames would point at the guard instead of the fix, while an
 * unexpected error keeps its frames even as the cause of a refusal. A
 * trailing hint names the debug hatch whenever refusal frames were
 * withheld; the hatch restores them.
 */
export function renderError(err: unknown, options: { debug: boolean }): string {
  const lines: string[] = [];
  let withheld = false;
  let current: unknown = err;
  for (let depth = 0; depth < CAUSE_DEPTH_LIMIT && current !== undefined; depth += 1) {
    const prefix = depth === 0 ? "" : "caused by: ";
    if (typeof current !== "object" || current === null) {
      lines.push(`${prefix}${String(current)}`);
      break;
    }
    lines.push(`${prefix}${headerOf(current)}`);
    if (isRefusal(current) && !options.debug) withheld = true;
    else lines.push(...framesOf(current));
    current = safeRead(() => (current as Error).cause);
  }
  if (withheld) lines.push(DEBUG_HINT);
  return lines.join("\n");
}
