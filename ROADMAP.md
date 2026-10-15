# Roadmap

Deferred work, in no particular order.

## GitHub Action recipe

Tracked in #3.

A documented workflow that runs `backlog-ranker rank --json` on a schedule and publishes the result as a build artifact or a job summary, read-only toward the repository like the CLI.

## Considered and deferred

A custom Jev-compatible base URL (a self-hosted or proxy endpoint) was considered and deferred. Backends are a fixed table (TypeSafe direct and OpenRouter) because the pinned-version check depends on knowing how each backend reports the model that answered.
