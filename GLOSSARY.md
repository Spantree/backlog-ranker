# backlog-decisions

Ranks a tracker's pending tickets by a rubric: a decision model answers narrow questions about one ticket at a time, and fixed rules turn the answers into an order.

## Tickets and sources

**Ticket**:
One pending issue from a source, as the ranker sees it: its key, title, body, labels and facts.
_Avoid_: Item, task, card

**Source**:
One backlog the ranker reads, named as `github:<owner>/<repo>` or `linear:<TEAM>`.
_Avoid_: Repo, project, board

**Allowlist**:
The committed list of sources whose tickets may be sent to the decision model.
_Avoid_: Whitelist, permitted repos

**Fact**:
A number about a ticket counted by the ranker itself, never judged by the model.
_Avoid_: Signal, metadata, feature

**Open blocker**:
An open issue that a ticket is explicitly marked as blocked by.
_Avoid_: Dependency, open parent

**Closing pull request**:
An open pull request set to close a ticket when it merges, draft or not.
_Avoid_: Linked PR, related PR

## Rubrics and outcomes

**Rubric**:
The committed policy that says which questions are asked about every ticket and how the answers become an order.
_Avoid_: Scoring model, config

**Criterion**:
One question with ordered levels whose answer is a score for every ticket; it counts as a benefit or a cost.
_Avoid_: Dimension, metric

**Gate**:
A yes-or-no question to the model that can lift a ticket or hold it out, regardless of its score.
_Avoid_: Filter, check

**Fact gate**:
A rule on a fact, applied without asking the model, that can hold or sink a ticket.
_Avoid_: Fact filter, threshold gate

**Pin**:
The outcome that lifts a ticket above every unpinned ticket.
_Avoid_: Boost, prioritize

**Hold**:
The outcome that takes a ticket out of the ranking and sets it aside for a human.
_Avoid_: Exclude, skip, flag

**Sink**:
The outcome that keeps a ticket ranked but below every ticket that is neither pinned nor sunk.
_Avoid_: Demote, deprioritize

**Calibration**:
Measuring how far the rubric's order agrees with a person's own ranking of the same tickets.
_Avoid_: Validation, tuning
