/**
 * The verb runner. `run(argv, io)` dispatches a verb, renders help and
 * failures through the injected writers and RETURNS the exit code: no
 * `process.exit` and no process streams in here, so the whole surface
 * is testable in-process. `bin.ts` is the only place that touches the
 * process.
 */

import { type ParseArgsConfig, parseArgs } from "node:util";
import { calibrateBacklog, explainTicket, rankBacklog } from "./api.js";
import { openCache } from "./cache.js";
import type { Ranking } from "./compose.js";
import { HelpRequest, isHelpRequest, isRefusal, RefusalError } from "./errors.js";
import { BACKEND_NAMES, type BackendName, isBackendName } from "./jev/backends.js";
import { TRUST_MIN_TICKETS, TRUST_TAU } from "./kendall.js";
import { type LoadOptions, loadProject, type Project } from "./loader.js";
import { loadRubricArg } from "./rubric.js";
import { assertAllowed, parseIssueKey, parseSource, type SourceRef } from "./source.js";
import { grid, renderExplain, renderTable } from "./table.js";
import { MAX_TIEBREAK } from "./tiebreak.js";

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Readonly<Record<string, string | undefined>>;
}

/** A verb returns its exit code, or nothing for success. */
export type VerbHandler = (
  args: readonly string[],
  io: CliIo,
) => Promise<number | undefined> | number | undefined;

export const VERBS = ["rank", "calibrate", "explain"] as const;
export type Verb = (typeof VERBS)[number];

/** Resolves the project a verb runs in: its root, config and allowlist,
 * with the engine and tracker built on demand. */
export type ProjectResolver = (
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  options?: LoadOptions,
) => Project | Promise<Project>;

export interface RunOptions {
  /** Replace one or more verb handlers; the rest keep their defaults. */
  verbs?: Partial<Record<Verb, VerbHandler>>;
  /** The project resolver; {@link loadProject} by default. */
  resolve?: ProjectResolver;
  /** The working directory the project is resolved from. */
  cwd?: () => string;
  /** The clock that buckets ticket ages. */
  now?: () => Date;
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
  rank: `usage: backlog-decisions rank --rubric <name|path> --source <spec> [options]

  -r, --rubric <name>     Rubric under .backlog-decisions/rubrics/, or a YAML file path
                          (a relative path resolves against the project root)
  -s, --source <spec>     github:owner/repo (linear:TEAM is planned)
  -w, --weight <id=n>     Override a criterion weight; repeatable
  -t, --tiebreak <n>      Pairwise tie-break depth
      --concurrency <n>   Parallel engine requests
  -j, --json              Machine-readable output
      --allow-once        Admit this source for one run, never persisted
      --backend <name>    With --allow-once and no config: typesafe or openrouter
  -h, --help              This text`,
  calibrate: `usage: backlog-decisions calibrate --rubric <name|path> --source <spec> --hand KEY,KEY,... [options]

  -r, --rubric <name>     Rubric under .backlog-decisions/rubrics/, or a YAML file path
                          (a relative path resolves against the project root)
  -s, --source <spec>     github:owner/repo (linear:TEAM is planned)
      --hand <keys>       Hand ranking, best first, comma separated
  -w, --weight <id=n>     Override a criterion weight; repeatable
  -j, --json              Machine-readable output
  -h, --help              This text

Exits 2 when the tool's ranking is not trusted.`,
  explain: `usage: backlog-decisions explain --rubric <name|path> <owner/repo#123> [options]

  -r, --rubric <name>     Rubric under .backlog-decisions/rubrics/, or a YAML file path
                          (a relative path resolves against the project root)
  -j, --json              Machine-readable output
  -h, --help              This text

Decision-model answers come from the cache after a rank; one GitHub lookup reads the issue.`,
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

type Values = ReturnType<typeof parseArgs>["values"];

function usageError(verb: Verb, message: string): RefusalError {
  return new RefusalError(`${message}\n\n${VERB_USAGE[verb]}`);
}

function requiredString(verb: Verb, values: Values, name: string): string {
  const value = values[name];
  if (typeof value !== "string" || value === "") throw usageError(verb, `--${name} is required`);
  return value;
}

function noPositionals(verb: Verb, positionals: readonly string[]): void {
  if (positionals.length > 0) {
    throw usageError(
      verb,
      `unexpected argument${positionals.length > 1 ? "s" : ""} ${positionals.join(" ")}`,
    );
  }
}

/** A whole number from 1 to `max`, or absent. */
function boundedInt(verb: Verb, values: Values, name: string, max: number): number | undefined {
  const raw = values[name];
  if (raw === undefined) return undefined;
  const n = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(Number.isSafeInteger(n) && n >= 1 && n <= max)) {
    const range =
      max === Number.MAX_SAFE_INTEGER ? "a whole number of at least 1" : `a whole number from 1 to ${max}`;
    throw usageError(verb, `--${name} takes ${range}, not "${String(raw)}"`);
  }
  return n;
}

