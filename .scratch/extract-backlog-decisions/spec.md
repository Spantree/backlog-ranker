# Spec: extract the backlog ranker from evie-kit as `backlog-decisions`

Status: resolved
Type: enhancement
Created: 2026-10-15

## Problem Statement

A team with a GitHub backlog has no reliable way to order it by the criteria they actually care about. Manual triage does not scale past a few dozen issues and drifts between people. Existing AI prioritizers either hard-code RICE-style signals, return prose with no notion of certainty, or write labels back without asking. The rubric ranker inside evie-kit solves this, but it lives in a monorepo, reads evie-kit's layered settings, talks to Linear only, and cannot be installed or imported on its own.

## Solution

`backlog-decisions` is a standalone npm package, usable as a CLI and as a library, that ranks a GitHub repository's open issues by a committed YAML rubric. A decision model (TypeSafe's Jev) answers narrow Score and yes/no questions about one ticket at a time; code does the weighting, ROI arithmetic, pinning, holding, caching, tie-breaking and calibration. The tool is read-only toward GitHub, refuses to send ticket text anywhere not listed in a committed allowlist, caches every answer so re-weighting costs nothing, and will not call a rubric trusted until it agrees with the user's own hand ranking at Kendall's tau of at least 0.4 on 12 or more tickets. A rubric is built conversationally with the bundled agent skill.

## User Stories

