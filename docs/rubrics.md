# Rubrics

A rubric is a YAML file that says what to ask about each issue and how code turns the answers into an order. The model answers one issue at a time; it never sees the other issues, never divides, counts or compares dates.

Rubrics live in `.backlog-ranker/rubrics/<name>.yaml` and are passed by name: `--rubric impact-roi`. A gitignored `<name>.local.yaml` beside it replaces the committed file outright when it exists, and the run header names the file it read. Every verb (`rank`, `calibrate` and `explain`) also accepts a file path: anything containing a `/` or ending in `.yaml` or `.yml`. A rubric name is lowercase letters, digits and dashes, at most 64 characters.

The package ships an example at `rubrics/impact-roi.yaml` (in `node_modules/backlog-ranker/rubrics/` once installed). Copy it into your project and reword it.

## Schema

| Key | Required | Default | Meaning |
| --- | --- | --- | --- |
| `name` | yes | | Shown in the run header |
| `description` | no | | Free text |
| `compose` | yes | | `roi` or `weighted_sum` |
| `confidence_floor` | no | `0.5` | A score answered with lower confidence is flagged |
| `criteria` | yes | | At least one; see below |
| `gates` | no | `[]` | See below |
| `fact_gates` | no | `[]` | See [Fact gates](#fact-gates) |
| `tiebreak_question` | no | built from the criteria | The question `--tiebreak` asks of each pair |

Each criterion:

| Key | Required | Default | Meaning |
| --- | --- | --- | --- |
| `id` | yes | | Lowercase snake_case, starts with a letter, at most 40 characters |
| `question` | yes | | What the model is asked |
| `levels` | yes | | 2 to 10 answers, lowest first |
| `weight` | no | `1` | Zero or more |
| `direction` | yes | | `benefit` (a higher level ranks higher) or `cost` (a higher level ranks lower) |

Each gate:

| Key | Required | Default | Meaning |
| --- | --- | --- | --- |
| `id` | yes | | Same rule as a criterion id; ids are unique across criteria, gates and fact gates |
| `question` | yes | | A yes/no question |
| `action` | yes | | `pin_top` or `flag_if_below` |
| `threshold` | no | `0.5` | Probability of yes, 0 to 1 |

Unknown keys are refused. At least one criterion needs a weight above 0, and `roi` needs at least one weighted `benefit` and one weighted `cost` criterion.

## Writing levels

Each level describes a concrete situation a reader would recognize in an issue, not an adjective. "Fixes a failure that blocks a workflow most users follow" works; "high impact" does not. The model reads the words literally: if you find yourself explaining what a level means, put that explanation into the level. Three to five levels is usually enough.

Ask impact and effort as two separate criteria. Never ask the model for a ratio, a count or a date; the tool computes those facts itself and sends them alongside the issue:

- `age`: a bucket (`under a week`, `under a month`, `under a quarter`, `under a year`, `a year or more`), not a day count, so cached answers do not expire daily
- `reactions`: the issue's total reaction count
- `linked_issues`: issues that cross-reference or are connected to it, plus its sub-issues (pull requests and the parent do not count)
- `duplicates`: issues marked as duplicates of it (on GitHub, issues closed or marked as a duplicate of this one by name; one closed as a duplicate without naming the original links to nothing and is not counted)

Three more facts are counted for [fact gates](#fact-gates) only and are never sent to the model:

- `open_blockers`: open issues it is blocked by (GitHub's issue dependencies)
- `open_closing_prs`: open pull requests set to close it, drafts included
- `assignees`: users assigned to it

Only the title, body and labels leave GitHub or Linear. A body that would push the request past the model's prompt budget is cut and marked, and the row is flagged `truncated`.

## Scores

A criterion's score is the probability-weighted level index: 0 is the first level, `levels - 1` the last. Each score carries the model's confidence. A score under `confidence_floor` keeps its value and its place; the row is flagged `low-confidence:<id>` and the table marks it with `?`.

## Gates

- `pin_top`: when the probability of yes is at or above `threshold`, the issue goes above every unpinned issue. Use it for "any credential leak jumps the queue".
- `flag_if_below`: when the probability is under `threshold`, the issue is held out of the ranking and listed separately for a human. Use it for issues too thin to judge.

A pin wins over a hold: a pinned issue that a `flag_if_below` gate would hold stays on top and carries both flags. The table shows each gate's probability, a comparison sign and its threshold, so you can see how close a pin or a hold was.

## Fact gates

A fact gate is a rule on a fact, applied in code without asking the model. It never sends a request and is not part of any cache key, so editing fact gates re-ranks from the cache.

```yaml
fact_gates:
  - id: blocked
    fact: open_blockers
    at_least: 1
    action: sink
  - id: in_progress
    fact: open_closing_prs
    at_least: 1
    action: hold
```

| Key | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Same rule as a criterion id; unique across criteria, gates and fact gates |
| `fact` | yes | `open_blockers`, `open_closing_prs`, `assignees`, `reactions`, `linked_issues` or `duplicates` |
| `at_least` | yes | A whole number, 1 or more; the gate fires when the fact is at least this. 0 is refused: every issue has at least 0 of everything |
| `action` | yes | `hold` or `sink` |

- `hold`: the issue is held out of the ranking for a human, flagged `held:<id>`, beside the issues a `flag_if_below` gate held.
- `sink`: the issue stays ranked but goes below every issue that is neither pinned nor sunk, flagged `sunk:<id>`.

The shipped `impact-roi` rubric carries only the `blocked` gate; delete it to turn it off. It does not hold work already in progress: whether an open closing pull request or an assignee means a ticket should leave the ranking differs by team, so `in_progress` above is an example to add, not a default. A team that treats an assigned issue as started can add:

```yaml
  - id: assigned
    fact: assignees
    at_least: 1
    action: hold
```

A tracker that does not report `open_blockers`, `open_closing_prs` or `assignees` counts them as 0, so a gate on them never fires there.

### Precedence

When one issue triggers several outcomes:

1. A fact-gate hold wins over everything: an issue with an open closing pull request is held even when a gate pins it.
2. A pin wins over a model-gate hold (see [Gates](#gates)) and over a sink: a pinned issue with an open blocker stays pinned and carries no `sunk:` flag.
3. A sink applies only to unpinned issues that are not held.

## Composition

- `weighted_sum`: each score is normalized to 0..1 (cost criteria flipped, so lower effort scores higher) and the weighted mean is the composite.
- `roi`: the weighted mean of benefit scores over the weighted mean of cost scores, both on a 1-based level scale so the lowest cost divides by 1, not 0.

Rows are ordered pinned first, then normal rows, then sunk rows, each by composite descending; ties go to the issue key. Held rows are listed apart.

## Weights

`--weight impact=2` overrides a criterion's weight for one run. Weights are composition inputs only: an override never changes a question, so it re-ranks from the cache with no new requests. Under `roi` a weight only shifts the balance between criteria on the same side of the ratio; with one benefit and one cost criterion it has no effect.

## Tie-break

`--tiebreak n` (1 to 10) asks the model to compare every pair in the top `n` rows directly, with `tiebreak_question` or, when absent, a question built from every criterion's wording, levels and direction (never its weight, so a `--weight` override does not change the question). Each pair is asked in both orders and the two answers averaged, so option-order bias cancels. Rows are reordered by summed win probability, inside the pinned, normal and sunk groups separately: pairs are only asked within a group, so a pin always holds and a sunk row never rises above a normal one.

## Calibrating with a hand ranking

A rubric is a guess until it agrees with you. To check it:

1. Pick 12 to 15 pending issues from the source.
2. Rank them by hand, best first, before you look at any output from the tool. A hand ranking made after seeing the tool's order is not a calibration.
3. Run:

   ```bash
   backlog-ranker calibrate --rubric impact-roi --source github:acme/app --hand acme/app#12,#7,31,...
   ```

   Keys may be written `owner/repo#N`, `#N` or `N`; all must belong to the source's repository.

The verb scores the same issues, orders them as `rank` would (pinned, normal and sunk issues, then held issues after every ranked one) and reports Kendall's tau between your order and the tool's.

**The trust rule:** a rubric is trusted when tau is at least 0.4 on at least 12 hand-ranked issues. Below that, calibrate exits 2 and lists every pair the rubric orders against you, your choice first. Read those pairs, reword the level or gate that explains them, and run calibrate again. Only questions whose wording changed are asked again; everything else comes from the cache.

A tau holds for one model version. The calibrate header names the engine and model; re-calibrate when you change `model`.

## Explaining one issue

`backlog-ranker explain --rubric impact-roi acme/app#42` prints one issue's facts (including the three fact-gate-only ones), its level probabilities per criterion, each gate's probability against its threshold and its outcome (`pinned`, `held` or `no effect`), each fact gate's value against `at_least` and its outcome (`held`, `sunk` or `no effect`), and the issue's flags. A gate that fired but lost to [precedence](#precedence) reads `no effect (held)` when a hold overrode it (a pin or sink on a held issue) or `no effect (pinned)` when a pin did (a `flag_if_below` hold or a sink on a pinned issue). It reuses the cache a `rank` filled.