/** `--weight id=n`, repeatable; the last value for an id wins. */
function weightOverrides(verb: Verb, values: Values): Record<string, number> | undefined {
  const raw = values.weight;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: Record<string, number> = {};
  for (const item of raw) {
    const m = typeof item === "string" ? /^([a-z][a-z0-9_]*)=(\d+(?:\.\d+)?|\.\d+)$/.exec(item) : null;
    if (m?.[1] === undefined || m[2] === undefined) {
      throw usageError(verb, `--weight takes <criterion>=<number>, such as impact=2, not "${String(item)}"`);
    }
    out[m[1]] = Number(m[2]);
  }
  return out;
}

/** `--allow-once` and its `--backend`: refused before anything is read. */
function allowOnceOptions(verb: Verb, values: Values, source: SourceRef): LoadOptions {
  const raw = values.backend;
  if (raw !== undefined && values["allow-once"] !== true) {
    throw usageError(verb, "--backend is accepted only with --allow-once; the config file names the backend");
  }
  let backend: BackendName | undefined;
  if (raw !== undefined) {
    if (typeof raw !== "string" || !isBackendName(raw)) {
      throw usageError(verb, `--backend takes ${BACKEND_NAMES.join(" or ")}, not "${String(raw)}"`);
    }
    backend = raw;
  }
  if (values["allow-once"] !== true) return {};
  return { allowOnce: source, ...(backend === undefined ? {} : { backend }) };
}

interface VerbDeps {
  resolve: ProjectResolver;
  cwd: () => string;
  now: () => Date;
}

function rankJson(ranking: Ranking): { ranked: unknown[]; held: unknown[] } {
  const row = (r: Ranking["ranked"][number], position: number | null): unknown => ({
    position,
    key: r.key,
    title: r.title,
    url: r.url,
    composite: r.composite,
    pinnedBy: r.pinnedBy,
    heldBy: r.heldBy,
    lowConfidence: r.lowConfidence,
    truncated: r.truncated,
    answers: r.answers,
  });
  return {
    ranked: ranking.ranked.map((r, i) => row(r, i + 1)),
    held: ranking.held.map((r) => row(r, null)),
  };
}

