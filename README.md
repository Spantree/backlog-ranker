# backlog-ranker

Rank a GitHub repository's open issues, or a Linear team's pending issues, by a YAML rubric you write.

```text
#  key        composite  impact      effort      security   judgeable  flags            title
1  kit/kit#1  1.894      4.00 c1.00  1.64 c0.57  0.99≥0.50  0.96≥0.50  pinned:security  Executor launches print the API key into the pane
2  kit/kit#2  2.110      1.11 c0.71  0.00 c1.00  0.01<0.50  0.97≥0.50  -                Fix a typo in the README install section
3  kit/kit#3  2.010      3.00 c0.99  0.99 c0.99  0.02<0.50  0.94≥0.50  -                Lint gate crashes on every goal that renames a file

Held for a human (a flag_if_below gate answered under its threshold, or a hold fact gate fired): 2
-  kit/kit#5  0.771      0.08 c0.94  0.40 c0.68  0.04<0.50  0.02<0.50  held:judgeable  Make it better
```

A decision model (TypeSafe's Jev) answers narrow questions about one issue at a time, such as "how big is the impact?" or "is this a security issue?". Code does the rest: weighting, ROI, pinning, holding, caching and tie-breaking.

- **Read-only.** It never writes to GitHub or Linear.
- **Allowlist first.** Issue text is sent only for sources listed in your committed config.
- **Checked against you.** `calibrate` compares the rubric's order with your own hand ranking, and calls the rubric trusted only when they agree.

## Try it

Node 22 or later, or Bun.

1. Install:
   ```bash
   npm install --save-dev @feniix/backlog-ranker
   ```
2. Set the keys:
   ```bash
   export GITHUB_TOKEN=$(gh auth token)
   export OPENROUTER_API_KEY=...   # or TYPESAFE_API_KEY with --backend typesafe
   ```
3. Rank a public repository with the shipped example rubric:
   ```bash
   npx backlog-ranker rank \
     --rubric node_modules/@feniix/backlog-ranker/rubrics/impact-roi.yaml \
     --source github:octocat/hello-world \
     --allow-once --backend openrouter
   ```

`--allow-once` admits the source for this run only and prints what leaves the machine. It writes no config, but it does create the answer cache in `.backlog-ranker/cache/`.

## Use it on your project

1. Commit `.backlog-ranker/config.yaml`:
   ```yaml
   sources:
     - github:acme/app
     - linear:ENG        # a Linear team; reads LINEAR_API_KEY
   backend: openrouter
   model: jev-1.14
   ```
2. Copy the example rubric and edit its levels:
   ```bash
   mkdir -p .backlog-ranker/rubrics
   cp node_modules/@feniix/backlog-ranker/rubrics/impact-roi.yaml .backlog-ranker/rubrics/
   ```
3. Rank:
   ```bash
   npx backlog-ranker rank --rubric impact-roi --source github:acme/app
   npx backlog-ranker rank --rubric impact-roi --source linear:ENG
   ```
4. Check the rubric against your judgement: rank 12 or more issues by hand, best first, before you look at the tool's order.
   ```bash
   npx backlog-ranker calibrate --rubric impact-roi --source github:acme/app \
     --hand '#12,#7,#31,#4,#18,#2,#40,#9,#22,#15,#3,#27'
   ```
5. Ask why one issue landed where it did:
   ```bash
   npx backlog-ranker explain --rubric impact-roi acme/app#42
   ```

Keep the cache and local overrides out of git ([why](docs/config.md#local-overrides)):

```gitignore
.backlog-ranker/cache/
.backlog-ranker/**/*.local.yaml
```

## Read next

| To… | Read |
| --- | --- |
| Write levels and gates, set weights, calibrate | [docs/rubrics.md](docs/rubrics.md) |
| Configure sources, Linear states, keys, the cache | [docs/config.md](docs/config.md) |
| Look up a verb, flag, exit code or the JSON output | [docs/cli.md](docs/cli.md) |
| Call it from TypeScript | [docs/library.md](docs/library.md) |
| Rank on a schedule in GitHub Actions | [docs/github-actions.md](docs/github-actions.md) |
| Build and calibrate a rubric with Claude | copy `skills/backlog-ranker/` into `~/.claude/skills/` |

Deferred work: [ROADMAP.md](ROADMAP.md).
