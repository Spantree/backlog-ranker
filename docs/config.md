# Config

Every verb reads the project's committed policy from `.backlog-decisions/config.yaml`. It names the sources whose issues may be sent to a model provider, the provider, the pinned model version, and the environment variables that hold each key. No secret is ever written in it.

## Project root

The project root is the nearest ancestor of the working directory that holds a `.backlog-decisions/` directory or a `.git` entry; if none does, the working directory itself. Config, rubrics and the cache are all found under `<root>/.backlog-decisions/`, so the verbs work from any subdirectory.

## Schema

```yaml
sources:
  - github:acme/app
  - github:acme/api
backend: openrouter
model: jev-1.14
keys:
  github: GITHUB_TOKEN
  typesafe: TYPESAFE_API_KEY
  openrouter: OPENROUTER_API_KEY
```

| Key | Required | Default | Meaning |
| --- | --- | --- | --- |
| `sources` | yes | | The allowlist: `github:<owner>/<repo>` entries. `linear:<TEAM>` parses but the Linear adapter is not built yet |
| `backend` | yes | | `typesafe` (https://api.typesafe.ai) or `openrouter` (https://openrouter.ai/api) |
| `model` | no | `jev-1.14` | The pinned Jev version: `jev-1.13` or `jev-1.14` |
| `keys` | no | all three defaults | Environment variable names, never values |
| `keys.github` | no | `GITHUB_TOKEN` | Read for the GitHub token |
| `keys.typesafe` | no | `TYPESAFE_API_KEY` | Read when `backend: typesafe` |
| `keys.openrouter` | no | `OPENROUTER_API_KEY` | Read when `backend: openrouter` |

Unknown keys are refused at every level. A `keys` value must look like an environment variable name (`^[A-Za-z_][A-Za-z0-9_]*$`), so a pasted key is refused rather than committed.

The model is pinned because cached answers and a calibration's tau are only comparable within one version. A response from any other served version is refused and discarded.

When no config exists, every verb refuses with the path it expected and this minimal example:

```yaml
sources:
  - github:octocat/hello-world
backend: typesafe   # or openrouter
model: jev-1.14
```

## Local overrides

`.backlog-decisions/config.local.yaml` replaces `config.yaml` outright when it exists; the two are not merged. Rubrics work the same way: `<name>.local.yaml` replaces `<name>.yaml`. The run header names the file that was read, so an override is never silent. Keep both out of git:

```gitignore
.backlog-decisions/cache/
.backlog-decisions/**/*.local.yaml
```

## The allowlist and what leaves the machine

Before reading a rubric, building a tracker or sending any request, every verb checks the source against `sources`. Matching ignores case. An unlisted source is refused with the config key and the sources that are listed, and nothing is sent. Adding a source is a committed config change, so the decision to send a repository's issues to a provider is reviewed like any other change.

For an allowed source:

- To GitHub (https://api.github.com/graphql): read-only GraphQL queries, authenticated with the token. Nothing is ever written.
- To the backend: per issue, its title, body, sorted labels and four facts computed locally (age bucket, reaction count, linked issue count, duplicate count). Comments and the text of linked issues are never read or sent. A body that would exceed the prompt budget is cut and marked.

`rank --allow-once` admits the `--source` it is given for that one run, prints a line on stderr naming the source and the backend that will receive its issues, and writes nothing to config. With a config file it adds the source to the listed ones; `--backend` then replaces the configured backend for that run. Without a config file `--backend` is required, `model` is the default and every key variable is its default name. `calibrate` and `explain` have no `--allow-once`.

## Keys

Keys are read after the allowlist check passes: the GitHub token from the variable `keys.github` names, and the engine key from the variable `keys.<backend>` names. An unset or empty variable refuses with its name.

### A GitHub token

GitHub's GraphQL API needs a token even for public repositories. The token only needs to read issues.

With the gh CLI:

```bash
gh auth login
export GITHUB_TOKEN=$(gh auth token)
```

Or create a fine-grained personal access token at https://github.com/settings/personal-access-tokens with access to the repositories you rank and the repository permission **Issues: Read-only**, and export it as `GITHUB_TOKEN` (or the variable `keys.github` names).

A rejected token (HTTP 401 or 403) refuses with the same instructions. Error messages name the operation and HTTP status, never the token or any text from the reply.

### A model provider key

Export `TYPESAFE_API_KEY` for `backend: typesafe` or `OPENROUTER_API_KEY` for `backend: openrouter`, or point `keys.typesafe` / `keys.openrouter` at another variable. Engine errors name the backend and HTTP status, never the key or the issue text.

## The cache

Every answer is cached in `.backlog-decisions/cache/<engine>--<model>.json`, for example `typesafe--jev-1.14.json`. An entry is keyed by the SHA-256 of the issue state as sent and the hash of the question, so:

- changing a weight, a threshold, `compose` or `confidence_floor` re-ranks from the cache with no requests;
- rewording a level, adding a criterion or editing an issue asks only what changed;
- answers from different model versions live in different files and never mix;
- the cache does not depend on the backend: answers fetched through OpenRouter answer a run against TypeSafe, and the reverse.

The file is merged on write with an atomic rename, so two concurrent runs keep each other's answers. A file from another schema, engine or model, or a corrupt one, is treated as empty. Delete the directory to start cold.
