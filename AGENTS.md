# AGENTS.md

`backlog-ranker` ranks a GitHub repository's open issues, or a Linear team's pending issues, by a YAML rubric. A decision model (TypeSafe's Jev) answers narrow questions about one issue at a time; code does the weighting, gates, caching, tie-break and calibration. It ships as one npm package with a CLI (`rank`, `calibrate`, `explain`) and a library.

## Layout

- `src/cli.ts`: the verb runner and the pipeline the verbs share; `src/cli/flags.ts` (usage text and flag checks), `src/cli/hand.ts` (`--hand` keys), `src/cli/render-error.ts` (failure output). `src/bin.ts` is the only file that touches the process, including the working directory.
- `src/api.ts`: the library facades `rankBacklog`, `calibrateBacklog`, `explainTicket`. `src/index.ts` is the package's public surface.
- `src/config.ts`, `src/loader.ts`: `.backlog-ranker/config.yaml`, the project root walk, and the lazily built engine and tracker (the tracker re-checks the allowlist). `src/keys.ts`: the one table of default key variable names.
- `src/source.ts`: source grammar, the one issue-key grammar, and the allowlist check. `src/errors.ts`: the refusal and help-request brands.
- `src/rubric.ts`, `src/state.ts`, `src/score.ts`, `src/compose.ts`, `src/tiebreak.ts`, `src/kendall.ts`, `src/cache.ts`, `src/table.ts`: rubric parsing, state building, scoring, composition, tie-break, tau, the answer cache and rendering.
- `src/engine.ts`: the engine-neutral decision interface. `src/jev/`: the Jev adapter over `@typesafe-ai/sdk` and the backend table.
- `src/trackers/`: the `Tracker` interface, the GitHub and Linear adapters, and `trackerFor` (`index.ts`), which picks one for a source.
- `src/fixtures/`: the fixture rubric, the GitHub issue page, the Linear team's issues and workflow states (`linear-issues.json`, `linear-workflow-states.json`), recorded Jev responses (`jev/<hash16>.json`), `replay.ts` (the offline fetch the suite runs on), `capture.ts` (the capture script's testable parts) and `project.ts` (the CLI suites' fixture project, io capture and temp roots).
- `rubrics/impact-roi.yaml`: the shipped example rubric. `skills/backlog-ranker/SKILL.md`: the shipped agent skill.
- `scripts/capture-fixtures.ts`: re-records the Jev fixtures. `docs/`: user docs, shipped in the package (`docs/agents/` is not). `.scratch/`: local issues and specs, never shipped.

## Commands

Run everything through mise so the pinned Bun (1.4.3) and Node are used.

```bash
mise exec -- bun install
mise exec -- bun run typecheck   # src and scripts/
mise exec -- bun run lint        # biome
mise exec -- bun test
mise exec -- bun run build       # empties dist/, then tsc; npm pack and publish run it (prepack)
mise exec -- npm pack --dry-run  # check what ships
mise exec -- node scripts/smoke-package.mjs  # pack, install in a temp project, run the CLI, import the library (needs the npm registry)
```

CI (`.github/workflows/ci.yml`) runs these on every pull request and push to `main`.

## Releasing

The package publishes to npm as `@feniix/backlog-ranker`. To release: bump `version` in `package.json` on a branch, merge to `main`, then run the **Release** workflow (`.github/workflows/release.yml`) by hand from `main` (`gh workflow run release.yml --ref main`). It re-runs the checks and the smoke test, then `npm publish --loglevel verbose`; npm refuses a version already published. It authenticates with npm trusted publishing, so no npm token exists anywhere, and npm attaches a provenance attestation linking each version to the commit and workflow run that built it. 0.1.2 was the first release published this way; 0.1.0 and 0.1.1 were published by hand and carry no provenance.

The npm side, as configured on the package's settings page:

- Trusted publisher: GitHub Actions, organization `Spantree` (capital S: every field is case-sensitive, and a lowercase `spantree` fails the exchange), repository `backlog-ranker`, workflow `release.yml`, no environment, direct `npm publish` allowed. A saved entry cannot be edited: delete it and add a new one, which must complete a publish within 2 days to stay valid.
- Publishing access: two-factor authentication required and tokens disallowed. A maintainer can still publish by hand with a passkey (`mise exec -- npm publish --auth-type=web`, from a real terminal).

When a publish fails with `ENEEDAUTH` or `E404`, the verbose log's `oidc` lines carry npm's real reason: `OIDC token exchange error - package not found` means the trusted publisher does not match the run (owner, repository, workflow file or environment).

## Invariants

- Read-only toward GitHub and Linear. Nothing in the package writes a label, comment, field or anything else to a tracker.
- Allowlist first. Every verb checks the source against `sources` in the config before reading a rubric, building a tracker or engine, reading a key, or sending a request. A refused source sends nothing and writes no cache. `--allow-once` never writes config. Never add a source to an allowlist to get a test or a run through.
- Only title, body and labels leave the tracker, plus facts computed in code. Errors name the backend or operation and the HTTP status, never a key, a token or issue text; a failed decision is prefixed with its issue key (or tie-break pair). The Jev adapter breaks the SDK's image-reference token (`<image:` + 32 hex) in everything it sends, which leaves any state without one, and so its hash, unchanged.
- No network in tests. The suite runs on `src/fixtures/replay.ts`, which serves the recorded GitHub page, the Linear team and the Jev responses and counts requests per destination (`github`, `linear`, `jev`, `other`).
- Recorded fixtures replay by state hash. A Jev recording is found by the first 16 hex digits of the SHA-256 of the state sent; a state with no recording answers 404, so a changed state fails loudly instead of replaying a stale answer. A request for another Jev version than the recording's served model also answers 404. The state hash excludes the issue key.
- The model version is pinned; answers from any other served version are refused.

## Re-recording fixtures

The Linear team's Backlog and Todo issues carry the same tickets as the GitHub page (`src/github-fixture.test.ts` checks it), so both replay the same recordings: change them together. Re-record after changing `src/fixtures/rubric.yaml`, `src/fixtures/github-issues.json`, or anything that changes the state sent (its fields, the age buckets, the prompt budget):

```bash
OPENROUTER_API_KEY=... mise exec -- bun scripts/capture-fixtures.ts
OPENROUTER_API_KEY=... mise exec -- bun scripts/capture-fixtures.ts --model jev-1.13 --out <dir>
```

It runs scoring and a top-10 tie-break over the fixture issues against a cold cache in a temporary directory, through OpenRouter, with ages pinned to `FIXTURE_NOW`, and writes each response to `src/fixtures/jev/<hash16>.json` with its `id` removed. Responses are held in memory and written only after the whole run has passed the engine's checks, so a failed run leaves the folder untouched. `src/fixtures/jev/` holds the default model's (jev-1.14) recordings only: a recording is named by state hash alone, so a capture with any other `--model` refuses to run without an `--out <dir>` elsewhere, and replay answers 404 when the model a request names is not the recording's. It costs real requests: run it only when asked, then run the suite and commit the new recordings with the change that required them.

## The Bun SDK shim

`@typesafe-ai/sdk` 0.7.0 fails every call under Bun with "Body already used": its response buffering takes a reader on the original body and releases it, and Bun then treats that body as used (Node tolerates it). `bunSafeFetch` in `src/jev/engine.ts` reads the body itself and hands the SDK a fresh `Response` streaming those bytes, the workaround from the upstream report. Remove it once https://github.com/typesafe-ai/typesafe-sdk-js/issues/20 is fixed.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues on Spantree/backlog-ranker, via `gh`. The first spec and its tickets predate the remote and stay resolved under `.scratch/` as history. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage roles, label strings equal to their names. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root, created lazily. See `docs/agents/domain.md`.
