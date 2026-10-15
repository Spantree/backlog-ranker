# 09: Shipped content and docs

**What to build:** A newcomer reads a short README (one paragraph, install, the public-repo quickstart, one rank example, links) and can go deeper in `docs/` for rubrics, config, the CLI and the library. The package ships a generic `impact-roi` example rubric and the `backlog-decisions` agent skill that builds and calibrates rubrics. ROADMAP.md lists deferred work. AGENTS.md gains the repo's invariants and commands beside the existing Agent skills block. A capture script re-records the Jev fixtures.

**Blocked by:** 06 (calibrate), 07 (explain), 08 (allow-once)

**Status:** resolved

- [x] Example rubric `impact-roi` ported with evie-kit wording made generic; no EVA references, no calibration claims, no hand-ranking file
- [x] Skill at `skills/backlog-decisions/SKILL.md` rewritten for the new verbs and GitHub keys; invariants kept: concrete levels, hand ranking before tool output, never edit the allowlist, never write to the tracker; README says how to install it
- [x] `scripts/capture-fixtures.ts` ported with new imports; documented in AGENTS.md
- [x] README kept short; `docs/rubrics.md`, `docs/config.md` (including minting a GitHub token with `gh auth login` and `gh auth token`), `docs/cli.md`, `docs/library.md`
- [x] ROADMAP.md: Linear adapter; linked-PR and blocked-by-parent facts (re-record fixtures); GitHub Action recipe
- [x] AGENTS.md: layout, commands, the read-only and allowlist invariants, fixture re-recording, kept beside the Agent skills block
- [x] `files` whitelist in package.json ships dist, the example rubric and the skill
