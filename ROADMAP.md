# Roadmap

Deferred work, in no particular order.

## Open-blocker and closing-PR facts with fact gates

Tracked in #2. Triage replaced "blocked by an open parent" with open blockers from GitHub's native issue dependencies, and turned both facts into code-side gates that hold or sink a ticket.

Two more facts computed in code: how many open pull requests reference the issue, and whether the issue is blocked by an open parent. Both change the state sent to the model, so every state hash changes: existing cache entries stop matching, and the recorded Jev fixtures must be re-recorded with `scripts/capture-fixtures.ts`.

## GitHub Action recipe

Tracked in #3.

A documented workflow that runs `backlog-ranker rank --json` on a schedule and publishes the result as a build artifact or a job summary, read-only toward the repository like the CLI.

## Considered and deferred

A custom Jev-compatible base URL (a self-hosted or proxy endpoint) was considered and deferred. Backends are a fixed table (TypeSafe direct and OpenRouter) because the pinned-version check depends on knowing how each backend reports the model that answered.
