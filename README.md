# backlog-decisions

Rank a GitHub repository's open issues by a YAML rubric you write. A decision model (TypeSafe's Jev) answers narrow questions about one issue at a time, with probabilities; code does the weighting, ROI arithmetic, pinning, holding, caching and tie-breaking. The tool never writes to GitHub, sends issue text only for sources listed in a committed allowlist, and will not call a rubric trusted until it agrees with your own hand ranking (Kendall's tau of at least 0.4 on 12 or more issues).

## Install

```bash
npm install --save-dev backlog-decisions
```

Node 22 or later, or Bun.

## Try it without config

Rank a public repository with the shipped example rubric. `--allow-once` admits the source for this run only, prints what leaves the machine, and writes nothing to config.

```bash
gh auth login
export GITHUB_TOKEN=$(gh auth token)
export OPENROUTER_API_KEY=...   # or TYPESAFE_API_KEY with --backend typesafe

npx backlog-decisions rank \
  --rubric node_modules/backlog-decisions/rubrics/impact-roi.yaml \
  --source github:octocat/hello-world \
  --allow-once --backend openrouter
```

## Rank with config

Commit `.backlog-decisions/config.yaml`:

```yaml
sources:
  - github:acme/app
backend: openrouter
model: jev-1.14
```

Copy the example rubric to `.backlog-decisions/rubrics/impact-roi.yaml`, edit its levels, then:

```bash
npx backlog-decisions rank --rubric impact-roi --source github:acme/app --tiebreak 5
```

## More

- [docs/rubrics.md](docs/rubrics.md): writing levels and gates, composition, weights, calibration
- [docs/config.md](docs/config.md): config keys, local overrides, the cache, the allowlist, tokens
- [docs/cli.md](docs/cli.md): every verb and flag, exit codes, JSON output
- [docs/library.md](docs/library.md): using the package from TypeScript
- [ROADMAP.md](ROADMAP.md): deferred work

The agent skill that builds and calibrates rubrics with you ships in `skills/backlog-decisions/`; copy or symlink that folder into `~/.claude/skills/` to install it.
