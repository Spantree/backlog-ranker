/**
 * The verb runner. `run(argv, io)` dispatches a verb, renders help and
 * failures through the injected writers and RETURNS the exit code: no
 * `process.exit`, no process streams and no `process.cwd()` in here, so
 * the whole surface is testable in-process. `bin.ts` is the only place
 * that touches the process.
 *
 * Flags and usage live in `cli/flags.ts`, `--hand` in `cli/hand.ts`,
 * failure rendering in `cli/render-error.ts` and the reports in `table.ts`.
 */

import { calibrateBacklog, explainTicket, rankBacklog } from "./api.js";
import { type AnswerCache, openCache } from "./cache.js";
import { isVerb, parseVerbArgs, USAGE, VERB_USAGE, VERBS, type Verb, type VerbFlags } from "./cli/flags.js";
import { parseHand } from "./cli/hand.js";
import { debugFromEnv, renderError } from "./cli/render-error.js";
import type { Ranking } from "./compose.js";
import type { DecisionEngine } from "./engine.js";
import { HelpRequest, isHelpRequest, RefusalError } from "./errors.js";
import { type LoadOptions, loadProject, type Project } from "./loader.js";
import { type LoadedRubric, loadRubricArg } from "./rubric.js";
import { assertAllowed, parseIssueKey, parseSource, type SourceRef } from "./source.js";
import { type RunHeader, renderCalibrate, renderExplain, renderTable } from "./table.js";
import { MAX_TIEBREAK } from "./tiebreak.js";
import type { Tracker } from "./trackers/tracker.js";

export { DEBUG_HINT, debugFromEnv, renderError } from "./cli/render-error.js";
export { parseHand, parseVerbArgs, VERB_USAGE, VERBS, type Verb };

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
  /** The working directory the project is resolved from. `bin.ts` passes
   * the process's; absent, `"."`, which `node:path` resolves the same way. */
  cwd?: () => string;
  /** The clock that buckets ticket ages. */
  now?: () => Date;
}

/** Exit codes for calibrate: CI fails a rubric edit that loses trust. */
export const EXIT_NOT_TRUSTED = 2;

interface VerbDeps {
  resolve: ProjectResolver;
  cwd: () => string;
  now: () => Date;
}

/** Everything a verb needs once the source is admitted. */
interface Prepared {
  project: Project;
  loaded: LoadedRubric;
  tracker: Tracker;
  engine: DecisionEngine;
  cache: AnswerCache;
  header: RunHeader;
}

/**
 * The pipeline every verb shares: resolve the project, check the
 * allowlist, read the rubric, build the tracker then the engine, open the
 * cache. The allowlist is checked before the rubric is read, the tracker
 * is built, or anything leaves the machine; the tracker comes before the
 * engine so an unsupported source says so instead of reporting a missing
 * engine key.
 */
async function prepare(
  deps: VerbDeps,
  io: CliIo,
  run: { source: SourceRef; rubric: string; load?: LoadOptions },
): Promise<Prepared> {
  const { source } = run;
  const project = await deps.resolve(deps.cwd(), io.env, run.load ?? {});
  assertAllowed(source, project.sources, project.allowlistKey);
  if (run.load?.allowOnce !== undefined) {
    io.stderr(
      `the titles, bodies and labels of open issues in ${source.spec} will be sent to ` +
        `${project.backend} for this run only; nothing is saved to config\n`,
    );
  }
  const loaded = loadRubricArg(project.projectRoot, run.rubric);
  const tracker = project.tracker(source);
  const engine = project.engine();
  const cache = openCache(project.projectRoot, engine.id, engine.model, deps.now);
  const header: RunHeader = {
    rubricPath: loaded.path,
    rubricHash: loaded.hash,
    configPath: project.configPath,
    source: source.spec,
    engine: engine.id,
    model: engine.model,
    backend: project.backend,
  };
  return { project, loaded, tracker, engine, cache, header };
}

