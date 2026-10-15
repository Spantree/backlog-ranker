# AGENTS.md

`backlog-decisions` ranks a GitHub repository's open issues by a YAML rubric. A decision model (TypeSafe's Jev) answers narrow questions about one issue at a time; code does the weighting, gates, caching, tie-break and calibration. It ships as one npm package with a CLI (`rank`, `calibrate`, `explain`) and a library.

## Layout

- `src/cli.ts`: the verb runner, flags and usage text; `src/bin.ts` is the only file that touches the process.
- `src/api.ts`: the library facades `rankBacklog`, `calibrateBacklog`, `explainTicket`. `src/index.ts` is the package's public surface.
- `src/config.ts`, `src/loader.ts`: `.backlog-decisions/config.yaml`, the project root walk, and the lazily built engine and tracker.
- `src/source.ts`: source grammar and the allowlist check. `src/errors.ts`: the refusal and help-request brands.
- `src/rubric.ts`, `src/state.ts`, `src/score.ts`, `src/compose.ts`, `src/tiebreak.ts`, `src/kendall.ts`, `src/cache.ts`, `src/table.ts`: rubric parsing, state building, scoring, composition, tie-break, tau, the answer cache and rendering.
- `src/engine.ts`: the engine-neutral decision interface. `src/jev/`: the Jev adapter over `@typesafe-ai/sdk` and the backend table.
- `src/trackers/`: the `Tracker` interface and the GitHub adapter.
- `src/fixtures/`: the fixture rubric, the GitHub issue page, recorded Jev responses (`jev/<hash16>.json`) and `replay.ts`, the offline fetch the suite runs on.
- `rubrics/impact-roi.yaml`: the shipped example rubric. `skills/backlog-decisions/SKILL.md`: the shipped agent skill.
- `scripts/capture-fixtures.ts`: re-records the Jev fixtures. `docs/`: user docs. `.scratch/`: local issues and specs, never shipped.

## Commands

Run everything through mise so the pinned Bun (1.4.3) and Node are used.

```bash
mise exec -- bun install
mise exec -- bun run typecheck   # src and scripts/
mise exec -- bun run lint        # biome
mise exec -- bun test
mise exec -- bun run build       # tsc to dist/
mise exec -- npm pack --dry-run  # check what ships
```

## Invariants

- Read-only toward GitHub. Nothing in the package writes a label, comment, field or anything else to a tracker.
- Allowlist first. Every verb checks the source against `sources` in the config before reading a rubric, building a tracker or engine, reading a key, or sending a request. A refused source sends nothing and writes no cache. `--allow-once` never writes config. Never add a source to an allowlist to get a test or a run through.
- Only title, body and labels leave GitHub, plus facts computed in code. Errors name the backend or operation and the HTTP status, never a key, a token or issue text.
- No network in tests. The suite runs on `src/fixtures/replay.ts`, which serves the recorded GitHub page and Jev responses and counts requests per destination.
- Recorded fixtures replay by state hash. A Jev recording is found by the first 16 hex digits of the SHA-256 of the state sent; a state with no recording answers 404, so a changed state fails loudly instead of replaying a stale answer. The state hash excludes the issue key.
- The model version is pinned; answers from any other served version are refused.

## Re-recording fixtures

Re-record after changing `src/fixtures/rubric.yaml`, `src/fixtures/github-issues.json`, or anything that changes the state sent (its fields, the age buckets, the prompt budget):

```bash
OPENROUTER_API_KEY=... mise exec -- bun scripts/capture-fixtures.ts [--model jev-1.13]
```

It runs scoring and a top-10 tie-break over the fixture issues against a cold cache in a temporary directory, through OpenRouter, with ages pinned to `FIXTURE_NOW`, and writes each response to `src/fixtures/jev/<hash16>.json` with its `id` removed. It costs real requests: run it only when asked, then run the suite and commit the new recordings with the change that required them.

## The Bun SDK shim

`@typesafe-ai/sdk` 0.7.0 buffers a response by taking a reader on the original body and releasing it; Bun then refuses `text()` with "Body already used" (Node tolerates it). `bunSafeFetch` in `src/jev/engine.ts` hides `body` on the real Response so the SDK drains only its clone. Remove it once fixed upstream: https://github.com/typesafe-ai/typesafe-sdk-js

## Agent skills

### Issue tracker

Issues and specs live as local markdown under `.scratch/<feature>/` (no remote yet). See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage roles, label strings equal to their names. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root, created lazily. See `docs/agents/domain.md`.
