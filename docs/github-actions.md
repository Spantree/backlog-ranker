# Ranking on a schedule with GitHub Actions

[`github-actions/backlog-ranking.yml`](github-actions/backlog-ranking.yml) is a workflow you copy into your repository. Every Monday at 06:00 UTC, and whenever you start it by hand, it ranks the repository's open issues and publishes the ranking twice: as the table in the run's job summary, and as `ranking.json`, a `--json` artifact. It is read-only toward the repository, like the CLI: its token can only read, and it never writes issues, labels, comments or anything else.

## Set it up

1. Commit `.backlog-ranker/config.yaml` listing this repository under `sources` (see [config.md](config.md)). The allowlist stays a reviewed change: the workflow never uses `--allow-once`.
2. Commit the rubric at `.backlog-ranker/rubrics/impact-roi.yaml`, or change `RUBRIC` in the workflow to your rubric's name (see [rubrics.md](rubrics.md)).
3. Add the model key as a repository secret (Settings → Secrets and variables → Actions) named after the variable the config's `keys` names for its backend: `OPENROUTER_API_KEY` for `backend: openrouter`, `TYPESAFE_API_KEY` for `backend: typesafe`. With `typesafe`, rename the workflow's `OPENROUTER_API_KEY` line to match.
4. Copy the workflow to `.github/workflows/backlog-ranking.yml`, and set `BACKLOG_RANKER` to the version you tested. A new release can change the ranking, so upgrade it on purpose.
5. Start it once from the Actions tab (**Run workflow**) and read the job summary.

## What it does

- **Permissions:** `contents: read` to check out the config and rubric, `issues: read` to read the issues. Nothing else.
- **GitHub token:** the workflow's built-in token, passed as `GITHUB_TOKEN`, reads this repository's issues.
- **Cache:** `.backlog-ranker/cache` is restored from the previous run and saved after this one, so a run asks the model only about issues that are new or edited since. The JSON step runs after the table step and is answered entirely from the cache: its `stats.requests` is 0. GitHub evicts a cache entry nobody has read for 7 days, so a weekly run can occasionally start cold; it then asks about every issue once, at the cost of one first run.
- **What leaves the runner:** each issue's title, body and labels, plus facts computed locally, go to the backend the config names, exactly as from your machine; see [config.md](config.md#the-allowlist-and-what-leaves-the-machine).

## Rank another repository

The built-in token reads only the repository the workflow runs in. To rank another one:

1. Create a fine-grained personal access token with access to that repository and **Issues: Read-only**, and store it as a secret, for example `BACKLOG_GITHUB_TOKEN`.
2. In the workflow, set `GITHUB_TOKEN: ${{ secrets.BACKLOG_GITHUB_TOKEN }}` and `SOURCE: github:<owner>/<repo>`.
3. List `github:<owner>/<repo>` under `sources` in the committed config.

## Change the schedule

Edit the `cron` line. It is in UTC: `"0 6 * * 1"` is Mondays at 06:00, `"0 6 * * 1-5"` is every weekday at 06:00. A schedule that runs at least every 6 days keeps the cache warm.