function printJson(io: CliIo, report: unknown): void {
  io.stdout(`${JSON.stringify(report, null, 2)}\n`);
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
    const flags: VerbFlags = parseVerbArgs("rank", args);
    flags.noPositionals();
    const rubric = flags.required("rubric");
    const source = parseSource(flags.required("source"));
    const weights = flags.weights();
    const top = flags.boundedInt("tiebreak", MAX_TIEBREAK);
    const concurrency = flags.boundedInt("concurrency", Number.MAX_SAFE_INTEGER);
    const load = flags.allowOnce(source);
    const p = await prepare(deps, io, { source, rubric, load });
    const result = await rankBacklog({
      rubric: p.loaded.rubric,
      tracker: p.tracker,
      engine: p.engine,
      cache: p.cache,
      now: deps.now,
      ...(weights === undefined ? {} : { weights }),
      ...(top === undefined ? {} : { tiebreak: top }),
      ...(concurrency === undefined ? {} : { concurrency }),
    });
    if (flags.json) {
      printJson(io, {
        rubric: result.rubric.name,
        ...p.header,
        stats: result.stats,
        tiebreak: result.tiebreak,
        ...rankJson(result.ranking),
      });
      return;
    }
    const table = renderTable({
      rubric: result.rubric,
      header: p.header,
      ranking: result.ranking,
      stats: result.stats,
      ...(result.tiebreak === undefined ? {} : { tiebreak: result.tiebreak }),
    });
    io.stdout(`${table}\n`);
  };
}

function calibrateVerb(deps: VerbDeps): VerbHandler {
  return async (args, io) => {
    const flags = parseVerbArgs("calibrate", args);
    flags.noPositionals();
    const rubric = flags.required("rubric");
    const source = parseSource(flags.required("source"));
    const hand = parseHand(flags.required("hand"), source);
    const weights = flags.weights();
    const p = await prepare(deps, io, { source, rubric });
    const result = await calibrateBacklog({
      rubric: p.loaded.rubric,
      tracker: p.tracker,
      engine: p.engine,
      cache: p.cache,
      hand,
      now: deps.now,
      ...(weights === undefined ? {} : { weights }),
    });
    const code = result.calibration.trusted ? 0 : EXIT_NOT_TRUSTED;
    if (flags.json) {
      const { tool, stats, calibration } = result;
      printJson(io, { rubric: result.rubric.name, ...p.header, hand, tool, stats, ...calibration });
    } else {
      io.stdout(`${renderCalibrate({ header: p.header, hand, result })}\n`);
    }
    return code;
  };
}

function explainVerb(deps: VerbDeps): VerbHandler {
  return async (args, io) => {
    const flags = parseVerbArgs("explain", args);
    const rubric = flags.required("rubric");
    const [keyArg, ...extra] = flags.positionals;
    if (keyArg === undefined || extra.length > 0) {
      throw flags.error("explain takes exactly one issue key, such as octocat/hello-world#1");
    }
    const { source, key } = parseIssueKey(keyArg);
    const p = await prepare(deps, io, { source, rubric });
    const result = await explainTicket({
      rubric: p.loaded.rubric,
      tracker: p.tracker,
      key,
      engine: p.engine,
      cache: p.cache,
      now: deps.now,
    });
    if (flags.json) {
      const { rubric: applied, ...rest } = result;
      printJson(io, { rubric: applied.name, ...p.header, ...rest });
      return;
    }
    io.stdout(`${renderExplain({ header: p.header, result })}\n`);
  };
}

function defaultVerbs(deps: VerbDeps): Record<Verb, VerbHandler> {
  return {
    rank: rankVerb(deps),
    calibrate: calibrateVerb(deps),
    explain: explainVerb(deps),
  };
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
    cwd: options.cwd ?? (() => "."),
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
  io.stderr(`${renderError(err, { debug: debugFromEnv(io.env.BACKLOG_RANKER_DEBUG) })}\n`);
  return 1;
}
