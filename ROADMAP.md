# Roadmap

Deferred work, in no particular order.

## Linear adapter

Tracked in #1.

`linear:<TEAM>` sources already parse and are accepted in `sources`, but the tracker refuses them as not built yet. The adapter would read a team's pending issues (open, not started, done or canceled) with the same ticket shape and facts as GitHub.

## GitHub facts for linked pull requests and blocked-by-open-parent

Tracked in #2.

Two more facts computed in code: how many open pull requests reference the issue, and whether the issue is blocked by an open parent. Both change the state sent to the model, so every state hash changes: existing cache entries stop matching, and the recorded Jev fixtures must be re-recorded with `scripts/capture-fixtures.ts`.

## GitHub Action recipe

Tracked in #3.

A documented workflow that runs `backlog-decisions rank --json` on a schedule and publishes the result as a build artifact or a job summary, read-only toward the repository like the CLI.

## Considered and deferred

A custom Jev-compatible base URL (a self-hosted or proxy endpoint) was considered and deferred. Backends are a fixed table (TypeSafe direct and OpenRouter) because the pinned-version check depends on knowing how each backend reports the model that answered.
