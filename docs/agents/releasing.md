# Releasing

The package publishes to npm as `@feniix/backlog-ranker` through npm trusted publishing: no npm token exists anywhere, and every workflow release carries a provenance attestation.

1. Bump `version` in `package.json` on a branch and merge it to `main`.
2. Run `gh workflow run release.yml --ref main`. It re-runs the checks and the smoke test, then `npm publish --loglevel verbose`.
3. Done when `npm view @feniix/backlog-ranker dist-tags --prefer-online` shows the new version as `latest`. The npmjs.com page lags the registry by minutes; trust the registry.

## The npm side

Configured on the package's settings page at npmjs.com:

- Trusted publisher: GitHub Actions, organization `Spantree`, repository `backlog-ranker`, workflow `release.yml`, no environment, direct `npm publish` allowed. Every field is case-sensitive: `Spantree` with a capital S. A saved entry is fixed: to change it, delete it and add a new one, which must complete a publish within 2 days to stay valid.
- Publishing access: two-factor authentication required, tokens disallowed. A maintainer publishes by hand with a passkey from a real terminal: `mise exec -- npm publish --auth-type=web`.

## When a publish fails

`ENEEDAUTH` and `E404` hide npm's real reason; the verbose log's `oidc` lines carry it. `OIDC token exchange error - package not found` means the trusted publisher does not match the run: check owner case, repository, workflow file and environment against the list above.
