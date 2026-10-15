# 10: Verify end to end and make the import commit

**What to build:** The whole package passes typecheck, lint, build and the full test suite under the pinned Bun, and the built bin runs `--help`, `rank`, `calibrate` and `explain` under plain `node` against a temp fixture project with an injected fake network. Everything then lands as one import commit on main with no remote and no push.

**Blocked by:** 09 (shipped content and docs)

**Status:** ready-for-human

- [ ] `bun run typecheck`, `bun run lint`, `bun run build`, `bun run test` all green
- [ ] `node dist/bin.js` exercised for every verb; exit codes 0, 1 and 2 observed where the spec says
- [ ] `npm pack --dry-run` lists only dist, the example rubric, the skill, README, LICENSE
- [ ] One commit on main titled as the import of the backlog ranker from evie-kit; no attribution lines; nothing pushed
- [ ] The pre-existing working-tree state (staged `.envrc`, `.claude/`, deleted `.evie-kit/settings.ts`) is reviewed with the user before the commit, not swept in silently
