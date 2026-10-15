---
name: backlog-ranker
description: >-
  Rank a GitHub repository's open issues or a Linear team's pending
  issues by criteria the user chooses:
  turn "rank by impact and ROI" or "rank by what unblocks the launch"
  into a rubric one question at a time, calibrate it against the user's
  own hand ranking (Kendall's tau), then run `backlog-ranker rank`
  and present the table. Use when the user asks to rank, prioritize,
  order or triage a backlog or a set of issues by value, impact, effort,
  ROI or any criterion of their own, or to build, tune, calibrate or
  explain a backlog rubric. Read-only toward GitHub and Linear: it never
  writes a label, comment or priority back.
argument-hint: "[what to rank by, e.g. impact and ROI]"
---

# Backlog ranker

`backlog-ranker rank` asks a decision model (TypeSafe's Jev) narrow
questions about one issue at a time, then weighs, divides and gates
the answers in code. The rubric is the whole design: a vague level
makes noise, a concrete one makes a ranking. This skill builds the
rubric with the user, proves it against their judgment, and runs it.

A source is `github:owner/repo` (its open issues, keyed
`owner/repo#123`) or `linear:TEAM` (the team's issues in the workflow
states `linear.states` names, Backlog and Todo by default, keyed
`TEAM-123`).

## Before anything leaves the machine

Issue titles, bodies and labels go to a third-party API. Every verb
reads `.backlog-ranker/config.yaml` (or `config.local.yaml`, which
replaces it) and refuses any source not listed under `sources` before
a request is sent. `backend` names the provider (`typesafe` or
`openrouter`), `model` pins the Jev version, and `keys` names the
environment variables that hold the keys (defaults `GITHUB_TOKEN`,
`LINEAR_API_KEY`, `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`).
`linear.states` lists the Linear state names or types to rank; a
misspelt one is refused with the team's states listed, so fix the
config rather than guessing.

A source that is not listed is the user's decision to make in
committed config. Never add one yourself to get a run through, and
never suggest `--allow-once` to get around a refusal: that flag is for
a newcomer trying the tool on a public repository, not a way past the
allowlist.

## Build the rubric: one question at a time

Ask with the question tool, one decision per question, in grill-me
style. Start from an existing rubric in `.backlog-ranker/rubrics/`
when one fits, or from the shipped example `rubrics/impact-roi.yaml`
in the package. A new rubric is saved as
`.backlog-ranker/rubrics/<name>.local.yaml` (gitignored, an
experiment); renaming it to `<name>.yaml` and committing it shares it
as ranking policy. When both exist, the local file is read instead.

1. **Criteria.** What makes an issue worth doing first? Each criterion
   is one Score question with a `direction`: `benefit` (higher ranks
   higher) or `cost` (higher ranks lower). Impact and effort are two
   criteria. Never ask the model for a ratio, a count or a date
   comparison: code divides, counts and compares.
2. **Levels.** 3 to 5 ordered levels per criterion, lowest first (the
   schema allows 2 to 10). Each describes a concrete situation the
   user would recognize in an issue ("Fixes a failure that blocks a
   workflow most users follow"), never an adjective ("high impact").
   The model reads literally: when you catch yourself explaining what
   a level means, that explanation belongs in the level. Keep asking
   until every level passes that test.
3. **Gates.** Yes/no rules that override the arithmetic. `pin_top`
   lifts an issue above every unpinned one at or above `threshold`
   ("any credential leak jumps the queue"). `flag_if_below` holds an
   issue out of the ranking for a human below `threshold`. Offer a
   `judgeable` gate ("does the issue say concretely what is wrong and
   what done looks like?") so thin issues do not land mid-ranking.
   Fact gates (`fact_gates`) act on counts code reads from the tracker
   without asking the model: `hold` or `sink` an issue when a fact
   (`open_blockers`, `open_closing_prs`, `assignees`, `reactions`,
   `linked_issues`, `duplicates`) is `at_least` a whole number of 1 or
   more. Offer the one `impact-roi` ships (sink issues with an open
   blocker). Ask before holding work already in progress: an open
   closing pull request or an assignee means "started" only on some
   teams, so a hold on `open_closing_prs` or `assignees` is the
   user's choice, not a default.
4. **Composition.** `roi` (weighted benefit over weighted cost, both
   on a 1-based level scale) or `weighted_sum` (compensating
   criteria, cost flipped). Weights can change later for free; under
   `roi` a weight only shifts the order between criteria on the same
   side of the ratio.

The schema, with every key: the package's `rubrics/impact-roi.yaml`.

## Calibrate before trusting it

Ask the user to hand-rank 12 to 15 issues from the source, best
first, before showing any tool output. A hand ranking made after
seeing the tool's order is not a calibration. Give them keys and
titles in key order. Then:

```bash
backlog-ranker calibrate --rubric <name> --source github:<owner>/<repo> --hand owner/repo#12,#7,31,...
backlog-ranker calibrate --rubric <name> --source linear:<TEAM> --hand TEAM-12,7,31,...
```

A rubric is trusted at Kendall's tau >= 0.4 on at least 12 issues;
the verb exits 2 when it is not. Below that, it lists the pairs the
rubric orders against the user. Read them with the user, revise the
level or gate wording that explains them, and re-run: the cache
re-asks only the questions whose wording changed.

## Run and present

```bash
backlog-ranker rank --rubric <name> --source <github:owner/repo|linear:TEAM> [--weight impact=2] [--tiebreak 10] [--json]
```

Every row shows each criterion's score (a probability-weighted level
index, 0 = the first level) with its confidence, and each gate's
probability beside its threshold. The model returns no reasoning
text, so that breakdown is the explanation; present it, do not invent
reasons. Point out the rows that need a human: pinned, held, sunk,
low-confidence (kept in place rather than scored lower) and truncated.
`--weight` re-ranks from the cache with no new requests; `--tiebreak n`
reorders the top n (at most 10) with pairwise questions asked in both
orders.

To show why one issue landed where it did:

```bash
backlog-ranker explain --rubric <name> <owner/repo#123|TEAM-123>
```

It prints each criterion's level probabilities and each gate's margin,
from the cache when a rank already asked.

## What this skill never does

- Write anything back to GitHub or Linear. Moving a ranking into labels,
  milestones or project fields is a separate, confirmed step outside
  this skill.
- Rank a source the allowlist does not list, add a source to the
  allowlist, or suggest `--allow-once` to get past a refusal.
- Commit a `.local.yaml` rubric, or present a rubric as trusted
  without a calibration at the threshold.
