# AGENTS.md

`backlog-ranker` ranks a GitHub repository's open issues, or a Linear team's pending issues, by a YAML rubric. A decision model (TypeSafe's Jev) answers narrow questions about one issue at a time; code does the weighting, gates, caching, tie-break and calibration. One npm package, `@feniix/backlog-ranker`: a CLI (`rank`, `calibrate`, `explain`) and a library.

## Layout

- `src/bin.ts` is the only file that touches the process (exit, stdio, working directory). `src/cli.ts` runs the verbs; `src/api.ts` holds the library facades; `src/index.ts` is the public surface.
- `src/source.ts` owns the source grammar, the issue-key grammar and the allowlist check; `src/loader.ts` builds the tracker and engine lazily, and the tracker re-checks the allowlist. `src/keys.ts` is the one table of key variable names.
- `src/engine.ts` is the engine-neutral interface; `src/jev/` adapts `@typesafe-ai/sdk` to it. `src/trackers/` holds the GitHub and Linear adapters.
- `src/fixtures/` feeds the offline suite: `replay.ts` is the fake network, `jev/<hash16>.json` the recorded answers, `project.ts` the CLI suites' fixture project.
- `docs/` ships in the package; `docs/agents/` and `.scratch/` do not.

## Commands

Run everything through mise, so the pinned Bun and Node are used:

```bash
mise exec -- bun install
mise exec -- bun run typecheck   # src and scripts/
mise exec -- bun run lint        # biome
mise exec -- bun test
mise exec -- bun run build       # empties dist/, then tsc; prepack runs it
mise exec -- npm pack --dry-run  # what ships
mise exec -- node scripts/smoke-package.mjs  # installs the packed tarball and runs it (needs the npm registry)
```

CI runs all of them on every pull request and push to `main`.

## Invariants

- Read-only toward GitHub and Linear: the package only reads trackers.
- Allowlist first. Every verb checks the source against `sources` in the config before reading a rubric, building a tracker or engine, reading a key, or sending a request; a refused source sends nothing and writes no cache. `--allow-once` admits a source for one run and writes no config. Get a test or a run through with `--allow-once` or a fixture, and leave committed allowlists unchanged.
- Only title, body and labels leave the tracker, plus facts computed in code. Errors name the backend or operation, the HTTP status, and the issue key or tie-break pair; keys, tokens and issue text stay out. The Jev adapter breaks the SDK's image-reference token (`<image:` + 32 hex) in everything it sends.
- Tests run offline on `src/fixtures/replay.ts`, which counts requests per destination (`github`, `linear`, `jev`, `other`).
- Recorded fixtures replay by state hash: the first 16 hex digits of the SHA-256 of the state sent, excluding the issue key. A state with no recording, or a request for another Jev version, answers 404, so a changed state fails loudly.
- The model version is pinned; answers from any other served version are refused.

## When you need more

- **Releasing** a version to npm, or a failed Release workflow: `docs/agents/releasing.md`.
- **Re-recording** the Jev fixtures, after changing the fixture rubric, the fixture issues or the state sent: `docs/agents/fixtures.md`.
- **Issues and specs** live in GitHub Issues on Spantree/backlog-ranker, via `gh`: `docs/agents/issue-tracker.md`. Triage labels: `docs/agents/triage-labels.md`.
- **Domain language**: `GLOSSARY.md` and `docs/adr/`, created lazily: `docs/agents/domain.md`.

## The Bun SDK shim

`bunSafeFetch` in `src/jev/engine.ts` works around `@typesafe-ai/sdk` 0.7.0 failing every call under Bun with "Body already used": it buffers the body and hands the SDK a fresh `Response`. Remove it once https://github.com/typesafe-ai/typesafe-sdk-js/issues/20 is fixed.
