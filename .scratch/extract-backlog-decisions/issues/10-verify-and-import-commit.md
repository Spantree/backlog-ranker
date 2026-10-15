# 10: Verify end to end and make the import commit

**What to build:** The whole package passes typecheck, lint, build and the full test suite under the pinned Bun, and the built bin runs `--help`, `rank`, `calibrate` and `explain` under plain `node` against a temp fixture project with an injected fake network. Everything then lands as one import commit on main with no remote and no push.

**Blocked by:** 09 (shipped content and docs)

**Status:** resolved

- [x] `bun run typecheck`, `bun run lint`, `bun run build`, `bun run test` all green
- [x] `node dist/bin.js` exercised for every verb; exit codes 0, 1 and 2 observed where the spec says
- [x] `npm pack --dry-run` lists only dist, the example rubric, the skill, README, LICENSE
- [x] One commit on main titled as the import of the backlog ranker from evie-kit; no attribution lines; nothing pushed
- [x] The pre-existing working-tree state (staged `.envrc`, `.claude/`, deleted `.evie-kit/settings.ts`) is reviewed with the user before the commit, not swept in silently

## Comments

- 2026-10-15: verified on the integration branch: typecheck, lint (0 warnings), 194 tests, build, `npm pack --dry-run` (122 files: dist, docs without docs/agents, rubrics, skills, README, ROADMAP, LICENSE). Built bin run under Node 22.23.3: help exits 0 for every verb; allowlist, missing token, `--backend` with config, malformed key and unknown flag each refuse message-first with exit 1; debug variable restores frames; nothing written. Exit 2 for an untrusted calibration is covered by in-process tests, since a spawned process cannot reach the fixture network.
- The user chose a `--no-ff` merge into main that keeps the ticket history, instead of one squashed import commit. The user also chose to commit the three pre-existing working-tree changes (new `.envrc`, removal of `.evie-kit/settings.ts`, `.claude/settings.json`) as a separate chore commit. Nothing pushed; no remote exists.
