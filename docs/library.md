# Library

Everything the CLI does is exported from the package root, with type declarations. The package is ESM and runs on Node 22 or later and on Bun.

```ts
import { rankBacklog } from "@feniix/backlog-ranker";
```

## The project path: loadProject

`loadProject(cwd, env, options?)` is the path the CLI takes. It finds the project root, reads `.backlog-ranker/config.yaml` (or `config.local.yaml`), and returns the allowlist with an engine and a tracker that are built only when you ask for them. `tracker(source)` checks the source against the allowlist itself and refuses an unlisted one before reading a token or building anything. The CLI also calls `assertAllowed` first, so an unlisted source is refused before the rubric is read; do the same if your code reads anything before building the tracker.

```ts
import { assertAllowed, loadProject, loadRubric, openCache, parseSource, rankBacklog } from "@feniix/backlog-ranker";

const project = loadProject(process.cwd(), process.env);
const source = parseSource("github:acme/app");
assertAllowed(source, project.sources, project.allowlistKey);

const { rubric } = loadRubric(project.projectRoot, "impact-roi");
const tracker = project.tracker(source);
const engine = project.engine();
const cache = openCache(project.projectRoot, engine.id, engine.model);

const result = await rankBacklog({ rubric, tracker, engine, cache, tiebreak: 5 });
for (const [i, row] of result.ranking.ranked.entries()) {
  console.log(i + 1, row.key, row.composite.toFixed(3), row.pinnedBy, row.lowConfidence);
}
console.log("held:", result.ranking.held.map((row) => row.key));
console.log(result.stats.requests, "requests,", result.stats.cachedAnswers, "answers from cache");
```

`Project` carries `projectRoot`, `configPath`, `config`, `sources`, `unreviewedSources` (the canonical specs a `config.local.yaml` lists that the committed `config.yaml` does not; the CLI prints a notice when it uses one, the library prints nothing), `allowlistKey`, `backend`, `engine()` and `tracker(source)`. `engine()` refuses when the backend's key variable is unset. `assertAllowed` and `tracker()` decide on what the tracker will read: the ref's `owner` and `repo` (or `team`), canonicalised by `sourceSpec(ref)` and matched case-insensitively, never the ref's own `spec` string. `tracker()` refuses, in order, a source not on the allowlist (with the same wording as `assertAllowed`) and an unset key variable for the source's tracker (`keys.github` for a `github:` source, `keys.linear` for a `linear:` one); a Linear tracker gets the config's `linear.states`. `LoadOptions` takes `allowOnce` (a `SourceRef` admitted for this project object only), `backend` and `fetch` (a replacement for the global fetch, used by tests).

## Building the pieces yourself

`createJevEngine`, `githubTracker` and `linearTracker` take their keys directly. This path has no config file and so no allowlist: deciding which repositories or teams may be sent to the provider is up to your code.

```ts
import { createJevEngine, githubTracker, openCache, rankBacklog } from "@feniix/backlog-ranker";

const engine = createJevEngine({
  backend: "openrouter",
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
  model: "jev-1.14",
});
const tracker = githubTracker({ owner: "acme", repo: "app", token: process.env.GITHUB_TOKEN ?? "" });
const cache = openCache(process.cwd(), engine.id, engine.model);

const { ranking } = await rankBacklog({
  rubric: "rubrics/impact-roi.yaml",
  tracker,
  engine,
  cache,
  weights: { impact: 2 },
});
console.log(ranking.ranked.map((row) => row.key));
```

`createJevEngine(options)`: `backend` (`"typesafe"` or `"openrouter"`), `apiKey`, and optionally `apiKeyVar` (the variable named when the backend refuses the key, default the backend's entry in `DEFAULT_KEY_VARS`), `model` (default `jev-1.14`; an unknown version refuses), `fetch`, `retry` (the SDK's retry policy, partially overridden; by default 408, 429 and 5xx are retried twice with backoff) and `timeoutMs` (per attempt, default 60000).

`githubTracker(options)`: `owner`, `repo`, `token`, and optionally `fetch` and `tokenEnvVar` (named in auth refusals, default `GITHUB_TOKEN`).

`linearTracker(options)`: `team` (the team key, as in `ENG-123`), `apiKey` (a personal API key, sent without a `Bearer` prefix), and optionally `apiKeyVar` (named in auth refusals, default `LINEAR_API_KEY`), `states` (workflow state names or types to rank, case-insensitive; default `DEFAULT_LINEAR_STATES`, `["backlog", "unstarted"]`), `fetch` and `timeoutMs` (per request, default 30000). `pending()` reads the team's workflow states, refuses a `states` entry that matches none of them (listing the team's states) or an empty list, then pages through the issues in the matched states. `issues(keys)` takes `TEAM-123` keys of its own team, in any state, and refuses another team's keys before any request. Every reply is checked against a schema; one of an unexpected shape refuses naming the field path. Failures are `LinearTrackerError`s.

