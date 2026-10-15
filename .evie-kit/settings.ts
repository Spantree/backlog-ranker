// evie-kit settings (project layer, committed). TypeScript-native —
// no dollar-brace interpolation machinery. Credential references go
// through ctx.env("NAME"), NEVER process.env: the settings function
// evaluates TWICE per load and envFiles (.envrc.local et al.) load
// between the passes, so a process.env read is envFiles-blind and the
// key it feeds knocks out silently (`settings explain <key>` shows the
// knockout). The function must be side-effect-free. Layering:
// built-in defaults ->
// ~/.evie-kit/settings.ts -> this file -> .evie-kit/settings.local.ts
// (gitignored — credentials live there, never in this file).
//
// Everything under tools.* is a capability with an engine behind it.
// Enabled-only semantics: DEFINING a review tool block declares this
// repo's contributors have that tool — a defined tool is part of review
// waves and must be available. Machines with more tools define them in
// .evie-kit/settings.local.ts.
//
// The full authoring reference (layers, env files, worktrees(), flags,
// debugging): node_modules/@evie-kit/goals/docs/settings-reference.md.
// Wondering which layer won a key, or why one is unavailable?
// `evie-kit settings explain tools.review` shows winner/shadowed/env
// attribution per key.

import type { SettingsContext } from "@evie-kit/goals";

export const settings = (ctx: SettingsContext) => ({
  // Dotenv files the runtime loads (EVA-55) — first-defined-wins,
  // ambient env outranks files, a missing file is silently fine.
  // Credentials dropped here load with no manual sourcing.
  envFiles: [
    ".envrc.local",
  ],
  tools: {
    review: {
      "claude-code": {
        model: "opus",
        effort: "high",
      },
    },
    // Where goals promote: every project promotes somewhere different, so
    // the goals skill reads these — never a hardcoded team. The ACTIVE
    // tracker is whichever tools.tracker.* sub-block is defined (both
    // defined errors at load).
    // tracker: {               // exactly ONE sub-block — linear or github
    //   linear: { team: "YOUR-TEAM-KEY", project: "Your Project Name" },
    //   github: { repo: "owner/repo", keyPrefix: "gh" },  // repo default: the origin remote
    // },
  },
  // Draft-phase git policy (EVA-62): by default drafts stay LOCAL — plain
  // files in the draft worktree, nothing committed or pushed until
  // promotion enters the whole folder as ONE commit (behind the intake
  // review gate). Uncomment to restore commit+push-as-you-draft wholesale;
  // `goals draft --push` / `goals share` shares a single draft either way.
  // goals: { drafts: { commit: true } },
  //
  // Per-worktree environment config (EVA-63). The sample line below is a
  // SAFE NO-OP: uncommented as-is (`isolated: false`) it asserts nothing
  // and the orchestrator keeps the cautious one-goal-at-a-time default.
  // Flip to `isolated: true` only once the config MAKES worktrees fully
  // independent — that assertion is what unlocks parallel goal execution.
  // setUp() provisions at launch and returns env vars,
  // envUp()/envStop()/envDown() start/suspend/destroy services, and
  // tearDown() restores the files half at merge cleanup. Declare per-goal
  // service flags under `worktree.flags` (defineWorktreeFlags types
  // wtx.flags from one declaration) and branch on wtx.flags inside.
  // Contract: the WorktreeConfig/WorktreeContext types in
  // @evie-kit/goals (worktreesConfig.ts). The documented consumer
  // pattern: node_modules/@evie-kit/goals/fixtures/
  // database-strategy.settings.ts; the full reference:
  // node_modules/@evie-kit/goals/docs/settings-reference.md.
  // worktrees: (wtx) => ({ isolated: false }),
});
