# Changelog

Notable changes to `@feniix/backlog-ranker`, newest first.
Changes awaiting release live under **Unreleased**, grouped by Added, Changed,
Deprecated, Removed, Fixed or Security as needed.

Entries through 0.1.3 are backfilled from git history and the net changes
between release tags, excluding changes reverted before release.
Release dates use UTC npm publication dates.

## Unreleased

### Changed

- Centralize gate firing, precedence and effective outcomes so ranking and
  explanation share the same policy. Public flags, output and ranking behavior
  are unchanged. ([#6](https://github.com/Spantree/backlog-ranker/pull/6))

## [0.1.3] - 2026-10-16

### Added

- A copyable GitHub Actions workflow for scheduled backlog ranking.
  ([#3](https://github.com/Spantree/backlog-ranker/issues/3))
- Automatic version tags and GitHub releases with grouped commit notes after
  publishing to npm.

### Changed

- README examples now lead with sample output and show ranking, calibration and
  explanation.
- Clarify that `--allow-once` still writes the answer cache and that dated
  snapshots of the pinned model version share a cache file.

### Fixed

- Preserve a failed run's original error when saving the cache also fails, and
  report both failures in the CLI.
- Refuse calibration hand keys that no returned ticket answers instead of
  silently omitting them from the comparison.
- Suppress low-confidence flags for zero-weight criteria.
- Count GitHub connected tickets net of disconnections.
- Discard malformed cache entries so their questions are asked again.
- Treat unreadable ticket creation dates as unknown ages.
- Warn when a source is allowed only by `config.local.yaml`; include computed
  facts in the `--allow-once` notice and wait until credentials are available
  before printing it.
- Honor `--help` before malformed or unknown flags, distinguish malformed hand
  keys from keys belonging to another source, and render a null error cause as
  no cause.

### Security

- Refuse GitHub owner or repository names that could name a parent path.

## [0.1.2] - 2026-10-16

### Changed

- Version bump only. The attempted npm-token fallback was reverted before this
  tag, leaving no net changes beyond `package.json`'s version.

## [0.1.1] - 2026-10-16

### Changed

- Add diagnostic logging for npm's trusted-publishing exchange. No CLI or
  library behavior changes.

## [0.1.0] - 2026-10-16

### Added

- First public release of `@feniix/backlog-ranker`, with `rank`, `calibrate` and
  `explain` commands and a TypeScript library.
- Read-only GitHub and Linear trackers with source allowlists and one-run
  admission through `--allow-once`.
- YAML rubrics with weighted and ROI composition, model gates, fact gates,
  pin/hold/sink outcomes and optional pairwise tie-breaking.
- TypeSafe Jev decisions through TypeSafe or OpenRouter, pinned model versions,
  prompt-budget fitting and a reusable answer cache.
- Calibration against a hand ranking using Kendall's tau, ticket explanations,
  table and JSON output, an example rubric and an agent skill.
- Offline recorded fixtures, CI checks, a packed-install smoke test and npm
  publishing with provenance.

[0.1.3]: https://github.com/Spantree/backlog-ranker/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Spantree/backlog-ranker/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Spantree/backlog-ranker/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Spantree/backlog-ranker/releases/tag/v0.1.0