1. As a maintainer, I want to rank my repository's open issues by a rubric I wrote, so that I work on what matters most first.
2. As a maintainer, I want each criterion to be a question with concrete ordered levels, so that the model reads situations rather than adjectives.
3. As a maintainer, I want impact and effort asked separately and divided in code, so that the model never guesses a ratio.
4. As a maintainer, I want to choose between weighted-sum and ROI composition, so that the rubric matches how I think about value.
5. As a maintainer, I want to change a criterion's weight on the command line, so that I can explore orderings without new requests.
6. As a maintainer, I want a pin-top gate, so that a security leak jumps the queue whatever its ROI.
7. As a maintainer, I want a flag-if-below gate, so that thin tickets are held for a human instead of landing mid-ranking.
8. As a maintainer, I want a confidence floor, so that a low-confidence score is marked rather than silently trusted.
9. As a maintainer, I want to see each criterion's score and confidence per row, so that the breakdown is the explanation.
10. As a maintainer, I want each gate's probability shown beside its threshold, so that I can see how close a pin or hold was.
11. As a maintainer, I want flags per row (pinned, held, low-confidence, truncated), so that I know which rows need a human.
12. As a maintainer, I want a `--json` output with the same data, so that I can pipe the ranking into other tools.
13. As a maintainer, I want the run header to name the rubric file, its content hash, the source, engine, model and backend, so that a saved ranking records what produced it.
14. As a maintainer, I want a pairwise tie-break over the top N, so that near-ties at the top are settled by direct comparison.
15. As a maintainer, I want the tie-break to ask each pair in both orders, so that option-order bias cancels.
16. As a maintainer, I want pinned rows to stay above unpinned ones through the tie-break, so that a pin always holds.
17. As a maintainer, I want to hand-rank a dozen tickets and get Kendall's tau against the tool's order, so that I know whether to trust the rubric.
18. As a maintainer, I want calibrate to list the pairs the rubric orders against me, so that I know which level wording to fix.
19. As a maintainer, I want calibrate to exit non-zero when the rubric is not trusted, so that CI can block a rubric edit that degrades agreement.
20. As a maintainer, I want to explain one ticket's ranking, so that I can see its per-level probabilities and gate margins without re-running the whole backlog.
21. As a maintainer, I want explain to answer from the cache when it can, so that it costs nothing after a rank.
22. As a maintainer, I want only sources on a committed allowlist to be ranked, so that sending ticket text to a provider is a reviewed decision.
23. As a maintainer, I want the allowlist checked before any request or rubric read, so that a refused source leaks nothing.
24. As a maintainer, I want the refusal to name the config key and the listed sources, so that I know how to fix it.
25. As a maintainer, I want the backend and model declared in committed config, so that which provider receives ticket text is reviewed.
26. As a maintainer, I want API keys referenced by environment variable name in config, so that no secret is ever committed.
27. As a maintainer, I want sensible default variable names for every key, so that config stays minimal.
28. As a maintainer, I want a missing config file to refuse with a minimal example, so that first use is self-explanatory.
29. As a maintainer, I want a gitignored local config and local rubric that replace the committed ones, so that I can experiment without committing.
30. As a maintainer, I want the run to say which file it read, so that a local override is never silent.
31. As a maintainer, I want the project root found by walking up to the config directory or the git root, so that the verbs work from any subdirectory.
32. As a maintainer, I want only an issue's title, body and labels to leave GitHub, so that comments and linked text stay private.
33. As a maintainer, I want facts like age, reactions, linked issues and duplicates computed by code, so that the model never counts.
34. As a maintainer, I want age bucketed rather than counted in days, so that cached answers do not expire daily.
35. As a maintainer, I want oversized bodies cut to the model's prompt budget and marked, so that a long issue never fails the run.
36. As a maintainer, I want pending to mean open issues with pull requests excluded, so that the ranking is a backlog.
37. As a maintainer, I want pagination handled, so that large repositories rank completely.
38. As a maintainer, I want issue keys as `owner/repo#123`, so that rows are unambiguous across repositories.
39. As a maintainer, I want calibrate to refuse keys from another repository, so that a typo cannot mix backlogs.
40. As a maintainer, I want every answer cached by state hash, question hash, engine and model, so that re-weighting is free and a reworded level re-asks only itself.
41. As a maintainer, I want answers from different model versions kept in separate cache files, so that they never mix.
42. As a maintainer, I want the cache to merge on write, so that two concurrent runs do not lose each other's answers.
43. As a maintainer, I want the model version pinned and any other served version refused, so that a tau measured on one version stays valid.
44. As a maintainer, I want to choose TypeSafe direct or OpenRouter, so that I can use whichever account I have.
45. As a maintainer, I want request errors to name the backend and status but never the key or ticket text, so that logs stay safe.
46. As a maintainer, I want rate-limit and overload responses retried with backoff, so that transient failures do not abort a run.
47. As a maintainer, I want a concurrency bound on requests, so that a big backlog does not hammer the provider.
48. As a maintainer, I want the first failure to stop new requests and settle in-flight ones before the error surfaces, so that the cache is flushed cleanly.
49. As a maintainer, I want refusals printed message-first without a stack trace, so that the fix is the first thing I read.
50. As a maintainer, I want a debug environment variable that restores stack traces, so that I can diagnose a crash.
51. As a maintainer, I want `--help` on every verb, so that usage is discoverable.
52. As a maintainer, I want short flag aliases, so that frequent runs are quick to type.
53. As a maintainer, I want unknown flags and stray arguments refused by name, so that a typo never silently changes a run.
54. As a newcomer, I want to try the tool on a public repository with one command and a one-run allow flag, so that I can evaluate it before adding config.
55. As a newcomer, I want that one-run flag to print what leaves the machine, so that the trade is explicit.
56. As a newcomer, I want that flag never to touch config, so that a trial cannot become policy by accident.
57. As a newcomer, I want a short README with install, quickstart, one example and links, so that I can start in a minute.
58. As a newcomer, I want deeper docs on rubrics, config, the CLI and the library in a docs folder, so that the README stays short.
59. As a newcomer, I want docs that explain how to mint a GitHub token with the gh CLI, so that auth is not a research project.
60. As a developer, I want to import a facade that ranks tickets given a rubric, engine, tracker and cache, so that I can embed ranking in my own tool.
61. As a developer, I want a calibrate facade returning tau, the trust verdict and disagreements, so that I can build my own calibration flow.
62. As a developer, I want the building blocks exported (rubric parsing, scoring, composition, tie-break, tau, cache), so that I can compose them differently.
63. As a developer, I want the tracker and engine interfaces exported, so that I can plug in another tracker or decision model.
64. As a developer, I want the error classes and guards exported, so that I can distinguish refusals from crashes.
65. As a developer, I want a loader that reads the project's config directory and enforces the allowlist, so that the CLI and my code share one policy path.
66. As a developer, I want the facade to accept an in-memory rubric object, so that I need not touch the filesystem.
67. As a developer, I want the library to run on Node 22 as well as Bun, so that it fits an ordinary Node project.
68. As a developer, I want type declarations shipped, so that the API is typed in my editor.
69. As a developer, I want the package to have no build step for consumers, so that `npm install` is enough.
70. As a contributor, I want the test suite to run with no network, so that tests are deterministic and free.
71. As a contributor, I want recorded Jev answers replayed by state hash, so that a changed state fails loudly instead of returning stale answers.
72. As a contributor, I want a capture script to re-record fixtures after editing the fixture rubric, so that fixtures stay honest.
73. As a contributor, I want typecheck, lint and tests behind single scripts, so that the gate is one command.
74. As a contributor, I want the Bun version pinned, so that the toolchain is reproducible.
75. As a contributor, I want an AGENTS.md with the invariants and commands, so that a coding agent works safely in the repo.
76. As a contributor, I want a ROADMAP.md naming deferred work, so that scope creep has somewhere to go.
77. As an agent user, I want a skill that builds a rubric one question at a time, so that levels come out concrete.
78. As an agent user, I want the skill to insist on a hand ranking before showing tool output, so that calibration is not contaminated.
79. As an agent user, I want the skill never to add a source to the allowlist on its own, so that the policy decision stays mine.
80. As an agent user, I want the skill never to write to GitHub, so that ranking never becomes labeling.