```ts
import { linearTracker } from "@feniix/backlog-ranker";

const tracker = linearTracker({ team: "ENG", apiKey: process.env.LINEAR_API_KEY ?? "", states: ["Todo"] });
```

`trackerFor(source, options)` builds the tracker for a parsed `SourceRef`: `token` (the GitHub token or Linear API key), and optionally `tokenEnvVar`, `linearStates` and `fetch`.

`openCache(projectRoot, engineId, model, now?)` opens `<projectRoot>/.backlog-ranker/cache/<engine>--<model>.json`. The facades flush it before they return or throw.

## rankBacklog

Takes `rubric` (a parsed `Rubric` or a YAML file path; a relative path resolves against the working directory, and a missing file refuses with a `RubricError`, "no rubric file <path>"), exactly one of `tickets` and `tracker`, `engine`, `cache`, and optionally `now` (the clock that buckets ages), `weights`, `concurrency` (a whole number of at least 1, default 8) and `tiebreak` (1 to 10). Returns `rubric` (as applied, overrides included), `ranking` (`ranked` rows, pinned then normal then sunk, and `held` rows), `states` (each issue's state as sent, by key), `stats`, and `tiebreak` stats when asked.

Each row (`RankedRow`) carries `key`, `title`, `url`, `composite`, `answers`, `facts` (the numeric facts fact gates read, by rubric name), `pinnedBy`, `heldBy` (`flag_if_below` gates and `hold` fact gates), `sunkBy` (`sink` fact gates, on rows neither pinned nor held), `lowConfidence` and `truncated`. Fact gates never send a request and never change a cache key; see [rubrics.md](rubrics.md#fact-gates) for their precedence over pins and holds.

## calibrateBacklog

Takes the same options as `rankBacklog` without `tiebreak`, plus `hand`: issue keys best first (`acme/app#12`, `ENG-12`), in any case: each is matched to the issue read for it case-insensitively and counted under the tracker's spelling, so `ACME/app#12` counts as `acme/app#12`, and two spellings of one key are refused as a repeat. With a tracker it reads only those issues. A hand key that no ticket answers (the tracker returned no issue for it, or `tickets` holds none) is refused by name before any engine request, rather than dropped from tau's `n`; the GitHub and Linear trackers already refuse an issue that does not exist.

```ts
import { calibrateBacklog, type DecisionEngine, type AnswerCache, type Tracker } from "@feniix/backlog-ranker";

declare const engine: DecisionEngine;
declare const cache: AnswerCache;
declare const tracker: Tracker;

const { calibration, tool } = await calibrateBacklog({
  rubric: ".backlog-ranker/rubrics/impact-roi.yaml",
  tracker,
  engine,
  cache,
  hand: ["acme/app#12", "acme/app#7", "acme/app#31"],
});
console.log(calibration.tau, calibration.trusted, tool);
for (const { above, below } of calibration.disagreements) console.log(`${above} over ${below}`);
```

`calibration` is `{ n, concordant, discordant, tau, trusted, disagreements }`; `trusted` means `tau >= TRUST_TAU` (0.4) on at least `TRUST_MIN_TICKETS` (12) issues. The result also carries `tool` (the tool's order of the same keys, held issues last), `scored`, `ranking` and `stats`.

## explainTicket

Takes the options every facade shares (`DecisionRunOptions`: `rubric`, `engine`, `cache` and optionally `now`) and either `ticket` or both `tracker` and `key`. Returns the composite, per-criterion `score`, `confidence`, `lowConfidence` and per-level `probability`, per-gate `probability`, `threshold`, `triggered` (the answer crossed the threshold) and `outcome` (`pinned`, `held`, `none`, `overridden by hold` or `overridden by pin`), `facts` (the age bucket and every numeric fact, including those only fact gates read), per-fact-gate `fact`, `action`, `atLeast`, `value`, `fired` and `outcome` (`held`, `sunk`, `none`, `overridden by hold` or `overridden by pin`: a fired gate that [precedence](rubrics.md#precedence) overrode), `flags` (`pinnedBy`, `heldBy`, `sunkBy`, `lowConfidence`, and `truncated`, when the body was cut to fit the prompt) and `stats`. A rubric can be built in memory with `rubricSchema.parse` (or `parseRubric(yamlText, origin)`), which applies the defaults:

```ts
import { explainTicket, rubricSchema, type AnswerCache, type DecisionEngine, type Ticket } from "@feniix/backlog-ranker";

declare const engine: DecisionEngine;
declare const cache: AnswerCache;

const rubric = rubricSchema.parse({
  name: "impact-roi",
  compose: "roi",
  criteria: [
    { id: "impact", direction: "benefit", question: "How much does this help users?", levels: ["None", "Some", "A lot"] },
    { id: "effort", direction: "cost", question: "How much work is it?", levels: ["An hour", "A day", "A week"] },
  ],
});

const ticket: Ticket = {
  key: "acme/app#42",
  title: "Export fails on large projects",
  body: "Exporting a project with more than 500 files times out. Done when it finishes.",
  labels: ["bug"],
  url: "https://github.com/acme/app/issues/42",
  createdAt: "2026-09-01T00:00:00Z",
  reactions: 3,
  linkedIssues: 0,
  duplicates: 1,
};

const explained = await explainTicket({ rubric, ticket, engine, cache });
for (const c of explained.criteria) console.log(c.id, c.score.toFixed(2), c.levels.map((l) => l.probability));
```

## Custom trackers

A tracker is any object that satisfies `Tracker`:

```ts
import type { Ticket, Tracker } from "@feniix/backlog-ranker";

declare function loadFromMyTracker(): Promise<Ticket[]>;

export const myTracker: Tracker = {
  source: "mytracker:team",
  async pending() {
    return loadFromMyTracker();
  },
  async issues(keys) {
    const all = await loadFromMyTracker();
    return keys.map((key) => {
      const found = all.find((t) => t.key === key);
      if (found === undefined) throw new Error(`no issue ${key}`);
      return found;
    });
  },
};
```

`pending()` returns every issue to rank; `issues(keys)` returns the named ones, for calibrate and explain. Compute `reactions`, `linkedIssues` and `duplicates` in code: they are sent as facts. `openBlockers`, `openClosingPrs` and `assignees` are optional and are read only by fact gates, never sent to the model; a tracker that leaves them out has them counted as 0, so a fact gate on them never fires. Only `title`, `body` and `labels` are sent as text. The allowlist and `loadProject` know only `github:` and `linear:` sources, so a custom tracker is used through the facades directly.

## Custom engines

A decision engine is any object that satisfies `DecisionEngine`: an `id` and a pinned `model` (both part of every cache key) and `decide(state, questions)`, which answers every question about one state in one call. Questions are `score` (ordered `levels`), `noul` (yes/no) or `choice` (named `options`, used by the tie-break). This one answers without a model, which is useful in tests:

```ts
import type { DecisionAnswer, DecisionEngine } from "@feniix/backlog-ranker";

export const middleEngine: DecisionEngine = {
  id: "fixed",
  model: "fixed-1",
  async decide(_state, questions) {
    const answers: Record<string, DecisionAnswer> = {};
    for (const [id, q] of Object.entries(questions)) {
      if (q.kind === "score") {
        const n = q.levels.length;
        answers[id] = {
          kind: "score",
          value: (n - 1) / 2,
          probabilities: q.levels.map(() => 1 / n),
          confidence: 1,
        };
      } else if (q.kind === "noul") {
        answers[id] = { kind: "noul", probability: 0.5 };
      } else {
        const p = 1 / q.options.length;
        answers[id] = {
          kind: "choice",
          choice: q.options[0]?.name ?? "",
          probabilities: Object.fromEntries(q.options.map((o) => [o.name, p])),
          confidence: p,
        };
      }
    }
    return { servedModel: "fixed-1", answers };
  },
};
```

## Errors and guards

Every error the tool expects you to fix is a `RefusalError`: a usage or config problem, an unlisted source, an unset key, a failed request. Subclasses name the area: `ConfigError`, `LoaderError`, `RubricError`, `SourceError`, `GitHubTrackerError`, `LinearTrackerError`, `JevError` (with the HTTP `status` when there was one) and `PromptBudgetError`. Their messages never contain a key, a token or issue text. A failed decision is prefixed with the issue key it was about (`KIT-12: the openrouter backend answered HTTP 503`), or with both keys for a tie-break pair.

Use `isRefusal(err)` rather than `instanceof`: it checks a registry symbol, so it recognises refusals from another copy of the package (a symlinked or duplicated install). `isHelpRequest(err)` does the same for the `HelpRequest` a `--help` throws.

```ts
import { isRefusal, rankBacklog, type RankOptions } from "@feniix/backlog-ranker";

declare const options: RankOptions;

try {
  await rankBacklog(options);
} catch (err) {
  if (isRefusal(err)) console.error((err as Error).message);
  else throw err;
}
```

`run(argv, io, options?)` runs the CLI in-process and returns the exit code; `io` supplies `stdout`, `stderr` and `env`.

## Building blocks

Also exported: `parseRubric`, `loadRubric`, `loadRubricFile`, `withWeights`, `rubricHash`; `scoreTickets`, `pool`; `rank`, `compositeOf`, `rubricQuestions`; `FACT_NAMES`, `ticketFacts`; `tiebreak`, `MAX_TIEBREAK`; `kendallTau`; `toState`, `stateHash`, `canonicalJson` and the prompt budget helpers; `parseSource`, `parseIssueKey` (`owner/repo#123` or `TEAM-123`), `issueKeyIn`, `sourceSpec`, `assertAllowed`; `loadConfig`, `parseConfig`, `configSchema`, `findProjectRoot`; `BACKENDS`, `JEV_MODELS`, `DEFAULT_JEV_MODEL`; `renderTable`, `renderExplain`.
