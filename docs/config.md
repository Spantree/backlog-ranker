# Config

Every verb reads the project's committed policy from `.backlog-ranker/config.yaml`. It names the sources whose issues may be sent to a model provider, the provider, the pinned model version, the environment variables that hold each key, and which Linear workflow states are ranked. No secret is ever written in it.

## Project root

The project root is the nearest ancestor of the working directory that holds `.backlog-ranker/config.yaml`, `.backlog-ranker/config.local.yaml`, a `.backlog-ranker/rubrics/` directory, or a `.git` entry; if none does, the working directory itself. A `.backlog-ranker/` holding only a cache (as an `--allow-once` run outside any project leaves) does not mark a root. Config, rubrics and the cache are all found under `<root>/.backlog-ranker/`, so the verbs work from any subdirectory.

## Schema

```yaml
sources:
  - github:acme/app
  - linear:ENG
backend: openrouter
model: jev-1.14
keys:
  github: GITHUB_TOKEN
  linear: LINEAR_API_KEY
  typesafe: TYPESAFE_API_KEY
  openrouter: OPENROUTER_API_KEY
linear:
  states: [Backlog, Todo]
```

| Key | Required | Default | Meaning |
| --- | --- | --- | --- |
| `sources` | yes | | The allowlist: `github:<owner>/<repo>` and `linear:<TEAM>` entries (`TEAM` is the Linear team key, as in `ENG-123`) |
| `backend` | yes | | `typesafe` (https://api.typesafe.ai) or `openrouter` (https://openrouter.ai/api) |
| `model` | no | `jev-1.14` | The pinned Jev version: `jev-1.13` or `jev-1.14` |
| `keys` | no | all four defaults | Environment variable names, never values |
| `keys.github` | no | `GITHUB_TOKEN` | Read for the GitHub token |
| `keys.linear` | no | `LINEAR_API_KEY` | Read for the Linear API key |
| `keys.typesafe` | no | `TYPESAFE_API_KEY` | Read when `backend: typesafe` |
| `keys.openrouter` | no | `OPENROUTER_API_KEY` | Read when `backend: openrouter` |
| `linear.states` | no | `[backlog, unstarted]` | The Linear workflow states whose issues are ranked, for every `linear:` source; see [Linear states](#linear-states) |

Unknown keys are refused at every level. A `keys` value must look like an environment variable name (`^[A-Za-z_][A-Za-z0-9_]*$`), so a pasted key is refused rather than committed.

The model is pinned because cached answers and a calibration's tau are only comparable within one version. A response from any other served version is refused and discarded.

When no config exists, every verb refuses with the path it expected and this minimal example:

```yaml
sources:
  - github:octocat/hello-world
backend: typesafe   # or openrouter
model: jev-1.14
```

## Linear states

A GitHub source ranks every open issue. A Linear source ranks the issues of its team that are in the workflow states `linear.states` lists. Each entry matches a state by its name as Linear shows it (`Backlog`, `Todo`, `In Review`) or by its type as Linear reports it (`triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`, and on current workspaces `duplicate` for the Duplicate state), ignoring case; names and types may be mixed.

```yaml
sources:
  - linear:ENG
linear:
  states: [Backlog, Todo]
```

Without `linear.states`, every state of type `backlog` or `unstarted` is ranked, which on Linear's default workflow is Backlog and Todo, and still holds when a team renames them. Triage, started, completed, canceled and duplicate issues are left out. Naming a `started`, `completed`, `canceled` or `duplicate` state is allowed, but ranking work that is in progress or finished is usually not what you want.

Each run first reads the team's workflow states. An entry that matches none of them refuses before any issue is read, naming the entry and listing the team's states with their types, so a typo never silently ranks nothing. An empty list, or one that is not a list, is refused when the config is read. Issues in other states are never requested. `calibrate --hand` and `explain` read the issues they name in any state, so a calibration set may include issues that have since moved on.

## Local overrides

`.backlog-ranker/config.local.yaml` replaces `config.yaml` outright when it exists; the two are not merged. Rubrics work the same way: `<name>.local.yaml` replaces `<name>.yaml`. The run header names the file that was read, so an override is never silent. Keep both out of git:

```gitignore
.backlog-ranker/cache/
.backlog-ranker/**/*.local.yaml
```

## The allowlist and what leaves the machine

Before reading a rubric, building a tracker or sending any request, every verb checks the source against `sources`. Matching ignores case. An unlisted source is refused with the config key and the sources that are listed, and nothing is sent. Adding a source is a committed config change, so the decision to send a repository's or a team's issues to a provider is reviewed like any other change.

For an allowed source:

- To GitHub (https://api.github.com/graphql): read-only GraphQL queries, authenticated with the token. Nothing is ever written.
- To Linear (https://api.linear.app/graphql): read-only GraphQL queries, authenticated with the API key: the team's workflow states, then its issues in the ranked states, a page of 100 at a time, or one issue per named key. Nothing is ever written.
- To the backend: per issue, its title, body (a Linear issue's description), sorted labels and four facts computed locally (age bucket, reaction count, linked issue count, duplicate count). On GitHub, linked issues are cross-references and connections from other issues plus sub-issues; pull requests and the parent do not count. Duplicates are issues closed or marked as a duplicate of this one by name; an issue closed as a duplicate without naming the original records no link and is not counted. On GitHub, no count stops at a page boundary. On Linear, linked issues are the issue's `blocks`, `duplicate` and `related` relations in either direction; `similar` relations are left out because Linear's AI suggests them. Each Linear issue's labels, relations and inverse relations are read up to 100 each, so a count above that stops at 100. On both trackers, duplicates count only issues marked as duplicates of this one; an issue that is itself a duplicate of another does not count that link. Comments and the text of linked issues are never read or sent. A body that would exceed the prompt budget is cut and marked.
- Kept from the backend: the facts only fact gates read are computed from the same reply and never sent. On GitHub, `open_blockers` counts open issues the issue is blocked by (GitHub's issue dependencies), `open_closing_prs` counts open pull requests set to close it (drafts included, merged ones excluded), and `assignees` counts its assignees. On Linear, `open_blockers` counts the issues that block this one (a `blocks` relation held by the other issue) whose state type is not `completed`, `canceled` or `duplicate`, and `assignees` is 1 when the issue has an assignee, else 0. `open_closing_prs` is always 0 on Linear: an issue's pull request attachments carry the URL but not whether the pull request is open, merged or closed, so a gate on it never fires for a Linear source.

`rank --allow-once` admits the `--source` it is given for that one run, prints a line on stderr naming the source and the backend that will receive its issues, and writes nothing to config. With a config file it adds the source to the listed ones and the config's backend receives the issues; `--backend` is refused there, because the committed config chooses the backend. Without a config file `--backend` is required, `model` is the default and every key variable is its default name. `calibrate` and `explain` have no `--allow-once`.

## Keys

Keys are read after the allowlist check passes: the GitHub token from the variable `keys.github` names, the Linear API key from the variable `keys.linear` names, and the engine key from the variable `keys.<backend>` names. An unset or empty variable refuses with its name.

### A GitHub token

GitHub's GraphQL API needs a token even for public repositories. The token only needs to read issues.

With the gh CLI:

```bash
gh auth login
export GITHUB_TOKEN=$(gh auth token)
```

Or create a fine-grained personal access token at https://github.com/settings/personal-access-tokens with access to the repositories you rank and the repository permission **Issues: Read-only**, and export it as `GITHUB_TOKEN` (or the variable `keys.github` names).

A rejected token (HTTP 401 or 403) refuses with the same instructions. Error messages name the operation and HTTP status, never the token or any text from the reply.

### A Linear API key

Create a personal API key at https://linear.app/settings/account/security and export it as `LINEAR_API_KEY` (or the variable `keys.linear` names). It is sent as the `authorization` header as is, with no `Bearer` prefix. The key reads what its owner can read, so the owner must be able to see the teams you rank. OAuth and other Linear tokens are not supported.

A rejected key (HTTP 401 or 403, or Linear's authentication error) refuses naming the variable and where to create a key. Error messages name the operation and the HTTP status, or for a reply of an unexpected shape the path of the first mismatching field, never the key or any text from the reply.

### A model provider key

Export `TYPESAFE_API_KEY` for `backend: typesafe` or `OPENROUTER_API_KEY` for `backend: openrouter`, or point `keys.typesafe` / `keys.openrouter` at another variable. Engine errors name the backend and HTTP status, never the key or the issue text.

## The cache

Every answer is cached in `.backlog-ranker/cache/<engine>--<model>.json`, for example `typesafe--jev-1.14.json`. An entry is keyed by the SHA-256 of the issue state as sent and the hash of the question, so:

- changing a weight, a threshold, `compose` or `confidence_floor` re-ranks from the cache with no requests;
- rewording a level, adding a criterion or editing an issue asks only what changed;
- answers from different model versions live in different files and never mix;
- the cache does not depend on the backend: answers fetched through OpenRouter answer a run against TypeSafe, and the reverse.

The file is merged on write with an atomic rename, so a run keeps the answers another run flushed before it. There is no lock: two runs that flush at the same moment can lose one run's new answers, which are asked again on the next run. A file from another schema, engine or model, or a corrupt one, is treated as empty. Delete the directory to start cold.