function rankVerb(deps: VerbDeps): VerbHandler {
  return async (args, io) => {
    const { values, positionals } = parseVerbArgs("rank", args);
    noPositionals("rank", positionals);
    const rubricName = requiredString("rank", values, "rubric");
    const source = parseSource(requiredString("rank", values, "source"));
    const weights = weightOverrides("rank", values);
    const top = boundedInt("rank", values, "tiebreak", MAX_TIEBREAK);
    const concurrency = boundedInt("rank", values, "concurrency", Number.MAX_SAFE_INTEGER);
    const loadOptions = allowOnceOptions("rank", values, source);
    const project = await deps.resolve(deps.cwd(), io.env, loadOptions);
    // The allowlist is checked before the rubric is read, the tracker is
    // built, or anything leaves the machine.
    assertAllowed(source, project.sources, project.allowlistKey);
    if (loadOptions.allowOnce !== undefined) {
      io.stderr(
        `the titles, bodies and labels of open issues in ${source.spec} will be sent to ` +
          `${project.backend} for this run only; nothing is saved to config\n`,
      );
    }
    const loaded = loadRubricArg(project.projectRoot, rubricName);
    // The tracker first: an unsupported source should say so, not report
    // a missing engine key.
    const tracker = project.tracker(source);
    const engine = project.engine();
    const cache = openCache(project.projectRoot, engine.id, engine.model, deps.now);
    const result = await rankBacklog({
      rubric: loaded.rubric,
      tracker,
      engine,
      cache,
      now: deps.now,
      ...(weights === undefined ? {} : { weights }),
      ...(top === undefined ? {} : { tiebreak: top }),
      ...(concurrency === undefined ? {} : { concurrency }),
    });
    if (values.json === true) {
      const report = {
        rubric: result.rubric.name,
        rubricPath: loaded.path,
        rubricHash: loaded.hash,
        configPath: project.configPath,
        source: source.spec,
        engine: engine.id,
        model: engine.model,
        backend: project.backend,
        stats: result.stats,
        tiebreak: result.tiebreak,
        ...rankJson(result.ranking),
      };
      io.stdout(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    const header = {
      rubricPath: loaded.path,
      rubricHash: loaded.hash,
      configPath: project.configPath,
      source: source.spec,
      engine: engine.id,
      model: engine.model,
      backend: project.backend,
    };
    const table = renderTable({
      rubric: result.rubric,
      header,
      ranking: result.ranking,
      stats: result.stats,
      ...(result.tiebreak === undefined ? {} : { tiebreak: result.tiebreak }),
    });
    io.stdout(`${table}\n`);
  };
}

/** Exit codes for calibrate: CI fails a rubric edit that loses trust. */
export const EXIT_NOT_TRUSTED = 2;

const HAND_KEY_RE = /^(?:([\w.-]+)\/([\w.-]+))?#?(\d+)$/;

/**
 * `--hand`, best first: `owner/repo#N`, `#N` or `N`, each expanded to
 * the source's repository so it matches the tracker's keys exactly.
 * Refuses another repository's keys, duplicates and short lists before
 * any request leaves the machine.
 */
export function parseHand(raw: string, source: SourceRef): string[] {
  const items = raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k !== "");
  if (source.kind !== "github") return items.map((k) => k.toUpperCase());
  const repoName = `${source.owner}/${source.repo}`;
  const keys: string[] = [];
  const foreign: string[] = [];
  for (const item of items) {
    const m = HAND_KEY_RE.exec(item);
    const named = m?.[1] === undefined ? undefined : `${m[1]}/${m[2]}`;
    if (m?.[3] === undefined || (named !== undefined && named.toLowerCase() !== repoName.toLowerCase())) {
      foreign.push(item);
    } else {
      keys.push(`${repoName}#${Number(m[3])}`);
    }
  }
  if (foreign.length > 0) {
    throw usageError(
      "calibrate",
      `--hand: ${foreign.join(", ")} not in ${repoName}, the repository this source reads ` +
        `(keys look like ${repoName}#123, #123 or 123). No request was sent.`,
    );
  }
  if (new Set(keys).size !== keys.length) throw usageError("calibrate", "--hand lists a key twice");
  if (keys.length < 2) throw usageError("calibrate", "--hand needs at least two issue keys, best first");
  return keys;
}

function calibrateVerb(deps: VerbDeps): VerbHandler {
  return async (args, io) => {
    const { values, positionals } = parseVerbArgs("calibrate", args);
    noPositionals("calibrate", positionals);
    const rubricName = requiredString("calibrate", values, "rubric");
    const source = parseSource(requiredString("calibrate", values, "source"));
    const hand = parseHand(requiredString("calibrate", values, "hand"), source);
    const weights = weightOverrides("calibrate", values);
    const project = await deps.resolve(deps.cwd(), io.env);
    // The allowlist is checked before the rubric is read, the tracker is
    // built, or anything leaves the machine.
    assertAllowed(source, project.sources, project.allowlistKey);
    const loaded = loadRubricArg(project.projectRoot, rubricName);
    const tracker = project.tracker(source);
    const engine = project.engine();
    const cache = openCache(project.projectRoot, engine.id, engine.model, deps.now);
    const result = await calibrateBacklog({
      rubric: loaded.rubric,
      tracker,
      engine,
      cache,
      hand,
      now: deps.now,
      ...(weights === undefined ? {} : { weights }),
    });
    const { calibration, tool, stats } = result;
    const code = calibration.trusted ? 0 : EXIT_NOT_TRUSTED;
    if (values.json === true) {
      const report = {
        rubric: result.rubric.name,
        rubricHash: loaded.hash,
        rubricPath: loaded.path,
        configPath: project.configPath,
        source: source.spec,
        engine: engine.id,
        model: engine.model,
        backend: project.backend,
        hand,
        tool,
        stats,
        ...calibration,
      };
      io.stdout(`${JSON.stringify(report, null, 2)}\n`);
      return code;
    }
    const rows = new Map([...result.ranking.ranked, ...result.ranking.held].map((r) => [r.key, r]));
    const lines = [
      `backlog-decisions calibrate: rubric ${result.rubric.name} (${loaded.path}) (sha ${loaded.hash}), source ${source.spec}, ${calibration.n} tickets`,
      // A tau holds for one model version only: name it beside the number.
      `engine ${engine.id}/${engine.model} via ${project.backend} (config ${project.configPath})`,
      "",
      ...grid([
        ["#", "hand", "tool", "tool composite", "title"],
        ...hand.map((k, i) => {
          const row = rows.get(tool[i] ?? "");
          return [String(i + 1), k, row?.key ?? "-", row?.composite.toFixed(3) ?? "-", row?.title ?? ""];
        }),
      ]),
      "",
      `Kendall's tau ${calibration.tau.toFixed(3)} (${calibration.concordant} concordant, ${calibration.discordant} discordant pairs).`,
      calibration.trusted
        ? `TRUSTED: tau >= ${TRUST_TAU} on at least ${TRUST_MIN_TICKETS} tickets.`
        : `NOT TRUSTED: needs tau >= ${TRUST_TAU} on at least ${TRUST_MIN_TICKETS} tickets (have ${calibration.tau.toFixed(3)} on ${calibration.n}).`,
      `Engine: ${stats.tickets} tickets, ${stats.requests} requests; answers from cache ${stats.cachedAnswers}, asked ${stats.askedAnswers}.`,
    ];
    if (!calibration.trusted && calibration.disagreements.length > 0) {
      lines.push("", "Pairs the rubric orders against the hand ranking (hand's choice first):");
      for (const d of calibration.disagreements) lines.push(`  ${d.above} over ${d.below}`);
    }
    io.stdout(`${lines.join("\n")}\n`);
    return code;
  };
}

function explainVerb(deps: VerbDeps): VerbHandler {
  return async (args, io) => {
    const { values, positionals } = parseVerbArgs("explain", args);
    const rubricName = requiredString("explain", values, "rubric");
    if (positionals.length !== 1 || positionals[0] === undefined) {
      throw usageError("explain", "explain takes exactly one issue key, such as octocat/hello-world#1");
    }
    const { source, key } = parseIssueKey(positionals[0]);
    const project = await deps.resolve(deps.cwd(), io.env);
    // The allowlist is checked before the rubric is read or anything
    // leaves the machine.
    assertAllowed(source, project.sources, project.allowlistKey);
    const loaded = loadRubricArg(project.projectRoot, rubricName);
    const tracker = project.tracker(source);
    const engine = project.engine();
    const cache = openCache(project.projectRoot, engine.id, engine.model, deps.now);
    const result = await explainTicket({ rubric: loaded.rubric, tracker, key, engine, cache, now: deps.now });
    const header = {
      rubricPath: loaded.path,
      rubricHash: loaded.hash,
      configPath: project.configPath,
      source: source.spec,
      engine: engine.id,
      model: engine.model,
      backend: project.backend,
    };
    if (values.json === true) {
      const { rubric, ...rest } = result;
      const report = { rubric: rubric.name, ...header, ...rest };
      io.stdout(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    io.stdout(`${renderExplain({ header, result })}\n`);
  };
}

function defaultVerbs(deps: VerbDeps): Record<Verb, VerbHandler> {
  return {
    rank: rankVerb(deps),
    calibrate: calibrateVerb(deps),
    explain: explainVerb(deps),
  };
}

function isVerb(word: string): word is Verb {
  return (VERBS as readonly string[]).includes(word);
}

function dispatch(
  argv: readonly string[],
  io: CliIo,
  verbs: Record<Verb, VerbHandler>,
): ReturnType<VerbHandler> {
  const [first, ...rest] = argv;
  if (first === undefined || first === "--help" || first === "-h") throw new HelpRequest(USAGE);
  if (!isVerb(first)) {
    throw new RefusalError(`unknown verb \`${first}\`; expected one of ${VERBS.join(", ")}\n\n${USAGE}`);
  }
  return verbs[first](rest, io);
}

export async function run(argv: readonly string[], io: CliIo, options: RunOptions = {}): Promise<number> {
  const deps: VerbDeps = {
    resolve: options.resolve ?? loadProject,
    cwd: options.cwd ?? (() => process.cwd()),
    now: options.now ?? (() => new Date()),
  };
  const verbs = { ...defaultVerbs(deps), ...options.verbs };
  try {
    return (await dispatch(argv, io, verbs)) ?? 0;
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