## Implementation Decisions

### Package and runtime

- One npm package named `backlog-decisions`, bin of the same name, verbs `rank`, `calibrate`, `explain`. No workspaces.
- Runs on Node 22 and later and on Bun. TypeScript compiled by tsc to ESM with declarations; `exports` and `bin` point at the compiled output. Development on Bun pinned to 1.4.3, tests on `bun:test`, biome for lint and format. No CI workflow in this iteration.
- Runtime dependencies: the official TypeSafe JavaScript SDK, octokit's GraphQL client, the `yaml` package, zod. Flag parsing uses Node's built-in `parseArgs`.
- Calver versioning starting at 2026.10.15. MIT, copyright Sebastian Otaegui. Public npm ready; publishing manual.
- Fork of evie-kit's backlog and typesafe packages (sibling checkout at `../evie-kit`). Fresh history, one import commit, no remote.

### Module layout

- An errors module with the refusal brand and the help-request brand, both registry symbols with property-based guards, so copies of the package across a symlink chain still recognise each other.
- An engine-neutral decision interface (score, choice, noul questions; typed answers; a decide call per state). Nothing in rubric, composition or cache code names a vendor.
- A Jev engine adapter over the SDK: backend table (TypeSafe direct, OpenRouter) selected by base URL and spelled model id; pinned-version check that refuses any served version other than the pinned one plus a dated snapshot suffix; validation that score and choice distributions carry exactly the requested keys and sum to one within rounding. No custom base URL in this iteration.
- A GitHub tracker over octokit GraphQL: paginated open issues excluding pull requests; ticket shape is key, title, body, labels, url, createdAt, reactions, linkedIssues, duplicates. Reactions from the total count; linked issues from cross-referenced and connected timeline items plus sub-issues and parent; duplicates from marked-as-duplicate timeline items. Issue lookup by number for calibrate and explain, refusing keys whose repository differs from the source. Token read from the environment variable named in config, default `GITHUB_TOKEN`.
- Source grammar keeps `github:owner/repo` and `linear:TEAM`; Linear parses and refuses as a planned adapter.
- State building unchanged: title, sorted labels, body, facts (age bucket, reactions, linked_issues, duplicates); 30,000-byte prompt budget shared with the longest question; bodies clipped on character boundaries and marked; canonical JSON and SHA-256 state hash.
- Cache unchanged in semantics: one JSON file per engine and model under the project's cache directory, entries keyed by state hash and question hash, merge-on-flush with atomic rename, schema-tagged.
- Rubric schema unchanged: name, description, compose (weighted_sum or roi), confidence_floor, criteria (id, question, 2 to 10 levels, weight, direction), gates (id, question, pin_top or flag_if_below, threshold), optional tiebreak_question. Parsed with the `yaml` package. Local file replaces committed file outright. A short content hash of the rubric text is computed on load.
- Composition, scoring pool, tie-break and Kendall's tau unchanged in behaviour.
- Table renderer: gate cells render as probability, comparison sign and threshold; header gains the rubric hash.

### Config and loader

- Directory `.backlog-decisions/` at the project root with `config.yaml`, `rubrics/`, `cache/`. Project root is the nearest ancestor holding that directory or `.git`.
- Config schema: `sources` (allowlist, same grammar as `--source`), `backend` (typesafe or openrouter), `model` (a pinned Jev version), `keys` (optional map of service to environment variable name; defaults `GITHUB_TOKEN`, `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`). Strict, no unknown keys. `config.local.yaml` replaces it outright.
- Missing config refuses with the expected path and a minimal example. Unset key variable refuses naming the variable and, for GitHub, the gh commands that mint a token.
- The loader resolves config, checks the allowlist before reading a rubric or building anything, and builds engine and tracker lazily. The allowlist applies only on this path.

### Library API

- A rank facade taking rubric (object or path), engine, tracker, cache, clock, optional weight overrides, tie-break depth and concurrency; returning ranking, states, scoring stats and tie-break stats.
- A calibrate facade taking the same plus a hand ranking; returning the Kendall calibration and the tool order.
- An explain facade taking one ticket; returning composite, per-criterion score, confidence and level probabilities, per-gate probability and threshold, flags and truncation.
- Building blocks, interfaces, error classes and the loader exported from the package root.

### CLI

- `rank --rubric <name> --source <spec> [--weight id=n]… [--tiebreak n] [--concurrency n] [--json] [--allow-once [--backend name]]`.
- `calibrate --rubric <name> --source <spec> --hand KEY,KEY,… [--weight]… [--json]`; exits 2 when not trusted.
- `explain --rubric <name> <owner/repo#123> [--json]`; source derived from the key.
- Short aliases `-r -s -w -t -j`. `--help` throws a help request printed on stdout with exit 0. Refusals print message-first on stderr, exit 1; stack frames only under `BACKLOG_DECISIONS_DEBUG`.
- `--allow-once` admits the given source for one run, prints a one-line notice of what leaves the machine, is never persisted, and with `--backend` works without a config file (keys still from environment defaults).

### Shipped content

- Example rubric `impact-roi` with generic wording, no evie-kit references and no calibration claims.
- Skill `backlog-decisions` rewritten for the new verbs, same invariants: concrete levels, hand ranking before tool output, never alter the allowlist, never write to GitHub.
- Docs: short README (one paragraph, install, public-repo quickstart, one rank example, links); `docs/` pages for rubrics, config, CLI and library; ROADMAP.md listing the Linear adapter, linked-PR and blocked-by-parent facts, and a GitHub Action recipe; AGENTS.md extended with invariants and commands.

## Testing Decisions

A good test exercises external behaviour through the highest seam and asserts on outputs, request counts and exit conditions, never on internal calls.

### Primary seam

The CLI verb runner with an injected resolver. The resolver's engine and tracker run over a fake network that replays a GitHub-shaped issue page and the recorded Jev answers keyed by state hash, counting requests per destination. Prior art is evie-kit's backlog CLI test suite, ported with the Linear fixture page reshaped into a GitHub page carrying identical titles, bodies, labels and facts, so every recorded Jev answer still matches.

Tests at this seam prove: a ranked table with no live network; re-weighting asks nothing; an unlisted source refuses with zero requests and no cache written; the allowlist runs before the rubric is read; case-insensitive source matching; `--json` shape; tie-break reordering from recorded pairwise answers; usage errors and help are refusals and help requests; calibrate reports tau, names engine and model, refuses duplicate or short hand lists, and exits 2 when not trusted; explain answers from cache after a rank and sends one request cold; `--allow-once` admits a source with a notice and persists nothing; the rubric hash appears in header and JSON; gate cells show threshold.

### Facade

Exercised through the same fixtures without argv, asserting the returned ranking and stats equal what the CLI prints.

### Unit suites ported as-is

Composition (ROI and weighted sum, pins over holds, confidence floor), state (age buckets, byte fitting, surrogate safety, prompt budget refusal), cache (schema and model isolation, merge on flush), Kendall's tau, rubric parsing and weight overrides, flag parsing (adapted to parseArgs), tracker pagination and error wording (adapted from the Linear suite to GitHub), Jev adapter validation against recorded responses from both backends with the SDK transport mocked.

### Loader

Temp project directories with and without config, local override wins, unset key variable refuses, project root walk.

No test calls a live endpoint. Bun's test runner, temp directories for every filesystem test.

## Out of Scope

- The Linear adapter (deferred; the source spelling parses and refuses).
- Linked-pull-request and blocked-by-parent facts (change the state shape; next change after import).
- Custom or self-hosted Jev-compatible backends.
- A GitHub Action recipe, an `init` verb, a web dashboard.
- Writing anything back to GitHub.
- Moving evie-kit onto this package.
- CI workflow and npm publish automation.
- Confidence intervals on tau.

## Further Notes

- Prior art reviewed: jeff (YAML rank spec, no tracker or cache), hush (Jev issue labeling with abstention, benchmark of 800 issues), treliq (fixed-signal LLM triage with write-back), jev-triage, jev-orderby-bench (Score ordering can fail on human-graded relevance; batching changes results). The design's one-ticket-per-request, both-orders tie-break and calibration gate are the guards that study argues for.
- The recorded Jev fixtures are reusable only because the state hash excludes the ticket key; the GitHub fixture page must carry exactly the same title, body, labels and facts as the Linear one.
- The SDK's exact API surface will be verified at install time; if it differs from the docs, the adapter absorbs the difference.
- Source material: `../evie-kit/packages/backlog`, `../evie-kit/packages/typesafe`, `../evie-kit/packages/core/src/utils/errors.ts`, `../evie-kit/packages/cli/src/backlog.ts`, `../evie-kit/skills/backlog/SKILL.md`, `../evie-kit/.evie-kit/backlog/impact-roi.yaml`.

## Comments

- 2026-10-15, implementation: tickets 01 to 09 merged on branch `extract-backlog-decisions`, then a two-axis code review (standards and spec) and one fix pass covering all 15 findings. Final gates: typecheck, lint with 0 warnings, 194 tests, build, `npm pack` of 122 files with no tests or fixtures, and the built bin checked under Node 22.23.3. Decisions made during review: `--backend` is refused when a config file exists; the loader's tracker also enforces the allowlist; every verb accepts a rubric path; `explain` makes one GitHub lookup and reads decision-model answers from the cache; refusals print their message only.
